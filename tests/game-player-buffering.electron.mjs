import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const root=resolve('.');
const directory=resolve('.desktop-runtime/media-audit-fixes/game-player-buffering');
await mkdir(directory,{recursive:true});
await promisify(execFile)(createRequire(import.meta.url)('ffmpeg-static'),[
  '-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24',
  '-t','42','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','48','-sc_threshold','0',
  '-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',resolve(directory,'segment-%02d.ts'),resolve(directory,'all.m3u8'),
],{windowsHide:true,timeout:30000});
await build({stdin:{contents:`
  import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {GamePlayer} from './components/game-player';
  function Fixture(){
    const [playing,setPlaying]=useState(true);
    return <GamePlayer feed={{url:location.origin+'/live.m3u8',label:'Delayed live feed'}} focused={false} audible={false}
      volume={0} defaultQuality="auto" playing={playing} onPlayingChange={setPlaying} onAudibleChange={()=>{}}
      onVolumeChange={()=>{}} onFatal={(_url,reason,phase)=>window.fixtureFailures.push({reason,phase})}/>;
  }
  window.fixtureFailures=[];
  createRoot(document.getElementById('root')).render(<Fixture/>);
`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"production"'},outfile:resolve(directory,'fixture.js'),logLevel:'silent'});

async function verify(root,directory){
  const require=process.mainModule.require.bind(process.mainModule);
  const {BrowserWindow,session}=process.mainModule.require('electron');
  const {join}=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
  const own=session.fromPartition('game-player-buffering-'+randomUUID());
  const manifest=await fs.readFile(join(directory,'all.m3u8'),'utf8');
  const duration=manifest.split('\n').find(line=>line.startsWith('#EXT-X-TARGETDURATION:'));
  const segments=manifest.split('\n').filter(line=>line.endsWith('.ts'));
  let jumped=false,playlistRequests=0;
  const playlist=(start,end)=>[ '#EXTM3U','#EXT-X-VERSION:3',duration,`#EXT-X-MEDIA-SEQUENCE:${start}`,
    ...segments.slice(start,end).flatMap(name=>['#EXTINF:2.000000,',name]),'' ].join('\n');
  own.protocol.handle('http',async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/')return new Response('<!doctype html><style>html,body,#root,.native-player{width:100%;height:100%;margin:0}video{width:100%;height:100%}.player-buffering,.player-message{position:absolute;inset:0}</style><div id="root"></div><script src="/fixture.js"></script>',{headers:{'content-type':'text/html'}});
    if(url.pathname==='/fixture.js')return new Response(await fs.readFile(join(directory,'fixture.js')),{headers:{'content-type':'text/javascript'}});
    if(url.pathname==='/generated/hls.worker.js')return new Response(await fs.readFile(join(root,'node_modules/hls.js/dist/hls.worker.min.js')),{headers:{'content-type':'text/javascript'}});
    if(url.pathname==='/jump'){jumped=true;return new Response(null,{status:204});}
    if(url.pathname==='/live.m3u8'){playlistRequests++;return new Response(jumped?playlist(12,20):playlist(0,10),{headers:{'content-type':'application/vnd.apple.mpegurl','cache-control':'no-store'}});}
    const match=/^\/segment-(\d{2})\.ts$/.exec(url.pathname);
    if(match){if(jumped&&Number(match[1])>=12)await new Promise(resolve=>setTimeout(resolve,5000));return new Response(await fs.readFile(join(directory,url.pathname.slice(1))),{headers:{'content-type':'video/mp2t'}});}
    return new Response('',{status:404});
  });
  const host=new BrowserWindow({show:false,width:640,height:360,webPreferences:{session:own,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const sample=()=>host.webContents.executeJavaScript(`(()=>{const video=document.querySelector('video');const end=video.buffered.length?video.buffered.end(video.buffered.length-1):0;return {currentTime:video.currentTime,bufferedEnd:end,readyState:video.readyState,frames:video.getVideoPlaybackQuality().totalVideoFrames,status:document.querySelector('.player-buffering')?.textContent??null,failures:window.fixtureFailures};})()`);
  try{
    await host.loadURL('http://127.0.0.1:9000/');
    const deadline=Date.now()+15000;let before;
    while(Date.now()<deadline){before=await sample();if(before.frames>=48&&before.bufferedEnd-before.currentTime>=2)break;await wait(100);}
    if(!before||before.frames<48||before.bufferedEnd-before.currentTime<2)throw new Error('Live fixture did not establish a playable buffer');
    const requestsBefore=playlistRequests;
    await host.webContents.executeJavaScript(`fetch('/jump',{cache:'no-store'})`);
    const updateDeadline=Date.now()+6000;while(playlistRequests===requestsBefore&&Date.now()<updateDeadline)await wait(50);
    if(playlistRequests===requestsBefore)throw new Error('HLS did not refresh the advanced playlist');
    await wait(300);
    const after=await sample();
    const recoveryDeadline=Date.now()+20000;let recovered=after,crossedFrames=null;
    while(Date.now()<recoveryDeadline){
      recovered=await sample();
      if(recovered.currentTime>before.bufferedEnd+.25){
        crossedFrames??=recovered.frames;
        if(recovered.readyState>=3&&recovered.frames>crossedFrames)break;
      }
      await wait(100);
    }
    return {before,after,recovered,playlistRequests};
  }finally{host.destroy();own.protocol.unhandle('http');}
}

const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();
assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Game player buffering verification timed out')),50000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(root)},${JSON.stringify(directory)})`,awaitPromise:true,returnByValue:true}}));});
  await writeFile(resolve(directory,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.after.failures.length,0);
  assert.ok(result.after.readyState>=3,'The player lost its playable state while old media remained buffered');
  assert.ok(result.after.currentTime>0&&result.after.frames>0,'The fixture did not prove advancing decoded video before the gap');
  assert.ok(result.after.currentTime<=result.before.bufferedEnd+.25,
    `The live player discarded buffered media by seeking from ${result.before.currentTime.toFixed(2)}s to ${result.after.currentTime.toFixed(2)}s past ${result.before.bufferedEnd.toFixed(2)}s`);
  assert.equal(result.recovered.failures.length,0);
  assert.ok(result.recovered.currentTime>result.before.bufferedEnd+.25&&result.recovered.readyState>=3&&result.recovered.frames>result.after.frames,
    'The live player did not resume advancing after delayed future segments arrived');
}finally{socket.close();}
