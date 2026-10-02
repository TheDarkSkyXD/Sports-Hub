import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopNsisUpdater } = require('../desktop/nsis-updater.cjs');

function setup() {
  const events: string[] = [];
  let onQuit = (code: number) => { assert.equal(code, 0); };
  const app = {
    version: '1.0.6', name: 'Sunday Room', isPackaged: true,
    appUpdateConfigPath: 'C:\\app-update.yml', userDataPath: 'C:\\UserData', baseCachePath: 'C:\\Cache',
    whenReady: () => Promise.resolve(),
    onQuit: (handler: (code: number) => void) => { onQuit = handler; },
    quit: () => { events.push('app quit'); onQuit(0); },
  };
  const updater = new DesktopNsisUpdater(undefined, app, () => { events.push('before-quit-for-update'); });
  updater.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  updater.downloadedUpdateHelper = {
    file: 'C:\\Cache\\Sunday Room Setup.exe',
    packageFile: 'C:\\Cache\\Sunday Room Package.7z',
    downloadedFileInfo: { isAdminRightsRequired: false },
  };
  updater.installDirectory = 'D:\\Apps\\Sunday Room';
  return { updater, events, app };
}

test('explicit install waits for process launch and keeps the install directory argument last', async () => {
  const { updater, events } = setup();
  let acknowledge = (value: boolean) => { assert.equal(value, true); };
  const launched = new Promise<boolean>(resolve => { acknowledge = resolve; });
  const calls: { file: string; args: string[] }[] = [];
  updater.spawnLog = (file: string, args: string[]) => {
    calls.push({ file, args });
    return launched;
  };

  const install = updater.quitAndInstall(true, true);
  await Promise.resolve();
  await updater.quitAndInstall(true, true);
  assert.deepEqual(events, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, [{
    file: 'C:\\Cache\\Sunday Room Setup.exe',
    args: ['--updated', '/S', '--force-run', '--package-file=C:\\Cache\\Sunday Room Package.7z', '/D=D:\\Apps\\Sunday Room'],
  }]);
  acknowledge(true);
  await install;
  assert.deepEqual(events, ['before-quit-for-update', 'app quit']);
});

test('installer launch failure keeps Electron open and allows Retry', async () => {
  const { updater, events } = setup();
  let attempts = 0;
  updater.spawnLog = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('missing installer'), { code: 'ENOENT' });
    return true;
  };
  await assert.rejects(() => updater.quitAndInstall(true, true), /missing installer/);
  assert.deepEqual(events, []);
  assert.equal(updater.quitAndInstallCalled, false);
  await updater.quitAndInstall(true, true);
  assert.equal(attempts, 2);
  assert.deepEqual(events, ['before-quit-for-update', 'app quit']);
});

test('access denied falls back to elevate and still waits for its launch', async () => {
  const previousResourcesPath = Reflect.get(process, 'resourcesPath');
  Reflect.set(process, 'resourcesPath', 'C:\\Program Files\\Sunday Room\\resources');
  try {
    const { updater, events } = setup();
    const calls: { file: string; args: string[] }[] = [];
    let acknowledge = (value: boolean) => { assert.equal(value, true); };
    const elevated = new Promise<boolean>(resolve => { acknowledge = resolve; });
    updater.spawnLog = (file: string, args: string[]) => {
      calls.push({ file, args });
      if (calls.length === 1) return Promise.reject(Object.assign(new Error('access denied'), { code: 'EACCES' }));
      return elevated;
    };
    const install = updater.quitAndInstall(true, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.match(calls[1].file, /elevate\.exe$/);
    assert.equal(calls[1].args[0], 'C:\\Cache\\Sunday Room Setup.exe');
    assert.equal(calls[1].args.at(-1), '/D=D:\\Apps\\Sunday Room');
    assert.deepEqual(events, []);
    acknowledge(true);
    await install;
    assert.deepEqual(events, ['before-quit-for-update', 'app quit']);
  } finally {
    if (previousResourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath');
    else Reflect.set(process, 'resourcesPath', previousResourcesPath);
  }
});

test('ordinary quit remains silent and does not force a relaunch', async () => {
  const { updater, app, events } = setup();
  const calls: string[][] = [];
  updater.spawnLog = async (_file: string, args: string[]) => { calls.push(args); return true; };
  updater.addQuitHandler();
  app.quit();
  await Promise.resolve();
  assert.deepEqual(calls, [['--updated', '/S', '--package-file=C:\\Cache\\Sunday Room Package.7z', '/D=D:\\Apps\\Sunday Room']]);
  assert.deepEqual(events, ['app quit']);
});
