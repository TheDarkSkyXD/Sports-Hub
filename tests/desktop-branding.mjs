import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit';
import sharp from 'sharp';
import { prepareDevelopmentElectron } from '../scripts/electron-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const payload = icon => Buffer.from(icon.isRaw() ? icon.bin : icon.generate());
const digest = data => createHash('sha256').update(data).digest('hex');

export async function assertExecutableBranding(executablePath) {
  const expected = Data.IconFile.from(await readFile(path.join(root, 'desktop/icons/sunday-room.ico')))
    .icons.map(icon => digest(payload(icon.data))).sort();
  const resources = NtExecutableResource.from(NtExecutable.from(await readFile(executablePath), { ignoreCert: true }));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.ok(groups.length > 0, `${executablePath} must contain an icon group`);
  for (const group of groups) {
    assert.deepEqual(group.getIconItemsFromEntries(resources.entries).map(icon => digest(payload(icon))).sort(),
      expected, `${executablePath} must embed every Sunday Room icon size for Task Manager and Explorer`);
  }
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  assert.ok(versions.length > 0, 'The executable must expose its Sunday Room description to Windows');
  for (const version of versions) {
    for (const language of version.getAllLanguagesForStringValues()) {
      const values = version.getStringValues(language);
      assert.equal(values.FileDescription, 'Sunday Room');
      assert.equal(values.ProductName, 'Sunday Room');
    }
  }
}

async function assertRenderedLogo(imagePath) {
  assert.ok(imagePath, 'Windows must expose the native icon');
  const actual = await sharp(imagePath).flatten({ background: '#000000' }).raw().toBuffer({ resolveWithObject: true });
  const ico = Data.IconFile.from(await readFile(path.join(root, 'desktop/icons/sunday-room.ico')));
  const frame = ico.icons.find(icon => (icon.width || 256) === actual.info.width);
  assert.ok(frame, `No source logo frame for native ${actual.info.width}px icon`);
  const expected = await sharp(payload(frame.data)).flatten({ background: '#000000' }).raw().toBuffer();
  assert.equal(actual.data.length, expected.length);
  const maximumChannelDifference = actual.data.reduce((maximum, channel, index) => Math.max(maximum, Math.abs(channel - expected[index])), 0);
  assert.ok(maximumChannelDifference <= 1, `${imagePath} must render the Sunday Room logo within Windows' one-level alpha rounding`);
}

export async function assertDesktopBranding(desktop, artifacts) {
  if (process.platform !== 'win32') return;
  const runtime = await desktop.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible());
    if (!window) throw new Error('Sunday Room must have a visible native window');
    const handle = window.getNativeWindowHandle();
    return {
      hwnd: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
      pid: process.pid, executablePath: process.execPath, packaged: app.isPackaged,
    };
  });
  await mkdir(artifacts, { recursive: true });
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    path.join(root, 'tests/windows-taskbar.ps1'), '-Hwnd', runtime.hwnd, '-OutputDirectory', artifacts], { windowsHide: true });
  const native = JSON.parse(stdout);
  console.log(JSON.stringify({ ...runtime, ...native }));
  assert.equal(native.processId, runtime.pid, 'Native icon verification must inspect the launched process');
  await assertExecutableBranding(runtime.executablePath);
  assert.equal(native.appUserModelId, runtime.packaged ? 'com.sundayroom.desktop' : 'com.sundayroom.desktop.dev');
  assert.equal(native.relaunchDisplayNameResource, 'Sunday Room');
  assert.equal(native.relaunchIconResource, `${runtime.executablePath},0`, 'The taskbar icon must reference a real executable outside app.asar');
  assert.equal(native.relaunchCommand, runtime.packaged ? `"${runtime.executablePath}"`
    : `"${runtime.executablePath}" "${path.join(root, 'desktop/main.cjs')}"`);
  for (const imagePath of [native.windowIconBig, native.windowIconSmall, native.executableIcon]) await assertRenderedLogo(imagePath);
  console.log(`PASS ${runtime.packaged ? 'packaged' : 'development'} Windows taskbar and Task Manager branding`);
  return native.relaunchCommand;
}

async function run() {
  if (process.platform !== 'win32') {
    console.log('Windows desktop branding requires Windows.');
    return;
  }
  const packaged = process.argv.includes('--packaged');
  const scratch = await mkdtemp(path.join(tmpdir(), 'sunday-room-branding-'));
  let desktop;
  try {
    const executablePath = packaged ? path.join(root, 'dist-electron/win-unpacked/Sunday Room.exe') : await prepareDevelopmentElectron();
    desktop = await electron.launch({
      executablePath,
      args: [...(packaged ? [] : [path.join(root, 'desktop/main.cjs')]), `--user-data-dir=${path.join(scratch, 'profile')}`],
      cwd: scratch,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      timeout: 120_000,
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const relaunchCommand = await assertDesktopBranding(desktop, path.join(root, 'work/icon-fix', packaged ? 'packaged' : 'development'));
    const relaunch = /^"([^"]+)"(?: "([^"]+)")?$/.exec(relaunchCommand);
    assert.ok(relaunch, 'The shell relaunch command must quote its executable and entry point');
    await desktop.close();
    desktop = await electron.launch({
      executablePath: relaunch[1],
      args: [...(relaunch[2] ? [relaunch[2]] : []), `--user-data-dir=${path.join(scratch, 'profile')}`],
      cwd: scratch,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE')),
      timeout: 120_000,
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()))) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await assertDesktopBranding(desktop, path.join(root, 'work/icon-fix', packaged ? 'packaged-relaunch' : 'development-relaunch'));
    console.log('PASS Windows relaunch from an unrelated working directory');
  } finally {
    if (desktop) await desktop.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run();
