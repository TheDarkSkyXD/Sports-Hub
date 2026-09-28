const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const retryDelays = [1000, 2000, 5000, 10000, 30000];

function createLocalServer({ root, origin, port, userData, controlToken, observerOrigin, packaged = false, logDir = path.join(root, '.desktop-runtime'), onReady, onHealthy }) {
  const production = packaged || (process.env.SUNDAY_ROOM_FORCE_DEV !== '1' && fs.existsSync(path.join(root, '.next', 'BUILD_ID')));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'server.log');
  let child;
  let restartTimer;
  let healthTimer;
  let stableTimer;
  let checking = false;
  let replacing = false;
  let healthFailures = 0;
  let restartAttempt = 0;
  let stopping = false;
  let firstReady;

  function record(message) {
    try { fs.appendFileSync(logPath, `[desktop ${new Date().toISOString()}] ${message}\n`); }
    catch {}
  }

  async function healthy() {
    try {
      const response = await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
      response.body?.cancel();
      return response.ok;
    } catch { return false; }
  }

  async function killTree(target) {
    if (!target?.pid || target.exitCode !== null) return;
    if (process.platform === 'win32') {
      const disconnect = () => {
        if (target.connected) target.disconnect();
      };
      await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { disconnect(); resolve(); });
        killer.once('exit', code => { if (code !== 0) disconnect(); resolve(); });
      });
    } else target.kill();
  }

  function clearHealth() {
    clearInterval(healthTimer);
    clearTimeout(stableTimer);
    healthTimer = undefined;
    stableTimer = undefined;
    healthFailures = 0;
    replacing = false;
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    const delay = retryDelays[Math.min(restartAttempt, retryDelays.length - 1)];
    restartAttempt++;
    record(`Restarting local server in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopping && !child) spawnServer();
    }, delay);
  }

  function exited(target, reason) {
    if (target !== child) return;
    record(`Local server supervisor exited: ${reason}`);
    child = undefined;
    clearHealth();
    scheduleRestart();
  }

  async function checkNow() {
    const target = child;
    if (!target || stopping || checking || !healthTimer) return;
    checking = true;
    if (replacing) {
      await killTree(target);
      checking = false;
      return;
    }
    const okay = await healthy();
    checking = false;
    if (target !== child || stopping) return;
    healthFailures = okay ? 0 : healthFailures + 1;
    if (healthFailures >= 3) {
      replacing = true;
      record('Local server failed three consecutive health checks');
      clearTimeout(stableTimer);
      await killTree(target);
    } else if (okay) onHealthy?.();
  }

  async function waitForReady(target) {
    for (let attempt = 0; attempt < 120 && target === child && !stopping; attempt++) {
      if (await healthy()) {
        if (target !== child || stopping) return;
        healthFailures = 0;
        healthTimer = setInterval(() => { void checkNow(); }, 5000);
        stableTimer = setTimeout(() => { if (target === child) restartAttempt = 0; }, 30000);
        firstReady?.();
        firstReady = undefined;
        record('Local server ready');
        onReady();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (target === child && !stopping) await killTree(target);
  }

  function spawnServer() {
    if (stopping || child) return;
    const log = fs.openSync(logPath, 'a');
    const serverTarget = packaged ? path.join(root, 'server.js') : path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    const target = spawn(process.execPath, [
      path.join(__dirname, 'server-supervisor.cjs'),
      serverTarget,
      packaged ? 'standalone' : production ? 'start' : 'dev', String(port),
    ], {
      cwd: root, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SUNDAY_ROOM_DESKTOP: '1', SUNDAY_ROOM_BROWSER_COLLECTORS: '1', SUNDAY_ROOM_DATA_DIR: userData,
        SUNDAY_ROOM_CONTROL_TOKEN: controlToken,
        ...(observerOrigin ? { SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN: observerOrigin } : {}) },
      stdio: ['ignore', log, log, 'ipc'],
    });
    fs.closeSync(log);
    child = target;
    target.once('error', error => exited(target, error.message));
    target.once('exit', (code, signal) => exited(target, `code ${code ?? 'none'}, signal ${signal ?? 'none'}`));
    void waitForReady(target);
  }

  function start() {
    if (stopping) throw new Error('Local server is stopping');
    const ready = new Promise(resolve => { firstReady = resolve; });
    spawnServer();
    return ready;
  }

  function beginStop() {
    if (stopping) return;
    stopping = true;
    record('Stopping local server with desktop app');
    clearTimeout(restartTimer);
    restartTimer = undefined;
    clearHealth();
  }

  async function stop() {
    beginStop();
    await killTree(child);
    child = undefined;
  }

  return { start, beginStop, stop, checkNow };
}

module.exports = { createLocalServer };
