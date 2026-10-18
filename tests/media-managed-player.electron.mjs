import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const root=resolve('.'),directory=resolve('.desktop-runtime/media-audit-fixes/managed-player');
await mkdir(directory,{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','30','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',resolve(directory,'fixture.mp4'),
],{windowsHide:true,timeout:20000});
await build({stdin:{contents:`
  import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {ManagedPlayer} from './components/managed-player';
  const originalTimeout=window.setTimeout.bind(window);
  const originalNow=performance.now.bind(performance);
  window.fixtureElapsed=0;window.fixtureTimeouts=[];
  Object.defineProperty(performance,'now',{configurable:true,value:()=>originalNow()+window.fixtureElapsed});
  window.setTimeout=(callback,delay,...args)=>{window.fixtureTimeouts.push(delay);return originalTimeout(callback,window.fixtureFastTimeout&&delay>=55000?600:delay,...args);};
  function Fixture(){
    const [source,setSource]=useState('direct'),[playing,setPlaying]=useState(true),[audible,setAudible]=useState(false),[volume,setVolume]=useState(50),[dialog,setDialog]=useState(false),[mounted,setMounted]=useState(true);
    window.fixtureSource=source;
    const feed={label:source,url:location.origin+'/api/stream/nba-fixture/index.m3u8?session=00000000-0000-4000-8000-000000000001&candidate='+source+'&generation=0'};
    return <><nav>{['direct','near-deadline','no-progress','progress-freeze','hard-deadline','viewer-retry','viewer-cancel','viewer-too-late','embed','lazy-fallback','lazy-cancel','fallback-expired','late-recovery','timeout','upstream','capacity'].map(value=><button key={value} onClick={()=>{window.fixtureFastTimeout=value==='timeout';setMounted(true);setSource(value)}}>{value}</button>)}<button onClick={()=>setDialog(true)}>Open settings</button><button onClick={()=>setMounted(false)}>Remove player</button></nav>
      <main>{mounted&&<ManagedPlayer purpose={source==='capacity'?'verification':undefined} feed={feed} focused={false} audible={audible} playing={playing} volume={volume} defaultQuality="auto" onPlayingChange={setPlaying} onAudibleChange={setAudible} onVolumeChange={setVolume} onDecoded={(_url,proof,timings)=>{window.fixtureProofs.push({source,proof,timings})}} onFatal={(_url,reason,phase)=>window.fixtureFailures.push({source,reason,phase})} onDeferred={(_url,reason,details)=>window.fixtureDeferrals.push({source,reason,...details})} onRetry={()=>{window.fixtureRetries++;setMounted(false)}}/>}</main>
      {dialog&&<div role="dialog"><strong>Settings</strong><button onClick={()=>setDialog(false)}>Close settings</button></div>}</>;
  }
  window.fixtureProofs=[];window.fixtureFailures=[];window.fixtureDeferrals=[];window.fixtureRetries=0;window.fixtureActivity=[];
  for(const event of ['loadeddata','playing','timeupdate'])document.addEventListener(event,({target})=>{if(target instanceof HTMLVideoElement)window.fixtureActivity.push({source:window.fixtureSource,event,currentTime:target.currentTime,readyState:target.readyState,frames:target.getVideoPlaybackQuality().totalVideoFrames,error:target.error?.code??null})},true);
  createRoot(document.getElementById('root')).render(<Fixture/>);
`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},outfile:resolve(directory,'fixture.js'),logLevel:'silent'});
await writeFile(resolve(directory,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('sundayPlayer',{
  mount:value=>ipcRenderer.invoke('media-audit-ui:mount',value),update:value=>ipcRenderer.invoke('media-audit-ui:update',value),release:value=>ipcRenderer.invoke('media-audit-ui:release',value),
  subscribe:listener=>{const wrapped=(_event,value)=>listener(value);ipcRenderer.on('sunday-player:state',wrapped);return()=>ipcRenderer.removeListener('sunday-player:state',wrapped);}
});`);

async function verify(root,directory){
  const require=process.mainModule.require.bind(process.mainModule),{BrowserWindow,WebContentsView,session,ipcMain}=process.mainModule.require('electron');
  const {join}=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
  const {createIsolatedPlayers}=require(join(root,'desktop/isolated-player.cjs'));
  const own=session.fromPartition('media-ui-host-'+randomUUID()),views=[],sessions=[],requests=[],presentationRequests=[],presentationMoments=[];
  const origin='http://127.0.0.1:9000',capabilities={};
  let nearDeadlineReadyAt=0,nearDeadlineFallbackSnapshot=null;
  const media=await fs.readFile(join(directory,'fixture.mp4'));
  function video(request){
    const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range')||'');
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(media.length-1,Number(range[2])):media.length-1;
    return new Response(media.subarray(start,end+1),{status:range?206:200,headers:{'content-type':'video/mp4','accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${media.length}`}:{})}});
  }
  own.protocol.handle('http',async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/')return new Response(`<!doctype html><style>body{margin:0;background:#181a20;color:white;font:16px sans-serif}nav{height:50px;display:flex;gap:10px;align-items:center}button{padding:8px}main{height:440px;width:780px;margin:12px}.native-player{height:100%;width:100%;position:relative}video{height:100%;width:100%}.player-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:12px}.player-control-row{display:flex;align-items:center;gap:10px}.player-source{flex:1}[role=dialog]{position:fixed;z-index:100;inset:130px 220px;background:#335;padding:25px}</style><div id="root"></div><script src="/fixture.js"></script>`,{headers:{'content-type':'text/html'}});
    if(url.pathname==='/fixture.js')return new Response(await fs.readFile(join(directory,'fixture.js')),{headers:{'content-type':'text/javascript'}});
    if(url.pathname.endsWith('/presentation')){
      const candidate=url.searchParams.get('candidate'),intent=url.searchParams.get('intent');
      presentationRequests.push(request.url);
      presentationMoments.push({candidate,intent,at:Date.now()});
      if(intent==='fallback'){
        if(candidate==='lazy-cancel')await new Promise(resolve=>setTimeout(resolve,2500));
        if(candidate==='near-deadline')nearDeadlineFallbackSnapshot=await host.webContents.executeJavaScript(`(()=>{const video=document.querySelector('video');return video?{currentTime:video.currentTime,readyState:video.readyState,frames:video.getVideoPlaybackQuality().totalVideoFrames,error:video.error?.code??null}:null})()`);
        return Response.json({kind:'isolated-embed',capability:capabilities[candidate]});
      }
      if(['viewer-retry','viewer-cancel'].includes(candidate)&&presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')===candidate).length===1)
        return new Response('',{status:503,headers:{'retry-after':'2'}});
      if(candidate==='viewer-too-late')return new Response('',{status:503,headers:{'retry-after':'90'}});
      if(candidate==='capacity')return new Response('',{status:429,headers:{'retry-after':'2'}});
      const fallbackUrl='/api/stream/nba-fixture/presentation?session=00000000-0000-4000-8000-000000000001&candidate='+candidate+'&generation=0&intent=fallback';
      if(candidate==='fallback-expired')await host.webContents.executeJavaScript('window.fixtureElapsed+=59000');
      return Response.json(['direct','late-recovery','near-deadline','no-progress','progress-freeze','hard-deadline'].includes(candidate)?{kind:'progressive',url:'/api/stream/media/'+(candidate==='near-deadline'?'b':candidate==='no-progress'?'c':'a').repeat(48),fallbackUrl}:
        ['lazy-fallback','lazy-cancel','fallback-expired'].includes(candidate)?{kind:'hls',url:'/api/stream/nba-fixture/index.m3u8?bad=1',fallbackUrl}:
          ['viewer-retry','viewer-cancel'].includes(candidate)?{kind:'progressive',url:'/api/stream/media/'+'a'.repeat(48)}:
            {kind:'isolated-embed',capability:capabilities[candidate]});
    }
    if(url.pathname==='/api/stream/media/'+'a'.repeat(48))return video(request);
    if(url.pathname==='/api/stream/media/'+'b'.repeat(48)){
      if(!nearDeadlineReadyAt)nearDeadlineReadyAt=Date.now()+10500;
      const delay=nearDeadlineReadyAt-Date.now();
      if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      return video(request);
    }
    if(url.pathname==='/api/stream/media/'+'c'.repeat(48)){
      await new Promise(resolve=>{const timer=setTimeout(resolve,30000);request.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true});});
      return new Response('',{status:499});
    }
    return new Response('',{status:422});
  });
  const factory=createIsolatedPlayers({authorizeTarget:async()=>true,
    createSession(){const player=session.fromPartition('media-ui-player-'+randomUUID());sessions.push(player);
      player.protocol.handle('https',request=>{requests.push(request.url);const url=new URL(request.url);
        if(url.href==='https://embed.st/embed/basketball/game/1')return new Response('<!doctype html><body style="margin:0"><div id="player"><video autoplay muted loop src="https://media-fixture.example/game.mp4" style="width:640px;height:360px"></video></div>',{headers:{'content-type':'text/html'}});
        if(url.href==='https://embed.st/embed/basketball/game/2')return new Response('<!doctype html><body style="margin:0"><div id="player"><video style="width:640px;height:360px"></video></div>',{headers:{'content-type':'text/html'}});
        if(url.href==='https://media-fixture.example/game.mp4')return video(request);
        return new Response('',{status:404});});return player;},
    createView(preferences){const view=new WebContentsView({webPreferences:preferences});views.push(view);return view;}});
  const host=new BrowserWindow({show:false,width:850,height:620,webPreferences:{session:own,preload:join(directory,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(expression,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await host.webContents.executeJavaScript(expression))return;await wait(100);}throw new Error(message);}
  const click=label=>host.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)}||button.getAttribute('aria-label')===${JSON.stringify(label)});if(!button)throw new Error('Missing control');button.click();})()`,true);
  const active=()=>views.filter(view=>{try{return !view.webContents.isDestroyed();}catch{return false;}});
  let stage='setup',isolatedCaptureFailure=null;
  try{
    factory.registerHost(host,origin,'viewing');
    for(const action of ['mount','update','release'])ipcMain.handle('media-audit-ui:'+action,async(event,value)=>{try{await factory[action](event,value);return {kind:'ready'};}catch(error){if(error.name==='PlayerCapacityError')return {kind:'capacity'};throw error;}});
    for(const candidateId of ['embed','near-deadline','no-progress','progress-freeze','hard-deadline','lazy-fallback','lazy-cancel','fallback-expired','late-recovery','timeout','upstream'])capabilities[candidateId]=await factory.offer({target:{sessionId:randomUUID(),candidateId,gameId:'nba-fixture',generation:0},player:{url:'https://embed.st/embed/basketball/game/'+(['timeout','upstream'].includes(candidateId)?'2':'1'),referer:'https://ppv.st/events/game'}});
    await host.loadURL(origin+'/');host.showInactive();
    await until(`window.fixtureProofs?.some(value=>value.source==='direct')`,'Progressive ManagedPlayer did not decode');
    const directRequests=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='direct');
    const direct={proofs:await host.webContents.executeJavaScript('window.fixtureProofs'),nativeViews:views.length,
      primaryRequests:directRequests.filter(value=>new URL(value).searchParams.get('intent')===null).length,
      fallbackRequests:directRequests.filter(value=>new URL(value).searchParams.get('intent')==='fallback').length};
    stage='near-deadline';await click('near-deadline');
    await until(`window.fixtureProofs.some(value=>value.source==='near-deadline')`,'Near-deadline direct media never produced playback proof',18000);
    const nearDeadlineRequests=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='near-deadline');
    const nearDeadline={fallbackRequests:nearDeadlineRequests.filter(value=>new URL(value).searchParams.get('intent')==='fallback').length,
      fallbackSnapshot:nearDeadlineFallbackSnapshot,
      proofPaths:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='near-deadline').map(value=>value.timings?.path)`),
      activity:await host.webContents.executeJavaScript(`window.fixtureActivity.filter(value=>value.source==='near-deadline')`) };
    stage='no-progress';await click('no-progress');
    await until(`window.fixtureProofs.some(value=>value.source==='no-progress')`,'No-progress direct media did not reach fallback',18000);
    const noProgressMoments=presentationMoments.filter(value=>value.candidate==='no-progress');
    const noProgress={fallbackRequests:noProgressMoments.filter(value=>value.intent==='fallback').length,
      fallbackAfterMs:noProgressMoments.find(value=>value.intent==='fallback')?.at-noProgressMoments.find(value=>value.intent===null)?.at,
      proofPaths:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='no-progress').map(value=>value.timings?.path)`) };
    stage='progress-freeze';await click('progress-freeze');
    await until(`window.fixtureActivity.some(value=>value.source==='progress-freeze'&&value.currentTime>.5&&value.frames>0)`,'Progress-freeze direct media never began advancing');
    await host.webContents.executeJavaScript(`document.querySelector('video').playbackRate=0`);
    await until(`window.fixtureProofs.some(value=>value.source==='progress-freeze')`,'A started then frozen direct player did not reach fallback',22000);
    const frozenMoments=presentationMoments.filter(value=>value.candidate==='progress-freeze');
    const progressFreeze={fallbackRequests:frozenMoments.filter(value=>value.intent==='fallback').length,
      fallbackAfterMs:frozenMoments.find(value=>value.intent==='fallback')?.at-frozenMoments.find(value=>value.intent===null)?.at,
      proofPaths:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='progress-freeze').map(value=>value.timings?.path)`) };
    stage='hard-deadline';await click('hard-deadline');
    await until(`window.fixtureActivity.some(value=>value.source==='hard-deadline'&&value.currentTime>.5&&value.frames>0)`,'Hard-deadline direct media never began advancing');
    await host.webContents.executeJavaScript(`(()=>{const video=document.querySelector('video');video.playbackRate=0;window.fixtureHardTimer=setInterval(()=>{window.fixtureElapsed+=3000;video.currentTime+=.3},1900)})()`);
    await until(`window.fixtureDeferrals.some(value=>value.source==='hard-deadline'&&value.reason==='timeout')`,'The original startup deadline did not settle advancing but unproved media',30000);
    await host.webContents.executeJavaScript(`clearInterval(window.fixtureHardTimer)`);
    const hardMoments=presentationMoments.filter(value=>value.candidate==='hard-deadline');
    const hardDeadline={fallbackRequests:hardMoments.filter(value=>value.intent==='fallback').length,
      deferrals:await host.webContents.executeJavaScript(`window.fixtureDeferrals.filter(value=>value.source==='hard-deadline')`) };
    await click('viewer-retry');await until(`window.fixtureProofs.some(value=>value.source==='viewer-retry')`,'Viewer did not recover from a transient presentation response',10000);
    const viewerRetryUrls=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='viewer-retry');
    const viewerRetry={requests:viewerRetryUrls.length,sameUrl:new Set(viewerRetryUrls).size===1,
      callbackRetries:await host.webContents.executeJavaScript('window.fixtureRetries'),nativeViews:active().length};
    await click('viewer-cancel');await until(`document.body.innerText.includes('Connecting to your feed')`,'Cancelable viewer retry did not begin');await wait(300);
    await click('direct');await until(`window.fixtureProofs.filter(value=>value.source==='direct').length===2`,'Replacement feed did not decode');await wait(2500);
    const canceledRetryRequests=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='viewer-cancel').length;
    await click('viewer-too-late');await until(`document.querySelector('.player-message strong')?.textContent==='Connection delayed'`,'Out-of-budget viewer deferral did not settle');
    const viewerTooLate={requests:presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='viewer-too-late').length,
      label:await host.webContents.executeJavaScript(`document.querySelector('.player-message strong')?.textContent`)};
    await click('embed');await until(`window.fixtureProofs.some(value=>value.source==='embed')`,'Isolated ManagedPlayer did not decode');
    const embed=active()[0],contents=embed.webContents;
    const sample=()=>contents.executeJavaScript(`(()=>{const v=document.querySelector('video');return {time:v.currentTime,frames:v.getVideoPlaybackQuality().totalVideoFrames,paused:v.paused,volume:v.volume,muted:v.muted}})()`);
    stage='controls';const initial=await sample(),bounds=embed.getBounds();
    await click('Pause stream');await wait(700);const paused=await sample();
    await click('Play stream');await wait(2200);const resumed=await sample();
    await click('Unmute stream');await wait(600);const audio=await sample();
    await click('Open settings');await wait(600);const dialogHidden=!embed.getVisible()&&contents.isAudioMuted();
    await click('Close settings');await wait(600);const dialogRestored=embed.getVisible();
    stage='fullscreen';await click('Fullscreen stream');await until(`!!document.fullscreenElement`,'Fullscreen did not enter');await wait(600);
    const fullscreen={bounds:embed.getBounds(),active:await host.webContents.executeJavaScript('!!document.fullscreenElement')};
    await host.webContents.executeJavaScript('document.exitFullscreen()');await wait(600);
    stage='host-capture';await fs.writeFile(join(directory,'player-controls.png'),(await host.webContents.capturePage()).toPNG());
    stage='player-capture';try{await fs.writeFile(join(directory,'decoded-video.png'),(await contents.capturePage()).toPNG());}
    catch(error){isolatedCaptureFailure=error instanceof Error?error.message:String(error);}
    stage='fallback';await click('lazy-fallback');await until(`window.fixtureProofs.some(value=>value.source==='lazy-fallback')`,'Direct failure did not request and play its isolated fallback',15000);
    const lazyRequests=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='lazy-fallback');
    const switched={oldClosed:contents.isDestroyed(),activeViews:active().length,primaryRequests:lazyRequests.filter(value=>new URL(value).searchParams.get('intent')===null).length,
      fallbackRequests:lazyRequests.filter(value=>new URL(value).searchParams.get('intent')==='fallback').length};
    await click('Remove player');await wait(800);const removed=active().length;
    stage='fallback-cancel';await click('lazy-cancel');
    const cancelDeadline=Date.now()+5000;while(!presentationRequests.some(value=>{const url=new URL(value);return url.searchParams.get('candidate')==='lazy-cancel'&&url.searchParams.get('intent')==='fallback';})&&Date.now()<cancelDeadline)await wait(100);
    if(Date.now()>=cancelDeadline)throw new Error('Cancelable fallback request did not start');
    await click('direct');await until(`window.fixtureProofs.filter(value=>value.source==='direct').length>=3`,'Replacement direct player did not decode');await wait(2700);
    const canceledFallback={requests:presentationRequests.filter(value=>{const url=new URL(value);return url.searchParams.get('candidate')==='lazy-cancel'&&url.searchParams.get('intent')==='fallback';}).length,
      proofs:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='lazy-cancel').length`),activeViews:active().length};
    stage='fallback-budget';await click('fallback-expired');
    await until(`document.querySelector('.player-message strong')?.textContent==='Connection delayed'`,'Exhausted startup budget did not settle as deferred',10000);
    const expiredFallback={requests:presentationRequests.filter(value=>{const url=new URL(value);return url.searchParams.get('candidate')==='fallback-expired'&&url.searchParams.get('intent')==='fallback';}).length,
      deferrals:await host.webContents.executeJavaScript(`window.fixtureDeferrals.filter(value=>value.source==='fallback-expired')`)};
    stage='late-recovery';await host.webContents.executeJavaScript('window.fixtureTimeouts=[]');await click('late-recovery');
    await until(`window.fixtureProofs.some(value=>value.source==='late-recovery')`,'Late-recovery primary did not decode');
    await host.webContents.executeJavaScript('window.fixtureElapsed+=120000');await wait(2200);
    await host.webContents.executeJavaScript(`(()=>{const video=document.querySelector('video');video.dispatchEvent(new Event('error'));video.dispatchEvent(new Event('error'));})()`);
    await until(`window.fixtureProofs.filter(value=>value.source==='late-recovery').length>=2`,'Proven viewer did not play its bounded late fallback',15000);
    const recoveryCapability=capabilities['late-recovery'];
    host.webContents.send('sunday-player:state',{capability:recoveryCapability,kind:'failed',reason:'upstream'});
    host.webContents.send('sunday-player:state',{capability:recoveryCapability,kind:'failed',reason:'upstream'});await wait(300);
    const lateRequests=presentationRequests.filter(value=>new URL(value).searchParams.get('candidate')==='late-recovery');
    const lateRecovery={fallbackRequests:lateRequests.filter(value=>new URL(value).searchParams.get('intent')==='fallback').length,
      longTimeouts:await host.webContents.executeJavaScript(`window.fixtureTimeouts.filter(value=>value>=50000&&value<=60000)`),activeViews:active().length};
    await click('timeout');await until(`window.fixtureFailures.some(value=>value.source==='timeout')`,'The non-decoding player did not reach its startup timeout');await wait(200);
    const failedViews=active().length;
    host.webContents.send('sunday-player:state',{capability:capabilities.timeout,kind:'decoded',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:2100,mediaAdvanceMs:2100,presentedFrames:50}});await wait(100);
    const terminal={activeViews:failedViews,lateProofs:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='timeout').length`)};
    await click('upstream');
    const mountDeadline=Date.now()+5000;while(active().length===0&&Date.now()<mountDeadline)await wait(100);
    if(active().length!==1)throw new Error('Upstream failure fixture did not mount');
    host.webContents.send('sunday-player:state',{capability:capabilities.upstream,kind:'failed',reason:'upstream'});await wait(300);
    host.webContents.send('sunday-player:state',{capability:capabilities.upstream,kind:'decoded',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:2100,mediaAdvanceMs:2100,presentedFrames:50}});await wait(100);
    const upstream={activeViews:active().length,lateProofs:await host.webContents.executeJavaScript(`window.fixtureProofs.filter(value=>value.source==='upstream').length`)};
    await click('capacity');await until(`!![...document.querySelectorAll('button')].find(button=>button.textContent==='Try again')`,'Capacity response did not expose retry');
    await click('Try again');const retries=await host.webContents.executeJavaScript('window.fixtureRetries');
    return {direct,nearDeadline,noProgress,progressFreeze,hardDeadline,viewerRetry,canceledRetryRequests,viewerTooLate,initial,bounds,paused,resumed,audio,dialogHidden,dialogRestored,fullscreen,switched,removed,canceledFallback,expiredFallback,lateRecovery,terminal,upstream,retries,isolatedCaptureFailure,
      proofs:await host.webContents.executeJavaScript('window.fixtureProofs'),failures:await host.webContents.executeJavaScript('window.fixtureFailures'),deferrals:await host.webContents.executeJavaScript('window.fixtureDeferrals'),sessionAllocations:sessions.length};
  }catch(error){return {failure:error.message,failureStack:error.stack,stage,presentationRequests,playerRequests:requests,views:views.length,
    body:!host.isDestroyed()?await host.webContents.executeJavaScript('document.body.innerText'):null};}
  finally{await factory.stop();for(const action of ['mount','update','release'])ipcMain.removeHandler('media-audit-ui:'+action);host.destroy();own.protocol.unhandle('http');for(const player of sessions)player.protocol.unhandle('https');}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Managed player native verification timed out')),130000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)},${JSON.stringify(directory)})`,awaitPromise:true,returnByValue:true}}));});
  const output=resolve(process.argv[2]??'.desktop-runtime/media-audit-fixes/native-managed-player.json');
  await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
  assert.equal(result.failure,undefined,result.failure);assert.equal(result.direct.nativeViews,0);
  assert.equal(result.direct.primaryRequests,1);assert.equal(result.direct.fallbackRequests,0);
  assert.ok(result.nearDeadline.activity.some(value=>value.error===null&&(value.currentTime>0||value.frames>0)),'The direct player had not begun playback before fallback');
  assert.equal(result.nearDeadline.fallbackRequests,0,'Advancing direct media must not be replaced before its playback proof can complete');
  assert.deepEqual(result.nearDeadline.proofPaths,['progressive']);
  assert.equal(result.noProgress.fallbackRequests,1);
  assert.ok(result.noProgress.fallbackAfterMs>=10000&&result.noProgress.fallbackAfterMs<=16000,'No-progress direct media must retain the bounded fallback cutoff');
  assert.deepEqual(result.noProgress.proofPaths,['isolated-embed']);
  assert.equal(result.progressFreeze.fallbackRequests,1);
  assert.ok(result.progressFreeze.fallbackAfterMs>=14000&&result.progressFreeze.fallbackAfterMs<=22000,'Started media that freezes must retain bounded stall recovery');
  assert.deepEqual(result.progressFreeze.proofPaths,['isolated-embed']);
  assert.equal(result.hardDeadline.fallbackRequests,0);
  assert.deepEqual(result.hardDeadline.deferrals,[{source:'hard-deadline',reason:'timeout',phase:'activation'}]);
  assert.deepEqual(result.viewerRetry,{requests:2,sameUrl:true,callbackRetries:0,nativeViews:0});
  assert.equal(result.canceledRetryRequests,1);assert.deepEqual(result.viewerTooLate,{requests:1,label:'Connection delayed'});
  assert.equal(result.paused.paused,true);assert.equal(result.resumed.paused,false);assert.ok(result.resumed.time-result.paused.time>=1.8);
  assert.equal(result.audio.muted,false);assert.equal(result.dialogHidden,true);assert.equal(result.dialogRestored,true);
  assert.equal(result.fullscreen.active,true);assert.ok(result.fullscreen.bounds.width>result.bounds.width);
  assert.deepEqual(result.switched,{oldClosed:true,activeViews:1,primaryRequests:1,fallbackRequests:1});assert.equal(result.removed,0);assert.equal(result.retries,1);
  assert.deepEqual(result.canceledFallback,{requests:1,proofs:0,activeViews:0});
  assert.equal(result.expiredFallback.requests,0);assert.equal(result.expiredFallback.deferrals.length,1);
  assert.equal(result.expiredFallback.deferrals[0].reason,'timeout');
  assert.equal(result.lateRecovery.fallbackRequests,1);
  assert.ok(result.lateRecovery.longTimeouts.some(value=>value>=59000&&value<=60000));
  assert.ok(result.lateRecovery.longTimeouts.every(value=>value<=60000));assert.equal(result.lateRecovery.activeViews,0);
  assert.deepEqual(result.terminal,{activeViews:0,lateProofs:0});
  assert.deepEqual(result.upstream,{activeViews:0,lateProofs:0});
  assert.deepEqual(result.failures,[{source:'timeout',reason:'playback',phase:'decode'}]);
  assert.deepEqual(result.deferrals.find(value=>value.source==='upstream'),{source:'upstream',reason:'upstream',phase:'decode',retryAfterMs:30000});
  assert.deepEqual(result.deferrals.find(value=>value.source==='capacity'),{source:'capacity',reason:'capacity',phase:'resolution',retryAfterMs:2000});
}finally{socket.close();}
