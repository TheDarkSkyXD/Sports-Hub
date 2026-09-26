const { app, BrowserWindow, shell, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { localServerPort } = require('./port.cjs');

const root = path.resolve(__dirname,'..');
let win;
let serverProcess;
let origin;
const controlToken = randomUUID();
let shuttingDown = false;
app.setName('Sunday Room');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance',() => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

async function startServer() {
  const port = await localServerPort();
  origin = `http://127.0.0.1:${port}`;
  const production = process.env.SUNDAY_ROOM_FORCE_DEV !== '1' && fs.existsSync(path.join(root,'.next','BUILD_ID'));
  const logDir = path.join(root,'.desktop-runtime');
  fs.mkdirSync(logDir,{recursive:true});
  const log = fs.openSync(path.join(logDir,'server.log'),'a');
  serverProcess = spawn(process.execPath,[path.join(__dirname,'server-supervisor.cjs'),path.join(root,'node_modules','next','dist','bin','next'),production?'start':'dev',String(port)],{
    cwd:root,
    windowsHide:true,
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1',SUNDAY_ROOM_DESKTOP:'1',SUNDAY_ROOM_DATA_DIR:app.getPath('userData'),SUNDAY_ROOM_CONTROL_TOKEN:controlToken},
    stdio:['ignore',log,log,'ipc'],
  });
  fs.closeSync(log);
  for (let attempt=0;attempt<120;attempt++) {
    if (serverProcess.exitCode !== null) throw new Error('Local server stopped');
    try {
      const response = await fetch(origin,{signal:AbortSignal.timeout(1000)});
      if (response.ok) {
        const board = await fetch(`${origin}/api/games`,{signal:AbortSignal.timeout(5000)});
        if (board.ok) return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw new Error('Local server did not start');
}

app.whenReady().then(async () => {
  if (!singleInstance) return;
  await startServer();
  win = new BrowserWindow({
    title:'Sunday Room',width:1500,height:1060,minWidth:900,minHeight:650,
    backgroundColor:'#101114',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false},
  });
  win.webContents.setWindowOpenHandler(({url}) => {
    try { if (new URL(url).protocol === 'https:') void shell.openExternal(url); } catch {}
    return {action:'deny'};
  });
  win.webContents.on('will-navigate',(event,url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
  win.on('closed',() => { win=undefined; app.quit(); });
  powerMonitor.on('resume',() => { if (origin && !shuttingDown) void fetch(`${origin}/api/games`).catch(() => {}); });
  await win.loadURL(origin);
}).catch(error => {
  const logDir = path.join(root,'.desktop-runtime');
  fs.mkdirSync(logDir,{recursive:true});
  fs.appendFileSync(path.join(logDir,'startup.log'),String(error)+'\n');
  app.quit();
});
app.on('window-all-closed',() => app.quit());
async function stopServer() {
  if (!serverProcess) return;
  try {
    await fetch(`${origin}/api/internal/pipeline`,{
      method:'POST',headers:{'x-sunday-control-token':controlToken},signal:AbortSignal.timeout(5000),
    });
  } catch {}
  if (serverProcess.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe',['/PID',String(serverProcess.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      killer.on('error',resolve);
      killer.on('exit',resolve);
    });
  } else serverProcess.kill();
}
app.on('before-quit',event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown=true;
  void stopServer().finally(() => app.quit());
});
