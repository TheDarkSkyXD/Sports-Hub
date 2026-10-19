import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';

const [label='sample']=process.argv.slice(2);
assert.match(label,/^[a-z0-9-]+$/);
const directory=resolve('.scratch/performance/followup-2026-10-18/layout');
await mkdir(directory,{recursive:true});
const probe=String.raw`
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {ManagedPlayer} from '/components/managed-player.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const counts={mutations:0,resizes:0,polls:0},polls=new Set();
for(const [name,key] of [['MutationObserver','mutations'],['ResizeObserver','resizes']]){
  const Native=globalThis[name];
  globalThis[name]=class extends Native{
    active=true;
    constructor(callback){super(callback);counts[key]++;}
    disconnect(){if(this.active){this.active=false;counts[key]--;}super.disconnect();}
  };
}
const interval=globalThis.setInterval.bind(globalThis),clear=globalThis.clearInterval.bind(globalThis);
globalThis.setInterval=(callback,ms)=>{const id=interval(callback,ms);if(ms===500){polls.add(id);counts.polls=polls.size;}return id;};
globalThis.clearInterval=id=>{polls.delete(id);counts.polls=polls.size;clear(id);};
const query=document.querySelector.bind(document);
let overlayQueries=0;
document.querySelector=selector=>{
  if(selector==='[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]')overlayQueries++;
  return query(selector);
};
Object.defineProperty(document,'hidden',{configurable:true,value:false});
const capabilities=new Map(),layouts=new Map(),listeners=new Set(),releases=[];
globalThis.fetch=async input=>{
  const id=new URL(String(input),'https://fixture.invalid').pathname.split('/')[3];
  if(!capabilities.has(id))capabilities.set(id,crypto.randomUUID());
  return Response.json({kind:'isolated-embed',capability:capabilities.get(id)});
};
globalThis.sundayPlayer={
  mount:async()=>({kind:'ready'}),update:async layout=>{layouts.set(layout.capability,layout);},
  control:async()=>({kind:'applied'}),release:async({capability})=>{releases.push(capability);layouts.delete(capability);},
  subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
};
const host=document.createElement('div');document.body.append(host);
const style=document.createElement('style');style.textContent='body{margin:0}.native-player,.isolated-player-slot{position:absolute;inset:0}';document.head.append(style);
const root=createRoot(host),noop=()=>{};
function Room({ids=[0,1,2,3],focused=0,purpose='viewing'}){
  return ids.map(id=><div key={id} data-player={id} style={{position:'absolute',left:10+(id%2)*230,top:10+Math.floor(id/2)*150,width:200,height:120}}>
    <ManagedPlayer feed={{url:'/api/stream/fixture-'+id+'/index.m3u8?candidate=x',label:'Game '+id}}
      focused={id===focused} audible={id===focused} volume={70} defaultQuality="auto" playing={true} purpose={purpose}
      onPlayingChange={noop} onAudibleChange={noop} onVolumeChange={noop}/>
  </div>);
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const settle=async predicate=>{
  const deadline=performance.now()+5000;
  do{await act(async()=>{await pause(30);});if(predicate())return;}while(performance.now()<deadline);
  throw new Error('Player layouts did not reach the expected state: '+JSON.stringify({counts,capabilities:capabilities.size,layouts:layouts.size,text:host.textContent}));
};
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
const current=id=>layouts.get(capabilities.get('fixture-'+id));
const visible=()=>[0,1,2,3].map(id=>current(id)?.visible);
window.runLayoutProbe=async()=>{
  const results={};
  await act(async()=>root.render(<Room/>));
  await settle(()=>layouts.size===4);
  results.initial={...counts,layouts:layouts.size,visible:visible()};
  expect(layouts.size===4,'Each player must publish its initial layout');
  expect(visible().every(Boolean),'Every unobscured player must be visible');
  expect(counts.mutations===1&&counts.resizes===1&&counts.polls===1,
    'Four players created '+counts.mutations+' mutation observers, '+counts.resizes+' resize observers and '+counts.polls+' polling intervals; expected one of each');

  const beforeQueries=overlayQueries;
  window.dispatchEvent(new Event('resize'));window.dispatchEvent(new Event('scroll'));
  await act(async()=>{await pause(60);});
  results.burstOverlayQueries=overlayQueries-beforeQueries;
  expect(results.burstOverlayQueries===1,'One document pass must query overlays once for all players');

  const dialog=document.createElement('div');dialog.setAttribute('role','dialog');document.body.append(dialog);
  await settle(()=>visible().every(value=>value===false));
  dialog.remove();
  await settle(()=>visible().every(Boolean));
  results.dialogRestored=visible();

  const cover=document.createElement('div');Object.assign(cover.style,{position:'absolute',left:'10px',top:'10px',width:'200px',height:'120px',zIndex:'100'});document.body.append(cover);
  await settle(()=>current(0)?.visible===false&&[1,2,3].every(id=>current(id)?.visible));
  results.covered=visible();cover.remove();
  await settle(()=>visible().every(Boolean));

  await act(async()=>root.render(<Room focused={1}/>));
  await settle(()=>current(0)?.controls===null&&current(1)?.controls?.label==='Game 1');
  expect(current(0).focused===false&&current(1).focused===true,'Focus must move from the old player to the new player');
  results.focus={old:current(0).controls,next:current(1).controls};

  Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange',{bubbles:true}));
  await settle(()=>visible().every(value=>value===false));results.hiddenViewers=visible();
  await act(async()=>root.render(<Room focused={1} purpose="verification"/>));
  await settle(()=>visible().every(Boolean));
  expect([0,1,2,3].every(id=>current(id).controls===null),'Verification must not gain focused viewer controls');
  results.hiddenVerification=visible();
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  await act(async()=>root.render(<Room focused={1}/>));
  await settle(()=>current(1)?.controls?.label==='Game 1');

  document.querySelector('[data-player="2"]').style.transform='translateX(1000px)';
  await settle(()=>current(2)?.visible===false&&[0,1,3].every(id=>current(id)?.visible));results.offscreen=visible();
  document.querySelector('[data-player="2"]').style.transform='';
  await settle(()=>visible().every(Boolean));

  await act(async()=>root.render(<Room ids={[1,2,3]} focused={1}/>));
  await settle(()=>layouts.size===3);
  expect(counts.mutations===1&&counts.resizes===1&&counts.polls===1,'Removing one player must preserve shared monitoring for the others');
  const secondDialog=document.createElement('div');secondDialog.setAttribute('role','dialog');document.body.append(secondDialog);
  await settle(()=>[1,2,3].every(id=>current(id)?.visible===false));secondDialog.remove();
  await settle(()=>[1,2,3].every(id=>current(id)?.visible));
  results.remaining={...counts,layouts:layouts.size};
  await act(async()=>root.unmount());
  expect(counts.mutations===0&&counts.resizes===0&&counts.polls===0,'The last player must stop every shared observer and polling interval');
  expect(layouts.size===0&&listeners.size===0&&new Set(releases).size===4,'Every player must release its bridge session and subscription');
  const queriesAfterUnmount=overlayQueries;
  window.dispatchEvent(new Event('resize'));
  await pause(60);
  expect(overlayQueries===queriesAfterUnmount,'The last player must cancel pending frames and remove document event listeners');
  results.cleanup={...counts,layouts:layouts.size,listeners:listeners.size,released:new Set(releases).size};
  return results;
};
`;
const entry=resolve(directory,'probe.jsx');await writeFile(entry,probe);
const bundle=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('development')},
  resolve:{alias:{'@':process.cwd()}},build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'LayoutProbe'}}});
const output=(Array.isArray(bundle)?bundle[0]:bundle).output.find(item=>item.type==='chunk');
assert.ok(output,'The actual ManagedPlayer must bundle');
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const target=targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target,'The existing Electron app must be running');
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
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron layout probe timed out'));},30000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
try{
  await evaluate(`(()=>{
    const frame=document.createElement('iframe');frame.id='sunday-layout-probe';
    Object.assign(frame.style,{position:'fixed',left:'0',top:'0',width:'700px',height:'450px',opacity:'0',pointerEvents:'none'});document.body.append(frame);
    const script=frame.contentDocument.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;
    script.textContent=${JSON.stringify(output.code)};frame.contentDocument.body.append(script);return true;
  })()`);
  const results=await evaluate(`document.getElementById('sunday-layout-probe').contentWindow.runLayoutProbe()`);
  await writeFile(resolve(directory,label+'.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}catch(error){await writeFile(resolve(directory,label+'.json'),JSON.stringify({error:String(error)},null,2)+'\n');throw error;}
finally{try{await evaluate(`document.getElementById('sunday-layout-probe')?.remove()`);}finally{socket.close();}}
