import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('failed required days release optional history slots for the next current read',async()=>{
  const now=Date.UTC(2026,9,8,12);
  const workerUrl=pathToFileURL(join(process.cwd(),'lib','football','runtime','schedule-worker.ts')).href;
  const worker=new Worker(`
    const {parentPort}=require('node:worker_threads');
    let currentReads=0;
    globalThis.fetch=async(input,{signal})=>{
      const day=new URL(String(input)).searchParams.get('dates');
      if(day==='20261008') {
        currentReads++;
        return currentReads<=6?new Response('',{status:503}):Response.json({events:[]});
      }
      return new Promise((_resolve,reject)=>{
        if(signal.aborted)reject(signal.reason);
        else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      });
    };
    import(${JSON.stringify(workerUrl)});
  `,{eval:true,execArgv:['--experimental-strip-types']});
  const events:Array<{kind:string;id:number}>=[];
  const waiters:Array<()=>void>=[];
  worker.on('message',(event:{kind:string;id:number})=>{events.push(event);for(const notify of waiters)notify();});
  const waitFor=(ready:()=>boolean,timeoutMs=2000)=>new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`Timed out waiting for schedule worker: ${JSON.stringify(events)}`)),timeoutMs);
    const check=()=>{if(!ready())return;clearTimeout(timeout);waiters.splice(waiters.indexOf(check),1);resolve();};
    waiters.push(check);
    check();
  });
  try {
    for(let id=1;id<=6;id++)worker.postMessage({kind:'read',id,partitionId:'nfl',now});
    await waitFor(()=>events.filter(event=>event.kind==='failed').length===6,5000);
    await new Promise<void>(resolve=>setTimeout(resolve,20));
    worker.postMessage({kind:'read',id:7,partitionId:'nfl',now});
    await waitFor(()=>events.some(event=>event.kind==='current'&&event.id===7));
    assert.equal(events.filter(event=>event.kind==='failed').length,6);
    worker.postMessage({kind:'cancel',id:7});
  } finally {await worker.terminate();}
});
