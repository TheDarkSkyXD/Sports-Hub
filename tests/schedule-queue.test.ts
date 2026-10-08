import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleQueue } from '../lib/football/runtime/schedule-queue.ts';
import { readSchedule, SCHEDULES, type SchedulePermit } from '../lib/football/adapters/schedule.ts';

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
async function turn():Promise<void> {await new Promise<void>(resolve=>setImmediate(resolve));}

test('first current reads then current retries get permits before optional history and future work',async()=>{
  const queue=new ScheduleQueue(2,1);
  const signal=new AbortController().signal;
  const started:string[]=[];
  const gates=new Map<string,ReturnType<typeof deferred>>();
  const submit=(name:string,url:string,priority:'current'|'history'|'retry'|'future')=>{
    const gate=deferred();gates.set(name,gate);
    return queue.run(url,priority,signal,async()=>{started.push(name);await gate.promise;});
  };
  const espn='https://site.api.espn.com/scoreboard';
  const other='https://methstreams.st/F1';
  const work=[submit('current-1',espn,'current'),submit('current-other',other,'current')];
  await turn();
  assert.deepEqual(started,['current-1','current-other']);
  work.push(submit('history',espn,'history'),submit('retry',espn,'retry'),submit('future',other,'future'),submit('current-2',espn,'current'));
  await turn();
  assert.equal(started.length,2);
  const waitFor=(name:string)=>new Promise<void>((resolve,reject)=>{
    let attempts=0;
    const check=()=>{
      if(started.includes(name))resolve();
      else if(++attempts>10)reject(new Error(`${name} was not admitted`));
      else setImmediate(check);
    };
    check();
  });
  for(const [release,next] of [['current-1','current-2'],['current-2','retry'],['retry','history']] as const) {
    gates.get(release)!.resolve();
    await waitFor(next);
    assert.equal(started.at(-1),next);
  }
  gates.get('current-other')!.resolve();
  await waitFor('future');
  assert.equal(started.at(-1),'future');
  gates.get('history')!.resolve();
  gates.get('future')!.resolve();
  await Promise.all(work);
});

test('a queued task creates its transport deadline only after admission',async()=>{
  const queue=new ScheduleQueue(1,1);
  const signal=new AbortController().signal;
  const gate=deferred();
  const first=queue.run('https://site.api.espn.com/a','current',signal,async()=>{await gate.promise;});
  await turn();
  const second=queue.run('https://site.api.espn.com/b','current',signal,async()=>{
    const deadline=AbortSignal.timeout(40);
    await new Promise<void>(resolve=>setTimeout(resolve,10));
    assert.equal(deadline.aborted,false);
  });
  await new Promise<void>(resolve=>setTimeout(resolve,80));
  gate.resolve();
  await Promise.all([first,second]);
});

test('the production queue admits at most eight requests and six from one origin',async()=>{
  const queue=new ScheduleQueue();
  const signal=new AbortController().signal;
  const gate=deferred();
  const active:{origin:string}[]=[];
  const jobs=Array.from({length:14},(_,index)=>{
    const origin=index<10?'https://site.api.espn.com':'https://methstreams.st';
    return queue.run(`${origin}/${index}`,'current',signal,async()=>{active.push({origin});await gate.promise;});
  });
  await turn();
  assert.equal(active.length,8);
  assert.equal(active.filter(job=>job.origin==='https://site.api.espn.com').length,6);
  gate.resolve();
  await Promise.all(jobs);
  assert.equal(active.length,14);
});

test('aborting queued schedule work rejects it without consuming a permit',async()=>{
  const queue=new ScheduleQueue(1,1);
  const gate=deferred();
  const first=queue.run('https://site.api.espn.com/one','current',new AbortController().signal,async()=>{await gate.promise;});
  await turn();
  const controller=new AbortController();
  let started=false;
  const queued=queue.run('https://site.api.espn.com/two','current',controller.signal,async()=>{started=true;});
  controller.abort(new DOMException('Stopped','AbortError'));
  await assert.rejects(queued,{name:'AbortError'});
  gate.resolve();
  await first;
  assert.equal(started,false);
});

test('motorsport HTML timeout begins after its schedule permit',async()=>{
  const original=globalThis.fetch;
  const at=Date.parse('2026-10-08T23:00:00Z');
  const gate=deferred();
  let fetches=0;
  const permit:SchedulePermit=async(_url,_priority,_signal,task)=>{await gate.promise;return task();};
  globalThis.fetch=async input=>{
    fetches++;
    const host=new URL(String(input)).hostname;
    return new Response(`<section class="lg" id="g-cat-motogp-20261009"><a class="ev" data-start="2026-10-09T07:00:00Z" href="https://${host}/event/indonesian-grand-prix" title="Indonesian Grand Prix MotoGP - Practice"></a></section>`);
  };
  const pending=readSchedule(SCHEDULES.find(source=>source.id==='motogp')!,at,new AbortController().signal,undefined,permit);
  try {
    await new Promise<void>(resolve=>setTimeout(resolve,10_100));
    assert.equal(fetches,0);
    gate.resolve();
    const result=await pending;
    assert.equal(fetches,2);
    assert.equal(result.games.length,1);
  } finally {gate.resolve();globalThis.fetch=original;}
});
