import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

for (const name of ['sportsurge', 'streameast']) for (const [kind, reason, delay] of [
  ['complete', undefined, 300000], ['partial', 'unavailable', 300000], ['partial', 'rate-limited', 300000],
] as const) test(`${name} schedules ${kind}/${reason || 'success'} ${delay}ms after completion`, async () => {
  const file = resolve(`desktop/${name}-collector.cjs`), require = createRequire(file);
  let clock = 0, calls = 0, timerId = 0, release: (() => void) | undefined;
  const timers = new Map<number, { at: number; work: () => void }>();
  const setTimer = (work: () => void, ms: number) => { const id = ++timerId; timers.set(id, { at: clock + ms, work }); return id; };
  const exported = { exports: {} };
  const sweepName = name === 'sportsurge' ? 'runSportsurgeSweep' : 'runStreameastSweep';
  const createName = name === 'sportsurge' ? 'createSportsurgeCollector' : 'createStreameastCollector';
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {} };
  runInNewContext(readFileSync(file, 'utf8'), { module: exported,
    require: (id: string) => id === 'electron' ? { session: { fromPartition: () => session } } :
      id === `./${name}-sweep.cjs` ? { [sweepName]: async () => {
        calls++; await new Promise<void>(resolve => { release = resolve; }); return { state: { kind, reason } };
      } } : require(id),
    Date: { now: () => clock }, AbortController,
    setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id),
    setInterval: setTimer, clearInterval: (id: number) => timers.delete(id),
  });
  const create = Reflect.get(exported.exports, createName);
  const collector = create({ origin: 'http://127.0.0.1:1', controlToken: 'unused' });
  try {
    if(reason!=='rate-limited')collector.start();
    const pending = collector.requestSweep();
    assert.equal(calls, 1, 'manual trigger cannot overlap an active sweep');
    clock = 10000; release?.(); await pending;
    if(reason==='rate-limited'){assert.equal(timers.size,0);collector.start();}
    assert.deepEqual([...timers.values()].map(timer => timer.at), [clock + delay]);
    clock += delay;
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock);
    for (const [id, timer] of due) { timers.delete(id); timer.work(); }
    assert.equal(calls, 2);
    collector.stop(); release?.(); await collector.requestSweep();
    assert.equal(timers.size, 0);
  } finally { release?.(); collector.stop(); }
});

for(const name of ['sportsurge','streameast'])for(const [reason,delay] of [[undefined,60_000],['rate-limited',300_000]] as const)
test(`${name} applies the checkpoint interval with ${reason||'success'}`,async()=>{
  const file=resolve(`desktop/${name}-collector.cjs`), require=createRequire(file);
  const clock=0;
  let timerId=0;
  const timers=new Map<number,{at:number;work:()=>void}>();
  const setTimer=(work:()=>void,ms:number)=>{const id=++timerId;timers.set(id,{at:clock+ms,work});return id;};
  const exported={exports:{}};
  const sweepName=name==='sportsurge'?'runSportsurgeSweep':'runStreameastSweep';
  const createName=name==='sportsurge'?'createSportsurgeCollector':'createStreameastCollector';
  const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}};
  runInNewContext(readFileSync(file,'utf8'),{module:exported,
    require:(id:string)=>id==='electron'?{session:{fromPartition:()=>session}}:
      id===`./${name}-sweep.cjs`?{[sweepName]:async({send}:{send:(catalog:object)=>Promise<unknown>})=>{
        await send({runId:'fixture',sequence:0,events:[]});return {state:{kind:reason?'partial':'complete',reason}};
      }}:require(id),
    fetch:async()=>Response.json({kind:'catalog-ack',skipDetailEventIds:[],sourceRefreshMs:60_000}),
    Buffer,AbortSignal,AbortController,Date:{now:()=>clock},
    setTimeout:setTimer,clearTimeout:(id:number)=>timers.delete(id),
  });
  const create=Reflect.get(exported.exports,createName);
  const collector=create({origin:'http://127.0.0.1:1',controlToken:'unused'});
  try {
    collector.start();
    await collector.requestSweep();
    assert.deepEqual([...timers.values()].map(timer=>timer.at),[delay]);
  } finally {collector.stop();}
});
