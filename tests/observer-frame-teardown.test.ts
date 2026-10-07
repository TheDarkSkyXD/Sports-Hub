import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import test from 'node:test';

const observerFile = new URL('../desktop/sportsurge-observer.cjs', import.meta.url);
const observerRequire = createRequire(observerFile);

test('the observer keeps scanning live frames while Electron tears down an iframe', async () => {
  let tick: (() => void) | undefined;
  let playerChecks = 0;
  const player = {
    url: 'https://ch.aianimalvibes.com/football/728',
    isDestroyed: () => false,
    executeJavaScript: () => { playerChecks++; return Promise.resolve(false); },
  };
  const mainFrame = { framesInSubtree: [null, player] };
  class FakeWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      mainFrame,
      setAudioMuted() {},
      setWindowOpenHandler() {},
    });
    loadURL() { return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const sourceSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    on() {},
    webRequest: {
      onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {},
    },
  };
  const source = readFileSync(observerFile, 'utf8');
  const loadSlot = runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout,setInterval,clearInterval){
    ${source}
    return createObserverSlot;
  })`);
  const createSlot = loadSlot(
    (id: string) => id === 'electron'
      ? { BrowserWindow: FakeWindow, session: { fromPartition: () => sourceSession }, webFrameMain: {} }
      : observerRequire(id),
    { exports: {} }, {},
    () => 0, () => {}, (callback: () => void) => { tick = callback; return 0; }, () => {},
  );
  const observer = createSlot(0);
  const operation = observer.observe('https://example.com/event', 'probe');
  assert.ok(operation);
  operation.start();
  assert.equal(typeof tick, 'function');
  assert.doesNotThrow(() => tick?.());
  assert.equal(playerChecks, 1);
  operation.cancel();
  assert.equal(await operation.promise, null);
});
