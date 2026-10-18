import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import type {VerificationTarget} from '../lib/football/shared.ts';
import verificationPolicy from '../lib/playback/verification-policy.json' with {type:'json'};

function fixture(holdCancellation=false,capacity=4){
  let now=Date.parse('2026-10-14T04:59:00Z');
  const today=Date.UTC(2026,9,13)/86_400_000;
  let windowCount=0;
  let destroyedWindowCount=0;
  const events=new Map<string,()=>void>();
  const assignments=new Map<string,{url:string;resolve:(result:{kind:'deferred'})=>void}>();
  const cancellations:Array<()=>void>=[];
  const cancelFailures:Array<()=>void>=[];
  const context=runInNewContext('({})');
  context.__sundayVerify={
    assign(id:string,url:string){return new Promise(resolve=>assignments.set(id,{url,resolve}));},
    cancel(id:string){return new Promise<void>((resolve,reject)=>{
      const finish=()=>{const entry=assignments.get(id);assignments.delete(id);entry?.resolve({kind:'deferred'});resolve();};
      if(holdCancellation){cancellations.push(finish);cancelFailures.push(()=>reject(new Error('Renderer ended')));}else finish();
    });},
  };
  class BrowserWindow {
    destroyed=false;
    url='';
    constructor(options:{webPreferences:{disableDialogs:boolean}}){assert.equal(options.webPreferences.disableDialogs,true);windowCount++;}
    isDestroyed(){return this.destroyed;}
    destroy(){if(!this.destroyed)destroyedWindowCount++;this.destroyed=true;}
    async loadURL(url:string){this.url=url;}
    webContents={setAudioMuted(){},setWindowOpenHandler(){},on:(event:string,handler:()=>void)=>events.set(event,handler),getURL:()=>this.url,
      executeJavaScript:async(script:string)=>runInNewContext(script,{window:context})};
  }
  const file=resolve('desktop/playback-verifier.cjs'),actualRequire=createRequire(file);
  type Operation={result:Promise<unknown>;cancel:()=>void};
  const exported={exports:{createPlaybackVerifier:():{configure:(origin:string)=>void;verify:(target:VerificationTarget,signal:AbortSignal)=>Operation|null;stop:()=>void}=>{throw new Error('Module not loaded');}}};
  class Clock extends Date {static now(){return now;}}
  runInNewContext(readFileSync(file,'utf8'),{module:exported,__dirname:resolve('desktop'),Date:Clock,Intl,setTimeout,clearTimeout,
    require:(id:string)=>id==='electron'?{BrowserWindow}:id==='../lib/playback/verification-policy.json'?{concurrency:capacity}:actualRequire(id)});
  const verifier=exported.exports.createPlaybackVerifier();verifier.configure('http://127.0.0.1:1234');
  let sequence=0;
  const target=(gameId:string,gameDay=today):VerificationTarget=>({gameId,gameDay,candidateId:`feed-${++sequence}`,
    sessionId:`00000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,generation:0});
  return {verifier,target,today,assignments,cancellations,cancelFailures,crash:()=>events.get('render-process-gone')?.(),
    windowCount:()=>windowCount,destroyedWindowCount:()=>destroyedWindowCount,setNow(value:number){now=value;}};
}

test('sixteen playback checks share one verifier window and reuse an acknowledged slot',async()=>{
  const run=fixture(false,verificationPolicy.concurrency),signal=new AbortController().signal;
  try{
    const operations=Array.from({length:16},(_,index)=>run.verifier.verify(run.target('capacity-'+index,run.today+index%2),signal));
    assert.equal(operations.filter(Boolean).length,16);
    assert.equal(run.verifier.verify(run.target('overflow'),signal),null);
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.windowCount(),1);
    assert.equal(run.assignments.size,16);
    operations[7]?.cancel();await operations[7]?.result;
    assert.ok(run.verifier.verify(run.target('replacement'),signal));
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.assignments.size,16);
    assert.equal(run.windowCount(),1);
    assert.equal(run.verifier.verify(run.target('extra'),signal),null);
  }finally{run.verifier.stop();}
});

test('desktop shares four checks across all games in one verifier window',async()=>{
  const run=fixture(),signal=new AbortController().signal;
  try{
    const operations=Array.from({length:4},(_,index)=>run.verifier.verify(run.target('game-'+index,run.today+index%2),signal));
    assert.ok(operations.every(Boolean));
    assert.equal(run.verifier.verify(run.target('another-today'),signal),null);
    assert.equal(run.verifier.verify(run.target('another-tomorrow',run.today+1),signal),null);
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.windowCount(),1);
    assert.equal(run.assignments.size,4);
    operations[0]?.cancel();await operations[0]?.result;
    assert.ok(run.verifier.verify(run.target('replacement'),signal));
    assert.equal(run.verifier.verify(run.target('extra'),signal),null);
  }finally{run.verifier.stop();}
});

test('Chicago midnight does not create a new desktop checker pool',()=>{
  const run=fixture(),signal=new AbortController().signal;
  try{
    const operations=Array.from({length:4},()=>run.verifier.verify(run.target('old-today'),signal));
    assert.ok(operations.every(Boolean));
    run.setNow(Date.parse('2026-10-14T05:01:00Z'));
    assert.equal(run.verifier.verify(run.target('new-today',run.today+1),signal),null);
    operations[0]?.cancel();
    assert.ok(run.verifier.verify(run.target('new-today',run.today+1),signal));
    assert.equal(run.verifier.verify(run.target('old-today'),signal),null);
  }finally{run.verifier.stop();}
});

test('a canceled assignment retains capacity until the renderer acknowledges player teardown',async()=>{
  const run=fixture(true),signal=new AbortController().signal;
  try{
    const operations=Array.from({length:4},()=>run.verifier.verify(run.target('today'),signal));
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    operations[0]?.cancel();
    assert.equal(run.verifier.verify(run.target('today'),signal),null);
    run.cancellations[0]();await operations[0]?.result;
    assert.ok(run.verifier.verify(run.target('today'),signal));
  }finally{run.verifier.stop();for(const finish of run.cancellations)finish();}
});

test('a crashed renderer releases reservations even if cancellation cannot be acknowledged',async()=>{
  const run=fixture(true),signal=new AbortController().signal;
  try{
    const operations=Array.from({length:4},()=>run.verifier.verify(run.target('today'),signal));
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    run.crash();
    assert.ok(Array.from({length:4},()=>run.verifier.verify(run.target('today'),signal)).every(Boolean));
    await Promise.all(operations.map(operation=>operation?.result));
  }finally{run.verifier.stop();for(const finish of run.cancellations)finish();}
});

for(const lateResult of ['acknowledged','rejected'])test(`an unresponsive cancellation recovers all slots and ignores its late ${lateResult} result`,async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  const run=fixture(true),signal=new AbortController().signal;
  const outcomes:unknown[]=[];
  try{
    const operations=Array.from({length:4},()=>run.verifier.verify(run.target('today'),signal));
    for(const operation of operations)void operation?.result.then(value=>{
      assert.equal(run.destroyedWindowCount(),1);
      outcomes.push(structuredClone(value));
    });
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    operations[0]?.cancel();
    context.mock.timers.tick(1999);
    assert.equal(run.verifier.verify(run.target('blocked'),signal),null);
    assert.equal(run.destroyedWindowCount(),0);
    assert.deepEqual(outcomes,[]);
    context.mock.timers.tick(1);
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.destroyedWindowCount(),1);
    assert.deepEqual(outcomes,Array.from({length:4},()=>({kind:'deferred',reason:'cancelled',retryAfterMs:2000})));
    const replacements=Array.from({length:4},()=>run.verifier.verify(run.target('replacement'),signal));
    assert.ok(replacements.every(Boolean));
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.windowCount(),2);
    if(lateResult==='rejected')run.cancelFailures[0]();else run.cancellations[0]();
    for(let index=0;index<10;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.destroyedWindowCount(),1);
    assert.equal(run.verifier.verify(run.target('extra'),signal),null);
    assert.equal(outcomes.length,4);
    replacements[0]?.cancel();
    run.cancellations.at(-1)?.();
    await replacements[0]?.result;
    assert.ok(run.verifier.verify(run.target('after-acknowledged-teardown'),signal));
  }finally{run.verifier.stop();for(const finish of run.cancellations)finish();}
});
