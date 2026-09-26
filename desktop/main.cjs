const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { allowedPlayer, validGameId, safeBounds } = require('./security.cjs');
const { localServerPort } = require('./port.cjs');
const root=app.isPackaged?path.join(process.resourcesPath,'server'):path.resolve(__dirname,'..');
const logDir=app.isPackaged?path.join(app.getPath('userData'),'logs'):path.join(root,'.desktop-runtime');
let win, serverProcess, origin, poll;
const players=new Map();
const requests=new Map();
let control={audio:'',muted:false,volume:70,playing:true};
app.setName('Sunday Room');
const singleInstance=app.requestSingleInstanceLock();
if(!singleInstance)app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
function trusted(event) { return !!win && event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && new URL(event.senderFrame.url).origin===origin; }
function status(id,state,message,extra={}) { if(win&&!win.isDestroyed())win.webContents.send('room:status',{id,state,message,...extra}); }
function closePlayer(id,cancel=true) { if(cancel)requests.set(id,Symbol()); const p=players.get(id); if(!p)return; players.delete(id); win?.contentView.removeChildView(p.view); if(!p.view.webContents.isDestroyed())p.view.webContents.close(); }
// These are ordinary player controls. No responses, origins, cookies, CSP, or media URLs are rewritten.
const startPlayback=`(() => { const poster=document.querySelector('.play-wrapper[data-poster]'); if(poster && poster.getBoundingClientRect().width) poster.click(); const v=document.querySelector('video'); if(v) v.play().catch(()=>{}); })()`;
async function applyControl(id,p) {
  if(p.view.webContents.isDestroyed())return;
  p.view.webContents.setAudioMuted(control.muted || id!==control.audio || !p.visible);
  const value=JSON.stringify({volume:control.volume/100,playing:control.playing});
  try { await p.view.webContents.executeJavaScript(`(() => {const c=${value};const v=document.querySelector('video');if(v){v.volume=c.volume;if(c.playing)v.play().catch(()=>{});else v.pause();}})()`); } catch {}
}
async function openPlayer(gameId,serverIndex=0,attempt=0) {
  if(!validGameId(gameId)||!Number.isInteger(serverIndex)||serverIndex<0||serverIndex>5)throw new Error('Invalid game');
  const ticket=Symbol();requests.set(gameId,ticket);
  if(!players.has(gameId)&&players.size>=4)throw new Error('Your room already has four players.');
  const lookup=()=>fetch(`${origin}/api/playback?game=${encodeURIComponent(gameId)}`,{signal:AbortSignal.timeout(40000)});
  let response=await lookup();
  if(response.status>=500&&requests.get(gameId)===ticket)response=await lookup();
  const data=await response.json();
  if(requests.get(gameId)!==ticket||!win||win.isDestroyed())throw new Error('Playback cancelled');
  if(!response.ok)throw new Error(data.error||'Player unavailable');
  const source=data.players?.[serverIndex % data.players.length];
  if(!source||!allowedPlayer(source.url))throw new Error('Unsupported player address');
  // Check capacity again after asynchronous resolution.
  if(!players.has(gameId)&&players.size>=4)throw new Error('Your room already has four players.');
  closePlayer(gameId,false);
  const view=new WebContentsView({webPreferences:{partition:'sunday-room-players',sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false}});
  const p={view,visible:false,server:serverIndex,serverCount:data.players.length,url:source.url,started:Date.now(),reported:false,attempt};
  players.set(gameId,p);view.setBackgroundColor('#08090b');view.setVisible(false);win.contentView.addChildView(view);
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view.webContents.on('will-navigate',(event,url)=>{if(url!==source.url)event.preventDefault();});
  view.webContents.on('will-redirect',(event,url)=>{if(url!==source.url)event.preventDefault();});
  view.webContents.on('did-fail-load',(_e,code,_d,_u,isMain)=>{if(isMain&&code!==-3)status(gameId,'error','Player failed to load. Try another server.');});
  view.webContents.on('render-process-gone',()=>status(gameId,'error','The player stopped. Try another server.'));
  view.webContents.on('did-finish-load',async()=>{
    status(gameId,'ready',undefined,{label:source.label,server:serverIndex % data.players.length});
    // The explicit Play click in Sunday Room authorizes starting this player's own Play control.
    try {if(control.playing)await view.webContents.executeJavaScript(startPlayback,true);await applyControl(gameId,p);}catch{}
  });
  void view.webContents.loadURL(source.url).catch(()=>{});
  if(process.env.SUNDAY_ROOM_DIAGNOSTICS==='1')setTimeout(async()=>{if(view.webContents.isDestroyed())return;try{const report=await view.webContents.executeJavaScript(`(() => {const v=document.querySelector('video');return {title:document.title,text:document.body.innerText.slice(0,500),video:v?{ready:v.readyState,paused:v.paused,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,rect:v.getBoundingClientRect().toJSON(),style:{display:getComputedStyle(v).display,visibility:getComputedStyle(v).visibility}}:null}})()`);fs.mkdirSync(logDir,{recursive:true});fs.writeFileSync(path.join(logDir,`player-${gameId}.json`),JSON.stringify({report,bounds:view.getBounds(),visible:p.visible},null,2));const shot=await view.webContents.capturePage();fs.writeFileSync(path.join(logDir,`player-${gameId}.png`),shot.toPNG());}catch{}},18000);
  return {serverCount:data.players.length,label:source.label,server:serverIndex % data.players.length};
}
function installIPC() {
 ipcMain.handle('room:open',async(event,value)=>{if(!trusted(event))throw new Error('Untrusted sender');return openPlayer(value?.gameId,value?.server);});
 ipcMain.handle('room:close',(event,id)=>{if(!trusted(event)||!validGameId(id))throw new Error('Invalid sender or game');closePlayer(id);});
 ipcMain.on('room:layout',(event,items)=>{
  if(!trusted(event)||!Array.isArray(items)||items.length>4)return;
  const size=win.getContentSize();
  for(const [id,p] of players){const item=items.find(i=>i?.id===id);const bounds=item&&!item.hidden?safeBounds(item,size):null;p.visible=!!bounds;p.view.setVisible(!!bounds);if(bounds)p.view.setBounds(bounds);p.view.webContents.setAudioMuted(control.muted||id!==control.audio||!p.visible);}
 });
 ipcMain.on('room:controls',(event,value)=>{
  if(!trusted(event)||!value||typeof value.muted!=='boolean'||typeof value.playing!=='boolean'||!Number.isFinite(value.volume)||typeof value.audio!=='string')return;
  control={audio:value.audio,muted:value.muted,playing:value.playing,volume:Math.max(0,Math.min(100,value.volume))};
  for(const [id,p]of players)void applyControl(id,p);
 });
}
async function startServer() {
 const port=await localServerPort();
 origin=`http://127.0.0.1:${port}`;
 const production=app.isPackaged||fs.existsSync(path.join(root,'.next','BUILD_ID'));
 fs.mkdirSync(logDir,{recursive:true});
 const log=fs.openSync(path.join(logDir,'server.log'),'a');
 const args=app.isPackaged?[path.join(root,'server.js')]:[path.join(root,'node_modules','next','dist','bin','next'),production?'start':'dev','--hostname','127.0.0.1','--port',String(port)];
 serverProcess=spawn(process.execPath,args,{cwd:root,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...(app.isPackaged?{PORT:String(port),HOSTNAME:'127.0.0.1'}:{})},stdio:['ignore',log,log]});
 fs.closeSync(log);
 for(let n=0;n<120;n++){if(serverProcess.exitCode!==null)throw new Error('Local server stopped');try{const r=await fetch(origin,{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}
 throw new Error('Local server did not start');
}
app.whenReady().then(async()=>{
 if(!singleInstance)return;
 const remote=session.fromPartition('sunday-room-players');remote.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));remote.setPermissionCheckHandler(()=>false);remote.on('will-download',e=>e.preventDefault());
 await startServer();
 win=new BrowserWindow({title:'Sunday Room',width:1500,height:1060,minWidth:900,minHeight:650,backgroundColor:'#101114',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
 win.webContents.setWindowOpenHandler(({url})=>{try{if(new URL(url).protocol==='https:')void shell.openExternal(url);}catch{}return {action:'deny'};});
 win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==origin)e.preventDefault();});
 win.webContents.on('did-start-navigation',(_e,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace)for(const id of [...players.keys()])closePlayer(id);});
 installIPC();await win.loadURL(origin);
 poll=setInterval(async()=>{for(const [id,p]of players){if(p.reported||p.view.webContents.isDestroyed())continue;if(!control.playing){p.started=Date.now();continue;}try{const media=await p.view.webContents.executeJavaScript(`(() => {const v=document.querySelector('video');return v?{ready:v.readyState,error:!!v.error,time:v.currentTime,paused:v.paused}:null})()`);if(media?.ready>=3&&media.time>0&&!media.paused){p.reported=true;status(id,'playing');}else if(Date.now()-p.started>25000){p.reported=true;if(p.attempt<p.serverCount-1){status(id,'ready','Trying the next available server…');void openPlayer(id,(p.server+1)%p.serverCount,p.attempt+1).catch(()=>status(id,'error','The game provider is unavailable. Please try again.'));}else status(id,'error','The available servers have not started. Try again shortly.');}else if(control.playing){await p.view.webContents.executeJavaScript(startPlayback,true);}}catch{}}},2000);
 win.on('closed',()=>{clearInterval(poll);requests.clear();for(const p of players.values())if(!p.view.webContents.isDestroyed())p.view.webContents.close();players.clear();win=null;});
}).catch(error=>{fs.mkdirSync(logDir,{recursive:true});fs.appendFileSync(path.join(logDir,'startup.log'),String(error)+'\n');app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{clearInterval(poll);if(serverProcess&&!serverProcess.killed)serverProcess.kill();});
