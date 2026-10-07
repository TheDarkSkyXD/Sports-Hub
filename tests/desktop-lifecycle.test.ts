import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

async function desktop(options: { observerStopFails?: boolean } = {}) {
  const userData = mkdtempSync(path.join(tmpdir(), 'sunday-desktop-lifecycle-'));
  const windows: FakeWindow[] = [];
  const running = new Set(['server', 'sportsurge', 'observer', 'streameast']);
  let exited = false;

  class FakeWindow extends EventEmitter {
    visible = false;
    destroyed = false;
    minimized = false;
    focused = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler() {},
      send() {},
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
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault() { prevented = true; } });
      if (prevented) return;
      exited = true;
      app.emit('will-quit');
    },
    exit() { exited = true; },
  });
  const service = (name: string) => ({
    start: async () => 'http://127.0.0.1:4132',
    beginStop() {},
    requestSweep() {},
    async stop() {
      if (name === 'observer' && options.observerStopFails) throw new Error('observer cleanup failed');
      running.delete(name);
    },
  });
  class FakeUpdater { setFeedURL() {} }
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
      createUpdateService: () => ({ start() {}, stop() {}, invoke: () => () => {}, snapshot: () => ({ state: { kind: 'idle' } }) }),
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
    app, window, running, hasExited: () => exited,
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
  const room = await desktop({ observerStopFails: true });
  try {
    room.window.close();
    await settle();
    assert.equal(room.running.has('server'), false, 'observer failure must not leave the local server running');
    assert.equal(room.running.has('streameast'), false, 'observer failure must not skip the remaining collector');
    assert.equal(room.hasExited(), true, 'a failed cleanup must not retain a headless single-instance owner');
  } finally { room.dispose(); }
});
