import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {build} from 'esbuild';
import {CandidateSchema} from '../lib/football/shared.ts';
import {resource} from '../lib/playback/providers/public-page.ts';
import {streamPresentation,streamToken} from '../lib/stream-server.ts';
import {revokeSession} from '../lib/stream-relay.ts';

const directory=resolve('.scratch/performance/feed-coverage-2026-10-18/media-unit');
const fixtures=resolve('.scratch/performance/feed-coverage-2026-10-18/fixtures');
const verification=process.argv.includes('--verification');
await mkdir(directory,{recursive:true});
const bundle=await build({stdin:{resolveDir:resolve('.'),loader:'tsx',contents:`
  import React,{useState} from 'react';
  import {createRoot} from 'react-dom/client';
  import {ManagedPlayer} from './components/managed-player';
  const OriginalWorker=window.Worker;window.activeWorkers=0;
  window.Worker=class extends OriginalWorker{constructor(...args){super(...args);window.activeWorkers++;this.active=true}terminate(){if(this.active){this.active=false;window.activeWorkers--}return super.terminate()}};
  const position=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');window.seeks=[];
  Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{...position,set(value){window.seeks.push({from:position.get.call(this),to:value,stack:new Error().stack});position.set.call(this,value)}});
  function Fixture(){
    const [format,setFormat]=useState('dash'),[playing,setPlaying]=useState(true),[volume,setVolume]=useState(40),[mounted,setMounted]=useState(true);
    window.fixture={setFormat(value){setFormat(value);setPlaying(true);setMounted(true)},setPlaying,setVolume,setMounted};
    const sessions=${JSON.stringify(Object.fromEntries(['dash','progressive','webm','flv','mpegts'].map(format=>[format,randomUUID()])))};
    return mounted?<ManagedPlayer feed={{label:format,url:location.origin+'/api/stream/fixture-game/index.m3u8?session='+sessions[format]+'&candidate='+format+'&generation=0'}}
      focused={true} purpose={${verification?'"verification"':'"viewing"'}} playing={playing} audible={false} volume={volume} defaultQuality="auto"
      onPlayingChange={setPlaying} onAudibleChange={()=>{}} onVolumeChange={setVolume}
      onDecoded={(_url,proof,timings)=>window.proofs.push({format,proof,timings})}
      onFatal={(_url,reason,phase)=>window.failures.push({format,reason,phase})}
      onDeferred={(_url,reason,details)=>window.failures.push({format,reason,...details})}/>:null;
  }
  window.proofs=[];window.failures=[];window.mediaEvents=[];
  for(const event of ['loadedmetadata','playing','waiting','pause','ended','error','seeking','seeked'])document.addEventListener(event,({target})=>{
    if(target instanceof HTMLVideoElement)window.mediaEvents.push({event,time:target.currentTime,frames:target.getVideoPlaybackQuality().totalVideoFrames,ready:target.readyState,error:target.error?.code});
  },true);
  createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const sessions=new Set(),requests=[],responses=[];
const candidate=format=>CandidateSchema.parse({id:format,gameId:'fixture-game',label:format,sourceIds:['fixture'],observedAt:1,
  availability:{kind:'unknown'},locator:{provider:'gooz',playerId:'57069'}});
const send=async command=>({kind:'authorized',candidate:candidate(command.candidateId),
  session:{id:command.sessionId,gameId:'fixture-game',candidateId:command.candidateId,generation:0,state:'active',graceEndsAt:null}});
const contentType=path=>path.endsWith('.mpd')?'application/dash+xml':path.endsWith('.flv')?'video/x-flv':path.endsWith('.ts')?'video/mp2t':path.endsWith('.webm')?'video/webm':'video/mp4';
let reads=0,completed=0;
const requester=async(url,signal,headers)=>{
  signal.throwIfAborted();reads++;
  const bytes=await readFile(resolve(fixtures,basename(url.pathname)));
  const range=headers.get('range'),match=range&&/^bytes=(\d+)-(\d*)$/.exec(range);
  const start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
  requests.push({path:url.pathname,range});completed++;
  return new Response(bytes.subarray(start,end+1),{status:match?206:200,headers:{'content-type':contentType(url.pathname),
    'content-length':String(end-start+1),'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
};
const server=createServer(async(request,response)=>{
  const abort=new AbortController();response.once('close',()=>abort.abort());
  try{
    const url=new URL(request.url,'http://127.0.0.1'),query=url.searchParams;
    let reply;
    if(url.pathname==='/')reply=new Response('<!doctype html><style>body{margin:0;background:#111}#root{position:relative;width:720px;height:405px}.player-message{color:white}</style><div id="root"></div><script src="/fixture.js"></script>',{headers:{'content-type':'text/html'}});
    else if(url.pathname==='/fixture.js')reply=new Response(bundle.outputFiles[0].contents,{headers:{'content-type':'application/javascript'}});
    else if(url.pathname.endsWith('/presentation')){
      const sessionId=query.get('session');sessions.add(sessionId);
  const format=query.get('candidate'),file=format==='dash'?'manifest.mpd':`fixture.${format==='progressive'?'mp4':format==='mpegts'?'ts':format}`;
      reply=await streamPresentation({gameId:'fixture-game',sessionId,candidateId:format,generation:'0',intent:'primary',signal:abort.signal},
        {send,opener:async()=>({root:resource(new URL('https://media.example/fixtures/'+file),new URL('https://player.example/event'),
          format==='progressive'||format==='webm'?'media':format,requester,undefined,format==='dash'?'finite':'progressive'),close(){}})});
    }else if(url.pathname.startsWith('/api/stream/media/'))reply=await streamToken(url.pathname.split('/').at(-1),request.headers.range??null,
      abort.signal,send,query.has('reference')?{reference:query.get('reference'),kind:query.get('kind')}:undefined);
    else reply=new Response(null,{status:404});
    responses.push({path:url.pathname,query:Object.fromEntries(query),status:reply.status,base:reply.headers.get('content-location')});
    response.writeHead(reply.status,Object.fromEntries(reply.headers));
    if(reply.body){for await(const part of reply.body)if(!response.destroyed)response.write(part);}
    response.end();
  }catch(error){responses.push({error:String(error)});if(!response.destroyed){response.writeHead(500);response.end(String(error));}}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');
const targets=await(await fetch('http://127.0.0.1:9331/json/list')).json();assert.equal(targets.length,1);
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
async function verify(origin,verification){
  const {BrowserWindow,session}=process.mainModule.require('electron');
  const own=session.fromPartition('media-formats-'+process.mainModule.require('node:crypto').randomUUID(),{cache:false});
  const window=new BrowserWindow({show:false,width:900,height:650,webPreferences:{session:own,sandbox:true,contextIsolation:true,
    nodeIntegration:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const results=[];
  const consoleMessages=[];
  window.webContents.on('console-message',(_event,...args)=>consoleMessages.push(args.map(value=>String(value))));
  try{
    await window.loadURL(origin);
    for(const format of ['dash','progressive','webm','flv','mpegts']){
      if(format!=='dash')await evaluate(`window.fixture.setFormat(${JSON.stringify(format)})`);
      const deadline=Date.now()+25000;
      while(Date.now()<deadline){
        const state=await evaluate(`({proof:window.proofs.find(value=>value.format===${JSON.stringify(format)}),failures:window.failures,video:!!document.querySelector('video')})`);
        if(state.proof){results.push({format,...state.proof});break;}
        if(state.failures.length)throw new Error(JSON.stringify(state));
        await wait(100);
      }
      if(!results.some(value=>value.format===format))throw new Error('No advancing proof for '+format);
      if(format==='dash'&&!verification){
        const heights=[];
        for(const height of [180,360]){
          await evaluate('document.querySelector(\'[aria-label="Video quality"]\').click()');await wait(100);
          const found=await evaluate(`(()=>{const button=[...document.querySelectorAll('[aria-label="Playback quality options"] button')].find(value=>value.textContent.trim().startsWith('${height}p'));button?.click();return !!button})()`);
          if(!found)throw new Error('Missing DASH quality '+height);
          const deadline=Date.now()+10000;
          while(Date.now()<deadline&&await evaluate('document.querySelector("video").videoHeight')!==height)await wait(100);
          const actual=await evaluate('document.querySelector("video").videoHeight');heights.push(actual);
          if(actual!==height)throw new Error('DASH quality did not change to '+height);
        }
        results.at(-1).qualityHeights=heights;
      }
      await evaluate('window.fixture.setPlaying(false)');await wait(200);
      if(!await evaluate('document.querySelector("video").paused'))throw new Error('Pause failed for '+format);
      await evaluate('window.fixture.setVolume(23);window.fixture.setPlaying(true)');await wait(300);
      if(!await evaluate('!document.querySelector("video").paused&&Math.abs(document.querySelector("video").volume-.23)<.001'))throw new Error('Resume/volume failed for '+format);
      await evaluate('window.fixture.setMounted(false)');await wait(200);
      if(await evaluate('!!document.querySelector("video")'))throw new Error('Removal failed for '+format);
      if(await evaluate('window.activeWorkers')!==0)throw new Error('Worker retained after '+format+' removal');
    }
    return {results,failures:await evaluate('window.failures'),removed:true,consoleMessages,seeks:await evaluate('window.seeks')};
  }catch(error){return {error:String(error),results,consoleMessages,failures:await evaluate('window.failures').catch(()=>[]),
    video:await evaluate(`(()=>{const v=document.querySelector('video');return v?{currentTime:v.currentTime,paused:v.paused,ended:v.ended,
      readyState:v.readyState,networkState:v.networkState,error:v.error?{code:v.error.code,message:v.error.message}:null,
      quality:v.getVideoPlaybackQuality(),buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)]),events:window.mediaEvents,seeks:window.seeks}:null})()`).catch(()=>null)};
  }finally{window.destroy();await own.closeAllConnections();await own.clearStorageData();}
}
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Media format Electron proof timed out')),150000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(${verify.toString()})(${JSON.stringify(`http://127.0.0.1:${address.port}`)},${verification})`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(resolve(directory,`native-formats-${verification?'verification':'viewing'}.json`),JSON.stringify({...result,reads,completed,requests,responses},null,2)+'\n');
  console.log(JSON.stringify(result));assert.equal(result.error,undefined);assert.equal(result.results.length,5);assert.deepEqual(result.failures,[]);
  for(const value of result.results)assert.equal(value.timings.path,value.format==='webm'?'progressive':value.format);
}finally{
  socket.close();for(const id of sessions)revokeSession(id);
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
