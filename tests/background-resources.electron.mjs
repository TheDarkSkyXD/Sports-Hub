import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import policy from '../lib/playback/verification-policy.json' with {type:'json'};

const [label='sample',duration='15']=process.argv.slice(2);
assert.match(label,/^[a-z0-9-]+$/);
const seconds=Number(duration);
assert.ok(Number.isInteger(seconds)&&seconds>=1&&seconds<=60);

async function connect(port,choose){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target=choose(targets);
  assert.ok(target,'The local Electron app must be running');
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data),entry=pending.get(message.id);
    if(!entry)return;
    pending.delete(message.id);clearTimeout(entry.timer);
    if(message.error||message.result.exceptionDetails)entry.reject(new Error('Electron inspection failed'));
    else entry.resolve(message.result.result.value);
  });
  return {close:()=>socket.close(),evaluate(expression){
    return new Promise((resolve,reject)=>{
      const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Electron inspection timed out'));},25000);
      pending.set(id,{resolve,reject,timer});
      socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
    });
  }};
}
const main=await connect(9331,targets=>targets[0]);
const room=await connect(9321,targets=>targets.find(target=>/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url)));
const resourceExpression=`(async()=>{
  const e=process.mainModule.require('electron'),contents=e.webContents.getAllWebContents();
  const sessions=[...new Set(contents.filter(c=>!c.getURL().startsWith('http://127.0.0.1:')).map(c=>c.session))];
  const metrics=e.app.getAppMetrics();
  return {at:Date.now(),processes:metrics.length,workingSetMB:metrics.reduce((sum,p)=>sum+p.memory.workingSetSize/1024,0),
    cacheBytes:await Promise.all(sessions.map(s=>s.getCacheSize())),
    networkMB:metrics.filter(p=>p.serviceName==='network.mojom.NetworkService').reduce((sum,p)=>sum+p.memory.workingSetSize/1024,0)};
})()`;
const inventoryExpression=`fetch('/api/sources',{signal:AbortSignal.timeout(20000)}).then(r=>{if(!r.ok)throw new Error('Inventory unavailable');return r.json();}).then(s=>({at:s.at,checks:s.checks,
  games:s.games.map(g=>({id:g.gameId,name:g.name,working:g.workingChoiceCount,discovered:g.candidates.length,
    states:g.candidates.reduce((counts,c)=>(counts[c.availability.kind]=(counts[c.availability.kind]||0)+1,counts),{})}))}))`;
try{
  const before=await room.evaluate(inventoryExpression);
  const samples=[];
  const started=performance.now();
  do{
    samples.push(await main.evaluate(resourceExpression));
    if(performance.now()-started>=seconds*1000)break;
    await delay(1000);
  }while(true);
  const after=await room.evaluate(inventoryExpression);
  const elapsedSeconds=(after.at-before.at)/1000;
  const completed=after.checks.completed-before.checks.completed;
  const result={label,seconds,elapsedSeconds,completed,completedPerMinute:60*completed/elapsedSeconds,
    meanWorkingSetMB:samples.reduce((sum,s)=>sum+s.workingSetMB,0)/samples.length,
    peakProcesses:Math.max(...samples.map(s=>s.processes)),
    peakSampledSessionCacheBytes:Math.max(0,...samples.flatMap(s=>s.cacheBytes)),
    before,after,samples};
  const output=resolve('.scratch/performance',`${label}-resources.json`);
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({label,elapsedSeconds,completed,completedPerMinute:result.completedPerMinute,
    meanWorkingSetMB:result.meanWorkingSetMB,peakProcesses:result.peakProcesses,peakSampledSessionCacheBytes:result.peakSampledSessionCacheBytes,
    gamesBelowTarget:after.games.filter(g=>g.working<10).length,games:after.games.length}));
  assert.ok(after.checks.active<=policy.concurrency,'Background verification must respect its shared capacity limit');
}finally{main.close();room.close();}
