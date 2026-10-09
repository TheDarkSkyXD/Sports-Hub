import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const sourceRoot = resolve(import.meta.dirname, '..');
const buildRoot = resolve(process.argv[2] ?? sourceRoot);
assert.ok(existsSync(join(buildRoot, '.next', 'BUILD_ID')), 'Run npm run build before this verifier.');
const scratch = await mkdtemp(join(tmpdir(), 'sunday-web-worker-'));
const links = ['.next', 'node_modules', 'lib', 'desktop'];
let child;
let childClosed = false;
let output = '';

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  return address.port;
}

try {
  await mkdir(join(scratch, 'scripts'));
  for (const file of ['package.json', 'next.config.ts']) {
    await copyFile(join(sourceRoot, file), join(scratch, file));
  }
  await copyFile(join(sourceRoot, 'scripts', 'web-server.mjs'), join(scratch, 'scripts', 'web-server.mjs'));
  await writeFile(join(scratch, 'scripts', 'electron-runtime.mjs'),
    'export async function prepareDevelopmentElectron() { throw new Error("Observer disabled for verification."); }\n');
  for (const name of links) await symlink(join(['.next', 'node_modules'].includes(name) ? buildRoot : sourceRoot, name), join(scratch, name), 'junction');

  const port = await freePort();
  const env = { ...process.env };
  delete env.SUNDAY_ROOM_DATA_DIR;
  child = spawn(process.execPath, [join(scratch, 'scripts', 'web-server.mjs'), 'start', '--port', String(port)], {
    cwd: scratch, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.once('close', () => { childClosed = true; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = (output + chunk.toString()).slice(-8000); });
  }
  const url = `http://127.0.0.1:${port}/api/sources`;
  const deadline = Date.now() + 45_000;
  let snapshot;
  while (!snapshot && Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) snapshot = await response.json();
    } catch {}
    if (!snapshot) await new Promise(done => setTimeout(done, 250));
  }
  assert.ok(snapshot, `Web source API did not start.\n${output}`);
  assert.equal(snapshot.sources.length, 47);
  for (const id of ['streamed','sportsfeed24','livesportpro','crichd','sportsbite'])
    assert.ok(snapshot.sources.some(source=>source.id===id),`Missing ${id}`);
  assert.equal(snapshot.scheduleScopes.length, 14);
  assert.equal(existsSync(join(scratch, '.desktop-runtime', 'football.sqlite')), true);
  console.log('Browser launcher used its isolated default database and returned 47 sources with 14 league scopes.');
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGTERM');
  }
  if (child && !childClosed) {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('Web server process tree did not close.')), 8000);
      child.once('close', () => { clearTimeout(timer); done(); });
    });
  }
  assert.equal(dirname(scratch), resolve(tmpdir()));
  assert.match(basename(scratch), /^sunday-web-worker-/);
  for (const name of links) {
    if (existsSync(join(scratch, name))) await unlink(join(scratch, name));
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
