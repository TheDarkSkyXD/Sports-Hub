import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { CH } = require('../desktop/update.cjs');

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('Install keeps the window open until the local server stops, then starts the installer', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'sunday-install-handoff-'));
  writeFileSync(path.join(userData, 'update.json'), JSON.stringify({
    schema: 1, lastCheckedAt: Date.now(), autoCheckEnabled: false, checkFrequency: 'daily',
  }));

  const events: string[] = [];
  const serverStopped = deferred();
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  let window: FakeWindow | undefined;
  let updater: FakeNsisUpdater | undefined;

  class FakeWindow extends EventEmitter {
    visible = true;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler: () => {},
      send: () => {},
    });

    constructor() {
      super();
      window = this;
    }

    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
    isDestroyed() { return false; }
    isFocused() { return true; }
    isVisible() { return this.visible; }
  }

  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    setName: () => {},
    setAppUserModelId: () => {},
    getPath: () => userData,
    getVersion: () => '1.0.6',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit() {
      let prevented = false;
      app.emit('before-quit', { preventDefault: () => { prevented = true; } });
      if (!prevented) {
        if (window) window.visible = false;
        app.emit('quit', 0);
      }
    },
  });

  class FakeNsisUpdater extends EventEmitter {
    currentVersion = { constructor: String };
    setFeedURL() {}
    checkForUpdates() {
      this.emit('update-available', { version: '1.0.7', releaseDate: '2026-10-01T00:00:00Z' });
      return Promise.resolve();
    }
    downloadUpdate() {
      this.emit('update-downloaded');
      return Promise.resolve();
    }
    quitAndInstall() {
      events.push('installer started');
      setImmediate(() => app.quit());
    }
    constructor() {
      super();
      updater = this;
    }
  }

  const localServer = {
    start: async () => {},
    beginStop: () => { events.push('server stopping'); },
    stop: async () => {
      await serverStopped.promise;
      events.push('server stopped');
    },
  };
  const collector = (name: string) => ({
    start: () => {},
    stop: () => { events.push(`${name} stopped`); },
  });
  const observer = {
    start: async () => 'http://127.0.0.1:4132',
    stop: () => { events.push('observer stopped'); },
  };
  const dependency = (name: string) => {
    if (name === 'electron') return {
      app, BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
      shell: { openExternal: async () => {} }, powerMonitor: new EventEmitter(),
      Notification: { isSupported: () => false },
    };
    if (name === 'electron-updater') return { NsisUpdater: FakeNsisUpdater };
    if (name === './port.cjs') return { localServerPort: async () => 4132 };
    if (name === './local-server.cjs') return { createLocalServer: () => localServer };
    if (name === './sportsurge-collector.cjs') return { createSportsurgeCollector: () => collector('sportsurge') };
    if (name === './sportsurge-observer.cjs') return { createSportsurgeObserver: () => observer };
    if (name === './streameast-collector.cjs') return { createStreameastCollector: () => collector('streameast') };
    if (name === './update.cjs') return require('../desktop/update.cjs');
    return require(name);
  };

  try {
    const source = readFileSync(path.resolve('desktop/main.cjs'), 'utf8');
    const boot = runInNewContext(`(function(require, __dirname, process, fetch, AbortSignal, console) { ${source}\n})`, {
      setImmediate, setInterval, clearInterval, URL,
    });
    assert.equal(typeof boot, 'function');
    boot(
      dependency,
      path.resolve('desktop'),
      { platform: 'win32', resourcesPath: userData, execPath: 'C:\\Programs\\Sunday Room\\Sunday Room.exe', env: {} },
      async () => ({ ok: true }),
      AbortSignal,
      console,
    );

    for (let i = 0; i < 20 && !handlers.has(CH.install); i += 1) await Promise.resolve();
    assert.ok(window, 'the desktop window opened');
    assert.ok(updater, 'the desktop updater started');
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const get = (channel: string) => {
      const handler = handlers.get(channel);
      assert.ok(handler, `${channel} was registered`);
      return handler;
    };

    await get(CH.check)(event);
    await get(CH.download)(event);
    const status = await get(CH.get)(event);
    assert.ok(status && typeof status === 'object' && 'state' in status);
    assert.ok(status.state && typeof status.state === 'object' && 'kind' in status.state);
    assert.equal(status.state.kind, 'ready');

    const install = get(CH.install)(event);
    await Promise.resolve();
    assert.equal(window.isVisible(), true, 'the updating window stays visible during shutdown');
    assert.equal(events.includes('installer started'), false, 'the installer waits for shutdown');
    assert.ok(events.includes('server stopping'), 'the local server began shutting down');

    serverStopped.resolve();
    await install;
    assert.ok(events.indexOf('installer started') > events.indexOf('server stopped'));
    assert.ok(events.indexOf('installer started') > events.indexOf('sportsurge stopped'));
    assert.ok(events.indexOf('installer started') > events.indexOf('streameast stopped'));
    assert.ok(events.indexOf('installer started') > events.indexOf('observer stopped'));
  } finally {
    serverStopped.resolve();
    rmSync(userData, { recursive: true, force: true });
  }
});
