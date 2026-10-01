import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

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
      const win = new BrowserWindow({ width: 1280, height: 800, webPreferences: {
        preload: ${JSON.stringify(path.join(root, 'desktop/preload.cjs'))},
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      }});
      const updater = Object.assign(new EventEmitter(), {
        checkForUpdates() { this.emit('update-available', { version: '1.0.7' }); },
        downloadUpdate() { this.emit('update-downloaded'); },
        quitAndInstall() {},
      });
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
  await page.screenshot({ path: path.join(root, '.scratch/update-screen.png') });
  console.log('PASS Electron displays the updating page after Install and restart');
} finally {
  await desktop?.close();
  await rm(scratch, { recursive: true, force: true });
}
