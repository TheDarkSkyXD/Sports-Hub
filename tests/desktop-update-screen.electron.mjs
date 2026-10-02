import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const base = process.env.POPUP_BASE_URL || 'http://127.0.0.1:3112';
const scratch = await mkdtemp(path.join(tmpdir(), 'sunday-update-screen-'));
const entry = path.join(scratch, 'main.cjs');
const root = path.resolve('.');
let desktop;
try {
  await writeFile(entry, `
    const { app, BrowserWindow, ipcMain } = require('electron');
    const { EventEmitter } = require('node:events');
    const { CH, createUpdateService } = require(${JSON.stringify(path.join(root, 'desktop/update.cjs'))});
    app.setPath('userData', ${JSON.stringify(path.join(scratch, 'profile'))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 1280, height: 800,
        icon: ${JSON.stringify(path.join(root, 'desktop/icons/sunday-room.png'))}, webPreferences: {
        preload: ${JSON.stringify(path.join(root, 'desktop/preload.cjs'))},
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      }});
      const updater = Object.assign(new EventEmitter(), {
        checkForUpdates() { this.emit('update-available', { version: '1.0.7' }); },
        downloadUpdate() { this.emit('update-downloaded'); },
        quitAndInstall() { this.launched = true; },
      });
      global.testUpdater = updater;
      const service = createUpdateService({
        updater, currentVersion: '1.0.6', userDataDir: app.getPath('userData'),
        isPackaged: true, platform: 'win32', trusted: () => true,
        broadcast: status => win.webContents.send(CH.status, status),
        prepareInstall: () => new Promise(resolve => setTimeout(resolve, 2000)),
      });
      for (const command of ['get', 'check', 'download', 'install']) ipcMain.handle(CH[command], service.invoke(command));
      await service.start();
      await service.invoke('download')({});
      await win.loadURL(${JSON.stringify(base)});
      app.on('will-quit', () => service.stop());
    });
  `);
  desktop = await electron.launch({
    executablePath: await prepareDevelopmentElectron(),
    args: [entry],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
  });
  const page = await desktop.firstWindow();
  await page.getByRole('button', { name: 'Install and restart', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Install and restart', exact: true }).click();
  await page.getByRole('heading', { name: 'Updating Sunday Room', exact: true }).waitFor({ timeout: 3000 });
  const screen = page.getByRole('dialog', { name: 'Updating Sunday Room' });
  assert.equal(await screen.isVisible(), true);
  assert.match(await screen.innerText(), /1\.0\.7/);
  assert.equal(await screen.getByRole('button', { name: /dismiss/i }).count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await screen.isVisible(), true, 'Escape cannot dismiss an active update');
  assert.equal(await screen.evaluate(dialog => dialog.matches(':modal')), true, 'the update blocks interaction with the viewing room');
  await page.screenshot({ path: path.join(root, '.scratch/update-screen.png') });
  console.log('PASS Electron displays the updating page after Install and restart');
  await desktop.evaluate(async () => {
    while (!global.testUpdater.launched) await new Promise(resolve => setTimeout(resolve, 10));
    global.testUpdater.emit('error', new Error('The installer could not start'));
  });
  await page.getByRole('heading', { name: 'Update could not start', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry install', exact: true }).click();
  await page.getByRole('heading', { name: 'Updating Sunday Room', exact: true }).waitFor();
  console.log('PASS Electron keeps installation failures visible and offers Retry install');
} finally {
  await desktop?.close();
  await rm(scratch, { recursive: true, force: true });
}
