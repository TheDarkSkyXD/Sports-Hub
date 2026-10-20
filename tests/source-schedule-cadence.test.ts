import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFixtureSchedule,SCHEDULES} from '../lib/football/adapters/schedule.ts';
import type {ScheduleProgress} from '../lib/football/domain/ports.ts';
import {enqueueSchedule,waitForSchedule} from './schedule-fixture.ts';

const at=Date.parse('2026-10-02T18:00:00Z');
const event={id:'100',name:'Away at Home',date:new Date(at).toISOString(),
  status:{type:{state:'in',description:'In Progress'}},competitions:[{competitors:[
    {homeAway:'home',team:{id:'1',displayName:'Home'},score:'7'},
    {homeAway:'away',team:{id:'2',displayName:'Away'},score:'0'},
  ]}]};
const dates=(fixture:ReturnType<typeof createFixtureSchedule>)=>fixture.fixtureRequests().map(request=>new URL(request.url).searchParams.get('dates'));
const daily=(day:string|null)=>({events:day==='20261002'?[event]:[],week:{number:5}});

test('current games publish before future dates finish and future dates use a slower cadence',async()=>{
  const fixture=createFixtureSchedule(),signal=new AbortController().signal;
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>({body:JSON.stringify(daily(url.searchParams.get('dates'))),...(url.searchParams.get('dates')!>'20261002'?{gate:'future'}:{})}));
  let current:ScheduleProgress|undefined;
  const pending=fixture.readSchedule(SCHEDULES[0],at,signal,result=>{current=result;});
  try{
    await waitForSchedule(()=>current!==undefined);
    assert.deepEqual(current?.games.map(game=>[game.id,game.lifecycle]),[['100','live']]);
    fixture.releaseFixtureGate('future');
    assert.deepEqual((await pending).games.map(game=>game.id),['100']);
    let before=dates(fixture).length;
    enqueueSchedule(fixture,SCHEDULES[0],at+30000,url=>daily(url.searchParams.get('dates')),[-1,0]);
    await fixture.readSchedule(SCHEDULES[0],at+30000,signal);
    assert.deepEqual(dates(fixture).slice(before),['20261002','20261001']);
    before=dates(fixture).length;
    enqueueSchedule(fixture,SCHEDULES[0],at+300001,url=>daily(url.searchParams.get('dates')));
    await fixture.readSchedule(SCHEDULES[0],at+300001,signal);
    assert.equal(dates(fixture).length-before,9);
  }finally{fixture.releaseFixtureGate('future');await pending;fixture.close();}
});

test('today publishes while yesterday is still pending, then complete history clears the partial warning',async()=>{
  const fixture=createFixtureSchedule(),progress:ScheduleProgress[]=[];
  const yesterday={...event,id:'99',date:'2026-10-01T18:00:00.000Z'};
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>{const day=url.searchParams.get('dates')!;return{body:JSON.stringify({events:day==='20261001'?[yesterday]:day==='20261002'?[event]:[]}),...(day==='20261001'?{gate:'history'}:day>'20261002'?{gate:'future'}:{})};});
  const pending=fixture.readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try{
    await waitForSchedule(()=>progress.length>0);
    assert.deepEqual(progress[0].games.map(game=>game.id),['100']);
    assert.deepEqual(progress[0].history,{kind:'loading',day:'20261001'});
    fixture.releaseFixtureGate('history');await waitForSchedule(()=>progress.length===2);
    assert.deepEqual(progress[1].games.map(game=>game.id),['99','100']);assert.equal(progress[1].history,undefined);
    let settled=false;void pending.then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
    fixture.releaseFixtureGate('future');const complete=await pending;
    assert.equal(complete.history,undefined);assert.deepEqual(complete.games.map(game=>game.id),['99','100']);
  }finally{fixture.releaseFixtureGate('history');fixture.releaseFixtureGate('future');await pending;fixture.close();}
});

for(const failure of ['http-503','timeout'] as const)test(`settled history ${failure} publishes before the future horizon`,async()=>{
  const fixture=createFixtureSchedule(),progress:ScheduleProgress[]=[];
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>{const day=url.searchParams.get('dates')!;return day==='20261001'?{gate:'history',...(failure==='timeout'?{failure:{message:'timed out'}}:{status:503,body:''})}:{body:JSON.stringify(daily(day)),...(day>'20261002'?{gate:'future'}:{})};});
  const pending=fixture.readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try{
    await waitForSchedule(()=>progress.length>0);assert.deepEqual(progress[0].history,{kind:'loading',day:'20261001'});
    fixture.releaseFixtureGate('history');await waitForSchedule(()=>progress.length===2);
    assert.deepEqual(progress[1].history,{kind:'failed',day:'20261001',reason:failure});
    let settled=false;void pending.then(()=>{settled=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(settled,false);
    fixture.releaseFixtureGate('future');assert.deepEqual((await pending).history,{kind:'failed',day:'20261001',reason:failure});
  }finally{fixture.releaseFixtureGate('history');fixture.releaseFixtureGate('future');await pending;fixture.close();}
});

test('history that settles before current publishes one settled snapshot',async()=>{
  const fixture=createFixtureSchedule(),progress:ScheduleProgress[]=[];
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>{const day=url.searchParams.get('dates')!;return{body:JSON.stringify(daily(day)),...(day==='20261002'?{gate:'current'}:day>'20261002'?{gate:'future'}:{})};});
  const pending=fixture.readSchedule(SCHEDULES[0],at,new AbortController().signal,result=>{progress.push(result);});
  try{
    await waitForSchedule(()=>fixture.fixtureRequests().length===2);fixture.releaseFixtureGate('current');
    await waitForSchedule(()=>progress.length>0);assert.equal(progress.length,1);assert.equal(progress[0].history,undefined);
    fixture.releaseFixtureGate('future');await pending;assert.equal(progress.length,1);
  }finally{fixture.releaseFixtureGate('current');fixture.releaseFixtureGate('future');await pending;fixture.close();}
});

test('expired future rows remain visible during refresh and failed dates report their errors',async()=>{
  const fixture=createFixtureSchedule(),signal=new AbortController().signal;
  const firstFuture={...event,id:'101',date:'2026-10-03T18:00:00Z'},replacement={...firstFuture,id:'102'};
  const enqueue=(now:number,phase:number,offsets?:number[])=>enqueueSchedule(fixture,SCHEDULES[0],now,url=>{
    const day=url.searchParams.get('dates');
    if(phase===2&&day==='20261003')return{status:503,body:''};
    return{events:day==='20261002'?[event]:day==='20261003'?[phase?replacement:firstFuture]:phase===2&&day==='20261004'?[{id:'broken'}]:[]};
  },offsets);
  try{
    enqueue(at,0);assert.deepEqual((await fixture.readSchedule(SCHEDULES[0],at,signal)).games.map(game=>game.id),['100','101']);
    enqueue(at+30000,0,[-1,0]);let fresh:ScheduleProgress|undefined;
    await fixture.readSchedule(SCHEDULES[0],at+30000,signal,result=>{fresh=result;});assert.deepEqual(fresh?.games.map(game=>game.id),['100','101']);assert.equal(fresh?.horizonErrors,undefined);
    enqueue(at+300001,1);let progress:ScheduleProgress|undefined;
    const updated=await fixture.readSchedule(SCHEDULES[0],at+300001,signal,result=>{progress??=result;});assert.deepEqual(progress?.games.map(game=>game.id),['100','101']);assert.deepEqual(updated.games.map(game=>game.id),['100','102']);assert.equal(updated.horizonErrors,undefined);
    enqueue(at+600002,2);const failed=await fixture.readSchedule(SCHEDULES[0],at+600002,signal);
    assert.deepEqual(failed.games.map(game=>game.id),['100','102']);assert.deepEqual(failed.horizonErrors,['20261003:http-503','20261004:schedule-incomplete-or-duplicate']);
  }finally{fixture.close();}
});

test('a conflict from an expired future row clears when its fresh replacement is valid',async()=>{
  const fixture=createFixtureSchedule(),signal=new AbortController().signal;
  const conflict={...event,date:'2026-10-03T18:00:00Z',competitions:[{competitors:[{...event.competitions[0].competitors[0],team:{id:'9',displayName:'Other'}},event.competitions[0].competitors[1]]}]};
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>({events:url.searchParams.get('dates')==='20261002'?[event]:url.searchParams.get('dates')==='20261003'?[conflict]:[]}));
  assert.deepEqual((await fixture.readSchedule(SCHEDULES[0],at,signal)).horizonErrors,['20261003:schedule-conflicting-event']);
  enqueueSchedule(fixture,SCHEDULES[0],at+300001,url=>{const day=url.searchParams.get('dates')!;return{body:JSON.stringify(daily(day)),...(day==='20261001'?{gate:'history'}:day>'20261002'?{gate:'future'}:{})};});
  const progress:ScheduleProgress[]=[];const pending=fixture.readSchedule(SCHEDULES[0],at+300001,signal,result=>{progress.push(result);});
  try{
    await waitForSchedule(()=>progress.length>0);assert.equal(progress[0].horizonErrors,undefined);
    fixture.releaseFixtureGate('history');await waitForSchedule(()=>progress.length===2);assert.deepEqual(progress[1].horizonErrors,['20261003:schedule-conflicting-event']);
    fixture.releaseFixtureGate('future');assert.equal((await pending).horizonErrors,undefined);
  }finally{fixture.releaseFixtureGate('history');fixture.releaseFixtureGate('future');await pending;fixture.close();}
});

test('today wins when an event repeats across current and future dates',async()=>{
  const fixture=createFixtureSchedule();
  const withScore=(score:string)=>({...event,competitions:[{competitors:[{...event.competitions[0].competitors[0],score},event.competitions[0].competitors[1]]}]});
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>({events:url.searchParams.get('dates')==='20261001'?[withScore('1')]:url.searchParams.get('dates')==='20261002'?[event]:url.searchParams.get('dates')==='20261003'?[withScore('42')]:[]}));
  try{const result=await fixture.readSchedule(SCHEDULES[0],at,new AbortController().signal);assert.equal(result.games.length,1);assert.equal(result.games[0].home.score,'7');}finally{fixture.close();}
});

test('queued native schedule progress stops at cancellation',async()=>{
  const fixture=createFixtureSchedule(),controller=new AbortController(),progress:ScheduleProgress[]=[];
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>url.searchParams.get('dates')!>'20261002'?{pending:true}:{events:[]});
  const pending=fixture.readSchedule(SCHEDULES[0],at,controller.signal,result=>{progress.push(result);});
  const fence=new Int32Array(new SharedArrayBuffer(4)),deadline=performance.now()+2000;
  try{
    while(dates(fixture).filter(day=>day!>'20261002').length<3&&performance.now()<deadline)Atomics.wait(fence,0,0,1);
    assert.equal(dates(fixture).filter(day=>day!>'20261002').length,3);
    controller.abort();
    await assert.rejects(pending,{name:'AbortError'});
    await waitForSchedule(()=>fixture.fixtureCancels().length===3);
    assert.equal(progress.length,0);
  }finally{controller.abort();await pending.catch(()=>{});fixture.close();}
});

test('current-day failures still reject and future requests stop on abort',async()=>{
  const fixture=createFixtureSchedule(),controller=new AbortController();
  enqueueSchedule(fixture,SCHEDULES[0],at,url=>url.searchParams.get('dates')==='20261002'?{status:502,body:''}:{events:[]});
  await assert.rejects(fixture.readSchedule(SCHEDULES[0],at,controller.signal),/http-502/);fixture.close();
  const pendingFixture=createFixtureSchedule(),progress:ScheduleProgress[]=[];
  enqueueSchedule(pendingFixture,SCHEDULES[0],at,url=>url.searchParams.get('dates')!>'20261002'?{pending:true}:{events:[]});
  const pending=pendingFixture.readSchedule(SCHEDULES[0],at,controller.signal,result=>{progress.push(result);});
  await waitForSchedule(()=>dates(pendingFixture).filter(day=>day!>'20261002').length===3);
  const published=progress.length;controller.abort();await assert.rejects(pending,{name:'AbortError'});
  await waitForSchedule(()=>pendingFixture.fixtureCancels().length===3);
  assert.equal(dates(pendingFixture).filter(day=>day!>'20261002').length,3);assert.equal(progress.length,published);assert.equal(progress.some(result=>result.history?.kind==='failed'),false);pendingFixture.close();
});

test('a timed-out current day retries while an optional future timeout stays partial',async()=>{
  const fixture=createFixtureSchedule(),liveAt=Date.parse('2026-10-04T18:00:00Z');
  const currentEvent={...event,date:new Date(liveAt).toISOString()};
  enqueueSchedule(fixture,SCHEDULES[0],liveAt,url=>['20261004','20261010'].includes(url.searchParams.get('dates')!)?{failure:{message:'timed out'}}:{events:[]});
  enqueueSchedule(fixture,SCHEDULES[0],liveAt,()=>({events:[currentEvent]}),[0]);
  try{
    const result=await fixture.readSchedule(SCHEDULES[0],liveAt,new AbortController().signal);assert.deepEqual(result.games.map(game=>game.id),['100']);assert.deepEqual(result.horizonErrors,['20261010:timeout']);
    assert.equal(dates(fixture).filter(day=>day==='20261004').length,2);assert.equal(dates(fixture).filter(day=>day==='20261010').length,1);assert.equal(dates(fixture).length,10);
  }finally{fixture.close();}
});

test('a second timeout remains a real failure, while abort, HTTP, and parser errors do not retry',async()=>{
  const liveAt=Date.parse('2026-10-04T18:00:00Z');
  const timeout=createFixtureSchedule();enqueueSchedule(timeout,SCHEDULES[0],liveAt,()=>({failure:{message:'timed out'}}));enqueueSchedule(timeout,SCHEDULES[0],liveAt,()=>({failure:{message:'timed out'}}),[0]);
  await assert.rejects(timeout.readSchedule(SCHEDULES[0],liveAt,new AbortController().signal),{name:'TimeoutError'});assert.equal(dates(timeout).filter(day=>day==='20261004').length,2);timeout.close();
  const canceled=createFixtureSchedule(),controller=new AbortController();enqueueSchedule(canceled,SCHEDULES[0],liveAt,()=>({pending:true}));
  const pending=canceled.readSchedule(SCHEDULES[0],liveAt,controller.signal);await waitForSchedule(()=>dates(canceled).includes('20261004'));controller.abort(new DOMException('Stopped','TimeoutError'));
  await assert.rejects(pending,{name:'TimeoutError'});assert.equal(dates(canceled).filter(day=>day==='20261004').length,1);canceled.close();
  for(const response of [{status:503,body:''},{body:'{'},{body:JSON.stringify({events:[{id:'broken'}]})}]){
    const fixture=createFixtureSchedule();enqueueSchedule(fixture,SCHEDULES[0],liveAt,url=>url.searchParams.get('dates')==='20261004'?response:{events:[]});
    await assert.rejects(fixture.readSchedule(SCHEDULES[0],liveAt,new AbortController().signal));assert.equal(dates(fixture).filter(day=>day==='20261004').length,1);fixture.close();
  }
});
