const { app, BrowserWindow, ipcMain, shell, powerMonitor, Notification } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { localServerPort } = require('./port.cjs');
const { createLocalServer } = require('./local-server.cjs');
const { createSportsurgeCollector } = require('./sportsurge-collector.cjs');
const { createSportsurgeObserver } = require('./sportsurge-observer.cjs');
const { createStreameastCollector } = require('./streameast-collector.cjs');
const { CH, createUpdateService, selectUpdateFeedUrl } = require('./update.cjs');
const { NsisUpdater } = require('electron-updater');

app.setName('Sunday Room');
if (process.platform === 'win32') app.setAppUserModelId('com.sundayroom.desktop');

// The version the installer will carry, read from the manifest. On an unpackaged run
// `app.getVersion()` returns Electron's own version, which is not what a user should read
// in the update panel.
function packagedVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
}

// electron-updater skips every check when the app is not packaged unless
// `forceDevUpdateConfig` is set. Setting it and then pointing the feed at the same URL is
// what lets a development build exercise the real updater; without it every check silently
// returns without a request, which looks like "up to date" rather than an error.
function configureDevelopmentUpdater(updater, feedUrl) {
  updater.forceDevUpdateConfig=true;
  updater.setFeedURL({ provider:'generic', url:feedUrl });
}

// A release found while the app is in the background has to reach the person, not just the
// window. The in-app popup only helps if they happen to be looking at it, and a window
// behind something else is not looking, so a system notification carries it. Skipped when
// the window already has focus, because then the popup is in front of them already.
let announcedVersion = null;
function announceUpdate(version) {
  if (announcedVersion === version || !Notification.isSupported()) return;
  announcedVersion = version;
  if (win && !win.isDestroyed() && win.isFocused()) return;
  try {
    const notification = new Notification({
      title: `Sunday Room ${version} is available`,
      body: 'Open Sunday Room to install it, or check Room settings to see what changed.',
      silent: true,
    });
    notification.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.show();
  } catch (error) {
    // A notification is a courtesy. Failing to raise one must not take down the updater.
    try {
      fs.mkdirSync(logDir,{recursive:true});
      fs.appendFileSync(path.join(logDir,'updates.log'),`update: could not announce ${version}: ${String(error)}\n`);
    } catch {}
  }
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
  const updater=new NsisUpdater();
  const currentVersion=app.isPackaged?app.getVersion():packagedVersion();
  // An unpackaged Electron process reports Electron's version to NsisUpdater.
  if (!app.isPackaged) updater.currentVersion=new updater.currentVersion.constructor(currentVersion);
  // Nothing downloads until a person asks. `autoDownload=false` is what keeps a check from
  // pulling 120 MB the moment the app opens.
  updater.autoDownload=false;
  updater.disableDifferentialDownload=true;
  // A downloaded update installs on quit, so closing the app after a download still lands
  // it. The explicit Install button is not the only path.
  updater.autoInstallOnAppQuit=true;
  updater.logger={...console,info:()=>{},debug:()=>{}};
  // electron-updater declares this but never sets it. Without it the installer runs
  // without `/D=`, and `desktop/installer.nsh` cannot restore the install directory, so
  // the next launch looks like a fresh install.
  updater.installDirectory=path.dirname(process.execPath);
  const feedUrl=selectUpdateFeedUrl(app.isPackaged,process.env.SUNDAY_ROOM_UPDATE_SOURCE);
  if (!app.isPackaged) configureDevelopmentUpdater(updater,feedUrl);
  else updater.setFeedURL({ provider:'generic', url:feedUrl });
  update=createUpdateService({
    currentVersion,userDataDir:app.getPath('userData'),
    isPackaged:app.isPackaged,platform:process.platform,updater,trusted,feedUrl,
    broadcast:status=>{
      if (win && !win.isDestroyed()) win.webContents.send(CH.status,status);
      if (status.state.kind === 'available' && status.state.release) announceUpdate(status.state.release.version);
    },
    log:message=>{ try { fs.mkdirSync(logDir,{recursive:true}); fs.appendFileSync(path.join(logDir,'updates.log'),`${message}\n`); } catch {} },
  });
  ipcMain.handle(CH.get,update.invoke('get'));
  ipcMain.handle(CH.check,update.invoke('check'));
  ipcMain.handle(CH.download,update.invoke('download'));
  ipcMain.handle(CH.install,update.invoke('install'));
  ipcMain.handle(CH.setSource,update.invoke('setSource'));
  ipcMain.handle(CH.setPreferences,update.invoke('setPreferences'));
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
