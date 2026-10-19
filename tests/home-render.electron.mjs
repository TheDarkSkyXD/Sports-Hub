import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';

const [label='sample']=process.argv.slice(2);
assert.match(label,/^[a-z0-9-]+$/);
const directory=resolve('.scratch/performance/followup-2026-10-18/home');
await mkdir(directory,{recursive:true});
const probe=String.raw`
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import Home from '/app/page.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const NativeDate=Date;
let now=new NativeDate(2026,9,18,12).getTime(),nextId=0,dateReads=0,updateReads=0,sourceWrites=0;
const timers=new Map(),storage=new Map(),sentinelDates=new Set();
Object.defineProperty(window,'localStorage',{value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}});
storage.set('sunday-room:v1',JSON.stringify({slots:['1',null,null,null],showGameDayHeader:false}));
globalThis.Date=class extends NativeDate{
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
  static parse(value){if(sentinelDates.has(value))dateReads++;return NativeDate.parse(value);}
};
const schedule=(callback,delay=0,interval=0)=>{
  const id=++nextId;timers.set(id,{callback,at:now+Math.max(1,delay),interval});return id;
};
globalThis.setTimeout=(callback,delay)=>schedule(callback,delay);
globalThis.setInterval=(callback,delay)=>schedule(callback,delay,delay);
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
const advance=async milliseconds=>{
  const target=now+milliseconds;
  for(let count=0;count<2000;count++){
    const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next||next[1].at>target){now=target;return;}
    const [id,timer]=next;now=timer.at;
    if(timer.interval)timer.at+=timer.interval;else timers.delete(id);
    await act(async()=>timer.callback());
  }
  throw new Error('Home timers did not settle');
};
const updateSource='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download';
window.sundayDesktop={subscribe:()=>()=>{},get:async()=>{updateReads++;return {
  currentVersion:'1.0.12',source:{url:updateSource,editable:true},preferences:{autoCheckEnabled:true,checkFrequency:'daily'},
  state:{kind:'idle',lastCheckedAt:null},commands:[],
};},setSource:async()=>{sourceWrites++;throw new Error('The draft must not be saved');}};
const team={name:'Fixture',short:'Fixture',abbreviation:'FIX',color:'112233',score:'0'};
const games=Array.from({length:120},(_,index)=>{
  const date=new NativeDate(now+(index+1)*3600000).toISOString();
  if(index>=80)sentinelDates.add(date);
  return {id:String(index+1),league:index%2?'nba':'nfl',name:'Fixture '+(index+1),date,
    home:team,away:team,status:index===0?'in':'pre',lifecycle:index===0?'live':'scheduled',detail:index===0?'1st':'Scheduled',redzone:false};
});
let board={schemaVersion:2,revision:1,updatedAt:new NativeDate(now).toISOString(),scheduleState:'ready',aliases:{},
  leagues:Object.fromEntries(['nfl','ncaaf','nba','wnba','nhl','mlb','f1','nascar-cup','nascar-truck','motogp','motorsport','ufc','boxing','wwe','tna','aew','wrestling'].map(league=>[league,{scoresAt:null,errors:[]}])),games};
let sourceReads=0;
window.fetch=async path=>({ok:true,json:async()=>{
  if(path==='/api/games')return board;
  if(path==='/api/sources?view=room'){sourceReads++;return {revision:1,collecting:true,games:[{gameId:'1',candidates:[],pending:true}]};}
  return {at:now,revision:1,windowStartAt:now,lastDiscoveryAt:null,browserCollectorsAvailable:false,sportsurgeV2:{current:null,lastComplete:null,previous:null},streameast:{current:null,lastComplete:null,previous:null},sources:[],games:[]};
},body:{cancel:async()=>{}}});
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
const click=async element=>{expect(element,'Expected an interactive control');await act(async()=>{element.dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true}));element.click();});await advance(10);};
const byLabel=label=>document.querySelector('[aria-label="'+label+'"]');
const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text);
const tab=text=>[...document.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent.trim()===text);
const ids=()=>[...document.querySelectorAll('.center-game')].map(card=>card.dataset.gameId);
const close=()=>click(document.querySelector('[data-slot="dialog-close"]'));
window.runHomeProbe=async()=>{
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);let mounted=true;
  try{
    await act(async()=>root.render(<Home/>));await advance(100);
    expect(ids().length===40&&ids()[0]==='1','The initial list must preserve game sorting and pagination');
    expect(document.querySelector('.game-tile')?.dataset.gameId==='1','Saved selected games must remain selected');
    expect(document.querySelector('.screen-caption')?.textContent.includes('Checking listed servers'),'Collection progress must remain visible');
    expect(updateReads===1,'The update popup must subscribe at boot');
    const results={initialIds:ids(),popupReads:updateReads};
    dateReads=0;
    await click(byLabel('Theater mode'));await click(byLabel('Exit theater mode'));
    results.unrelatedDateReads=dateReads;
    expect(dateReads===0,'Unrelated room interactions parsed '+dateReads+' offscreen game dates');
    const card=document.querySelector('.center-game[data-game-id="2"]'),target=document.querySelector('.add-tile'),transfer=new DataTransfer();
    dateReads=0;
    await act(async()=>{card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
    expect(target.classList.contains('drop-hover'),'Dragging must still show its target');
    await act(async()=>card.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer})));
    results.dragDateReads=dateReads;
    expect(dateReads===0,'Dragging over a room slot must reuse game lists');
    await click(byLabel('Room settings'));
    expect(updateReads===1,'Opening General must not mount the hidden update panel');
    await click(tab('Playback'));
    const slider=byLabel('Default room volume');
    dateReads=0;
    await act(async()=>slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    await advance(10);
    results.volumeDateReads=dateReads;
    expect(dateReads===0,'Changing volume must reuse game lists');
    await click(tab('Updates'));
    expect(updateReads===2,'Opening Updates must mount the panel without replacing the popup');
    const draft='https://github.com/TheDarkSkyXD/Sports-Hub/releases/latest/download/unsaved';
    await act(async()=>{const input=document.querySelector('#update-source-url');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,draft);input.dispatchEvent(new Event('input',{bubbles:true}));});
    await click(tab('General'));await click(tab('Updates'));
    expect(document.querySelector('#update-source-url')?.value===draft,'Switching settings tabs must preserve the unsaved update-source draft');
    expect(updateReads===2&&sourceWrites===0,'Switching tabs must retain the update panel without saving its draft');
    results.updateDraftPreserved=true;
    await click(tab('Sources'));
    expect(document.querySelector('.source-inventory'),'Opening Sources must mount its inventory');
    await click(tab('General'));
    await click(byLabel('Show Game Day header'));
    expect(document.querySelectorAll('.mini-game').length===120,'Enabling the scoreboard must populate every game');
    await click(byLabel('Show Game Day header'));await close();
    await click(byLabel('Room settings'));
    expect(updateReads===2,'A new settings visit must defer Updates again');
    await click(tab('Updates'));
    expect(document.querySelector('#update-source-url')?.value===updateSource&&updateReads===3,'Closing Settings must reset its draft and visited-panel lifetime');
    expect(sourceWrites===0,'Inspecting the update draft must not write the update source');
    await close();
    await click(button('Basketball'));
    expect(ids().every(id=>Number(id)%2===0),'League filtering must remain current');
    await click(button('All'));
    const search=document.querySelector('#game-search');
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'Fixture 119');search.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(ids().join(',')==='119','Search must invalidate the filtered list');
    await click(byLabel('Clear search'));
    await click(byLabel('Favorite Fixture 3'));await click(byLabel('Favorite games'));
    expect(ids().join(',')==='3','Favorites must invalidate the filtered list');
    await click(tab('All games'));
    board={...board,revision:2,games:[{...games[2],date:new NativeDate(now-3600000).toISOString(),status:'in',lifecycle:'live'},...games.filter(game=>game.id!=='3')]};
    await click(button('Game schedule'));await click(button('Refresh'));await click(button('Watch room'));
    expect(ids().slice(0,2).join(',')==='3,1','Refreshed game data must invalidate sorting');
    results.refreshedIds=ids();results.sourceReads=sourceReads;
    results.settingsUpdateReads=updateReads;
    await act(async()=>root.unmount());mounted=false;
    now=new NativeDate(2026,11,31,23,59,59).getTime();
    board={...board,revision:3,games:[
      {...games[1],date:new NativeDate(2026,11,31,20).toISOString(),status:'post',lifecycle:'final',graceEndsAt:now+86400000},
      {...games[2],date:new NativeDate(2027,0,1,1).toISOString()},
    ]};
    const midnightRoot=createRoot(host);
    try{
      await act(async()=>midnightRoot.render(<Home/>));await advance(100);
      expect(ids().join(',')==='2,3','Today final must sort before tomorrow scheduled before midnight');
      await advance(1000);
      expect(ids().join(',')==='3,2','Local midnight must update sort order without a board refresh');
      results.midnightIds=ids();
    }finally{await act(async()=>midnightRoot.unmount());}
    results.remainingTimers=timers.size;
    expect(timers.size===0,'Unmounting Home must clear its timers');
    return results;
  }finally{if(mounted)await act(async()=>root.unmount());host.remove();}
};
`;
const entry=resolve(directory,'probe.jsx');
await writeFile(entry,probe);
const result=await build({
  configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('development'),'process.env':'{}'},
  resolve:{alias:{'@':process.cwd()}},
  plugins:[{name:'next-framework-boundaries',resolveId(id){if(['next/image','next/link','next/dynamic'].includes(id))return '\0'+id;},load(id){
    if(id==='\0next/image')return 'import React from "react";export default function Image({unoptimized,...props}){return React.createElement("img",props)}';
    if(id==='\0next/link')return 'import React from "react";export default function Link(props){return React.createElement("a",props)}';
    if(id==='\0next/dynamic')return 'import React,{lazy,Suspense} from "react";export default function dynamic(load,options={}){const Component=lazy(()=>load().then(defaultExport=>({default:defaultExport})));return props=>React.createElement(Suspense,{fallback:options.loading?React.createElement(options.loading):null},React.createElement(Component,props));}';
  }}],
  build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'HomeProbe'}},
});
const output=(Array.isArray(result)?result[0]:result).output.find(item=>item.type==='chunk');
assert.ok(output,'The actual Home component must bundle');
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
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron Home probe timed out'));},30000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
try{
  await evaluate(`(()=>{const frame=document.createElement('iframe');frame.id='sunday-home-probe';frame.hidden=true;document.body.append(frame);frame.contentWindow.probeErrors=[];frame.contentWindow.addEventListener('error',event=>frame.contentWindow.probeErrors.push(event.message));const script=frame.contentDocument.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;script.textContent=${JSON.stringify(output.code)};frame.contentDocument.body.append(script);return true;})()`);
  const results=await evaluate(`(()=>{const frame=document.getElementById('sunday-home-probe').contentWindow;if(!frame.runHomeProbe)throw new Error(JSON.stringify(frame.probeErrors));return frame.runHomeProbe();})()`);
  await writeFile(resolve(directory,label+'.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results));
}catch(error){await writeFile(resolve(directory,label+'.json'),JSON.stringify({error:String(error)},null,2)+'\n');throw error;}
finally{try{await evaluate(`document.getElementById('sunday-home-probe')?.remove()`);}finally{socket.close();}}
