import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSchedule, SCHEDULES } from '../lib/football/adapters/schedule.ts';
import type { ScheduleProgress } from '../lib/football/domain/ports.ts';

const at = Date.parse('2026-10-02T18:00:00Z');
const event = {
  id: '100', name: 'Away at Home', date: new Date(at).toISOString(),
  status: { type: { state: 'in', description: 'In Progress' } },
  competitions: [{ competitors: [
    { homeAway: 'home', team: { id: '1', displayName: 'Home' }, score: '7' },
    { homeAway: 'away', team: { id: '2', displayName: 'Away' }, score: '0' },
  ] }],
};

test('current games publish before future dates finish and future dates use a slower cadence', async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  const requests: string[] = [];
  let release!: () => void;
  const future = new Promise<void>(resolve => { release = resolve; });
  let current: ScheduleProgress | undefined;
  globalThis.fetch = async input => {
    const date = new URL(String(input)).searchParams.get('dates') || '';
    requests.push(date);
    if (date > '20261002') await future;
    return Response.json({ events: date === '20261002' ? [event] : [], week: { number: 5 } });
  };
  const pending = readSchedule(SCHEDULES[0], at, signal, result => { current = result; });
  try {
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(current?.games.map(game => [game.id, game.lifecycle]), [['100', 'live']]);
    release();
    const first = await pending;
    assert.deepEqual(first.games.map(game => game.id), ['100']);
    requests.length = 0;
    await readSchedule(SCHEDULES[0], at + 30_000, signal);
    assert.deepEqual(requests, ['20261002', '20261001']);
    requests.length = 0;
    await readSchedule(SCHEDULES[0], at + 300_001, signal);
    assert.equal(requests.length, 9);
    assert.equal(requests.filter(date => date === '20261002').length, 1);
  } finally {
    release();
    await pending;
    globalThis.fetch = original;
  }
});

test('today publishes while yesterday is still pending, then complete history clears the partial warning',async()=>{
  const original=globalThis.fetch;
  const history=Promise.withResolvers<void>();
  const future=Promise.withResolvers<void>();
  const yesterday={...event,id:'99',date:'2026-10-01T18:00:00.000Z'};
  const progress:ScheduleProgress[]=[];
  globalThis.fetch=async input=>{
    const day=new URL(String(input)).searchParams.get('dates');
    if(day==='20261001')await history.promise;
    if(day!==null&&day>'20261002')await future.promise;
    return Response.json({events:day==='20261001'?[yesterday]:day==='20261002'?[event]:[]});
  };
  const pending=readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try {
    for(let i=0;i<20&&!progress.length;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(progress[0]?.games.map(game=>game.id),['100']);
    assert.deepEqual(progress[0]?.history,{kind:'loading',day:'20261001'});
    history.resolve();
    for(let i=0;i<20&&progress.length<2;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(progress.length,2,'settled history must publish before the future horizon');
    assert.deepEqual(progress[1]?.games.map(game=>game.id),['99','100']);
    assert.equal(progress[1]?.history,undefined);
    assert.equal(await Promise.race([pending.then(()=>true),new Promise<false>(resolve=>setImmediate(()=>resolve(false)))]),false);
    future.resolve();
    const complete=await pending;
    assert.equal(complete.history,undefined);
    assert.deepEqual(complete.games.map(game=>game.id),['99','100']);
  } finally {history.resolve();future.resolve();await pending;globalThis.fetch=original;}
});

for(const failure of ['http-503','timeout'] as const)test(`settled history ${failure} publishes before the future horizon`,async()=>{
  const original=globalThis.fetch;
  const history=Promise.withResolvers<void>();
  const future=Promise.withResolvers<void>();
  const progress:ScheduleProgress[]=[];
  globalThis.fetch=async input=>{
    const day=new URL(String(input)).searchParams.get('dates');
    if(day==='20261001'){
      await history.promise;
      if(failure==='timeout')throw new DOMException('Timed out','TimeoutError');
      return new Response('',{status:503});
    }
    if(day!==null&&day>'20261002')await future.promise;
    return Response.json({events:day==='20261002'?[event]:[]});
  };
  const pending=readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try {
    for(let i=0;i<20&&!progress.length;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(progress[0]?.history,{kind:'loading',day:'20261001'});
    history.resolve();
    for(let i=0;i<20&&progress.length<2;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(progress[1]?.history,{kind:'failed',day:'20261001',reason:failure});
    assert.equal(await Promise.race([pending.then(()=>true),new Promise<false>(resolve=>setImmediate(()=>resolve(false)))]),false);
    future.resolve();
    assert.deepEqual((await pending).history,{kind:'failed',day:'20261001',reason:failure});
  } finally {history.resolve();future.resolve();await pending;globalThis.fetch=original;}
});

test('history that settles before current publishes one settled snapshot',async()=>{
  const original=globalThis.fetch;
  const current=Promise.withResolvers<void>();
  const future=Promise.withResolvers<void>();
  const progress:ScheduleProgress[]=[];
  globalThis.fetch=async input=>{
    const day=new URL(String(input)).searchParams.get('dates');
    if(day==='20261002')await current.promise;
    if(day!==null&&day>'20261002')await future.promise;
    return Response.json({events:day==='20261002'?[event]:[]});
  };
  const pending=readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try {
    for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    current.resolve();
    for(let i=0;i<20&&!progress.length;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(progress.length,1);
    assert.equal(progress[0]?.history,undefined);
    future.resolve();
    await pending;
    assert.equal(progress.length,1);
  } finally {current.resolve();future.resolve();await pending;globalThis.fetch=original;}
});

test('expired future rows remain visible during refresh and failed dates report their errors', async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  const firstFuture = {...event,id:'101',date:'2026-10-03T18:00:00Z'};
  const replacement = {...firstFuture,id:'102'};
  let phase = 0;
  globalThis.fetch = async input => {
    const day = new URL(String(input)).searchParams.get('dates');
    if (phase === 2 && day === '20261003') return new Response('',{status:503});
    if (phase === 2 && day === '20261004') return Response.json({events:[{id:'broken'}]});
    return Response.json({events:day === '20261002' ? [event] : day === '20261003' ? [phase ? replacement : firstFuture] : []});
  };
  try {
    const initial = await readSchedule(SCHEDULES[0],at,signal);
    assert.deepEqual(initial.games.map(game => game.id),['100','101']);
    let fresh: ScheduleProgress | undefined;
    await readSchedule(SCHEDULES[0],at+30000,signal,result => { fresh = result; });
    assert.deepEqual(fresh?.games.map(game => game.id),['100','101']);
    assert.equal(fresh?.horizonErrors,undefined);
    phase = 1;
    let pending: ScheduleProgress | undefined;
    const updated = await readSchedule(SCHEDULES[0],at+300001,signal,result => { pending = result; });
    assert.deepEqual(pending?.games.map(game => game.id),['100','101']);
    assert.equal(pending?.horizonErrors,undefined);
    assert.deepEqual(updated.games.map(game => game.id),['100','102']);
    assert.equal(updated.horizonErrors,undefined);
    phase = 2;
    const failed = await readSchedule(SCHEDULES[0],at+600002,signal);
    assert.deepEqual(failed.games.map(game => game.id),['100','102']);
    assert.deepEqual(failed.horizonErrors,['20261003:http-503','20261004:schedule-incomplete-or-duplicate']);
  } finally { globalThis.fetch = original; }
});

test('a conflict from an expired future row clears when its fresh replacement is valid',async()=>{
  const original=globalThis.fetch;
  const signal=new AbortController().signal;
  const conflict={...event,date:'2026-10-03T18:00:00Z',competitions:[{competitors:[
    {...event.competitions[0].competitors[0],team:{id:'9',displayName:'Other'}},
    event.competitions[0].competitors[1],
  ]}]};
  const history=Promise.withResolvers<void>();
  const future=Promise.withResolvers<void>();
  let refreshing=false;
  globalThis.fetch=async input=>{
    const day=new URL(String(input)).searchParams.get('dates');
    if(refreshing&&day==='20261001')await history.promise;
    if(refreshing&&day!==null&&day>'20261002')await future.promise;
    return Response.json({events:day==='20261002'?[event]:!refreshing&&day==='20261003'?[conflict]:[]});
  };
  try {
    assert.deepEqual((await readSchedule(SCHEDULES[0],at,signal)).horizonErrors,
      ['20261003:schedule-conflicting-event']);
    refreshing=true;
    const progress:ScheduleProgress[]=[];
    const pending=readSchedule(SCHEDULES[0],at+300_001,signal,result=>{progress.push(result);});
    for(let index=0;index<20&&!progress.length;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(progress[0]?.horizonErrors,undefined);
    history.resolve();
    for(let index=0;index<20&&progress.length<2;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.deepEqual(progress[1]?.horizonErrors,['20261003:schedule-conflicting-event']);
    future.resolve();
    assert.equal((await pending).horizonErrors,undefined);
  } finally {history.resolve();future.resolve();globalThis.fetch=original;}
});

test('today wins when an event repeats across current and future dates', async () => {
  const original = globalThis.fetch;
  const withScore = (score: string) => ({...event,competitions:[{competitors:[
    {...event.competitions[0].competitors[0],score},event.competitions[0].competitors[1],
  ]}]});
  globalThis.fetch = async input => {
    const day = new URL(String(input)).searchParams.get('dates');
    return Response.json({events:day === '20261001' ? [withScore('1')] :
      day === '20261002' ? [event] : day === '20261003' ? [withScore('42')] : []});
  };
  try {
    const result = await readSchedule(SCHEDULES[0],at,new AbortController().signal);
    assert.equal(result.games.length,1);
    assert.equal(result.games[0].home.score,'7');
  } finally { globalThis.fetch = original; }
});

test('current-day failures still reject and future requests stop on abort', async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async input => new URL(String(input)).searchParams.get('dates') === '20261002'
    ? new Response('',{status:502}) : Response.json({events:[]});
  try {
    await assert.rejects(readSchedule(SCHEDULES[0],at,controller.signal),/http-502/);
    let active = 0;
    let peak = 0;
    let started!: () => void;
    const threeStarted = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = async (input,init) => {
      if (new URL(String(input)).searchParams.get('dates')! > '20261002') {
        active++;
        peak = Math.max(peak,active);
        if (active === 3) started();
        return new Promise<Response>((_resolve,reject) => {
          init?.signal?.addEventListener('abort',() => { active--; reject(new Error('aborted')); },{once:true});
        });
      }
      return Response.json({events:[]});
    };
    const progress:ScheduleProgress[]=[];
    const pending = readSchedule(SCHEDULES[0],at,controller.signal,result=>{progress.push(result);});
    await threeStarted;
    assert.equal(peak,3);
    const published=progress.length;
    controller.abort();
    await assert.rejects(pending,/aborted/);
    assert.equal(active,0);
    assert.equal(progress.length,published);
    assert.equal(progress.some(result=>result.history?.kind==='failed'),false);
  } finally { globalThis.fetch = original; }
});

test('a timed-out current day retries while an optional future timeout stays partial',async()=>{
  const original=globalThis.fetch;
  const liveAt=Date.parse('2026-10-04T18:00:00Z');
  const currentEvent={...event,date:new Date(liveAt).toISOString()};
  const calls=new Map<string,number>();
  const signals=new Map<string,AbortSignal[]>();
  globalThis.fetch=async(input,init)=>{
    const day=new URL(String(input)).searchParams.get('dates') || '';
    calls.set(day,(calls.get(day)||0)+1);
    if(init?.signal)signals.set(day,[...(signals.get(day)||[]),init.signal]);
    if(day==='20261004'&&calls.get(day)===1)
      throw new DOMException('Timed out','TimeoutError');
    if(day==='20261010'&&calls.get(day)===1)
      return new Response(new ReadableStream({start(controller){controller.error(new DOMException('Timed out','TimeoutError'));}}));
    return Response.json({events:day==='20261004'?[currentEvent]:[]});
  };
  try {
    const controller=new AbortController();
    const result=await readSchedule(SCHEDULES[0],liveAt,controller.signal);
    assert.deepEqual(result.games.map(game=>game.id),['100']);
    assert.deepEqual(result.horizonErrors,['20261010:timeout']);
    assert.equal(calls.get('20261004'),2);
    assert.equal(calls.get('20261010'),1);
    assert.equal(calls.get('20261003'),1);
    assert.equal([...calls.values()].reduce((sum,count)=>sum+count,0),10);
    assert.notEqual(signals.get('20261004')?.[0],signals.get('20261004')?.[1]);
    controller.abort();
    assert.ok([...signals.values()].flat().every(signal=>signal.aborted));
  } finally {globalThis.fetch=original;}
});

test('a second timeout remains a real failure, while abort, HTTP, and parser errors do not retry',async()=>{
  const original=globalThis.fetch;
  const liveAt=Date.parse('2026-10-04T18:00:00Z');
  const currentEvent={...event,date:new Date(liveAt).toISOString()};
  const calls=new Map<string,number>();
  const count=(input:RequestInfo|URL)=>{
    const day=new URL(String(input)).searchParams.get('dates') || '';
    calls.set(day,(calls.get(day)||0)+1);
    return day;
  };
  try {
    globalThis.fetch=async input=>{
      const day=count(input);
      if(day==='20261010')throw new DOMException('Timed out','TimeoutError');
      return Response.json({events:day==='20261004'?[currentEvent]:[]});
    };
    const future=await readSchedule(SCHEDULES[0],liveAt,new AbortController().signal);
    assert.deepEqual(future.horizonErrors,['20261010:timeout']);
    assert.equal(calls.get('20261010'),1);

    calls.clear();
    globalThis.fetch=async input=>{
      const day=count(input);
      if(day==='20261004')throw new DOMException('Timed out','TimeoutError');
      return Response.json({events:[]});
    };
    await assert.rejects(readSchedule(SCHEDULES[0],liveAt,new AbortController().signal),{name:'TimeoutError'});
    assert.equal(calls.get('20261004'),2);

    calls.clear();
    const controller=new AbortController();
    globalThis.fetch=async input=>{
      const day=count(input);
      if(day==='20261004'){
        controller.abort(new DOMException('Stopped','TimeoutError'));
        throw controller.signal.reason;
      }
      return Response.json({events:[]});
    };
    await assert.rejects(readSchedule(SCHEDULES[0],liveAt,controller.signal),{name:'TimeoutError'});
    assert.equal(calls.get('20261004'),1);

    for(const response of [new Response('',{status:503}),new Response('{'),Response.json({events:[{id:'broken'}]})]) {
      calls.clear();
      globalThis.fetch=async input=>{
        const day=count(input);
        return day==='20261004'?response:Response.json({events:[]});
      };
      await assert.rejects(readSchedule(SCHEDULES[0],liveAt,new AbortController().signal));
      assert.equal(calls.get('20261004'),1);
    }
  } finally {globalThis.fetch=original;}
});
