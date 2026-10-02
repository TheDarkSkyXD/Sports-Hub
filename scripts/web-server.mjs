import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDevelopmentElectron } from './electron-runtime.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'start') throw new Error('Expected dev or start');

const args = process.argv.slice(3);
let port = process.env.PORT || '3000';
const nextArgs = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '-p' || arg === '--port') port = args[++index];
  else if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
  else if (arg === '-H' || arg === '--hostname' || arg.startsWith('--hostname=') || arg.startsWith('--experimental-https'))
    throw new Error('The web collector requires the local HTTP server');
  else nextArgs.push(arg);
}
if (!/^\d{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid port');

try {
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(Number(port), '127.0.0.1', () => probe.close(resolve));
  });
} catch {
  console.error(`Port ${port} is unavailable on 127.0.0.1`);
  process.exit(1);
}

const origin = `http://127.0.0.1:${port}`;
const controlToken = randomUUID();
const env = { ...process.env, SUNDAY_ROOM_DESKTOP: '0', SUNDAY_ROOM_BROWSER_COLLECTORS: '0',
  SUNDAY_ROOM_CONTROL_TOKEN: controlToken };
let next;
let collector;
let stopping = false;

function running(child) {
  return child?.pid && child.exitCode === null && child.signalCode === null;
}

async function killTree(child) {
  if (!running(child)) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    await waitForExit(child, 3000);
    if (running(child)) child.kill('SIGKILL');
    return;
  }
  await new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve);
    killer.once('exit', resolve);
  });
}

function waitForExit(child, timeoutMs) {
  if (!running(child)) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (collector?.connected) collector.send({ kind: 'stop' });
  await waitForExit(collector, 2000);
  await killTree(collector);
  await killTree(next);
  process.exit(code);
}

async function startCollector() {
  const electron = await prepareDevelopmentElectron();
  const collectorEnv = { ...env, SUNDAY_ROOM_COLLECTOR_ORIGIN: origin };
  delete collectorEnv.ELECTRON_RUN_AS_NODE;
  collector = spawn(electron, [join(root, 'desktop', 'sportsurge-sidecar.cjs')], {
    cwd: root, windowsHide: true, env: collectorEnv,
    stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
  });
  const current = collector;
  let ready = false;
  current.once('error',error => { if (ready) console.error('Sportsurge observer failed:',error); });
  current.once('exit',code => {
    if (collector === current) collector = undefined;
    if (ready && !stopping) console.error(`Sportsurge observer exited with code ${code ?? 'none'}`);
  });
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Sportsurge observer did not become ready')),15000);
    current.on('message',message => {
      if (message?.kind !== 'ready') return;
      clearTimeout(timer);
      if (message.origin !== null && !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(message.origin || ''))
        reject(new Error('Invalid observer address'));
      else { ready = true; resolve(message.origin); }
    });
    current.once('error',error => { clearTimeout(timer); reject(error); });
    current.once('exit',() => { clearTimeout(timer); reject(new Error('Sportsurge observer exited')); });
  });
}

async function waitForReady() {
  for (let attempt = 0; attempt < 240 && !stopping; attempt++) {
    if (next.exitCode !== null) return;
    try {
      const response = await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.ok) {
        if (collector?.connected) collector.send({ kind: 'start' });
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!stopping) { console.error('Web server did not become ready'); await stop(1); }
}

process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
let observerOrigin;
try { observerOrigin = await startCollector(); }
catch (error) {
  console.error('Sportsurge observer unavailable:',error);
  await killTree(collector);
  collector = undefined;
}
if (!stopping) {
  next = spawn(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), mode,
    '--hostname', '127.0.0.1', '--port', port, ...nextArgs], {
    cwd: root, env: { ...env, ...(collector ? { SUNDAY_ROOM_BROWSER_COLLECTORS: '1' } : {}),
      ...(observerOrigin ? { SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN: observerOrigin } : {}) },
    stdio: 'inherit', windowsHide: true,
  });
  next.once('error', error => { console.error('Web server error:', error); void stop(1); });
  next.once('exit', code => { if (!stopping) void stop(code || 1); });
  void waitForReady();
}
