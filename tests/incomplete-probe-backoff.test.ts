import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import {CandidateAvailabilitySchema,type Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-17T18:00:00Z');
const proof={kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} satisfies Extract<CandidateProbeResult,{kind:'playable'}>['proof'];
const drain=async()=>{for(let turn=0;turn<50;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
function fixture(probe:FootballDependencies['probeCandidate'],initialPlayers=['1']){
  let clock=at,players=initialPlayers;
  const game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'H',color:'112233',score:null},away:{name:'Away',short:'Away',abbreviation:'A',color:'332211',score:null}};
  const coordinator=createFootballCoordinator(':memory:',{now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],readSchedule:async()=>({games:[game],league:'nfl',at:clock}),
    readHtml:async()=>'<main/>',parseListings:()=>({outcome:'parsed',observations:[{id:'listing',sourceId:'fixture',url:'https://fixture.example/game',
      title:game.name,league:'nfl',teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:clock,parserVersion:3}]}),
    enrichObservation:value=>value,compatiblePlayers:()=>players.map(playerId=>({id:`player-${playerId}`,label:'Player',locator:{provider:'gooz',playerId}})),probeCandidate:probe});
  return {coordinator,get now(){return clock;},replacePlayer(id:string){players=[id];},
    async refresh(){await coordinator.refresh(true);await drain();},
    async advance(ms:number){clock+=ms;await coordinator.refresh(true);await drain();},
    async retry(){await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:true});await drain();},
    async delay(){const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected sources');const availability=reply.snapshot.games[0].candidates[0]?.availability;
      CandidateAvailabilitySchema.parse(availability);
      assert.equal(availability?.kind,'checking');if(availability?.kind!=='checking')throw new Error('Expected check');
      assert.equal(availability.progress.kind,'deferred');if(availability.progress.kind!=='deferred')throw new Error('Expected deferral');
      assert.equal(availability.progress.retryAfterMs,availability.progress.retryAt-clock);return availability.progress.retryAt-clock;},
    async stop(){await coordinator.stop();}};
}

test('consecutive incomplete checks back off through thirty seconds, one, two, five and ten minutes',async()=>{
  let calls=0;
  const run=fixture(async()=>{calls++;return {kind:'deferred',retryAfterMs:2000};});
  try{
    await run.refresh();
    for(const [index,delay] of [30_000,60_000,120_000,300_000,600_000,600_000].entries()){
      assert.equal(calls,index+1);assert.equal(await run.delay(),delay);
      await run.advance(delay-1);assert.equal(calls,index+1,'No check may run before its effective cooldown');
      await run.advance(1);assert.equal(calls,index+2,'A due incomplete feed must keep receiving retries');
    }
  }finally{await run.stop();}
});

test('provider retry minimums are preserved when they exceed the backoff turn',async()=>{
  let calls=0;
  const run=fixture(async()=>{calls++;return {kind:'deferred',retryAfterMs:90_000};});
  try{
    await run.refresh();assert.equal(await run.delay(),90_000);
    await run.advance(90_000);assert.equal(calls,2);assert.equal(await run.delay(),90_000);
    await run.advance(90_000);assert.equal(calls,3);assert.equal(await run.delay(),120_000);
  }finally{await run.stop();}
});

test('capacity and cancellation do not advance or discard an incomplete streak',async()=>{
  const results:CandidateProbeResult[]=[{kind:'deferred',retryAfterMs:2000},{kind:'deferred',reason:'capacity',retryAfterMs:2000},
    {kind:'deferred',retryAfterMs:2000},{kind:'deferred',reason:'cancelled',retryAfterMs:3000},{kind:'deferred',retryAfterMs:2000}];
  let calls=0;
  const run=fixture(async()=>results[Math.min(calls++,results.length-1)]);
  try{
    await run.refresh();assert.equal(await run.delay(),30_000);
    for(const [elapsed,expected] of [[30_000,2000],[2000,60_000],[60_000,3000],[3000,120_000]]){
      await run.advance(elapsed);assert.equal(await run.delay(),expected);
    }
    assert.equal(calls,5);
  }finally{await run.stop();}
});

test('explicit Retry wakes a deferred feed and restarts its incomplete backoff',async()=>{
  let calls=0;
  const run=fixture(async()=>{calls++;return {kind:'deferred',retryAfterMs:2000};});
  try{
    await run.refresh();await run.advance(30_000);assert.equal(await run.delay(),60_000);
    await run.advance(1000);await run.retry();assert.equal(calls,3);assert.equal(await run.delay(),30_000);
  }finally{await run.stop();}
});

test('explicit Retry resets an automatic retry waiting behind another active player',async()=>{
  let attempts=0;
  const held=Promise.withResolvers<CandidateProbeResult>();
  const probe:FootballDependencies['probeCandidate']=async locator=>{
    if(locator.provider==='gooz'&&locator.playerId==='1'){attempts++;return {kind:'deferred',retryAfterMs:2000};}
    return held.promise;
  };
  const run=fixture(Object.assign(probe,{concurrency:1}),['1','2']);
  try{
    await run.refresh();await run.advance(30_000);assert.equal(attempts,1);
    await run.retry();held.resolve({kind:'unavailable',reason:'invalid-media'});await drain();
    assert.equal(attempts,2);assert.equal(await run.delay(),30_000);
  }finally{held.resolve({kind:'deferred',reason:'cancelled',retryAfterMs:2000});await run.stop();}
});

test('Retry resets an active check without cancelling it and success resets the next maintenance failure',async()=>{
  let calls=0,activeSignal:AbortSignal|undefined;
  const held=Promise.withResolvers<CandidateProbeResult>();
  const run=fixture(async(_locator,signal,onProgress)=>{
    calls++;onProgress({kind:'active'});
    if(calls===2){activeSignal=signal;return held.promise;}
    return calls===4?{kind:'playable',proof}:{kind:'deferred',retryAfterMs:2000};
  });
  try{
    await run.refresh();await run.advance(30_000);assert.equal(calls,2);
    await run.retry();assert.equal(calls,2);assert.equal(activeSignal?.aborted,false);
    held.resolve({kind:'deferred',retryAfterMs:2000});await drain();assert.equal(await run.delay(),30_000);
    await run.advance(30_000);assert.equal(await run.delay(),60_000);
    await run.advance(60_000);assert.equal(calls,4);
    await run.advance(1_800_000);assert.equal(calls,5);assert.equal(await run.delay(),30_000);
  }finally{held.resolve({kind:'deferred',retryAfterMs:2000});await run.stop();}
});

test('a replacement physical identity starts at the first incomplete delay',async()=>{
  const calls:string[]=[];
  const run=fixture(async locator=>{if(locator.provider==='gooz')calls.push(locator.playerId);return {kind:'deferred',retryAfterMs:2000};});
  try{
    await run.refresh();await run.advance(30_000);assert.equal(await run.delay(),60_000);
    run.replacePlayer('2');await run.advance(30*60_000);
    assert.ok(calls.includes('2'));assert.equal(await run.delay(),30_000);
  }finally{await run.stop();}
});
