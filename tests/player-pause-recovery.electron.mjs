import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {build} from 'vite';
const [label='sample']=process.argv.slice(2);assert.match(label,/^[a-z0-9-]+$/);
const directory=resolve('.scratch/performance/autopilot-2026-10-18/player-pause');await mkdir(directory,{recursive:true});
const media=resolve(directory,'fixture.mp4');
await promisify(execFile)(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','12','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',media],{windowsHide:true});
const entry=resolve(directory,'probe.jsx');const probe=String.raw`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GamePlayer} from '/components/game-player.tsx';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
async function until(read,message,timeout=5000){const deadline=performance.now()+timeout;while(performance.now()<deadline){if(read())return;await wait(50);}throw new Error(message);}
window.runPlayerPauseProbe=async media=>{
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let proofs=0,failures=0;const mediaBlob=URL.createObjectURL(new Blob([Uint8Array.from(atob(media.split(',')[1]),c=>c.charCodeAt(0))],{type:'video/mp4'}));
 const rejections=[];
 async function checkRejection(names,{unmuted=false}={}){
  const container=document.createElement('div');host.append(container);const player=createRoot(container);let decoded=0,attempts=0;const outcomes=[];
  try{
   player.render(<GamePlayer feed={{url:mediaBlob,label:'Unfocused playback fixture'}} focused={false} audible={false} volume={0} defaultQuality="auto" playing onPlayingChange={()=>{}} onAudibleChange={()=>{}} onVolumeChange={()=>{}} onDecoded={()=>decoded++} onFatal={(_url,reason,phase)=>outcomes.push({reason,phase})}/>);
   await until(()=>decoded>0,'Unfocused video must advance before its interruption',10000);
   const video=container.querySelector('video');video.loop=true;video.muted=!unmuted;
   const play=video.play.bind(video),before=video.currentTime;
   video.play=()=>{const name=names[attempts++];return name?Promise.reject(new DOMException('Playback fixture rejection',name)):play();};
   video.pause();
   const terminal=names.some(name=>name!=='AbortError'&&name!=='NotAllowedError');
   if(terminal){
    await until(()=>outcomes.length>0,'Media rejection must reach automatic feed recovery instead of a Play prompt');
    expect(JSON.stringify(outcomes)===JSON.stringify([{reason:names.includes('NotSupportedError')?'unsupported':'playback',phase:'decode'}]),'Media rejection must report its cause once');
    await wait(700);expect(outcomes.length===1,'Media rejection must not repeatedly restart feed recovery');
    expect(!container.querySelector('.gesture'),'Media rejection must not ask an unfocused viewer to press Play');
   }else if(names.length===1&&names[0]==='NotAllowedError'&&!unmuted){
    await until(()=>container.querySelector('.gesture'),'A real autoplay restriction must still offer Play');
    expect(outcomes.length===0,'Autoplay restrictions must not mark the feed failed');
   }else{
    await until(()=>!video.paused&&video.currentTime>before+0.25,'A transient play rejection must recover without user input');
    expect(outcomes.length===0&&!container.querySelector('.gesture'),'Recoverable interruptions must preserve the feed');
    if(unmuted)expect(video.muted,'Autoplay audio restrictions must retry muted');
   }
   rejections.push({names,unmuted,outcomes,paused:video.paused,gesture:!!container.querySelector('.gesture'),attempts});
  }finally{player.unmount();container.remove();}
 }
 function Player(){const [playing,setPlaying]=useState(true);return <GamePlayer feed={{url:mediaBlob,label:'Playback fixture'}} focused audible={false} volume={0} defaultQuality="auto" playing={playing} onPlayingChange={setPlaying} onAudibleChange={()=>{}} onVolumeChange={()=>{}} onDecoded={()=>{proofs++;}} onFatal={()=>{failures++;}}/>;}
 try{
  await checkRejection(['NotSupportedError']);
  await checkRejection(['NetworkError']);
  await checkRejection(['AbortError']);
  await checkRejection(['NotAllowedError']);
  await checkRejection(['NotAllowedError'],{unmuted:true});
  await checkRejection(['NotAllowedError','NotSupportedError'],{unmuted:true});
  root.render(<Player/>);
  await until(()=>host.querySelector('video'),'The actual GamePlayer must mount');
  const video=host.querySelector('video');video.loop=true;
  await until(()=>proofs>0,'The fixture must prove advancing video before pause recovery',10000);
  const before=video.currentTime;video.pause();await wait(1600);
  expect(!video.paused&&video.currentTime>before,'Unexpected pause persisted while the app still requested playback');
  const recovered={paused:video.paused,time:video.currentTime,proofs};
  let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
  try{
   video.pause();await wait(200);hidden=true;document.dispatchEvent(new Event('visibilitychange'));await wait(800);expect(video.paused,'Hidden video must not resume itself');
   hidden=false;document.dispatchEvent(new Event('visibilitychange'));
   await until(()=>!video.paused,'Returning to the visible room must recover playback');
  }finally{delete document.hidden;}
  video.pause();host.querySelector('[aria-label="Pause stream"]').click();await wait(800);
  expect(video.paused,'An explicit Pause must cancel a pending automatic resume');
  host.querySelector('[aria-label="Play stream"]').click();await until(()=>!video.paused,'Explicit Play must resume after cancelling recovery');
  host.querySelector('[aria-label="Pause stream"]').click();await wait(1000);const pauseAt=video.currentTime;await wait(1000);
  expect(video.paused&&Math.abs(video.currentTime-pauseAt)<0.05,'The app must preserve intentional pauses');
  host.querySelector('[aria-label="Play stream"]').click();await until(()=>!video.paused,'Explicit Play must resume');
  let pip=video;Object.defineProperty(document,'pictureInPictureElement',{configurable:true,get:()=>pip});video.dispatchEvent(new Event('enterpictureinpicture'));video.pause();await wait(1200);
  expect(video.paused&&!!host.querySelector('[aria-label="Play stream"]'),'Picture-in-picture pause must update and preserve playback intent');
  pip=null;video.dispatchEvent(new Event('leavepictureinpicture'));delete document.pictureInPictureElement;
  host.querySelector('[aria-label="Play stream"]').click();await until(()=>!video.paused,'Playback must resume after leaving picture in picture');
  const frozenQuality=video.getVideoPlaybackQuality();
  Object.defineProperty(video,'getVideoPlaybackQuality',{configurable:true,value:()=>frozenQuality});
  await until(()=>failures===1,'Frozen video frames must trigger recovery even when media time advances',22000);
  return {rejections,frameFreezeDetected:true,recovered,intentionalPausePreserved:true,pendingRecoveryCancelled:true,visibilityRecovery:true,pictureInPictureIntentPreserved:true};
 }finally{root.unmount();host.remove();URL.revokeObjectURL(mediaBlob);}
};
`;
await writeFile(entry,probe);
const bundle=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('production')},resolve:{alias:{'@':process.cwd()}},build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'PauseProbe'}}});
const output=(Array.isArray(bundle)?bundle[0]:bundle).output.find(item=>item.type==='chunk');assert.ok(output);
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const target=targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target,'The existing local Electron app must be running');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let sequence=0;const pending=new Map();
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data),entry=pending.get(message.id);if(!entry)return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if(message.error||message.result.exceptionDetails)entry.reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
  else entry.resolve(message.result.result.value);
});
const evaluate=expression=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron Home probe timed out'));},75000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
try{
 await evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='sunday-pause-probe';frame.style.cssText='position:fixed;right:0;bottom:0;width:320px;height:240px;opacity:1;pointer-events:none';document.body.append(frame);const script=frame.contentDocument.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;script.textContent=${JSON.stringify(output.code)};frame.contentDocument.body.append(script);return true;})()`);
 const mediaUrl='data:video/mp4;base64,'+(await readFile(media)).toString('base64');
 const result=await evaluate(`document.getElementById('sunday-pause-probe').contentWindow.runPlayerPauseProbe(${JSON.stringify(mediaUrl)})`);
 await writeFile(resolve(directory,label+'.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){await writeFile(resolve(directory,label+'.json'),JSON.stringify({error:String(error)},null,2)+'\n');throw error;}
finally{try{await evaluate(`document.getElementById('sunday-pause-probe')?.remove()`);}finally{socket.close();}}
