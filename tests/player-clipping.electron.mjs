import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';

const directory=resolve('.scratch/player-clipping');
await mkdir(directory,{recursive:true});
const media=resolve(directory,'fixture.mp4');
await promisify(execFile)(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',media],{windowsHide:true});

async function verify(root,media){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,WebContentsView,session}=process.mainModule.require('electron');
  const {randomUUID}=require('node:crypto'),{readFile}=require('node:fs/promises');
  const {createIsolatedPlayers}=require(root+'/desktop/isolated-player.cjs');
  const assert=require('node:assert/strict'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  assert.ok(BrowserWindow.getAllWindows().some(window=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(window.webContents.getURL())),
    'The local Electron room must be running');
  const own=session.fromPartition('clipping-host-'+randomUUID(),{cache:false});
  own.protocol.handle('http',()=>new Response('<!doctype html><title>Player clipping check</title>',{headers:{'content-type':'text/html'}}));
  const host=new BrowserWindow({show:false,useContentSize:true,width:900,height:650,
    webPreferences:{session:own,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const playerSessions=[],views=[],states=[];
  const send=host.webContents.send.bind(host.webContents);
  host.webContents.send=(channel,value)=>{if(channel==='sunday-player:state')states.push(value);send(channel,value);};
  const factory=createIsolatedPlayers({authorizeTarget:async()=>true,
    createView(preferences){const view=new WebContentsView({webPreferences:preferences});views.push(view);return view;},
    createSession(){
      const own=session.fromPartition('clipping-player-'+randomUUID(),{cache:false});playerSessions.push(own);
      own.protocol.handle('https',async request=>new URL(request.url).pathname==='/fixture.mp4'
        ?new Response(await readFile(media),{headers:{'content-type':'video/mp4'}})
        :new Response('<!doctype html><style>html,body{margin:0}video{width:100vw;height:100vh}</style><div id="player"><video controls autoplay muted loop src="/fixture.mp4"></video><button>Provider controls</button></div>',{headers:{'content-type':'text/html'}}));
      return own;
    }});
  try{
    await host.loadURL('http://127.0.0.1:9000/');factory.registerHost(host,'http://127.0.0.1:9000','viewing');
    const event={sender:host.webContents,senderFrame:host.webContents.mainFrame};
    const capability=await factory.offer({target:{sessionId:randomUUID(),candidateId:'clipping',gameId:'nhl-clipping',generation:0},
      player:{url:'https://embed.st/embed/hockey/fixture/1',referer:'https://ppv.st/events/fixture'}});
    const height=host.getContentBounds().height;
    await factory.update(event,{capability,bounds:{x:20,y:height-68,width:343,height:193},visible:true,playing:true,focused:false,audible:false,volume:0});
    await factory.mount(event,{capability});
    const contents=views[0].webContents;
    const sample=()=>contents.executeJavaScript(`(()=>{const video=document.querySelector('video');return {paused:video.paused,time:video.currentTime,controls:video.controls,viewport:[innerWidth,innerHeight]};})()`);
    const deadline=Date.now()+6000;
    while((await sample()).time<0.25&&Date.now()<deadline)await wait(100);
    const results=[];
    for(const bounds of [{x:20,y:height-68,width:343,height:193},{x:-275,y:-125,width:343,height:193}]){
      await factory.update(event,{capability,bounds});await wait(200);
      const before=await contents.executeJavaScript(`(()=>{const video=document.querySelector('video');video.pause();return video.currentTime;})()`);
      await wait(1700);const after=await sample();
      results.push({bounds,after,advance:after.time-before});
      assert.equal(after.paused,false,'A clipped unfocused feed must resume without a click');
      assert.ok(after.time>before+0.5,'Recovered clipped playback must advance');
      assert.equal(after.controls,false,'Clipped players must hide provider controls');
      assert.deepEqual(after.viewport,[343,193]);
    }
    const proofDeadline=Date.now()+3000;
    while(!states.some(state=>state.kind==='decoded')&&Date.now()<proofDeadline)await wait(100);
    assert.ok(states.some(state=>state.kind==='decoded'),'A player starting partly offscreen must prove advancing video');
    await factory.update(event,{capability,playing:false});await wait(800);
    assert.equal((await sample()).paused,true,'Explicit pauses must still be preserved');
    return {passed:true,results,explicitPausePreserved:true};
  }catch(error){return {passed:false,error:error.message};}
  finally{
    await factory.stop();host.destroy();own.protocol.unhandle('http');
    for(const own of playerSessions)own.protocol.unhandle('https');
  }
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1,'Expected the running Electron main inspector');
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolveResult,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Clipping check timed out')),20000);
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolveResult(message.result.result.value);
    });
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(resolve('.'))},${JSON.stringify(media)})`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(resolve(directory,(process.argv[2]??'result')+'.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));assert.equal(result.passed,true,result.error);
}finally{socket.close();}
