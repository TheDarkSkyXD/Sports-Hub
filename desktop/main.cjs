const { app, BrowserWindow, ipcMain, shell, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { localServerPort } = require('./port.cjs');
const { createLocalServer } = require('./local-server.cjs');
const { createSportsurgeCollector } = require('./sportsurge-collector.cjs');
const { createSportsurgeObserver } = require('./sportsurge-observer.cjs');
const { createStreameastCollector } = require('./streameast-collector.cjs');
const { CH, createUpdateService } = require('./update.cjs');

app.setName('Sunday Room');
if (process.platform === 'win32') app.setAppUserModelId('com.sundayroom.desktop');

// The version the installer will carry, read from the manifest. On an unpackaged run
// `app.getVersion()` returns Electron's own version, which is not what a user should read
// in the update panel.
function packagedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
}
const root = app.isPackaged ? path.join(process.resourcesPath,'server') : path.resolve(__dirname,'..');
const logDir = app.isPackaged ? path.join(app.getPath('userData'),'logs') : path.join(root,'.desktop-runtime');
let win;
let localServer;
let origin;
let sportsurgeCollector;
let sportsurgeObserver;
let streameastCollector;
let update;
const controlToken = randomUUID();
let teardown = null;
let mainFrameFailed = false;
let reloadingMainFrame = false;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance',() => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function trusted(event) {
  if (teardown || !win || win.isDestroyed()) return false;
  if (event.sender !== win.webContents) return false;
  if (event.senderFrame !== win.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === origin; } catch { return false; }
}

function restoreMainFrame() {
  if (!mainFrameFailed || reloadingMainFrame || !win || win.isDestroyed() || teardown !== null) return;
  mainFrameFailed = false;
  reloadingMainFrame = true;
  void win.loadURL(origin).catch(() => { mainFrameFailed = true; }).finally(() => { reloadingMainFrame = false; });
}

async function startServer(observerOrigin) {
  const port = await localServerPort();
  origin = `http://127.0.0.1:${port}`;
  localServer = createLocalServer({
    root, origin, port, userData:app.getPath('userData'), controlToken, observerOrigin, packaged:app.isPackaged, logDir,
    onReady:() => {
      sportsurgeCollector?.requestSweep();
      streameastCollector?.requestSweep();
      restoreMainFrame();
    },
    onHealthy:restoreMainFrame,
  });
  await localServer.start();
}

app.whenReady().then(async () => {
  if (!singleInstance) return;
  let observerOrigin;
  try {
    sportsurgeObserver=createSportsurgeObserver({controlToken});
    observerOrigin=await sportsurgeObserver.start();
  } catch (error) {
    sportsurgeObserver?.stop();
    sportsurgeObserver=undefined;
    try {
      fs.mkdirSync(logDir,{recursive:true});
      fs.appendFileSync(path.join(logDir,'startup.log'),`Sportsurge observer unavailable: ${error}\n`);
    } catch {}
  }
  await startServer(observerOrigin);
  sportsurgeCollector=createSportsurgeCollector({origin,controlToken});
  sportsurgeCollector.start();
  streameastCollector=createStreameastCollector({origin,controlToken});
  streameastCollector.start();
  win = new BrowserWindow({
    title:'Sunday Room',width:1500,height:1060,minWidth:900,minHeight:650,
    backgroundColor:'#101114',autoHideMenuBar:true,
    icon:path.join(__dirname,'icons','sunday-room.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false},
  });
  win.webContents.setWindowOpenHandler(({url}) => {
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.webContents.on('did-fail-load',(_event,code,_description,url,isMainFrame) => {
    if (isMainFrame && code !== -3 && url === `${origin}/`) mainFrameFailed = true;
  });
  win.on('closed',() => { win=undefined; app.quit(); });
  powerMonitor.on('resume',() => { if (!teardown) { void localServer?.checkNow(); sportsurgeCollector?.requestSweep(); streameastCollector?.requestSweep(); } });
  update=createUpdateService({
    // `app.getVersion()` reports Electron's own version on an unpackaged run, which would
    // show a build number in the update panel instead of the app's. Read the manifest so a
    // development build shows the same version a packaged one would.
    currentVersion:app.isPackaged?app.getVersion():packagedVersion(),userDataDir:app.getPath('userData'),isPackaged:app.isPackaged,platform:process.platform,
    execPath:process.execPath,fetch:(...args)=>globalThis.fetch(...args),spawn,
    trusted,beginShutdown,exit:code=>app.exit(code),broadcast:status=>{ if (win && !win.isDestroyed()) win.webContents.send(CH.status,status); },
    log:message=>{ try { fs.mkdirSync(logDir,{recursive:true}); fs.appendFileSync(path.join(logDir,'updates.log'),`${message}\n`); } catch {} },
  });
  ipcMain.handle(CH.get,update.invoke('get'));
  ipcMain.handle(CH.check,update.invoke('check'));
  ipcMain.handle(CH.download,update.invoke('download'));
  ipcMain.handle(CH.cancel,update.invoke('cancel'));
  ipcMain.handle(CH.install,update.invoke('install'));
  ipcMain.handle(CH.setSource,update.invoke('setSource'));
  update.start();
  await win.loadURL(origin).catch(() => { mainFrameFailed = true; });
}).catch(error => {
  fs.mkdirSync(logDir,{recursive:true});
  fs.appendFileSync(path.join(logDir,'startup.log'),String(error)+'\n');
  app.quit();
});
app.on('window-all-closed',() => app.quit());
async function stopServer() {
  if (!localServer) return;
  try {
    await fetch(`${origin}/api/internal/pipeline`,{
      method:'POST',headers:{'x-sunday-control-token':controlToken},signal:AbortSignal.timeout(5000),
    });
  } catch {}
  await localServer.stop();
}

// Idempotent. The window-close path and the updater share one teardown, so the process
// tree is provably dead before NSIS goes looking for it.
function beginShutdown() {
  teardown ??= (async () => {
    localServer?.beginStop();
    sportsurgeCollector?.stop();
    sportsurgeObserver?.stop();
    streameastCollector?.stop();
    update?.stop();
    await stopServer();
  })();
  return teardown;
}
app.on('before-quit',event => {
  if (teardown) return;
  event.preventDefault();
  void beginShutdown().finally(() => app.quit());
});
