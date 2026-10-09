const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sourceIdentity, publicEnvironment } = require('./source-identity.cjs');
const { buildDirectory, reusableArtifact, completeArtifact } = require('./compiled-artifact.cjs');

const retryDelays = [1000, 2000, 5000, 10000, 30000];
const healthIntervalMs = 5000;

async function prepareCollector(root) {
  const { ensureCollectorAddon } = await import('../scripts/build-rust-collector.mjs');
  await ensureCollectorAddon(root);
}

function createLocalServer({ root, origin, port, userData, controlToken, observerOrigin, mode = 'compiled', logDir = path.join(root, '.desktop-runtime'), onReady, onHealthy, ensureCollector = prepareCollector }) {
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
  let preparation;
  let serverTarget;
  let preparationTimer;

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

  function commandEnvironment(instanceId, extra = {}) {
    return { ...process.env, ...extra, NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? '1',
      ELECTRON_RUN_AS_NODE: '1', SUNDAY_ROOM_DESKTOP: '1', SUNDAY_ROOM_BROWSER_COLLECTORS: '1',
      SUNDAY_ROOM_DATA_DIR: userData, SUNDAY_ROOM_CONTROL_TOKEN: controlToken,
      SUNDAY_ROOM_SERVER_INSTANCE_ID: instanceId, SUNDAY_ROOM_APP_ORIGIN: origin,
      ...(observerOrigin ? { SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN: observerOrigin } : {}) };
  }

  async function runPreparation(entry, mode, distDir, extra = {}) {
    if (stopping) throw new Error('Local server preparation was cancelled');
    record(`Preparing local server: ${mode}`);
    const log = fs.openSync(logPath, 'a');
    let target;
    try {
      target = spawn(process.execPath, [path.join(__dirname, 'server-supervisor.cjs'), entry, mode, distDir], {
        cwd: root, windowsHide: true, env: commandEnvironment(randomUUID(), extra),
        stdio: ['ignore', log, log, 'ipc'],
      });
    } finally { fs.closeSync(log); }
    const session = { target, instanceId: '', phase: 'preparing', termination: undefined,
      targetExited: false, treeCommandSucceeded: false };
    owned = session;
    try {
      let completionCode;
      await new Promise((resolve, reject) => {
        const onMessage = message => {
          if (message?.kind === 'complete') { completionCode = message.code; finish(); }
        };
        const onExit = (code, signal) => {
          session.targetExited = true;
          finish(new Error(`Local server ${mode} exited before completion: ${code ?? signal}`));
        };
        const onError = error => finish(error);
        const finish = error => {
          target.off('message', onMessage);
          target.off('exit', onExit);
          target.off('error', onError);
          if (error) reject(error);
          else resolve();
        };
        target.on('message', onMessage);
        target.once('exit', onExit);
        target.once('error', onError);
      });
      await terminate(session);
      if (completionCode !== 0) throw new Error(`Local server ${mode} failed with code ${completionCode}`);
      if (stopping) throw new Error('Local server preparation was cancelled');
    } finally {
      if (session === owned && session.treeCommandSucceeded && session.targetExited) owned = undefined;
    }
  }

  async function resolveServerTarget() {
    await ensureCollector(root);
    const inheritedPublicEnvironment = publicEnvironment();
    const sourceId = await sourceIdentity(root, inheritedPublicEnvironment);
    if (stopping) throw new Error('Local server preparation was cancelled');
    const reusable = await reusableArtifact(root, sourceId);
    if (reusable && publicEnvironment() === inheritedPublicEnvironment &&
        await sourceIdentity(root, inheritedPublicEnvironment) === sourceId) return reusable;
    const distDir = buildDirectory(randomUUID());
    const buildRoot = path.join(root, distDir);
    fs.mkdirSync(buildRoot, { recursive: true });
    const configRoot = path.join(root, '.desktop-runtime', 'local-build-config');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, `${path.basename(distDir)}.json`), JSON.stringify({
      extends: '../../tsconfig.json', compilerOptions: { baseUrl: '../..', paths: { '@/*': ['./*'] } },
    }));
    const realModules = fs.realpathSync(path.join(root, 'node_modules'));
    const linkedModules = path.normalize(realModules) !== path.normalize(path.join(root, 'node_modules'));
    await runPreparation(path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', distDir,
      { SUNDAY_ROOM_NEXT_DIST_DIR: distDir, SUNDAY_ROOM_BUILD_PUBLIC_ENV: inheritedPublicEnvironment,
        SUNDAY_ROOM_BUILD_WEBPACK: linkedModules ? '1' : '0' });
    await runPreparation(path.join(root, 'scripts', 'prepare-desktop.mjs'), 'prepare', distDir);
    if (publicEnvironment() !== inheritedPublicEnvironment ||
        await sourceIdentity(root, inheritedPublicEnvironment) !== sourceId)
      throw new Error('Source changed while preparing the desktop server');
    const target = await completeArtifact(root, distDir, sourceId);
    if (publicEnvironment() !== inheritedPublicEnvironment ||
        await sourceIdentity(root, inheritedPublicEnvironment) !== sourceId)
      throw new Error('Source changed before starting the desktop server');
    return target;
  }

  function spawnServer() {
    if (stopping || owned) return;
    const instanceId = randomUUID();
    const log = fs.openSync(logPath, 'a');
    const { entry, cwd, kind } = serverTarget;
    let target;
    try {
      target = spawn(process.execPath, [
        path.join(__dirname, 'server-supervisor.cjs'),
        entry,
        kind, String(port),
      ], {
        cwd, windowsHide: true,
        env: commandEnvironment(instanceId),
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
    if (mode === 'dev' || mode === 'packaged') {
      serverTarget = mode === 'dev'
        ? { kind: 'dev', cwd: root, entry: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next') }
        : { kind: 'standalone', cwd: root, entry: path.join(root, 'server.js') };
      startupTimer = setTimeout(() => beginStop(new Error('Local server startup timed out')), 120000);
      try { spawnServer(); } catch (error) { beginStop(error); }
      return startup;
    }
    preparationTimer = setTimeout(() => { beginStop(new Error(`Local server preparation timed out. See ${logPath}`)); void stop(); }, 600000);
    preparation = resolveServerTarget();
    void preparation.then(target => {
      if (stopping) return;
      clearTimeout(preparationTimer);
      preparationTimer = undefined;
      serverTarget = target;
      startupTimer = setTimeout(() => beginStop(new Error('Local server startup timed out')), 120000);
      spawnServer();
    }).catch(error => beginStop(new Error(`Local server preparation failed. See ${logPath}: ${error.message}`, { cause: error })));
    return startup;
  }

  function beginStop(error = new Error('Local server is stopping')) {
    if (stopping) return;
    stopping = true;
    settleStartup(error);
    clearTimeout(preparationTimer);
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
    const done = (async () => {
      const session = owned;
      if (session) {
        await terminate(session);
        if (session === owned) owned = undefined;
      }
      if (preparation) await preparation.catch(() => {});
      clearHealth();
    })();
    stopInFlight = done;
    try { await done; }
    finally { if (stopInFlight === done) stopInFlight = undefined; }
  }

  return { start, beginStop, stop, checkNow };
}

module.exports = { createLocalServer };
