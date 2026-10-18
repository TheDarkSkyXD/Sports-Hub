import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const room=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(room,'The local Electron room must be running');
const socket=new WebSocket(room.webSocketDebuggerUrl);
const output=process.argv[2]??'.desktop-runtime/cold-start-20261017/retry-recovery-electron.json';
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let sequence=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    const response=JSON.parse(event.data),entry=pending.get(response.id);if(!entry)return;
    pending.delete(response.id);clearTimeout(entry.timer);
    if(response.error||response.result.exceptionDetails)entry.reject(new Error('Electron inventory inspection failed'));
    else entry.resolve(response.result.result.value);
  });
  const snapshot=()=>new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inventory inspection timed out'));},20000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{awaitPromise:true,returnByValue:true,expression:
      `fetch('/api/sources',{signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)throw new Error('Inventory unavailable');return r.json();}).then(s=>({at:s.at,checks:s.checks,
        unknown:s.games.reduce((n,g)=>n+g.candidates.filter(c=>c.availability.kind==='unknown').length,0),
        choices:s.games.reduce((n,g)=>n+g.workingChoiceCount,0),
        staleLabels:(document.body.innerText.match(/Waiting for first checks to finish/g)||[]).length}))`}}));
  });
  const startedAt=Date.now(),deadline=startedAt+180000;
  const attempts=new Map(),samples=[];
  let retried;
  while(Date.now()<deadline&&!retried){
    const state=await snapshot();
    assert.equal(state.staleLabels,0,'The obsolete global waiting message must not appear');
    samples.push({at:state.at,unknown:state.unknown,choices:state.choices,completed:state.checks.completed,
      active:state.checks.active,queued:state.checks.queued});
    for(const result of [...state.checks.recent].reverse()){
      if(result.outcome==='deferred'&&(result.reason==='capacity'||result.reason==='cancelled'))continue;
      const key=`${result.gameId}/${result.candidateId}`,prior=attempts.get(key);
      if(prior&&result.checkedAt<=prior.checkedAt)continue;
      if(prior?.outcome==='deferred'&&prior.reason==='unverified'&&
        result.checkedAt>=prior.checkedAt+prior.retryAfterMs&&state.unknown>0){
        retried={gameId:result.gameId,candidateId:result.candidateId,before:prior,after:result,unknownStillPending:state.unknown};
        break;
      }
      attempts.set(key,result);
    }
    console.log(JSON.stringify(samples.at(-1)));
    if(!retried)await delay(3000);
  }
  const result={startedAt:new Date(startedAt).toISOString(),elapsedMs:Date.now()-startedAt,samples,retried:retried??null};
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
  assert.ok(retried,'An incomplete check must retry while first checks are still pending');
  console.log(JSON.stringify({retried,elapsedMs:result.elapsedMs}));
}finally{socket.close();}
