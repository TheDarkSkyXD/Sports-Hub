import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';

const [label='sample']=process.argv.slice(2);
assert.match(label,/^[a-z0-9-]+$/);
const directory=resolve('.scratch/performance/followup-2026-10-18/clocks');
await mkdir(directory,{recursive:true});
const probe=String.raw`
import React,{act} from 'react';
import {createRoot,hydrateRoot} from 'react-dom/client';
import {renderToString} from 'react-dom/server.browser';
import {useGameClock} from '/hooks/use-game-clock.ts';
import {GameTiming} from '/components/game-timing.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const NativeDate=Date;
let now=new NativeDate(2026,9,18,12).getTime(),nextId=0;
const timers=new Map(),renders={},values={};
let dateFormats=0;
const formatDescriptor=Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype,'format');
Object.defineProperty(Intl.DateTimeFormat.prototype,'format',{...formatDescriptor,get(){
  const format=formatDescriptor.get.call(this);
  return (...args)=>{dateFormats++;return format(...args);};
}});
globalThis.Date=class extends NativeDate{
  constructor(...args){super(...(args.length?args:[now]));}
  static now(){return now;}
};
const schedule=(callback,delay=0,interval=0)=>{
  const id=++nextId;timers.set(id,{callback,at:now+Math.max(1,delay),interval});return id;
};
globalThis.setTimeout=(callback,delay)=>schedule(callback,delay);
globalThis.setInterval=(callback,delay)=>schedule(callback,delay,delay);
globalThis.clearTimeout=globalThis.clearInterval=id=>timers.delete(id);
const advance=async milliseconds=>{
  const target=now+milliseconds;
  while(true){
    const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next||next[1].at>target)break;
    const [id,timer]=next;now=timer.at;
    if(timer.interval)timer.at+=timer.interval;else timers.delete(id);
    await act(async()=>timer.callback());
  }
  now=target;
};
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
function Clock({name,cadence,enabled=true}){
  const value=useGameClock(enabled,cadence);
  renders[name]=(renders[name]??0)+1;values[name]=value;
  return <span>{value===null?'loading':new Date(value).toISOString()}</span>;
}
const host=document.createElement('div');document.body.append(host);
let root;
const mount=async element=>{root=createRoot(host);await act(async()=>root.render(element));};
const unmount=async()=>{await act(async()=>root.unmount());expect(timers.size===0,'Unmount must clear every clock timer');};
window.runClockProbe=async()=>{
  const results={timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  await mount(<><Clock name="day" cadence="day"/><Clock name="second" cadence="second"/></>);
  const initialDay=renders.day,initialSecond=renders.second;
  await advance(5000);
  results.fiveSeconds={dayRenders:renders.day-initialDay,secondRenders:renders.second-initialSecond};
  expect(results.fiveSeconds.dayRenders===0,'Calendar-only subscriber rendered '+results.fiveSeconds.dayRenders+' times in five seconds');
  expect(results.fiveSeconds.secondRenders===5,'Countdown subscriber must update once per second');
  expect(values.second===now,'Countdown timestamp must follow the clock');
  await unmount();

  now=new NativeDate(2026,11,31,23,59,59).getTime();
  const game={date:new NativeDate(2027,0,1,0,30).toISOString(),status:'in',league:'nfl'};
  await mount(<GameTiming game={game} relativeDay/>);
  expect(host.textContent.startsWith('Tomorrow,'),'Calendar label must start as Tomorrow');
  await advance(1000);
  expect(host.textContent.startsWith('Today,'),'Calendar label must change at local midnight across the year');
  results.midnight=host.textContent;
  await unmount();

  for(const [name,month,day] of [['spring',2,8],['autumn',10,1]]){
    now=new NativeDate(2026,month,day,0).getTime();
    await mount(<Clock name="dst" cadence="day"/>);
    const before=renders.dst;
    const nextMidnight=new NativeDate(2026,month,day+1,0).getTime();
    const elapsed=nextMidnight-now;
    await advance(elapsed-1);
    expect(renders.dst===before,'Calendar clock must stay stable before '+name+' midnight');
    await advance(1);
    expect(renders.dst===before+1,'Calendar clock must roll over at '+name+' midnight');
    expect(values.dst===now,'Calendar clock must read the new local day');
    results[name+'DayHours']=elapsed/3600000;
    await unmount();
  }

  now=new NativeDate(2026,9,18,12).getTime();
  for(const status of ['pre','unknown']){
    const race={league:'motogp',status,date:new NativeDate(now+2000).toISOString()};
    await mount(<GameTiming game={race}/>);
    expect(host.textContent.includes('Start in 00:00:02'),'Race countdown must start at two seconds for '+status);
    await advance(1000);
    expect(host.textContent.includes('Start in 00:00:01'),'Race countdown must decrement for '+status);
    await advance(1000);
    expect(host.textContent.endsWith('In progress'),'Race must become In progress at its start for '+status);
    results['motorsports-'+status]=host.textContent;
    await unmount();
  }
  const kickoff={league:'nfl',status:'pre',date:new NativeDate(now+2000).toISOString()};
  await mount(<GameTiming game={kickoff} relativeDay/>);
  expect(host.textContent.includes('Kickoff in 00:00:02'),'Football countdown must start at two seconds');
  const formatsBefore=dateFormats;
  await advance(1000);
  expect(host.textContent.includes('Kickoff in 00:00:01'),'Football countdown must decrement each second');
  await advance(1000);
  expect(host.textContent.endsWith('Awaiting kickoff'),'Football must await the feed when the countdown ends');
  expect(dateFormats===formatsBefore,'Countdown updates must not reformat the calendar label');
  results.countdownDateFormats=dateFormats-formatsBefore;
  results.kickoff=host.textContent;
  await unmount();

  const html=renderToString(<GameTiming game={game} relativeDay/>);
  expect(html.includes('Start time loading'),'Server rendering must keep the hydration placeholder');
  host.innerHTML=html;
  const hydrationErrors=[];
  await act(async()=>{root=hydrateRoot(host,<GameTiming game={game} relativeDay/>,{onRecoverableError:error=>hydrationErrors.push(error.message)});});
  expect(!host.textContent.includes('loading'),'Hydration must show the actual local date');
  expect(hydrationErrors.length===0,'Hydration must match the server output');
  results.hydration={html,errors:hydrationErrors,client:host.textContent};
  await unmount();
  await mount(<Clock name="disabled" cadence="day" enabled={false}/>);
  expect(values.disabled===null&&timers.size===0,'Disabled clocks must neither subscribe nor read a timestamp');
  await unmount();
  results.remainingTimers=timers.size;
  return results;
};
`;
const entry=resolve(directory,'probe.jsx');
await writeFile(entry,probe);
const result=await build({
  configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':JSON.stringify('development')},
  resolve:{alias:{'@':process.cwd()}},
  build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'ClockProbe'}},
});
const output=(Array.isArray(result)?result[0]:result).output.find(item=>item.type==='chunk');
assert.ok(output,'The actual clock components must bundle');
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const target=targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(target,'The existing local Electron app must be running');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let sequence=0;
const pending=new Map();
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data),entry=pending.get(message.id);if(!entry)return;
  pending.delete(message.id);clearTimeout(entry.timer);
  if(message.error||message.result.exceptionDetails)entry.reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
  else entry.resolve(message.result.result.value);
});
const evaluate=expression=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron clock probe timed out'));},30000);
  pending.set(id,{resolve,reject,timer});
  socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
});
try{
  const code=JSON.stringify(output.code);
  await evaluate(`(()=>{
    const frame=document.createElement('iframe');frame.id='sunday-clock-probe';frame.hidden=true;document.body.append(frame);
    const script=frame.contentDocument.createElement('script');script.nonce=document.querySelector('script[nonce]').nonce;
    script.textContent=${code};frame.contentDocument.body.append(script);return true;
  })()`);
  const results=await evaluate(`document.getElementById('sunday-clock-probe').contentWindow.runClockProbe()`);
  await writeFile(resolve(directory,label+'.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results));
}catch(error){
  await writeFile(resolve(directory,label+'.json'),JSON.stringify({error:String(error)},null,2)+'\n');
  throw error;
}finally{
  try{await evaluate(`document.getElementById('sunday-clock-probe')?.remove()`);}finally{socket.close();}
}
