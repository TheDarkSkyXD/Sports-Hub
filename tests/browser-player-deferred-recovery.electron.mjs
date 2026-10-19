import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const root=resolve('.'),directory=resolve('.desktop-runtime/media-audit-fixes/deferred-recovery');
await mkdir(directory,{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',resolve(directory,'fixture.mp4'),
],{windowsHide:true,timeout:20000});
await build({stdin:{contents:`
  import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {BrowserProviderPlayer} from './components/browser-provider-player';
  function Fixture(){
    const [playing,setPlaying]=useState(true),[audible,setAudible]=useState(false),[volume,setVolume]=useState(50);
    return <BrowserProviderPlayer gameId={location.pathname.slice(1)} focused={location.pathname!=='/direct-game'} audible={audible} volume={volume}
      defaultQuality="auto" playing={playing} onPlayingChange={setPlaying} onAudibleChange={setAudible} onVolumeChange={setVolume}/>;
  }
  createRoot(document.getElementById('root')).render(<Fixture/>);
`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},outfile:resolve(directory,'fixture.js'),logLevel:'silent'});
await writeFile(resolve(directory,'preload.cjs'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('sundayPlayer',{
  mount:value=>ipcRenderer.invoke('deferred-recovery:mount',value),update:value=>ipcRenderer.invoke('deferred-recovery:update',value),release:value=>ipcRenderer.invoke('deferred-recovery:release',value),
  subscribe:listener=>{const wrapped=(_event,value)=>listener(value);ipcRenderer.on('sunday-player:state',wrapped);return()=>ipcRenderer.removeListener('sunday-player:state',wrapped);}
});`);

async function verify(root,directory){
  const require=process.mainModule.require.bind(process.mainModule),{BrowserWindow,ipcMain,session}=process.mainModule.require('electron');
  if(!BrowserWindow.getAllWindows().some(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL())))
    throw new Error('Wait for the local Electron room to load before testing recovery');
  const {join}=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
  const media=await fs.readFile(join(directory,'fixture.mp4'));
  const styles=await fs.readFile(join(root,'app/globals.css'),'utf8');
  const capabilities={first:'00000000-0000-4000-8000-000000000011',second:'00000000-0000-4000-8000-000000000012',capacity:'00000000-0000-4000-8000-000000000013',revoked:'00000000-0000-4000-8000-000000000014'};
  const proof={kind:'advancing-video',version:1,startupMs:3000,observedMs:2100,mediaAdvanceMs:2100,presentedFrames:50};
  const results={},nativeStates=[];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function video(request){
    const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range')||'');
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(media.length-1,Number(range[2])):media.length-1;
    return new Response(media.subarray(start,end+1),{status:range?206:200,headers:{'content-type':'video/mp4','accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${media.length}`}:{})}});
  }
  async function runScenario(kind){
    const own=session.fromPartition('deferred-recovery-'+kind+'-'+randomUUID()),origin='http://127.0.0.1:9000';
    const sessionId=randomUUID(),gameId=kind==='revoked'?'nascar-cup-202610180053':kind+'-game',failures=[],evidence=[];
    let generation=0,candidateId=kind!=='capacity'?'failed-feed':'capacity-feed',retryAt=null,recoveryPolls=0,earlyRetry=false,recoveryUI=null,interrupted=false;
    const playable={kind:'playable',checkedAt:Date.now(),proof};
    const candidates=kind!=='capacity'?[
    {
      id:'failed-feed',gameId,label:'StreamEast',sourceIds:['streameast'],observedAt:Date.now(),availability:playable,
    },{
      id:'verified-alternative',gameId,label:'Streamcenter',sourceIds:['sportsurge-v2'],observedAt:Date.now(),availability:playable,
    }]:[{id:'capacity-feed',gameId,label:'Busy local player',sourceIds:['streameast'],observedAt:Date.now(),availability:playable}];
    const playback=()=>({session:{id:sessionId,gameId,candidateId,generation,state:'active',graceEndsAt:null},candidates});
    own.protocol.handle('http',async request=>{
      const url=new URL(request.url);
      if(url.pathname===`/${gameId}`)return new Response(`<!doctype html><style>${styles}</style><style>body{margin:0;background:#181a20;color:white;font:16px sans-serif}.provider-player,.provider-surface,.native-player{height:420px;width:760px;position:relative}video{height:100%;width:100%}.player-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:12px}</style><div id="root"></div><script src="/fixture.js"></script>`,{headers:{'content-type':'text/html'}});
      if(url.pathname==='/fixture.js')return new Response(await fs.readFile(join(directory,'fixture.js')),{headers:{'content-type':'text/javascript'}});
      if(url.pathname==='/api/playback'&&request.method==='POST')return Response.json(playback());
      if(url.pathname==='/api/playback'&&request.method==='PATCH'){
        const body=await request.json();
        if(body.kind==='playback-evidence'){evidence.push(body);return Response.json({kind:'ok'});}
        if(body.failure){
          failures.push({candidateId:body.candidateId??candidateId,generation:body.generation});
          if(kind==='upstream'&&failures.length>=2){
            retryAt=Date.now()+1200;
            return Response.json({error:'Checking the next available stream.',retryAfter:retryAt},{status:503});
          }
          generation++;
          if(kind==='revoked'||kind==='direct')candidateId='verified-alternative';
        }
        if(retryAt!==null){
          earlyRetry ||= Date.now()<retryAt;recoveryPolls++;
          if(recoveryPolls===1){retryAt=Date.now()+400;return Response.json({error:'Checking the next available stream.',retryAfter:retryAt},{status:503});}
          retryAt=null;generation++;candidateId='verified-alternative';
        }
        return Response.json(playback());
      }
      if(url.pathname==='/api/playback'&&request.method==='DELETE')return Response.json({kind:'ok'});
      if(url.pathname.endsWith('/presentation')){
        const selected=url.searchParams.get('candidate');
        if(selected==='verified-alternative'||kind==='direct')return Response.json({kind:'progressive',url:'/api/stream/media/'+'a'.repeat(48)});
        if(selected==='capacity-feed')return Response.json({kind:'isolated-embed',capability:capabilities.capacity});
        if(kind==='revoked')return Response.json({kind:'isolated-embed',capability:capabilities.revoked});
        return Response.json({kind:'isolated-embed',capability:generation===0?capabilities.first:capabilities.second});
      }
      if(url.pathname==='/api/stream/media/'+'a'.repeat(48))return video(request);
      return new Response('',{status:404});
    });
    const host=new BrowserWindow({show:false,width:800,height:500,webPreferences:{session:own,preload:join(directory,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    try{
      await host.loadURL(origin+'/'+gameId);host.showInactive();
      const deadline=Date.now()+9000;
      while(Date.now()<deadline&&!evidence.some(value=>value.candidateId==='verified-alternative')){
        if(kind==='direct'&&!interrupted&&evidence.some(value=>value.candidateId==='failed-feed')){
          interrupted=true;
          await host.webContents.executeJavaScript(`(()=>{
            const video=document.querySelector('video'),play=video.play.bind(video);let attempts=0;
            video.play=()=>++attempts===1?Promise.reject(new DOMException('Playback interrupted','NotSupportedError')):play();
            video.pause();
          })()`);
        }
        if(kind==='capacity'&&await host.webContents.executeJavaScript(`document.querySelector('.player-message strong')?.textContent==='Connection delayed'`))break;
        if(retryAt!==null)recoveryUI=await host.webContents.executeJavaScript(`({label:document.querySelector('.player-message strong')?.textContent,manualPrompt:[...document.querySelectorAll('.player-message button')].some(button=>button.textContent.includes('Try again'))})`);
        await wait(100);
      }
      await wait(300);
      return {failures,evidence,selected:candidateId,generation,recovery:{polls:recoveryPolls,earlyRetry,...recoveryUI},
        ...(kind==='direct'?{interrupted,player:await host.webContents.executeJavaScript(`(()=>{const video=document.querySelector('video');return {playing:!!video&&!video.paused&&video.currentTime>0,gesture:!!document.querySelector('.gesture'),focused:!!document.querySelector('.player-focused')};})()`)}:{}),
        label:await host.webContents.executeJavaScript(`document.querySelector('.player-message strong')?.textContent??null`),
        cursor:await host.webContents.executeJavaScript(`(()=>{const message=document.querySelector('.player-message');return message?getComputedStyle(message).cursor:null})()`)};
    }finally{host.destroy();own.protocol.unhandle('http');}
  }
  ipcMain.handle('deferred-recovery:mount',async(event,{capability})=>{
    if(capability===capabilities.capacity)return {kind:'capacity'};
    if(capability===capabilities.revoked){
      setTimeout(()=>event.sender.send('sunday-player:state',{capability,kind:'decoded',proof}),50);
      setTimeout(()=>{nativeStates.push('ended');event.sender.send('sunday-player:state',{capability,kind:'ended'});},200);
      return {kind:'ready'};
    }
    if(capability===capabilities.first){
      setTimeout(()=>{nativeStates.push('first');event.sender.send('sunday-player:state',{capability,kind:'failed',reason:'upstream'});},50);
    }else{
      setTimeout(()=>{nativeStates.push('stale-first');event.sender.send('sunday-player:state',{capability:capabilities.first,kind:'failed',reason:'upstream'});},50);
      setTimeout(()=>{nativeStates.push('second');event.sender.send('sunday-player:state',{capability,kind:'failed',reason:'upstream'});},100);
    }
    return {kind:'ready'};
  });
  ipcMain.handle('deferred-recovery:update',async()=>({kind:'ready'}));
  ipcMain.handle('deferred-recovery:release',async()=>({kind:'ready'}));
  try{
    results.direct=await runScenario('direct');
    results.upstream=await runScenario('upstream');
    results.revoked=await runScenario('revoked');
    results.capacity=await runScenario('capacity');
    return {...results,nativeStates};
  }finally{
    for(const action of ['mount','update','release'])ipcMain.removeHandler('deferred-recovery:'+action);
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1,'The shared Electron inspector must be available');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Deferred recovery fixture timed out')),30000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)},${JSON.stringify(directory)})`,awaitPromise:true,returnByValue:true}}));
  });
  const output=resolve(process.argv[2]??'.desktop-runtime/cold-start-20261017/viewer-deferred-recovery-red.json');
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.direct.interrupted,true,'The unfocused stream must play before its resume fails');
  assert.equal(result.direct.selected,'verified-alternative','A rejected resume must automatically switch to a working stream');
  assert.deepEqual(result.direct.failures,[{candidateId:'failed-feed',generation:0}]);
  assert.deepEqual(result.direct.evidence.map(value=>value.candidateId),['failed-feed','verified-alternative']);
  assert.deepEqual(result.direct.player,{playing:true,gesture:false,focused:false},'The recovered unfocused stream must advance without a Play prompt');
  assert.equal(result.revoked.selected,'verified-alternative','A previously decoded native view that ends must recover instead of staying black');
  assert.deepEqual(result.revoked.failures,[{candidateId:'failed-feed',generation:0}]);
  assert.deepEqual(result.revoked.evidence.map(value=>value.candidateId),['failed-feed','verified-alternative']);
  assert.equal(result.capacity.cursor,'auto','Recovery messages must keep the pointer visible');
  assert.deepEqual(result.upstream.recovery,{polls:2,earlyRetry:false,label:'Reconnecting',manualPrompt:false},
    'Interrupted streams must show automatic recovery and retry at each server deadline without a click');
  assert.deepEqual(result.upstream.failures,[
    {candidateId:'failed-feed',generation:0},
    {candidateId:'failed-feed',generation:1},
  ]);
  assert.equal(result.upstream.selected,'verified-alternative');
  assert.equal(result.upstream.generation,2);
  assert.equal(result.upstream.evidence.length,1,'The verified alternative must advance and report playback evidence');
  assert.equal(result.upstream.evidence[0].candidateId,'verified-alternative');
  assert.deepEqual(result.nativeStates,['first','stale-first','second','ended'],
    'The stale generation 0 native failure must be delivered without creating another session failure');
  assert.deepEqual(result.capacity.failures,[],'Local player capacity must not mark the feed unavailable');
  assert.equal(result.capacity.generation,0,'Local player capacity must not churn the playback generation');
  assert.equal(result.capacity.label,'Connection delayed');
}finally{socket.close();}
