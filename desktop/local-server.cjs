const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const retryDelays = [1000, 2000, 5000, 10000, 30000];
const healthIntervalMs = 5000;

function createLocalServer({ root, origin, port, userData, controlToken, observerOrigin, packaged = false, logDir = path.join(root, '.desktop-runtime'), onReady, onHealthy }) {
  const production = packaged || (process.env.SUNDAY_ROOM_FORCE_DEV !== '1' && fs.existsSync(path.join(root, '.next', 'BUILD_ID')));
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'server.log');
  let owned;
  let restartTimer;
  let healthTimer;
  let stableTimer;
  let startupTimer;
  let startup;
  let resolveStartup;
  let rejectStartup;
  let startupSettled = false;
  let stopInFlight;
  let checking = false;
  let healthFailures = 0;
  let restartAttempt = 0;
  let stopping = false;

  function record(message) {
    try { fs.appendFileSync(logPath, `[desktop ${new Date().toISOString()}] ${message}\n`); }
    catch {}
  }

  function settleStartup(error) {
    if (!startup || startupSettled) return;
    startupSettled = true;
    clearTimeout(startupTimer);
    if (error) rejectStartup(error);
    else resolveStartup();
  }

  async function healthy(session) {
    try {
      const response = await fetch(`${origin}/api/internal/ready`, {
        method: 'HEAD', headers: { 'x-sunday-control-token': controlToken },
        cache: 'no-store', signal: AbortSignal.timeout(1500),
      });
      response.body?.cancel();
      return response.status === 204 && response.headers.get('x-sunday-server-instance-id') === session.instanceId;
    } catch { return false; }
  }

  function killTree(session) {
    const target = session.target;
    if (session.targetExited || target.exitCode !== null || target.signalCode != null) {
      return session.treeCommandSucceeded
        ? Promise.resolve()
        : Promise.reject(new Error('Local server supervisor exited without tree kill evidence'));
    }
    if (!target.pid) {
      return Promise.reject(new Error('Local server supervisor has no process ID'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let commandDone = false;
      let targetExited = target.exitCode !== null || target.signalCode != null;
      let killer;
      const onTargetExit = () => { session.targetExited = true; targetExited = true; complete(); };
      const onKillerError = error => finish(new Error(`Local server tree kill failed: ${error}`));
      const onKillerExit = code => {
        if (code !== 0) finish(new Error(`Local server tree kill exited with code ${code}`));
        else { session.treeCommandSucceeded = true; commandDone = true; complete(); }
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.off('exit', onTargetExit);
        killer?.off('exit', onKillerExit);
        if (error) reject(error);
        else resolve();
      };
      const complete = () => { if (commandDone && targetExited) finish(); };
      const timer = setTimeout(() => {
        try { killer?.kill?.(); } catch {}
        finish(new Error('Local server tree kill timed out before process exit'));
      }, 5000);
      target.once('exit', onTargetExit);
      if (process.platform === 'win32') {
        try {
          killer = spawn('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', onKillerError);
          killer.once('exit', onKillerExit);
        } catch (error) { finish(new Error(`Local server tree kill failed: ${error}`)); }
      } else {
        try {
          if (!target.kill()) finish(new Error('Local server process kill failed'));
          else { commandDone = true; complete(); }
        } catch (error) { finish(new Error(`Local server process kill failed: ${error}`)); }
      }
    });
  }

  function terminate(session) {
    if (session.termination) return session.termination;
    const done = killTree(session);
    session.termination = done;
    void done.then(
      () => { if (session.termination === done) session.termination = undefined; },
      () => { if (session.termination === done) session.termination = undefined; },
    );
    return done;
  }

  function clearHealth() {
    clearInterval(healthTimer);
    clearTimeout(stableTimer);
    healthTimer = undefined;
    stableTimer = undefined;
    healthFailures = 0;
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return;
    const delay = retryDelays[Math.min(restartAttempt, retryDelays.length - 1)];
    restartAttempt++;
    record(`Restarting local server in ${delay}ms`);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopping && !owned) {
        try { spawnServer(); }
        catch (error) { record(`Local server restart failed: ${error}`); scheduleRestart(); }
      }
    }, delay);
  }

  function exited(session, reason) {
    if (session !== owned) return;
    record(`Local server supervisor exited: ${reason}`);
    clearTimeout(session.replacementRetry);
    session.replacementRetry = undefined;
    if (stopping) return;
    if ((session.phase === 'replacing' || session.phase === 'unresolved')
      && (!session.targetExited || !session.treeCommandSucceeded)) return;
    owned = undefined;
    clearHealth();
    scheduleRestart();
  }

  function live(session) {
    return !!session.target.pid && !session.targetExited
      && session.target.exitCode === null && session.target.signalCode == null;
  }

  async function replace(session) {
    if (session !== owned || stopping || session.phase === 'replacing') return;
    if (session.phase === 'unresolved' && !live(session)) return;
    clearTimeout(session.replacementRetry);
    session.replacementRetry = undefined;
    session.phase = 'replacing';
    clearHealth();
    try {
      await terminate(session);
      if (session !== owned) return;
      owned = undefined;
      scheduleRestart();
    } catch (error) {
      if (session !== owned) return;
      session.phase = 'unresolved';
      record(`Local server replacement failed: ${error}`);
      if (!stopping && live(session)) {
        record(`Retrying local server termination in ${healthIntervalMs}ms`);
        session.replacementRetry = setTimeout(() => {
          session.replacementRetry = undefined;
          if (!stopping && session === owned && session.phase === 'unresolved' && live(session))
            void replace(session);
        }, healthIntervalMs);
      }
    }
  }

  async function checkNow() {
    const session = owned;
    if (!session || stopping || checking || !healthTimer || session.phase !== 'ready') return;
    checking = true;
    try {
      const okay = await healthy(session);
      if (session !== owned || stopping) return;
      healthFailures = okay ? 0 : healthFailures + 1;
      if (healthFailures >= 3) {
        record('Local server failed three consecutive health checks');
        await replace(session);
      } else if (okay) onHealthy?.();
    } finally { checking = false; }
  }

  async function waitForReady(session) {
    for (let attempt = 0; attempt < 120 && session === owned && !stopping; attempt++) {
      if (await healthy(session)) {
        if (session !== owned || stopping) return;
        session.phase = 'ready';
        healthFailures = 0;
        healthTimer = setInterval(() => { void checkNow(); }, healthIntervalMs);
        stableTimer = setTimeout(() => { if (session === owned) restartAttempt = 0; }, 30000);
        settleStartup();
        record('Local server ready');
        onReady();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (session === owned && !stopping) await replace(session);
  }

  function spawnServer() {
    if (stopping || owned) return;
    const instanceId = randomUUID();
    const log = fs.openSync(logPath, 'a');
    const serverTarget = packaged ? path.join(root, 'server.js') : path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    let target;
    try {
      target = spawn(process.execPath, [
        path.join(__dirname, 'server-supervisor.cjs'),
        serverTarget,
        packaged ? 'standalone' : production ? 'start' : 'dev', String(port),
      ], {
        cwd: root, windowsHide: true,
        env: { ...process.env, NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? '1', ELECTRON_RUN_AS_NODE: '1', SUNDAY_ROOM_DESKTOP: '1', SUNDAY_ROOM_BROWSER_COLLECTORS: '1', SUNDAY_ROOM_DATA_DIR: userData,
          SUNDAY_ROOM_CONTROL_TOKEN: controlToken, SUNDAY_ROOM_SERVER_INSTANCE_ID: instanceId,
          ...(observerOrigin ? { SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN: observerOrigin } : {}) },
        stdio: ['ignore', log, log, 'ipc'],
      });
    } finally { fs.closeSync(log); }
    const session = { target, instanceId, phase: 'starting', termination: undefined, replacementRetry: undefined,
      targetExited: false, treeCommandSucceeded: false };
    owned = session;
    target.once('error', error => {
      if (target.pid) { exited(session, error.message); return; }
      if (session !== owned) return;
      record(`Local server supervisor failed to spawn: ${error}`);
      owned = undefined;
      clearHealth();
      scheduleRestart();
    });
    target.once('exit', (code, signal) => {
      session.targetExited = true;
      exited(session, `code ${code ?? 'none'}, signal ${signal ?? 'none'}`);
    });
    void waitForReady(session).catch(error => record(`Local server readiness failed: ${error}`));
  }

  function start() {
    if (stopping) return Promise.reject(new Error('Local server is stopping'));
    if (startup) return startup;
    startup = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
    startupTimer = setTimeout(() => beginStop(new Error('Local server startup timed out')), 120000);
    try { spawnServer(); }
    catch (error) { beginStop(error); }
    return startup;
  }

  function beginStop(error = new Error('Local server is stopping')) {
    if (stopping) return;
    stopping = true;
    settleStartup(error);
    record('Stopping local server with desktop app');
    clearTimeout(restartTimer);
    restartTimer = undefined;
    clearTimeout(owned?.replacementRetry);
    if (owned) owned.replacementRetry = undefined;
    clearHealth();
  }

  async function stop() {
    beginStop();
    if (stopInFlight) return stopInFlight;
    const session = owned;
    if (!session) return;
    const done = (async () => {
      await terminate(session);
      if (session === owned) owned = undefined;
      clearHealth();
    })();
    stopInFlight = done;
    try { await done; }
    finally { if (stopInFlight === done) stopInFlight = undefined; }
  }

  return { start, beginStop, stop, checkNow };
}

module.exports = { createLocalServer };
