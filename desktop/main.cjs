const { app, BrowserWindow, WebContentsView, ipcMain, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { allowedPlayer, validGameId, playerBounds } = require('./security.cjs');
const { createPlaybackHealth, samplePlaybackHealth, playbackIsStable } = require('./playback-health.cjs');
const root=path.resolve(__dirname,'..');
let win, serverProcess, origin, poll, diagnostics;
const players=new Map();
const requests=new Map();
let control={audio:'',muted:false,volume:70,playing:true,overlayOpen:false};
app.setName('Sunday Room');
const singleInstance=app.requestSingleInstanceLock();
if(!singleInstance)app.quit();
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
function trusted(event) { try{return !!win && !win.isDestroyed() && event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && new URL(event.senderFrame.url).origin===origin;}catch{return false;} }
function status(id,state,message,extra={}) { if(win&&!win.isDestroyed())win.webContents.send('room:status',{id,state,message,requestId:players.get(id)?.requestId,...extra}); }
function trustedRoomWindow() { try{return !!win&&!win.isDestroyed()&&new URL(win.webContents.getURL()).origin===origin;}catch{return false;} }
function notifyFullscreen(value) { if(trustedRoomWindow())win.webContents.send('room:fullscreen-change',value); }
function handleRoomInput(event,input) {
  if(input.type!=='keyDown'||input.key!=='Escape'||!trustedRoomWindow())return;
  if(control.overlayOpen){event.preventDefault();win.webContents.send('room:overlay-escape');}
  else if(win.isFullScreen()){event.preventDefault();win.setFullScreen(false);}
}
function closePlayer(id,cancel=true) { if(cancel){requests.get(id)?.abort();requests.delete(id);} const p=players.get(id); if(!p)return; players.delete(id); if(win&&!win.isDestroyed())win.contentView.removeChildView(p.view); if(!p.view.webContents.isDestroyed())p.view.webContents.close(); }
function currentPlayer(id,p) { return players.get(id)===p && !p.view.webContents.isDestroyed(); }
function observablePlayer(p) { return p.visible && !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(); }
function resetPlaybackGrace() { for(const p of players.values()){p.health.lastProgress=Date.now();p.health.stableSince=null;} }
function suspendPlayer(p) {
  p.visible=false;p.view.setVisible(false);p.view.webContents.setAudioMuted(true);
  void p.view.webContents.executeJavaScript("document.querySelector('video')?.pause()").catch(()=>{});
}
function failPlayer(id,p,message) {
  if(!currentPlayer(id,p))return;
  p.failed=true;suspendPlayer(p);
  status(id,'error',message);
}
async function recoverPlayer(id,p) {
  if(!currentPlayer(id,p)||p.recovering||p.failed)return;
  if(p.attempt>=p.serverCount-1){failPlayer(id,p,'The available servers are not responding. Try another server shortly.');return;}
  p.recovering=true;suspendPlayer(p);
  status(id,'ready','Trying the next available server…');
  try{await openPlayer(id,(p.server+1)%p.serverCount,p.attempt+1,p.requestId);}
  catch(error){if(error.message!=='Playback cancelled')failPlayer(id,p,'The game provider is unavailable. Please try again.');}
}
// These are ordinary player controls. No responses, origins, cookies, CSP, or media URLs are rewritten.
const startPlayback=`(() => { const poster=document.querySelector('.play-wrapper[data-poster]'); if(poster && poster.getBoundingClientRect().width) poster.click(); const v=document.querySelector('video'); if(v) v.play().catch(()=>{}); })()`;
async function applyControl(id,p) {
  if(!currentPlayer(id,p))return;
  p.view.webContents.setAudioMuted(control.muted || !control.playing || id!==control.audio || !p.visible || p.failed || p.recovering);
  if(p.failed||p.recovering)return;
  const value=JSON.stringify({volume:control.volume/100,playing:control.playing,audible:!control.muted&&id===control.audio&&p.visible});
  // WebContents supplies the room's mute gate. Also release a provider's own
  // media mute when this game is selected, or Unmute could remain silent.
  try { await p.view.webContents.executeJavaScript(`(() => {const c=${value};const v=document.querySelector('video');if(v){v.volume=c.volume;if(c.audible)v.muted=false;if(c.playing)v.play().catch(()=>{});else v.pause();}})()`); } catch {}
}
async function openPlayer(gameId,serverIndex=0,attempt=0,requestId) {
  if(!validGameId(gameId)||!Number.isInteger(serverIndex)||serverIndex<0||serverIndex>5)throw new Error('Invalid game');
  if(requestId!==undefined&&(typeof requestId!=='string'||requestId.length>100))throw new Error('Invalid playback request');
  requests.get(gameId)?.abort();
  const ticket=new AbortController();requests.set(gameId,ticket);
  if(!players.has(gameId)&&players.size>=4)throw new Error('Your room already has four players.');
  const lookup=()=>fetch(`${origin}/api/playback?game=${encodeURIComponent(gameId)}`,{signal:AbortSignal.any([ticket.signal,AbortSignal.timeout(40000)])});
  let response,data;
  try{
    response=await lookup();
    if(response.status>=500&&requests.get(gameId)===ticket)response=await lookup();
    data=await response.json();
  }catch(error){if(requests.get(gameId)!==ticket||ticket.signal.aborted)throw new Error('Playback cancelled');throw error;}
  if(requests.get(gameId)!==ticket||!win||win.isDestroyed())throw new Error('Playback cancelled');
  if(!response.ok)throw new Error(data.error||'Player unavailable');
  const sources=Array.isArray(data.players)?data.players.slice(0,6):[];
  const source=sources[serverIndex % sources.length];
  if(!source||!allowedPlayer(source.url))throw new Error('Unsupported player address');
  // Check capacity again after asynchronous resolution.
  if(!players.has(gameId)&&players.size>=4)throw new Error('Your room already has four players.');
  closePlayer(gameId,false);
  const view=new WebContentsView({webPreferences:{partition:'sunday-room-players',sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false}});
  const p={view,visible:false,server:serverIndex%sources.length,serverCount:sources.length,url:source.url,reported:false,attempt,requestId,health:createPlaybackHealth(),checking:false,recovering:false,failed:false};
  players.set(gameId,p);view.setBackgroundColor('#08090b');view.setVisible(false);win.contentView.addChildView(view);
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view.webContents.on('before-input-event',(event,input)=>{if(currentPlayer(gameId,p)&&p.visible)handleRoomInput(event,input);});
  view.webContents.on('will-navigate',(event,url)=>{if(url!==source.url)event.preventDefault();});
  view.webContents.on('will-redirect',(event,url)=>{if(url!==source.url)event.preventDefault();});
  view.webContents.on('did-fail-load',(_e,code,_d,_u,isMain)=>{if(isMain&&code!==-3&&currentPlayer(gameId,p))void recoverPlayer(gameId,p);});
  view.webContents.on('render-process-gone',()=>{if(currentPlayer(gameId,p))void recoverPlayer(gameId,p);});
  view.webContents.on('did-finish-load',async()=>{
    if(!currentPlayer(gameId,p)||p.failed||p.recovering)return;
    p.reported=false;p.health=createPlaybackHealth();
    status(gameId,'ready',undefined,{label:source.label,server:p.server});
    // The explicit Play click in Sunday Room authorizes starting this player's own Play control.
    try {if(control.playing)await view.webContents.executeJavaScript(startPlayback,true);await applyControl(gameId,p);}catch{}
  });
  void view.webContents.loadURL(source.url).catch(()=>{});
  if(process.env.SUNDAY_ROOM_DIAGNOSTICS==='1')setTimeout(async()=>{if(view.webContents.isDestroyed())return;try{const report=await view.webContents.executeJavaScript(`(() => {const v=document.querySelector('video');return {title:document.title,text:document.body.innerText.slice(0,500),video:v?{ready:v.readyState,paused:v.paused,time:v.currentTime,width:v.videoWidth,height:v.videoHeight,rect:v.getBoundingClientRect().toJSON(),style:{display:getComputedStyle(v).display,visibility:getComputedStyle(v).visibility}}:null}})()`);fs.writeFileSync(path.join(root,'.desktop-runtime',`player-${gameId}.json`),JSON.stringify({report,bounds:view.getBounds(),visible:p.visible},null,2));const shot=await view.webContents.capturePage();fs.writeFileSync(path.join(root,'.desktop-runtime',`player-${gameId}.png`),shot.toPNG());}catch{}},18000);
  return {serverCount:sources.length,label:source.label,server:p.server};
}
async function checkPlayer(id,p) {
  if(!currentPlayer(id,p)||p.checking||p.failed||p.recovering)return;
  if(!control.playing){
    samplePlaybackHealth(p.health,null,{playing:false,visible:observablePlayer(p)});
    // Providers can create or replace an autoplay video after our first pause.
    // Continue enforcing pause, including on streams hidden by the room layout.
    p.checking=true;
    try{await applyControl(id,p);}finally{p.checking=false;}
    return;
  }
  if(!observablePlayer(p)){samplePlaybackHealth(p.health,null,{playing:true,visible:false});return;}
  p.checking=true;
  try{
    const media=await p.view.webContents.executeJavaScript(`(() => {const v=document.querySelector('video');return v?{ready:v.readyState,error:!!v.error,ended:v.ended,time:v.currentTime,paused:v.paused}:null})()`);
    if(!currentPlayer(id,p)||p.failed||p.recovering)return;
    const health=samplePlaybackHealth(p.health,media,{playing:control.playing,visible:observablePlayer(p)});
    if(health==='retry'){void recoverPlayer(id,p);return;}
    if(health==='playing'&&playbackIsStable(p.health))p.attempt=0;
    if(health==='playing'&&!p.reported){
      p.reported=true;await applyControl(id,p);
      if(currentPlayer(id,p)&&!p.failed&&!p.recovering)status(id,'playing');
    }else if(health==='buffering'&&p.reported){p.reported=false;status(id,'ready','The stream is buffering…');}
    if(health==='starting'||health==='buffering')await p.view.webContents.executeJavaScript(startPlayback,true);
  }catch{if(currentPlayer(id,p)&&samplePlaybackHealth(p.health,null,{playing:control.playing,visible:observablePlayer(p)})==='retry')void recoverPlayer(id,p);}
  finally{p.checking=false;}
}
function installIPC() {
 ipcMain.handle('room:set-fullscreen',(event,value)=>{
  if(!trusted(event)||typeof value!=='boolean')throw new Error('Invalid fullscreen request');
  // Native window fullscreen leaves Escape under app control. Chromium consumes
  // HTML fullscreen Escape before Electron can emit before-input-event.
  win.setFullScreen(value);return win.isFullScreen();
 });
 ipcMain.handle('room:open',async(event,value)=>{if(!trusted(event))throw new Error('Untrusted sender');return openPlayer(value?.gameId,value?.server,0,value?.requestId);});
 ipcMain.handle('room:close',(event,id)=>{if(!trusted(event)||!validGameId(id))throw new Error('Invalid sender or game');closePlayer(id);});
 ipcMain.on('room:layout',(event,items)=>{
  if(!trusted(event)||!Array.isArray(items)||items.length>4)return;
  const size=win.getContentSize();
  for(const [id,p] of players){if(p.view.webContents.isDestroyed())continue;const item=items.find(i=>i?.id===id);const bounds=item&&!item.hidden&&!p.failed&&!p.recovering?playerBounds(item,size,win.webContents.getZoomFactor()):null;p.visible=!!bounds;p.view.setVisible(!!bounds);if(bounds)p.view.setBounds(bounds);p.view.webContents.setAudioMuted(control.muted||!control.playing||id!==control.audio||!p.visible);}
 });
 ipcMain.on('room:controls',(event,value)=>{
  if(!trusted(event)||!value||typeof value.muted!=='boolean'||typeof value.playing!=='boolean'||typeof value.overlayOpen!=='boolean'||!Number.isFinite(value.volume)||typeof value.audio!=='string')return;
  if(control.playing!==value.playing)for(const p of players.values())p.health.lastProgress=Date.now();
  control={audio:value.audio,muted:value.muted,playing:value.playing,volume:Math.max(0,Math.min(100,value.volume)),overlayOpen:value.overlayOpen};
  for(const [id,p]of players)void applyControl(id,p);
 });
}
async function startServer() {
 const port=51931;
 await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve));});
 origin=`http://127.0.0.1:${port}`;
 const production=fs.existsSync(path.join(root,'.next','BUILD_ID'));
 const logDir=path.join(root,'.desktop-runtime');fs.mkdirSync(logDir,{recursive:true});
 const log=fs.openSync(path.join(logDir,'server.log'),'a');
 serverProcess=spawn(process.execPath,[path.join(root,'node_modules','next','dist','bin','next'),production?'start':'dev','--hostname','127.0.0.1','--port',String(port)],{cwd:root,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore',log,log]});
 fs.closeSync(log);
 for(let n=0;n<120;n++){if(serverProcess.exitCode!==null)throw new Error('Local server stopped');try{const r=await fetch(origin,{signal:AbortSignal.timeout(1000)});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,500));}
 throw new Error('Local server did not start');
}
app.whenReady().then(async()=>{
 if(!singleInstance)return;
 const remote=session.fromPartition('sunday-room-players');remote.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));remote.setPermissionCheckHandler(()=>false);remote.on('will-download',e=>e.preventDefault());
 await startServer();
 win=new BrowserWindow({title:'Sunday Room',width:1500,height:1060,minWidth:900,minHeight:650,backgroundColor:'#101114',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
 win.on('restore',resetPlaybackGrace);win.on('show',resetPlaybackGrace);
 // The native state accessor can lag the transition event on Windows.
 win.on('enter-full-screen',()=>notifyFullscreen(true));win.on('leave-full-screen',()=>notifyFullscreen(false));
 win.webContents.on('before-input-event',handleRoomInput);
 win.webContents.setWindowOpenHandler(({url})=>{try{if(new URL(url).protocol==='https:')void shell.openExternal(url);}catch{}return {action:'deny'};});
 win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==origin)e.preventDefault();});
 win.webContents.on('did-start-navigation',(_e,_url,isInPlace,isMainFrame)=>{if(isMainFrame&&!isInPlace){control.overlayOpen=false;if(win.isFullScreen())win.setFullScreen(false);for(const id of new Set([...requests.keys(),...players.keys()]))closePlayer(id);}});
 installIPC();await win.loadURL(origin);
 if(process.env.SUNDAY_ROOM_DIAGNOSTICS==='1')diagnostics=setInterval(async()=>{
  if(!win||win.isDestroyed())return;
  const snapshots=await Promise.all([...players].map(async([id,p])=>{
   if(p.view.webContents.isDestroyed())return null;
   try{return {id,visible:p.visible,bounds:p.view.getBounds(),audioMuted:p.view.webContents.isAudioMuted(),media:await p.view.webContents.executeJavaScript("(() => {const v=document.querySelector('video');return v?{width:v.videoWidth,height:v.videoHeight,time:v.currentTime,paused:v.paused,muted:v.muted,volume:v.volume,ready:v.readyState}:null})()")};}catch{return null;}
  }));
  fs.writeFileSync(path.join(root,'.desktop-runtime','room-state.json'),JSON.stringify({at:new Date().toISOString(),control,players:snapshots},null,2));
 },2000);
 poll=setInterval(()=>{for(const [id,p]of players)void checkPlayer(id,p);},2000);
 win.on('closed',()=>{clearInterval(poll);clearInterval(diagnostics);for(const request of requests.values())request.abort();requests.clear();for(const p of players.values())if(!p.view.webContents.isDestroyed())p.view.webContents.close();players.clear();win=null;});
}).catch(error=>{const logDir=path.join(root,'.desktop-runtime');fs.mkdirSync(logDir,{recursive:true});fs.appendFileSync(path.join(logDir,'startup.log'),String(error)+'\n');app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('will-quit',()=>{clearInterval(poll);clearInterval(diagnostics);if(serverProcess&&!serverProcess.killed)serverProcess.kill();});
