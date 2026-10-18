import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const root=resolve('.'),directory=resolve('.desktop-runtime/player-controls-fixture');
await mkdir(directory,{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=640x360:rate=24',
  '-filter_complex','[0:v]split=2[a][b];[a]scale=384:216[small];[b]scale=640:360[large]',
  '-map','[small]','-map','[large]','-t','60','-c:v','libx264','-preset','ultrafast','-g','24','-sc_threshold','0',
  '-b:v:0','300k','-b:v:1','800k','-f','hls','-hls_time','1','-hls_playlist_type','vod',
  '-var_stream_map','v:0 v:1','-master_pl_name','master.m3u8',
  '-hls_segment_filename',resolve(directory,'segment%v-%03d.ts'),resolve(directory,'quality%v.m3u8'),
],{windowsHide:true,timeout:20000});
await build({stdin:{contents:`
  import React,{useEffect,useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {ManagedPlayer} from './components/managed-player';
  function Fixture(){
    const [playing,setPlaying]=useState(true),[audible,setAudible]=useState(false),[volume,setVolume]=useState(50),[quality,setQuality]=useState('auto'),[focused,setFocused]=useState(true),[native,setNative]=useState(true);
    useEffect(()=>{const key=event=>{if(event.target.closest('input,textarea,select,button,[role="slider"],[contenteditable]'))return;if(event.key===' '){event.preventDefault();setPlaying(value=>!value);}if(event.key==='f'){event.preventDefault();if(document.fullscreenElement)void document.exitFullscreen();else void document.documentElement.requestFullscreen();}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
    return <><button onClick={()=>setQuality('360')}>Prefer 360p</button><button onClick={()=>setFocused(!focused)}>{focused?'Unfocus fixture':'Focus fixture'}</button><button onClick={()=>setNative(!native)}>{native?'Use direct player':'Use embedded player'}</button><main><ManagedPlayer managed={native}
      feed={{label:'Fixture feed',url:location.origin+(native?'/api/stream/nba-fixture/index.m3u8?session=00000000-0000-4000-8000-000000000001&candidate=controls&generation=0':'/master.m3u8')}}
      focused={focused} audible={audible} playing={playing} volume={volume} defaultQuality={quality}
      onPlayingChange={setPlaying} onAudibleChange={setAudible} onVolumeChange={setVolume} onFocus={()=>{setFocused(true);setAudible(true);}}/></main>
      <select aria-label="Fixture servers" style={{position:'fixed',bottom:8,left:12}}>{Array.from({length:20},(_,index)=><option key={index}>Server {index+1}</option>)}</select></>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},outfile:resolve(directory,'fixture.js'),logLevel:'silent'});
await writeFile(resolve(directory,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('sundayPlayer',{
  mount:value=>ipcRenderer.invoke('player-controls-test:mount',value),update:value=>ipcRenderer.invoke('player-controls-test:update',value),
  release:value=>ipcRenderer.invoke('player-controls-test:release',value),control:value=>ipcRenderer.invoke('player-controls-test:control',value),
  subscribe:listener=>{const wrapped=(_event,value)=>listener(value);ipcRenderer.on('sunday-player:state',wrapped);return()=>ipcRenderer.removeListener('sunday-player:state',wrapped);}
});`);

async function verify(root,directory){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,WebContentsView,session,ipcMain,screen}=process.mainModule.require('electron');
  const room=BrowserWindow.getAllWindows().find(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL()));
  if(!room)
    throw new Error('Wait for the local Electron room to finish loading before testing player controls');
  const appOrigin=new URL(room.webContents.getURL()).origin;
  const {join}=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
  const assert=require('node:assert/strict'),{createIsolatedPlayers}=require(join(root,'desktop/isolated-player.cjs'));
  const origin='http://127.0.0.1:9000',own=session.fromPartition('controls-host-'+randomUUID());
  const views=[],viewContents=new Map(),sessions=[],requests=[],navigation=[],actions=['mount','update','release','control'];
  let capability,host,chrome,stage='setup';
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  own.protocol.handle('http',async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/player-controls'||url.pathname.startsWith('/_next/')){
      const response=await fetch(appOrigin+url.pathname+url.search),headers=new Headers(response.headers);
      headers.delete('content-encoding');headers.delete('content-length');headers.delete('transfer-encoding');
      return new Response(await response.arrayBuffer(),{status:response.status,headers});
    }
    if(url.pathname==='/fixture.js')return new Response(await fs.readFile(join(directory,'fixture.js')),{headers:{'content-type':'text/javascript'}});
    if(url.pathname==='/fixture.css')return new Response(await fs.readFile(join(directory,'fixture.css')).catch(()=>''),{headers:{'content-type':'text/css'}});
    if(url.pathname==='/player.css')return new Response((await fs.readFile(join(root,'app/globals.css'),'utf8')).replace(/^@(?:import|source).*$/gm,''),{headers:{'content-type':'text/css'}});
    if(url.pathname.endsWith('/presentation'))return Response.json({kind:'isolated-embed',capability});
    if(/^\/(?:master|quality[01])\.m3u8$|^\/segment[01]-\d{3}\.ts$/.test(url.pathname))return new Response(await fs.readFile(join(directory,url.pathname.slice(1))),{headers:{'content-type':url.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'}});
    return new Response(`<!doctype html><link rel="stylesheet" href="/player.css"><link rel="stylesheet" href="/fixture.css"><style>main{position:relative;height:440px;width:780px;margin:12px}body{margin:0}body:has(main){background:#181a20;color:white;font:16px sans-serif}body:has(main)>#root>button{padding:6px}</style><div id="root"></div><script src="/fixture.js"></script>`,{headers:{'content-type':'text/html'}});
  });
  const factory=createIsolatedPlayers({authorizeTarget:async()=>true,
    createSession(){const player=session.fromPartition('controls-player-'+randomUUID());sessions.push(player);
      player.protocol.handle('https',async request=>{
        requests.push(request.url);
        const url=new URL(request.url);
        if(url.hostname==='embed.st')return new Response('<!doctype html><body style="margin:0"><div id="player"><iframe src="https://media-fixture.example/player" style="width:640px;height:360px;border:0"></iframe></div>',{headers:{'content-type':'text/html'}});
        if(url.pathname==='/player')return new Response(`<!doctype html><body style="margin:0"><div id="player"><video controls autoplay muted style="width:640px;height:360px"></video><button>Provider controls</button></div><script src="/hls.js"></script><script>
          window.fixtureMediaErrors=[];window.hls=new Hls();hls.on(Hls.Events.ERROR,(_event,data)=>window.fixtureMediaErrors.push({type:data.type,details:data.details,fatal:data.fatal,message:data.error?.message,code:data.response?.code}));hls.attachMedia(document.querySelector('video'));hls.loadSource('/master.m3u8');hls.on(Hls.Events.MANIFEST_PARSED,()=>document.querySelector('video').play());
        </script>`,{headers:{'content-type':'text/html'}});
        if(url.pathname==='/live.m3u8')return new Response((await fs.readFile(join(directory,'quality0.m3u8'),'utf8')).replace('#EXT-X-PLAYLIST-TYPE:VOD\n','').replace('#EXT-X-ENDLIST',''),{headers:{'content-type':'application/vnd.apple.mpegurl'}});
        const file=url.pathname==='/hls.js'?join(root,'node_modules/hls.js/dist/hls.js'):
          /^\/(?:master|quality[01])\.m3u8$|^\/segment[01]-\d{3}\.ts$/.test(url.pathname)?join(directory,url.pathname.slice(1)):null;
        if(!file)return new Response('',{status:404});
        return new Response(await fs.readFile(file),{headers:{'content-type':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.m3u8')?'application/vnd.apple.mpegurl':'video/mp2t'}});
      });return player;},
    createView(preferences){const view=new WebContentsView({webPreferences:preferences});views.push(view);viewContents.set(view,view.webContents);
      if(preferences.preload){view.webContents.on('did-start-navigation',(_event,url,inPlace,main)=>navigation.push({url,inPlace,main}));view.webContents.on('did-finish-load',()=>navigation.push({finished:true}));}
      return view;}});
  const page=expression=>host.webContents.executeJavaScript(expression,true);
  const controls=expression=>chrome.webContents.executeJavaScript(expression,true);
  const click=async label=>{
    const expression=`(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim().startsWith(${JSON.stringify(label)})||button.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)return false;button.click();return true;})()`;
    if(!await page(expression)&&!await controls(expression))throw new Error('Missing control '+label);
  };
  async function pointAt(x,y,click=false){
    if(process.platform!=='win32'){chrome.webContents.sendInputEvent({type:'mouseMove',x,y});return;}
    const windowBounds=host.getContentBounds(),viewBounds=chrome.getBounds();
    const point=screen.dipToScreenPoint({x:windowBounds.x+viewBounds.x+Math.round(x),y:windowBounds.y+viewBounds.y+Math.round(y)});
    const script=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class PlayerPointer{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);}'\n[PlayerPointer]::SetCursorPos(${point.x},${point.y})|Out-Null\n${click?'[PlayerPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[PlayerPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)':''}`;
    await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});
  }
  async function until(read,message,timeout=8000){const end=Date.now()+timeout;while(Date.now()<end){if(await read())return;await wait(100);}throw new Error(message);}
  async function closeNativePip(){
    const script=`Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class PipWindow{public delegate bool Callback(IntPtr handle,IntPtr parameter);[DllImport("user32.dll")]public static extern bool EnumWindows(Callback callback,IntPtr parameter);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint id);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr handle,uint message,IntPtr wparam,IntPtr lparam);}
'@
$script:pipHandle=[IntPtr]::Zero
[PipWindow]::EnumWindows({param($handle,$parameter);[uint32]$windowPid=0;[PipWindow]::GetWindowThreadProcessId($handle,[ref]$windowPid)|Out-Null;if($windowPid -eq ${process.pid}){$title=New-Object System.Text.StringBuilder 256;[PipWindow]::GetWindowText($handle,$title,256)|Out-Null;if($title.ToString() -match '^Picture.in.picture$'){$script:pipHandle=$handle}};return $true},[IntPtr]::Zero)|Out-Null
if($script:pipHandle -eq [IntPtr]::Zero){throw 'Native PiP window was not found.'}
[PipWindow]::SendMessage($script:pipHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null`;
    await require('node:util').promisify(require('node:child_process').execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true});
  }
  try{
    host=new BrowserWindow({show:false,x:100,y:100,width:850,height:620,alwaysOnTop:true,webPreferences:{session:own,preload:join(directory,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    factory.registerHost(host,origin,'viewing');
    for(const action of actions)ipcMain.handle('player-controls-test:'+action,async(event,value)=>{const result=await factory[action](event,value);return action==='control'?result:{kind:'ready'};});
    capability=await factory.offer({target:{sessionId:randomUUID(),candidateId:'controls',gameId:'nba-fixture',generation:0},player:{url:'https://embed.st/embed/basketball/game/1',referer:'https://ppv.st/events/game'}});
    await host.loadURL(origin+'/');host.showInactive();
    await until(()=>page(`!!document.querySelector('.isolated-player')&&!document.querySelector('.player-message')`),'Embedded fixture did not decode');
    stage='shared player controls';
    chrome=host.contentView.children.find(view=>view.webContents?.getURL()===origin+'/player-controls');
    assert.ok(chrome,'Embedded feeds must use the shared hover player controls over their video');
    await until(()=>controls(`!!document.querySelector('[aria-label="Focused stream controls"]')`),'Shared controls did not render');
    await until(()=>chrome.getVisible(),'The transparent controls document must become visible after startup');
    await controls('history.replaceState(history.state,"",location.href)');await wait(100);
    assert.equal(chrome.getVisible(),true,'Same-page navigation must preserve the ready custom controls');
    const nativeButtons=await controls(`Array.from(document.querySelectorAll('[aria-label="Focused stream controls"] button'),button=>button.getAttribute('aria-label'))`);
    stage='native hover';host.show();host.focus();
    await pointAt(220,160);
    await until(()=>controls(`getComputedStyle(document.querySelector('.player-controls')).opacity==='1'`),'Native pointer movement must reveal the custom controls');
    await wait(3300);
    assert.equal(await controls(`getComputedStyle(document.querySelector('.player-controls')).opacity`),'0','Native controls must hide after the same idle delay as direct video');
    await pointAt(400,180);
    await until(()=>controls(`getComputedStyle(document.querySelector('.player-controls')).opacity==='1'`),'Native pointer movement must restore the custom controls');
    stage='room fullscreen shortcut';chrome.webContents.focus();await controls('document.activeElement?.blur()');
    chrome.webContents.sendInputEvent({type:'keyDown',keyCode:'F'});chrome.webContents.sendInputEvent({type:'keyUp',keyCode:'F'});
    await until(()=>page('document.fullscreenElement===document.documentElement'),'F over embedded video must enter room fullscreen');
    chrome.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});chrome.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until(()=>page('!document.fullscreenElement'),'Escape over embedded video must leave room fullscreen');
    stage='quality control';
    assert.equal(await controls(`!!document.querySelector('button[aria-label="Video quality"]')`),true,'Embedded feeds must expose the custom quality control');
    assert.equal(await controls(`!!document.querySelector('button[aria-label="Picture in picture"]')`),true,'Embedded feeds must expose picture in picture');
    const contents=views[0].webContents,frame=contents.mainFrame.framesInSubtree.find(frame=>frame.url==='https://media-fixture.example/player');
    const media=expression=>frame.executeJavaScript(expression,true);
    const height=()=>media(`document.querySelector('video').videoHeight`);
    const nativeBounds=views[0].getBounds(),beforeMenu=await media('document.querySelector("video").currentTime');
    const qualityButton=await controls(`(()=>{const bounds=document.querySelector('button[aria-label="Video quality"]').getBoundingClientRect();return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};})()`);
    await pointAt(qualityButton.x,qualityButton.y,true);
    await until(()=>controls(`!!document.querySelector('.player-settings')`),'A native pointer click must open the custom quality menu');
    await wait(800);
    assert.equal(contents.isAudioMuted(),true,'Opening settings for the focused player must preserve muted audio');
    assert.equal(views[0].getVisible(),true,'The quality menu must leave native video visible');
    assert.deepEqual(views[0].getBounds(),nativeBounds,'Opening controls must preserve the video bounds');
    await until(async()=>await media('document.querySelector("video").currentTime')>beforeMenu+.5,'Video must advance behind the custom quality menu');
    await click('Auto');
    stage='server dropdown';host.show();host.focus();host.webContents.focus();await wait(300);
    await page(`(()=>{const select=document.querySelector('select[aria-label="Fixture servers"]');select.focus();select.showPicker();})()`);await wait(700);
    assert.equal(await page(`!!document.querySelector('select:open')`),true,'The real server dropdown must stay open during verification');
    assert.equal(views[0].getVisible(),true,'Opening the server dropdown must keep embedded video visible');
    const dropdownTime=await media(`document.querySelector('video').currentTime`);
    await until(async()=>await media(`document.querySelector('video').currentTime`)>dropdownTime+.5,'Video must keep playing while the server dropdown is open');
    assert.equal(await page(`!!document.querySelector('select:open')`),true,'The server dropdown must stay open while video plays');
    host.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});host.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    stage='focus controls';
    await click('Video quality');await until(()=>controls(`!!document.querySelector('.player-settings')`),'Quality settings did not open');
    await click('Unfocus fixture');await until(()=>!chrome.getVisible(),'Controls must hide when the stream loses focus');
    await until(()=>controls(`!document.querySelector('.player-settings')`),'Quality settings must close when the stream loses focus');
    assert.equal(await controls(`document.querySelectorAll('button,input').length`),0,'Unfocused embedded streams must not expose player controls');
    const unfocusedTime=await media(`document.querySelector('video').currentTime`);
    await until(async()=>await media(`document.querySelector('video').currentTime`)>unfocusedTime+.5,'Removing player controls must preserve unfocused playback');
    await click('Focus fixture');await until(()=>controls(`!!document.querySelector('button[aria-label="Video quality"]')`),'Player controls must return when the stream gains focus');
    stage='quality control';
    await click('Video quality');
    await until(()=>controls(`document.querySelector('.player-settings')?.textContent.includes('216p')&&document.querySelector('.player-settings')?.textContent.includes('360p')`),'Quality menu did not list actual variants');
    await click('216p');await until(async()=>await height()===216,'Choosing 216p did not change the decoded video');
    const low=await height();
    await click('Video quality');await click('360p');await until(async()=>await height()===360,'Choosing 360p did not change the decoded video');
    const high=await height();
    await click('Video quality');await click('Auto');
    await until(()=>media('hls.autoLevelEnabled'),'Auto did not restore adaptive playback');
    await click('Prefer 360p');await until(()=>media('hls.manualLevel===1'),'Saved quality preference was not applied');
    stage='picture in picture';
    await click('Picture in picture');await until(()=>media('document.pictureInPictureElement===document.querySelector("video")'),'The selected embedded video did not enter PiP');
    await click('Pause stream');await until(()=>media('document.querySelector("video").paused'),'Custom pause did not control PiP');
    await click('Play stream');await until(()=>media('!document.querySelector("video").paused'),'Custom play did not control PiP');
    await media('document.querySelector("video").pause()');await wait(1200);
    assert.equal(await media('document.querySelector("video").paused'),true,'Polling must preserve a native PiP pause');
    assert.equal(await controls(`!!document.querySelector('button[aria-label="Play stream"]')`),true,'Native PiP pause must update the custom controls');
    if(process.platform==='win32')await closeNativePip();else await media('document.exitPictureInPicture()');
    await wait(800);
    assert.equal(await media('document.querySelector("video").paused'),true,'Closing paused PiP must not restart playback');
    assert.equal(await media('document.pictureInPictureElement===null'),true,'Closing PiP must not reopen it');
    await click('Play stream');await until(()=>media('!document.querySelector("video").paused'),'Custom play did not resume video');
    await until(()=>controls(`!!document.querySelector('button[aria-label="Picture in picture"]')`),'PiP button did not reset after native close');
    stage='native keyboard';
    chrome.webContents.focus();await controls('document.activeElement?.blur()');
    chrome.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});chrome.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await until(()=>media('document.querySelector("video").paused'),'Space over embedded video must pause the focused stream');
    chrome.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});chrome.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await until(()=>media('!document.querySelector("video").paused'),'Space over embedded video must resume the focused stream');
    stage='fullscreen';await click('Fullscreen stream');
    await until(async()=>await page(`!!document.fullscreenElement`)&&await controls(`!!document.querySelector('button[aria-label="Exit fullscreen stream"]')`),'Fullscreen control did not update');
    await click('Unfocus fixture');
    await until(async()=>!await page('!!document.fullscreenElement')&&!chrome.getVisible(),'Losing native player focus must leave fullscreen and hide its controls');
    await click('Focus fixture');
    await until(()=>chrome.getVisible(),'Native controls did not return after focus change');
    await click('Fullscreen stream');
    await until(async()=>await page('!!document.fullscreenElement')&&await controls(`!!document.querySelector('button[aria-label="Exit fullscreen stream"]')`),'Native fullscreen did not return after focus change');
    await click('Exit fullscreen stream');await until(()=>page('!document.fullscreenElement'),'Fullscreen did not exit');
    stage='live indicator';await media(`hls.loadSource('/live.m3u8')`);
    await until(()=>controls(`document.querySelector('.player-live')?.textContent==='LIVE'`),'The custom live indicator did not reflect the live playlist');
    const isolated=await media('({inert:document.documentElement.inert,nativeControls:document.querySelector("video").controls})');
    stage='direct parity';await click('Use direct player');
    await until(()=>page(`document.querySelector('video')?.readyState>=2`),'Direct fixture did not decode');
    await until(()=>!chrome.getVisible(),'Direct playback must hide the native controls overlay');
    const directButtons=await page(`Array.from(document.querySelectorAll('[aria-label="Focused stream controls"] button'),button=>button.getAttribute('aria-label'))`);
    assert.deepEqual(directButtons,nativeButtons,'Direct and embedded feeds must render the same custom controls in the same order');
    assert.equal(host.contentView.children.filter(view=>view.webContents?.getURL()===origin+'/player-controls').length,1,'Focus changes must reuse one native controls overlay');
    await click('Unfocus fixture');
    await until(()=>page(`!document.querySelector('[aria-label="Focused stream controls"]')`),'Unfocused direct playback must remove custom controls');
    return {shared:{buttons:directButtons,productionRoute:true,samePageNavigation:true,nativeHover:true,oneOverlay:true},dropdown:{open:true,videoVisible:true,playbackContinues:true},focus:{controlsHidden:true,settingsClosed:true,playbackContinues:true,controlsRestored:true},quality:{low,high,auto:true,preference:true},pip:{entered:true,nativePausePreserved:true,pausedClosePreserved:true,closed:true},fullscreen:true,live:true,isolated};
  }catch(error){return {failure:error.message,stage,requests,navigation,chrome:chrome&&!viewContents.get(chrome)?.isDestroyed()?{visible:chrome.getVisible(),body:await controls('document.body.innerText'),state:await controls('({ready:document.readyState,classes:document.documentElement.className})')}:null,body:host&&!host.isDestroyed()?await page('document.body.innerText'):null,
    frames:await Promise.all([...viewContents.values()].filter(contents=>!contents.isDestroyed()).flatMap(contents=>contents.mainFrame.framesInSubtree).map(async frame=>({url:frame.url,
      media:await frame.executeJavaScript(`(()=>{const video=document.querySelector('video');return video?{paused:video.paused,readyState:video.readyState,height:video.videoHeight,time:video.currentTime,error:video.error?.message,src:video.currentSrc,levels:window.hls?.levels.length,manualLevel:window.hls?.manualLevel,hlsErrors:window.fixtureMediaErrors}:null})()`).catch(error=>({error:error.message}))}))) };
  }
  finally{await factory.stop();for(const action of actions)ipcMain.removeHandler('player-controls-test:'+action);if(host&&!host.isDestroyed())host.destroy();own.protocol.unhandle('http');for(const player of sessions)player.protocol.unhandle('https');}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolveResult,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Player controls verification timed out')),75000);
    socket.addEventListener('message',event=>{const reply=JSON.parse(event.data);if(reply.id!==1)return;clearTimeout(timer);if(reply.error||reply.result.exceptionDetails)reject(new Error(JSON.stringify(reply.error??reply.result.exceptionDetails)));else resolveResult(reply.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)},${JSON.stringify(directory)})`,awaitPromise:true,returnByValue:true}}));
  });
  await mkdir(resolve('.scratch'),{recursive:true});await writeFile(resolve(process.argv[2]??'.scratch/player-controls-features.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));assert.equal(result.failure,undefined,result.failure);
  assert.deepEqual(result.dropdown,{open:true,videoVisible:true,playbackContinues:true});
  assert.deepEqual(result.focus,{controlsHidden:true,settingsClosed:true,playbackContinues:true,controlsRestored:true});
  assert.deepEqual(result.quality,{low:216,high:360,auto:true,preference:true});
  assert.equal(result.live,true);
  assert.deepEqual(result.isolated,{inert:true,nativeControls:false});
}finally{socket.close();}
