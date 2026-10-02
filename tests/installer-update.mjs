import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const { extractFile } = require('@electron/asar');
const root = path.resolve(import.meta.dirname, '..');
const electronVersion = require('electron/package.json').version;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const suffix = randomUUID().slice(0, 8);
const scratch = mkdtempSync(path.join(tmpdir(), `sunday-upgrade-fixture-${suffix}-`));
const productName = `Upgrade Fixture ${suffix}`;
const appId = `com.sundayroom.upgrade.fixture.run${suffix}`;
const project = path.join(scratch, 'project');
const installDir = path.join(scratch, 'Chosen Install Path', productName);
const userDataDir = path.join(scratch, 'User Data');
const marker = path.join(userDataDir, 'opened.json');
const quitSignal = path.join(userDataDir, 'quit');
const executable = path.join(installDir, `${productName}.exe`);
const uninstaller = path.join(installDir, `Uninstall ${productName}.exe`);
const installerInclude = path.join(scratch, 'installer.nsh');

assert.equal(process.platform, 'win32', 'native NSIS verification runs on Windows');
assert.ok(existsSync(electronDist), `Electron distribution missing: ${electronDist}`);
mkdirSync(project, { recursive: true });
mkdirSync(userDataDir, { recursive: true });
copyFileSync(path.join(root, 'desktop', 'installer.nsh'), installerInclude);

const appSource = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.setPath('userData', ${JSON.stringify(userDataDir)});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ title: ${JSON.stringify(productName)}, show: false, width: 450, height: 250 });
  await win.loadURL('data:text/html,<h1>Installer update fixture</h1>');
  win.show();
  const opening = {
    version: app.getVersion(), pid: process.pid, visible: win.isVisible(), updated: process.argv.includes('--updated')
  };
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(opening));
  fs.writeFileSync(require('node:path').join(${JSON.stringify(userDataDir)}, 'launch-' + process.pid + '.json'), JSON.stringify(opening));
  setInterval(() => {
    if (fs.existsSync(${JSON.stringify(quitSignal)})) {
      fs.unlinkSync(${JSON.stringify(quitSignal)});
      app.quit();
    }
  }, 100);
});
app.on('window-all-closed', () => app.quit());
`;

function start(file, args = [], options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));
  return spawn(file, args, { cwd: project, windowsHide: false, stdio: 'ignore', env, ...options });
}

function exited(child, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${child.spawnfile} did not exit in ${timeoutMs} ms`)), timeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${child.spawnfile} exited ${code ?? signal}`));
    });
  });
}

async function until(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function readMarker(version) {
  if (!existsSync(marker)) return null;
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    return value.version === version ? value : null;
  } catch { return null; }
}

function launches(version) {
  return readdirSync(userDataDir)
    .filter(name => /^launch-\d+\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(path.join(userDataDir, name), 'utf8')))
    .filter(entry => entry.version === version);
}

function installedVersion() {
  const appAsar = path.join(installDir, 'resources', 'app.asar');
  return JSON.parse(extractFile(appAsar, 'package.json').toString()).version;
}

async function buildVersion(version) {
  writeFileSync(path.join(project, 'package.json'), JSON.stringify({
    name: `upgrade-fixture-${suffix}`, version, main: 'main.cjs', description: 'Native NSIS update verification',
  }));
  writeFileSync(path.join(project, 'main.cjs'), appSource);
  const artifacts = await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      appId,
      productName,
      electronVersion,
      electronDist,
      npmRebuild: false,
      asar: true,
      directories: { output: path.join(scratch, `build-${version}`) },
      files: ['package.json', 'main.cjs'],
      win: { icon: path.join(root, 'desktop/icons/sunday-room.ico'), target: [{ target: 'nsis', arch: ['x64'] }] },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false,
        createStartMenuShortcut: false,
        include: installerInclude,
      },
      artifactName: `Upgrade-Fixture-${version}-Setup.exe`,
    },
  });
  const installer = artifacts.find(file => file.endsWith('.exe'));
  assert.ok(installer, `electron-builder did not produce the ${version} installer`);
  return installer;
}

async function closeFixture() {
  if (!existsSync(marker)) return;
  const { pid } = JSON.parse(readFileSync(marker, 'utf8'));
  if (!Number.isInteger(pid)) return;
  try { process.kill(pid, 0); } catch { return; }
  writeFileSync(quitSignal, 'quit');
  await until(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, 'fixture Electron exit', 15000);
}

async function observeInstallerWindow(child) {
  const command = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NativeWindowProbe { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'
$targetPid = ${child.pid}
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  $target = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $target) { break }
  $target.Refresh()
  if ($target.MainWindowHandle -ne 0 -and
      [NativeWindowProbe]::IsWindowVisible($target.MainWindowHandle) -and
      $target.MainWindowTitle -like '*${productName}*') {
    [Console]::WriteLine('visible')
    break
  }
  Start-Sleep -Milliseconds 20
}
`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', chunk => { output += chunk; });
  watcher.stderr.setEncoding('utf8');
  watcher.stderr.on('data', chunk => { errors += chunk; });
  try { await exited(watcher, 125000); }
  catch (error) { throw new Error(`Installer window probe failed: ${errors || output || error.message}`); }
  return output.includes('visible');
}

try {
  const oldInstaller = await buildVersion('1.0.0');
  const newInstaller = await buildVersion('1.0.1');
  console.log('Installing old fixture');
  await exited(start(oldInstaller, ['/S', `/D=${installDir}`]));
  assert.ok(existsSync(executable), 'initial installer placed the fixture at the chosen path');
  assert.ok(existsSync(uninstaller), 'initial install has its own uninstaller');

  start(executable);
  const oldWindow = await until(() => readMarker('1.0.0'), 'old Electron window');
  assert.equal(oldWindow.visible, true);
  await closeFixture();
  rmSync(marker);
  writeFileSync(path.join(userDataDir, 'saved.txt'), 'preserved');

  console.log('Installing update fixture');
  const update = start(newInstaller, ['--updated', '/S', '--force-run', `/D=${installDir}`]);
  const visible = observeInstallerWindow(update);
  await exited(update);
  const installerWasVisible = await visible;
  console.log(`Update installer visible: ${installerWasVisible}`);
  assert.ok(installerWasVisible, 'the update installer showed a visible progress window');

  const newWindow = await until(() => readMarker('1.0.1'), 'new Electron window');
  assert.equal(newWindow.visible, true, 'the new Electron window reopened');
  assert.equal(newWindow.updated, true, 'the new app received the update launch marker');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(launches('1.0.1').length, 1, 'the explicit update launched one new Electron app');
  assert.equal(installedVersion(), '1.0.1');
  assert.equal(readFileSync(path.join(userDataDir, 'saved.txt'), 'utf8'), 'preserved');
  assert.ok(existsSync(executable), 'the app remains at its original install path');
  assert.ok(existsSync(uninstaller), 'the installation remains registered for removal');

  await closeFixture();
  rmSync(marker);
  await exited(start(newInstaller, ['--updated', '/S', `/D=${installDir}`]));
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(installedVersion(), '1.0.1', 'an update on ordinary close still replaces the app');
  assert.equal(existsSync(marker), false, 'an update on ordinary close does not reopen the window');
  assert.equal(launches('1.0.1').length, 1, 'ordinary close did not start a second app');
  console.log(`Native NSIS upgrade passed for ${productName} at ${installDir}`);
} finally {
  await closeFixture().catch(() => {});
  if (existsSync(uninstaller)) await exited(start(uninstaller, ['/S', '/currentuser']), 30000).catch(() => {});
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { rmSync(resolved, { recursive: true, force: true }); break; }
    catch (error) {
      if (attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
