const { app, BrowserWindow, shell, powerMonitor } = require('electron');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { localServerPort } = require('./port.cjs');
const { createLocalServer } = require('./local-server.cjs');
const { createSportsurgeCollector } = require('./sportsurge-collector.cjs');
const { createStreameastCollector } = require('./streameast-collector.cjs');

app.setName('Sunday Room');
if (process.platform === 'win32') app.setAppUserModelId('com.sundayroom.desktop');
const root = app.isPackaged ? path.join(process.resourcesPath,'server') : path.resolve(__dirname,'..');
const logDir = app.isPackaged ? path.join(app.getPath('userData'),'logs') : path.join(root,'.desktop-runtime');
let win;
let localServer;
let origin;
let sportsurgeCollector;
let streameastCollector;
const controlToken = randomUUID();
let shuttingDown = false;
let mainFrameFailed = false;
let reloadingMainFrame = false;
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance',() => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function restoreMainFrame() {
  if (!mainFrameFailed || reloadingMainFrame || !win || win.isDestroyed() || shuttingDown) return;
  mainFrameFailed = false;
  reloadingMainFrame = true;
  void win.loadURL(origin).catch(() => { mainFrameFailed = true; }).finally(() => { reloadingMainFrame = false; });
}

async function startServer() {
  const port = await localServerPort();
  origin = `http://127.0.0.1:${port}`;
  localServer = createLocalServer({
    root, origin, port, userData:app.getPath('userData'), controlToken, packaged:app.isPackaged, logDir,
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
  await startServer();
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
  powerMonitor.on('resume',() => { if (!shuttingDown) { void localServer?.checkNow(); sportsurgeCollector?.requestSweep(); streameastCollector?.requestSweep(); } });
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
app.on('before-quit',event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown=true;
  localServer?.beginStop();
  sportsurgeCollector?.stop();
  streameastCollector?.stop();
  void stopServer().finally(() => app.quit());
});
