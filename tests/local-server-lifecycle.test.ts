import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { HEAD } from '../app/api/internal/ready/route.ts';
import { stageNativeArtifact } from './native-artifact-fixture.ts';

const require = createRequire(import.meta.url);
const { sourceIdentity } = require('../desktop/source-identity.cjs');
const { buildDirectory, completeArtifact } = require('../desktop/compiled-artifact.cjs');
const root = path.resolve('.');
const source = readFileSync(path.join(root, 'desktop/local-server.cjs'), 'utf8');
const fastTimeout: typeof setTimeout = (callback, _delay, ...args) => setTimeout(callback, 10, ...args);
const compiledPreparationWatchdogMs = 15_000;
function nativeRoot(prefix: string) {
  const serverRoot = mkdtempSync(path.join(tmpdir(), prefix));
  stageNativeArtifact(serverRoot);
  return serverRoot;
}

class Child extends EventEmitter {
  pid = 830001;
  exitCode: number | null = null;
  connected = true;
  disconnect() { this.connected = false; }
  kill() { this.exit(0); return true; }
  exit(code: number) { this.exitCode = code; this.emit('exit', code, null); }
}

type TimerPolicy = {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

function localServer(options: {
  spawn: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => EventEmitter;
  fetch?: typeof fetch;
  origin?: string;
  port?: number;
  onReady?: () => void;
  timers?: TimerPolicy;
  serverRoot?: string;
  mode?: 'compiled' | 'dev' | 'packaged';
  env?: NodeJS.ProcessEnv;
}) {
  const logDir = mkdtempSync(path.join(tmpdir(), 'sunday-local-server-test-'));
  const wrapper = runInNewContext(`(function(require, __dirname, process, fetch, AbortSignal) { const module = { exports: {} }; ${source}\nreturn module.exports.createLocalServer; })`, {
    setTimeout: options.timers?.setTimeout ?? setTimeout,
    clearTimeout: options.timers?.clearTimeout ?? clearTimeout,
    setInterval, clearInterval,
  });
  const createLocalServer = wrapper((name: string) => name === 'node:child_process' ? { spawn: options.spawn } :
    name.startsWith('./') ? require(path.join(root, 'desktop', name)) : require(name),
    path.join(root, 'desktop'), {
      platform: 'win32', execPath: 'node.exe', env: options.env ?? {},
    }, options.fetch ?? (() => new Promise(() => {})), AbortSignal);
  const service = createLocalServer({
    root: options.serverRoot ?? root, origin: options.origin ?? 'http://127.0.0.1:49300', port: options.port ?? 49300,
    userData: logDir, controlToken: 'test-control-token', logDir,
    mode: options.mode ?? 'dev',
    ensureCollector: async () => {},
    onReady: options.onReady ?? (() => {}),
  });
  return { service, dispose: () => rmSync(logDir, { recursive: true, force: true }) };
}

for (const scenario of [
  { name: 'development startup passes the absolute staged collector directory', mode: 'dev', env: {},
    expected: path.join(root, '.desktop-runtime', 'rust-collector-addon') },
  { name: 'development startup preserves an explicit collector directory', mode: 'dev',
    env: { SUNDAY_ROOM_COLLECTOR_DIR: path.join(tmpdir(), 'custom-collector') },
    expected: path.join(tmpdir(), 'custom-collector') },
  { name: 'packaged startup leaves collector discovery to its server bootstrap', mode: 'packaged', env: {},
    expected: undefined },
] satisfies { name: string; mode: 'dev' | 'packaged'; env: NodeJS.ProcessEnv; expected: string | undefined }[]) {
  test(scenario.name, async () => {
    const child = new Child();
    let instanceId = '';
    let collectorDirectory: string | undefined;
    const room = localServer({
      mode: scenario.mode, env: scenario.env,
      fetch: async () => new Response(null, { status: 204, headers: { 'x-sunday-server-instance-id': instanceId } }),
      spawn(command, _args, options) {
        if (command === 'taskkill.exe') {
          const killer = new EventEmitter();
          setImmediate(() => { killer.emit('exit', 0); child.exit(0); });
          return killer;
        }
        collectorDirectory = options.env.SUNDAY_ROOM_COLLECTOR_DIR;
        instanceId = options.env.SUNDAY_ROOM_SERVER_INSTANCE_ID ?? '';
        return child;
      },
    });
    try {
      await room.service.start();
      assert.equal(collectorDirectory, scenario.expected);
    } finally {
      await within(room.service.stop(), 1000);
      room.dispose();
    }
  });
}

test('ordinary unpackaged desktop prepares compiled output instead of launching development',
  { timeout: compiledPreparationWatchdogMs }, async () => {
  const serverRoot = nativeRoot('sunday-local-source-test-');
  mkdirSync(path.join(serverRoot, '.next'));
  mkdirSync(path.join(serverRoot, 'node_modules'));
  writeFileSync(path.join(serverRoot, '.next', 'BUILD_ID'), 'stale-build');
  const child = new Child();
  let launch: string[] | undefined;
  let didLaunch = () => {};
  const launched = new Promise<void>(resolve => { didLaunch = resolve; });
  const room = localServer({
    serverRoot, mode: 'compiled',
    spawn(command, args) {
      if (command !== 'taskkill.exe') { launch = Array.from(args); didLaunch(); }
      return child;
    },
  });
  try {
    const ready = room.service.start();
    const rejected = assert.rejects(ready, /stop/i);
    try {
      await launched;
      assert.equal(launch?.[2], 'build');
    } finally {
      room.service.beginStop();
      await rejected;
    }
  } finally {
    room.service.beginStop();
    room.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
  }
});

test('a failed compiled build fails startup without serving an older build',
  { timeout: compiledPreparationWatchdogMs }, async () => {
  const serverRoot = nativeRoot('sunday-local-failed-build-');
  mkdirSync(path.join(serverRoot, 'node_modules'));
  const child = new Child();
  const modes: string[] = [];
  const room = localServer({
    serverRoot, mode: 'compiled',
    spawn(command, args) {
      if (command === 'taskkill.exe') {
        const killer = new EventEmitter();
        setImmediate(() => { killer.emit('exit', 0); child.exit(0); });
        return killer;
      }
      modes.push(args[2]);
      setImmediate(() => child.emit('message', { kind: 'complete', code: 1 }));
      return child;
    },
  });
  try {
    await assert.rejects(room.service.start(), /build failed with code 1/);
    assert.deepEqual(modes, ['build']);
    await within(room.service.stop());
  } finally {
    room.service.beginStop(); room.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
  }
});

test('stopping during a compiled build terminates its owned tree before serving',
  { timeout: compiledPreparationWatchdogMs }, async () => {
  const serverRoot = nativeRoot('sunday-local-cancel-build-');
  mkdirSync(path.join(serverRoot, 'node_modules'));
  const child = new Child();
  let launched = () => {};
  const buildStarted = new Promise<void>(resolve => { launched = resolve; });
  const modes: string[] = [];
  let treeKills = 0;
  const room = localServer({
    serverRoot, mode: 'compiled',
    spawn(command, args) {
      if (command === 'taskkill.exe') {
        treeKills++;
        const killer = new EventEmitter();
        setImmediate(() => { killer.emit('exit', 0); child.exit(0); });
        return killer;
      }
      modes.push(args[2]);
      launched();
      return child;
    },
  });
  try {
    const ready = room.service.start();
    const rejected = assert.rejects(ready, /stop/i);
    await buildStarted;
    room.service.beginStop();
    await within(room.service.stop(), 1000);
    await rejected;
    assert.deepEqual(modes, ['build']);
    assert.equal(treeKills, 1);
    assert.equal(child.exitCode, 0);
  } finally {
    room.service.beginStop(); room.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
  }
});

test('compiled startup reuses complete output and rebuilds after a source edit',
  { timeout: compiledPreparationWatchdogMs }, async () => {
  const serverRoot = nativeRoot('sunday-local-reuse-');
  mkdirSync(path.join(serverRoot, 'node_modules'));
  mkdirSync(path.join(serverRoot, 'app'));
  writeFileSync(path.join(serverRoot, 'app', 'page.tsx'), 'before');
  const sourceId = await sourceIdentity(serverRoot);
  const distDir = buildDirectory('abcd');
  const standalone = path.join(serverRoot, distDir, 'standalone');
  for (const [name, contents] of [
    [path.join(serverRoot, distDir, 'BUILD_ID'), sourceId],
    [path.join(standalone, distDir, 'BUILD_ID'), sourceId],
    [path.join(standalone, distDir, 'static', 'app.js'), 'asset'],
    [path.join(standalone, 'public', 'favicon.svg'), 'icon'],
    [path.join(standalone, 'server.cjs'), 'server'],
  ]) {
    mkdirSync(path.dirname(name), { recursive: true });
    writeFileSync(name, contents);
  }
  await completeArtifact(serverRoot, distDir, sourceId);
  const child = new Child();
  let instanceId = '';
  const modes: string[] = [];
  const room = localServer({
    serverRoot, mode: 'compiled',
    fetch: async () => new Response(null, { status: 204, headers: { 'x-sunday-server-instance-id': instanceId } }),
    spawn(command, args, options) {
      if (command === 'taskkill.exe') {
        const killer = new EventEmitter();
        setImmediate(() => { killer.emit('exit', 0); child.exit(0); });
        return killer;
      }
      modes.push(args[2]);
      instanceId = options.env.SUNDAY_ROOM_SERVER_INSTANCE_ID ?? '';
      assert.equal(options.cwd, standalone);
      assert.equal(args[1], path.join(standalone, 'server.cjs'));
      return child;
    },
  });
  try {
    await room.service.start();
    assert.deepEqual(modes, ['standalone']);
    await within(room.service.stop(), 1000);
  } finally { room.service.beginStop(); room.dispose(); }

  writeFileSync(path.join(serverRoot, 'app', 'page.tsx'), 'after');
  let rebuilt = () => {};
  const buildStarted = new Promise<void>(resolve => { rebuilt = resolve; });
  const nextChild = new Child();
  const nextRoom = localServer({
    serverRoot, mode: 'compiled',
    spawn(command, args) {
      if (command !== 'taskkill.exe') { modes.push(args[2]); rebuilt(); }
      return nextChild;
    },
  });
  try {
    const ready = nextRoom.service.start();
    const rejected = assert.rejects(ready, /stop/i);
    await buildStarted;
    assert.deepEqual(modes, ['standalone', 'build']);
    nextRoom.service.beginStop();
    await rejected;
  } finally {
    nextRoom.service.beginStop(); nextRoom.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
  }
});

test('source changes during preparation prevent a compiled server from starting', { timeout: 10_000 }, async () => {
  const serverRoot = nativeRoot('sunday-local-source-change-');
  mkdirSync(path.join(serverRoot, 'node_modules'));
  mkdirSync(path.join(serverRoot, 'app'));
  writeFileSync(path.join(serverRoot, 'app', 'page.tsx'), 'before');
  const modes: string[] = [];
  let reportMutation = () => {};
  const mutated = new Promise<void>(resolve => { reportMutation = resolve; });
  let currentChild: Child;
  const room = localServer({
    serverRoot, mode: 'compiled',
    spawn(command, args, options) {
      if (command === 'taskkill.exe') {
        const killer = new EventEmitter();
        setImmediate(() => { killer.emit('exit', 0); currentChild.exit(0); });
        return killer;
      }
      modes.push(args[2]);
      const child = new Child();
      currentChild = child;
      if (args[2] === 'build') {
        setImmediate(async () => {
          const distDir = options.env.SUNDAY_ROOM_NEXT_DIST_DIR ?? '';
          const sourceId = await sourceIdentity(serverRoot, options.env.SUNDAY_ROOM_BUILD_PUBLIC_ENV);
          for (const name of [path.join(serverRoot, distDir, 'BUILD_ID'),
            path.join(serverRoot, distDir, 'standalone', distDir, 'BUILD_ID')]) {
            mkdirSync(path.dirname(name), { recursive: true });
            writeFileSync(name, sourceId);
          }
          child.emit('message', { kind: 'complete', code: 0 });
        });
      } else if (args[2] === 'prepare') {
        setImmediate(() => {
          writeFileSync(path.join(serverRoot, 'app', 'page.tsx'), 'after');
          reportMutation();
          child.emit('message', { kind: 'complete', code: 0 });
        });
      }
      return child;
    },
  });
  try {
    await Promise.all([mutated, assert.rejects(room.service.start(), /Source changed while preparing/)]);
    assert.deepEqual(modes, ['build', 'prepare']);
    await within(room.service.stop());
  } finally {
    room.service.beginStop(); room.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
  }
});

async function within<T>(promise: Promise<T>, milliseconds = 150): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle')), milliseconds);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

test('failed Windows tree kill keeps the owned supervisor for a later stop', async () => {
  const child = new Child();
  let killCalls = 0;
  const room = localServer({ spawn(command) {
    if (command !== 'taskkill.exe') return child;
    killCalls++;
    const killer = new EventEmitter();
    setImmediate(() => {
      if (killCalls === 1) killer.emit('exit', 1);
      else { killer.emit('exit', 0); setImmediate(() => child.exit(0)); }
    });
    return killer;
  } });
  void room.service.start().catch(() => {});
  try {
    await assert.rejects(within(room.service.stop()), /kill|terminat|exit|stop/i);
    assert.equal(child.exitCode, null, 'a failed kill left the owned supervisor alive');
    await within(room.service.stop());
    assert.equal(killCalls, 2, 'a later stop retried the same owned supervisor');
    assert.equal(child.exitCode, 0);
  } finally { room.service.beginStop(); room.dispose(); }
});

test('a later stop never targets the PID of a supervisor that exited after failed tree kill', async () => {
  const child = new Child();
  let killCalls = 0;
  const room = localServer({ spawn(command) {
    if (command !== 'taskkill.exe') return child;
    killCalls++;
    const killer = new EventEmitter();
    setImmediate(() => killer.emit('exit', 1));
    return killer;
  } });
  void room.service.start().catch(() => {});
  try {
    await assert.rejects(within(room.service.stop()), /kill|terminat|exit|stop/i);
    child.exit(0);
    await assert.rejects(within(room.service.stop()), /without tree kill evidence/i);
    assert.equal(killCalls, 1, 'the exited supervisor PID is never used again');
  } finally { room.service.beginStop(); room.dispose(); }
});

test('a successful tree command and later owned exit complete cleanup without another PID kill', async () => {
  const child = new Child();
  let killCalls = 0;
  const room = localServer({
    timers: { setTimeout: fastTimeout },
    spawn(command) {
      if (command !== 'taskkill.exe') return child;
      killCalls++;
      const killer = new EventEmitter();
      setImmediate(() => killer.emit('exit', 0));
      return killer;
    },
  });
  void room.service.start().catch(() => {});
  try {
    await assert.rejects(within(room.service.stop()), /timed out|timeout/i);
    child.exit(0);
    await within(room.service.stop());
    assert.equal(killCalls, 1);
  } finally { room.service.beginStop(); room.dispose(); }
});

test('a hung Windows tree kill rejects within its deadline and retains ownership', async () => {
  const child = new Child();
  let killCalls = 0;
  let lastKiller: EventEmitter | undefined;
  const room = localServer({
    timers: { setTimeout: fastTimeout },
    spawn(command) {
      if (command !== 'taskkill.exe') return child;
      killCalls++;
      lastKiller = new EventEmitter();
      return lastKiller;
    },
  });
  void room.service.start().catch(() => {});
  try {
    await assert.rejects(within(room.service.stop()), /kill|terminat|timeout|stop/i);
    assert.equal(child.exitCode, null);
    await assert.rejects(within(room.service.stop()), /kill|terminat|timeout|stop/i);
    assert.equal(killCalls, 2, 'the owned supervisor remained available for retry');
    assert.ok(lastKiller);
    assert.doesNotThrow(() => lastKiller.emit('error', new Error('late helper error')));
  } finally { room.service.beginStop(); room.dispose(); }
});

test('failed health replacement retries the same live supervisor before spawning a successor', async () => {
  const first = new Child();
  const second = new Child();
  second.pid = 830002;
  let supervisorSpawns = 0;
  let instanceId = '';
  let healthy = true;
  let activeKills = 0;
  let maxActiveKills = 0;
  const killedPids: string[] = [];
  let replacementStarted = () => {};
  const replacement = new Promise<void>(resolve => { replacementStarted = resolve; });
  const room = localServer({
    timers: { setTimeout: fastTimeout },
    fetch: async () => healthy || supervisorSpawns > 1
      ? new Response(null, { status: 204, headers: { 'x-sunday-server-instance-id': instanceId } })
      : new Response(null, { status: 503 }),
    spawn(command, args, options) {
      if (command === 'taskkill.exe') {
        killedPids.push(args[1]);
        activeKills++;
        maxActiveKills = Math.max(maxActiveKills, activeKills);
        const attempt = killedPids.length;
        const killer = new EventEmitter();
        setImmediate(() => {
          activeKills--;
          killer.emit('exit', attempt === 1 ? 1 : 0);
          if (attempt === 2) setImmediate(() => first.exit(0));
        });
        return killer;
      }
      supervisorSpawns++;
      instanceId = options.env.SUNDAY_ROOM_SERVER_INSTANCE_ID ?? '';
      if (supervisorSpawns === 2) replacementStarted();
      return supervisorSpawns === 1 ? first : second;
    },
  });
  try {
    await within(room.service.start());
    healthy = false;
    await room.service.checkNow();
    await room.service.checkNow();
    await room.service.checkNow();
    assert.equal(killedPids.length, 1);
    assert.equal(first.exitCode, null, 'the failed kill left the first supervisor live');
    await within(replacement, 200);
    assert.deepEqual(killedPids, [String(first.pid), String(first.pid)]);
    assert.equal(maxActiveKills, 1, 'tree termination attempts do not overlap');
    assert.equal(supervisorSpawns, 2, 'one verified cleanup starts one replacement');
  } finally { room.service.beginStop(); room.dispose(); }
});

test('late owned exit after successful tree command starts one replacement', async () => {
  const first = new Child();
  const second = new Child();
  second.pid = 830002;
  let supervisorSpawns = 0;
  let instanceId = '';
  let healthy = true;
  let killCalls = 0;
  let replacementStarted = () => {};
  const replacement = new Promise<void>(resolve => { replacementStarted = resolve; });
  const room = localServer({
    timers: { setTimeout: fastTimeout },
    fetch: async () => healthy || supervisorSpawns > 1
      ? new Response(null, { status: 204, headers: { 'x-sunday-server-instance-id': instanceId } })
      : new Response(null, { status: 503 }),
    spawn(command, _args, options) {
      if (command === 'taskkill.exe') {
        killCalls++;
        const killer = new EventEmitter();
        setImmediate(() => killer.emit('exit', 0));
        return killer;
      }
      supervisorSpawns++;
      instanceId = options.env.SUNDAY_ROOM_SERVER_INSTANCE_ID ?? '';
      if (supervisorSpawns === 2) replacementStarted();
      return supervisorSpawns === 1 ? first : second;
    },
  });
  try {
    await within(room.service.start());
    healthy = false;
    await room.service.checkNow();
    await room.service.checkNow();
    await room.service.checkNow();
    assert.equal(killCalls, 1);
    assert.equal(first.exitCode, null, 'the tree command completed before the owned exit');
    first.exit(0);
    await within(replacement, 200);
    assert.equal(killCalls, 1, 'the exited supervisor PID is not killed again');
    assert.equal(supervisorSpawns, 2);
  } finally { room.service.beginStop(); room.dispose(); }
});

test('startup rejects after its absolute deadline when readiness never settles', async () => {
  const child = new Child();
  const room = localServer({
    timers: { setTimeout: fastTimeout },
    spawn: () => child,
  });
  try {
    await assert.rejects(within(room.service.start()), /start|ready|timeout/i);
  } finally { room.service.beginStop(); room.dispose(); }
});

test('stopping during startup settles the pending start promise', async () => {
  const child = new Child();
  const room = localServer({ spawn: () => child });
  try {
    const ready = room.service.start();
    room.service.beginStop();
    await assert.rejects(within(ready), /stop|cancel/i);
  } finally { room.service.beginStop(); room.dispose(); }
});

for (const scenario of ['foreign 200', 'old instance', 'owned instance'] as const) {
  test(`${scenario} readiness uses the owned server identity`, async () => {
    let spawnedEnvironment: NodeJS.ProcessEnv | undefined;
    let readyCalls = 0;
    const requests: { method: string | undefined; url: string | undefined; token: string | undefined }[] = [];
    const foreign = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url,
        token: request.headers['x-sunday-control-token']?.toString() });
      if (scenario === 'foreign 200') response.writeHead(200);
      else response.writeHead(204, {
        'x-sunday-server-instance-id': scenario === 'old instance' ? 'old-instance' : spawnedEnvironment?.SUNDAY_ROOM_SERVER_INSTANCE_ID ?? '',
      });
      response.end();
    });
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const port = foreign.address();
    assert.ok(port && typeof port !== 'string');
    const child = new Child();
    const room = localServer({
      origin: `http://127.0.0.1:${port.port}`, port: port.port, fetch,
      onReady() { readyCalls++; },
      spawn(_command, _args, options) {
        spawnedEnvironment = options.env;
        return child;
      },
    });
    try {
      const ready = room.service.start();
      if (scenario === 'owned instance') {
        await within(ready);
        assert.equal(readyCalls, 1);
        assert.ok(spawnedEnvironment?.SUNDAY_ROOM_SERVER_INSTANCE_ID);
      } else {
        const outcome = await Promise.race([
          ready.then(() => 'ready', () => 'rejected'),
          new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 60)),
        ]);
        assert.equal(outcome, 'pending');
        assert.equal(readyCalls, 0);
      }
      assert.ok(requests.length > 0);
      assert.equal(requests[0].method, 'HEAD');
      assert.equal(requests[0].url, '/api/internal/ready');
      assert.equal(requests[0].token, 'test-control-token');
    } finally {
      room.service.beginStop();
      await new Promise<void>(resolve => foreign.close(() => resolve()));
      room.dispose();
    }
  });
}

test('the readiness route returns its instance only to the desktop control token', () => {
  const previousToken = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  const previousInstance = process.env.SUNDAY_ROOM_SERVER_INSTANCE_ID;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN = 'test-control-token';
  process.env.SUNDAY_ROOM_SERVER_INSTANCE_ID = 'owned-instance';
  try {
    const wrong = HEAD(new Request('http://127.0.0.1/api/internal/ready', {
      method: 'HEAD', headers: { 'x-sunday-control-token': 'wrong-token' },
    }));
    assert.equal(wrong.status, 404);
    assert.equal(wrong.headers.get('x-sunday-server-instance-id'), null);

    const owned = HEAD(new Request('http://127.0.0.1/api/internal/ready', {
      method: 'HEAD', headers: { 'x-sunday-control-token': 'test-control-token' },
    }));
    assert.equal(owned.status, 204);
    assert.equal(owned.headers.get('x-sunday-server-instance-id'), 'owned-instance');
    assert.equal(owned.headers.get('cache-control'), 'no-store');
  } finally {
    if (previousToken === undefined) delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN = previousToken;
    if (previousInstance === undefined) delete process.env.SUNDAY_ROOM_SERVER_INSTANCE_ID;
    else process.env.SUNDAY_ROOM_SERVER_INSTANCE_ID = previousInstance;
  }
});
