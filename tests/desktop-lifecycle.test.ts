import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { DesktopNsisUpdater } = require('../desktop/nsis-updater.cjs');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function desktop(options: { stopFailures?: readonly string[]; observerStopGate?: Promise<void>;
  downloadedUpdate?: boolean } = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), 'sunday-desktop-lifecycle-'));
  const windows: FakeWindow[] = [];
  const running = new Set(['server', 'sportsurge', 'observer', 'streameast']);
  const stopAttempts: string[] = [];
  let installPreparation: (() => Promise<void>) | undefined;
  const updaters: FakeUpdater[] = [];
  let exited = false;
  let exitCode: number | undefined;

  class FakeWindow extends EventEmitter {
    visible = false;
    destroyed = false;
    minimized = false;
    focused = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler() {},
      send() {},
      executeJavaScript: async () => {},
    });
    constructor() { super(); windows.push(this); }
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
    setAppDetails() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    restore() { this.minimized = false; }
    isMinimized() { return this.minimized; }
    isDestroyed() { return this.destroyed; }
    isFocused() { return this.focused; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault() { prevented = true; } });
      if (prevented) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setName() {},
    setAppUserModelId() {},
    getPath: () => userData,
    getVersion: () => '1.0.10',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    onQuit(handler: (code: number) => void) { app.on('quit', handler); },
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (prevented) return;
      exited = true;
      exitCode = 0;
      app.emit('quit', 0);
      app.emit('will-quit');
    },
    exit(code = 0) { exited = true; exitCode = code; app.emit('quit', code); },
  });
  const service = (name: string) => ({
    start: async () => 'http://127.0.0.1:4132',
    beginStop() { stopAttempts.push('admission'); },
    requestSweep() {},
    async stop() {
      stopAttempts.push(name);
      if (name === 'observer') await options.observerStopGate;
      if (options.stopFailures?.includes(name)) throw new Error(`${name} cleanup failed`);
      running.delete(name);
    },
  });
  class FakeUpdater {
    app = app;
    autoInstallOnAppQuit = false;
    quitHandlerAdded = false;
    quitAndInstallCalled = false;
    installAttempts = 0;
    _logger = { error() {} };
    constructor() { updaters.push(this); }
    setFeedURL() {}
    async install() { this.installAttempts++; return true; }
    addQuitHandler() { DesktopNsisUpdater.prototype.addQuitHandler.call(this); }
  }
  const dependency = (name: string) => {
    if (name === 'electron') return {
      app, autoUpdater: new EventEmitter(), BrowserWindow: FakeWindow,
      ipcMain: { handle() {} }, shell: { openExternal: async () => {} },
      powerMonitor: new EventEmitter(), Notification: { isSupported: () => false },
    };
    if (name === './port.cjs') return { localServerPort: async () => 4132 };
    if (name === './local-server.cjs') return { createLocalServer: () => service('server') };
    if (name === './sportsurge-collector.cjs') return { createSportsurgeCollector: () => service('sportsurge') };
    if (name === './sportsurge-observer.cjs') return { createSportsurgeObserver: () => service('observer') };
    if (name === './streameast-collector.cjs') return { createStreameastCollector: () => service('streameast') };
    if (name === './nsis-updater.cjs') return { DesktopNsisUpdater: FakeUpdater };
    if (name === './update.cjs') return {
      CH: { get: 'get', check: 'check', download: 'download', install: 'install', setSource: 'source', setPreferences: 'preferences' },
      selectUpdateFeedUrl: () => 'https://updates.example.invalid/',
      createUpdateService: ({ prepareInstall }: { prepareInstall: () => Promise<void> }) => {
        installPreparation = prepareInstall;
        return { start() { if (options.downloadedUpdate) updaters.at(-1)?.addQuitHandler(); }, stop() {},
          invoke: () => () => {}, snapshot: () => ({ state: { kind: 'idle' } }) };
      },
    };
    return require(name);
  };
  const source = readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
  const boot = runInNewContext(`(function(require, __dirname, process, fetch, AbortSignal, console) { ${source}\n})`, {
    setImmediate, setTimeout, clearTimeout, setInterval, clearInterval, URL,
  });
  boot(dependency, path.resolve('desktop'), {
    platform: 'win32', resourcesPath: userData,
    execPath: 'C:\\Programs\\Sunday Room\\Sunday Room.exe', env: {},
  }, async () => ({ ok: true }), AbortSignal, console);
  await settle();
  const window = windows[0];
  assert.ok(window, 'the production entry point opened a desktop window');
  assert.equal(window.visible, true);
  return {
    app, window, running, stopAttempts, hasExited: () => exited, exitCode: () => exitCode,
    installAttempts: () => updaters.at(-1)?.installAttempts,
    shutdownLog: () => readFileSync(path.join(userData, 'logs', 'startup.log'), 'utf8'),
    prepareInstall: () => { assert.ok(installPreparation); return installPreparation(); },
    dispose: () => rmSync(userData, { recursive: true, force: true }),
  };
}

test('launching a second instance makes the existing hidden window visible', async () => {
  const room = await desktop();
  try {
    room.window.hide();
    room.app.emit('second-instance');
    assert.equal(room.window.visible, true, 'relaunch must show the existing desktop window');
    assert.equal(room.window.focused, true);
  } finally { room.dispose(); }
});

test('closing the desktop stops its services and exits', async () => {
  const room = await desktop();
  try {
    room.window.close();
    await settle();
    assert.equal(room.hasExited(), true);
    assert.equal(room.running.size, 0);
  } finally { room.dispose(); }
});

test('closing the desktop still stops the server and exits when observer cleanup fails', async () => {
  const room = await desktop({ stopFailures: ['observer'] });
  try {
    room.window.close();
    await settle();
    assert.equal(room.running.has('server'), false, 'observer failure must not leave the local server running');
    assert.equal(room.running.has('streameast'), false, 'observer failure must not skip the remaining collector');
    assert.equal(room.hasExited(), true, 'a failed cleanup must not retain a headless single-instance owner');
  } finally { room.dispose(); }
});

test('shutdown attempts every service and logs each failure before exiting', async () => {
  const room = await desktop({ stopFailures: ['sportsurge', 'observer', 'streameast'] });
  try {
    room.window.close();
    await settle();
    assert.deepEqual(room.stopAttempts, ['admission', 'sportsurge', 'observer', 'streameast', 'server']);
    assert.equal(room.running.has('server'), false);
    assert.equal(room.hasExited(), true);
    const log = room.shutdownLog();
    for (const name of ['sportsurge', 'observer', 'streameast'])
      assert.match(log, new RegExp(`${name} cleanup failed`));
  } finally { room.dispose(); }
});

test('repeated quit events share one cleanup while the observer is stopping', async () => {
  let releaseObserver = () => {};
  const observerStopGate = new Promise<void>(resolve => { releaseObserver = resolve; });
  const room = await desktop({ observerStopGate });
  try {
    room.window.close();
    await settle();
    assert.deepEqual(room.stopAttempts, ['admission', 'sportsurge', 'observer']);
    room.app.quit();
    room.app.emit('window-all-closed');
    assert.equal(room.hasExited(), false);
    assert.deepEqual(room.stopAttempts, ['admission', 'sportsurge', 'observer']);
    releaseObserver();
    await settle();
    assert.deepEqual(room.stopAttempts, ['admission', 'sportsurge', 'observer', 'streameast', 'server']);
    assert.equal(room.hasExited(), true);
  } finally { releaseObserver(); room.dispose(); }
});

test('explicit install preparation rejects cleanup failure and keeps the window open', async () => {
  const room = await desktop({ stopFailures: ['observer'] });
  try {
    await assert.rejects(room.prepareInstall(), /observer cleanup failed/);
    assert.deepEqual(room.stopAttempts, ['admission', 'sportsurge', 'observer', 'streameast', 'server']);
    assert.equal(room.running.has('server'), false);
    assert.equal(room.window.visible, true);
    assert.equal(room.hasExited(), false);
  } finally { room.dispose(); }
});

test('normal close permits an already downloaded update after cleanup succeeds', async () => {
  const room = await desktop({ downloadedUpdate: true });
  try {
    room.window.close();
    await settle();
    assert.equal(room.running.size, 0);
    assert.equal(room.hasExited(), true);
    assert.equal(room.exitCode(), 0);
    assert.equal(room.installAttempts(), 1);
  } finally { room.dispose(); }
});

test('failed cleanup exits with code 1 and does not install a downloaded update', async () => {
  const room = await desktop({ downloadedUpdate: true, stopFailures: ['observer'] });
  try {
    room.window.close();
    await settle();
    assert.equal(room.running.has('server'), false);
    assert.equal(room.hasExited(), true);
    assert.equal(room.exitCode(), 1);
    assert.equal(room.installAttempts(), 0);
  } finally { room.dispose(); }
});

test('permanent local server startup failure shows an error and exits after cleanup', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'sunday-desktop-startup-'));
  const events: string[] = [];
  let exited = false;
  let windows = 0;
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setName() {},
    setAppUserModelId() {},
    getPath: () => userData,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (!prevented) { exited = true; events.push('exit'); }
    },
    exit() { exited = true; events.push('exit'); },
  });
  class Window {
    constructor() { windows++; }
  }
  const observer = {
    start: async () => 'http://127.0.0.1:49301',
    stop() { events.push('observer stopped'); },
  };
  const server = {
    start: async () => { throw new Error('server launch failed'); },
    beginStop() { events.push('server admission stopped'); },
    async stop() { events.push('server stopped'); },
  };
  const dependency = (name: string) => {
    if (name === 'electron') return {
      app, autoUpdater: new EventEmitter(), BrowserWindow: Window,
      dialog: { showErrorBox(title: string, message: string) { events.push(`dialog: ${title}: ${message}`); } },
      ipcMain: { handle() {} }, shell: { openExternal: async () => {} },
      powerMonitor: new EventEmitter(), Notification: { isSupported: () => false },
    };
    if (name === './port.cjs') return { localServerPort: async () => 49300 };
    if (name === './local-server.cjs') return { createLocalServer: () => server };
    if (name === './sportsurge-observer.cjs') return { createSportsurgeObserver: () => observer };
    if (name === './sportsurge-collector.cjs') return { createSportsurgeCollector: () => { throw new Error('collector started before server'); } };
    if (name === './streameast-collector.cjs') return { createStreameastCollector: () => { throw new Error('collector started before server'); } };
    if (name === './nsis-updater.cjs') return { DesktopNsisUpdater: class {} };
    if (name === './update.cjs') return { CH: {}, createUpdateService() {}, selectUpdateFeedUrl() {} };
    return require(name);
  };
  const source = readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
  const boot = runInNewContext(`(function(require, __dirname, process, fetch, AbortSignal, console) { ${source}\n})`, {
    setImmediate, setTimeout, clearTimeout, setInterval, clearInterval, URL,
  });
  try {
    boot(dependency, path.resolve('desktop'), {
      platform: 'win32', resourcesPath: userData, execPath: 'Sunday Room.exe', env: {},
    }, async () => ({ ok: true }), AbortSignal, console);
    for (let attempt = 0; attempt < 20 && !exited; attempt++) await settle();
    assert.equal(exited, true, 'startup failure releases the single-instance owner');
    assert.equal(windows, 0, 'a broken server never loads the room');
    assert.deepEqual(events.filter(event => !event.startsWith('dialog: ')), [
      'server admission stopped', 'observer stopped', 'server stopped', 'exit',
    ]);
    assert.equal(events.filter(event => event.startsWith('dialog: ')).length, 1);
    assert.match(events.find(event => event.startsWith('dialog: ')) ?? '', /Sunday Room could not start.*server launch failed/i);
  } finally { rmSync(userData, { recursive: true, force: true }); }
});
