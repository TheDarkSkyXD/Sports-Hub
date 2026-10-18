import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';

const compiled=await build({stdin:{contents:`
  import {SourcesSnapshotSchema,ReplySchema} from './lib/football/shared';
  window.mediaAuditInventoryBenchmark=async()=>{
    const reads=[];let snapshot,text;
    for(let index=0;index<5;index++){
      const started=performance.now(),response=await fetch('/api/sources',{cache:'no-store',signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Inventory unavailable');
      text=await response.text();const received=performance.now();snapshot=JSON.parse(text);
      reads.push({receiveMs:received-started,parseMs:performance.now()-received,bytes:new TextEncoder().encode(text).byteLength,revision:snapshot.revision});
    }
    const reply={kind:'sources',snapshot},measure=operation=>{const start=performance.now();operation();return performance.now()-start;};
    const operations={workerReplyValidation:()=>ReplySchema.parse(reply),structuredClone:()=>structuredClone(reply),
      clientReplyValidation:()=>ReplySchema.safeParse(reply),jsonStringify:()=>JSON.stringify(snapshot),
      jsonParse:()=>JSON.parse(text),uiSnapshotValidation:()=>SourcesSnapshotSchema.safeParse(snapshot)};
    const stages={};
    for(const [name,operation] of Object.entries(operations)){
      const coldMs=measure(operation),values=[];
      for(let iteration=0;iteration<25;iteration++)values.push(measure(operation));
      values.sort((left,right)=>left-right);
      stages[name]={coldMs,medianMs:values[12],p95Ms:values[23]};
    }
    if(!SourcesSnapshotSchema.safeParse(snapshot).success)throw new Error('Live source snapshot did not match the current schema');
    return {reads,stages,sectionBytes:Object.fromEntries(Object.entries(snapshot).map(([name,value])=>[name,new TextEncoder().encode(JSON.stringify(value)).byteLength])),
      counts:{sources:snapshot.sources.length,games:snapshot.games.length,candidates:snapshot.games.reduce((sum,game)=>sum+game.candidates.length,0)},
      checks:snapshot.checks??null,
      scope:'Actual Electron room renderer; repeated conversions of one live snapshot. Excludes coordinator construction, IPC transit/queuing, rendering and Next overhead.'};
  };
`,resolveDir:resolve('.'),loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false,
  define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const targets=await(await fetch('http://127.0.0.1:9321/json/list')).json();
const room=targets.find(target=>target.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target.url));
assert.ok(room,'The local Electron room must be running');
const socket=new WebSocket(room.webSocketDebuggerUrl);
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Inventory benchmark timed out')),90000);
    socket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id!==1)return;clearTimeout(timer);
      if(message.error||message.result.exceptionDetails)reject(new Error(JSON.stringify(message.error??message.result.exceptionDetails)));
      else resolve(message.result.result.value);});
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:compiled.outputFiles[0].text+`\n(async()=>{try{return await window.mediaAuditInventoryBenchmark()}finally{delete window.mediaAuditInventoryBenchmark}})()`,awaitPromise:true,returnByValue:true}}));
  });
  await writeFile(resolve(process.argv[2]??'.desktop-runtime/media-audit-fixes/native-inventory-performance.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  assert.equal(result.reads.length,5);assert.ok(result.counts.sources>0&&result.counts.candidates>0);
}finally{socket.close();}
