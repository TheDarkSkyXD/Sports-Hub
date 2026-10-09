import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { ScheduleWorkerClient } from '../lib/football/runtime/schedule-client.ts';
import { SCHEDULES } from '../lib/football/adapters/schedule.ts';

test('an accepted-result callback failure rejects only its request and leaves the schedule client usable',async()=>{
  const messages:Array<{kind:string;id:number}>=[];
  const fake=new EventEmitter() as EventEmitter & {postMessage:(message:{kind:string;id:number})=>void;terminate:()=>Promise<number>};
  fake.postMessage=message=>{
    messages.push(message);
    if(message.kind!=='read')return;
    const result={games:[],at:Date.now(),league:'nfl'};
    setImmediate(()=>{
      fake.emit('message',{kind:'current',id:message.id,result});
      fake.emit('message',{kind:'complete',id:message.id,result});
    });
  };
  fake.terminate=async()=>0;
  const client=new ScheduleWorkerClient(()=>fake as unknown as Worker);
  try {
    await assert.rejects(client.readSchedule(SCHEDULES[0],Date.now(),new AbortController().signal,()=>{
      throw new Error('accept-failed');
    }),/accept-failed/);
    assert.ok(messages.some(message=>message.kind==='cancel'&&message.id===1));
    const result=await client.readSchedule(SCHEDULES[0],Date.now(),new AbortController().signal);
    assert.equal(result.league,'nfl');
    assert.deepEqual(result.games,[]);
  } finally {await client.close();}
});

test('cancellation after a current publication discards late completion',async()=>{
  const controller=new AbortController();
  const messages:Array<{kind:string;id:number}>=[];
  const fake=new EventEmitter() as EventEmitter & {postMessage:(message:{kind:string;id:number})=>void;terminate:()=>Promise<number>};
  fake.postMessage=message=>{
    messages.push(message);
    if(message.kind==='read')setImmediate(()=>{
      const result={games:[],at:Date.now(),league:'nfl'};
      fake.emit('message',{kind:'current',id:message.id,result});
      fake.emit('message',{kind:'complete',id:message.id,result});
    });
  };
  fake.terminate=async()=>0;
  const client=new ScheduleWorkerClient(()=>fake as unknown as Worker);
  try {
    let current=0;
    await assert.rejects(client.readSchedule(SCHEDULES[0],Date.now(),controller.signal,()=>{
      current++;
      controller.abort(new DOMException('Stopped','AbortError'));
    }),{name:'AbortError'});
    assert.equal(current,1);
    assert.ok(messages.some(message=>message.kind==='cancel'));
  } finally {await client.close();}
});

test('a crashed schedule worker fails its request and restarts after the bounded backoff',async()=>{
  const workers:Array<EventEmitter & {postMessage:(message:{kind:string;id:number})=>void;terminate:()=>Promise<number>}> = [];
  const client=new ScheduleWorkerClient(()=>{
    const fake=new EventEmitter() as EventEmitter & {postMessage:(message:{kind:string;id:number})=>void;terminate:()=>Promise<number>};
    const generation=workers.push(fake);
    fake.postMessage=message=>{
      if(message.kind==='read')setImmediate(()=>{
        if(generation===1)fake.emit('error',new Error('crash'));
        else fake.emit('message',{kind:'complete',id:message.id,result:{games:[],at:Date.now(),league:'nfl'}});
      });
    };
    fake.terminate=async()=>0;
    return fake as unknown as Worker;
  });
  try {
    await assert.rejects(client.readSchedule(SCHEDULES[0],Date.now(),new AbortController().signal),/schedule-worker-unavailable/);
    await assert.rejects(client.readSchedule(SCHEDULES[0],Date.now(),new AbortController().signal),/schedule-worker-unavailable/);
    await new Promise<void>(resolve=>setTimeout(resolve,1050));
    const result=await client.readSchedule(SCHEDULES[0],Date.now(),new AbortController().signal);
    assert.equal(result.league,'nfl');
    assert.equal(workers.length,2);
  } finally {await client.close();}
});
