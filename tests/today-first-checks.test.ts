import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {MatchupGame} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-04T17:00:00Z');
const playable:CandidateProbeResult={kind:'playable',proof:{kind:'advancing-video',version:1,
  startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
const incomplete:CandidateProbeResult={kind:'deferred',phase:'capture',retryAfterMs:20_000};
const unavailable:CandidateProbeResult={kind:'unavailable',reason:'upstream'};
const games:MatchupGame[]=[
  {id:'10001',league:'nfl',name:'Denver Broncos at San Francisco 49ers',date:new Date(at+2*60*60_000).toISOString(),
    lifecycle:'scheduled',status:'pre',detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:'San Francisco 49ers',short:'49ers',abbreviation:'SF',color:'112233',score:null},
    away:{name:'Denver Broncos',short:'Broncos',abbreviation:'DEN',color:'332211',score:null}},
  {id:'10002',league:'nfl',name:'Tennessee Titans at Baltimore Ravens',date:new Date(at+26*60*60_000).toISOString(),
    lifecycle:'scheduled',status:'pre',detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:null},
    away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:null}},
];
const todayId='10001',tomorrowId='10002';

async function drain() {
  for(let index=0;index<60;index++)await new Promise<void>(resolve=>setImmediate(resolve));
}

function fixture(options:{today?:number;tomorrow?:number;concurrency?:number;overnight?:boolean;todayInitiallyHidden?:boolean}={}) {
  const directory=mkdtempSync(join(tmpdir(),'today-first-checks-'));
  let clock=at,todayHidden=options.todayInitiallyHidden??false;
  const scheduled=games.map(game=>options.overnight&&game.id===todayId?
    {...game,date:new Date(at-24*60*60_000).toISOString(),lifecycle:'live' as const,status:'in' as const}:game);
  const counts=new Map([[todayId,options.today??4],[tomorrowId,options.tomorrow??2]]);
  const calls:Array<{gameId:string;candidateId:string}>=[];
  const pending=new Map<string,{gameId:string;candidateId:string;signal:AbortSignal;finish:(result:CandidateProbeResult)=>void}>();
  const probe:FootballDependencies['probeCandidate']=(_locator,signal,onProgress,target)=>{
    const {gameId,candidateId}=target;
    calls.push({gameId,candidateId});
    onProgress({kind:'active',since:clock});
    return new Promise<CandidateProbeResult>(resolve=>{
      const key=`${gameId}/${candidateId}`;
      const finish=(result:CandidateProbeResult)=>{
        signal.removeEventListener('abort',onAbort);
        pending.delete(key);
        resolve(result);
      };
      const onAbort=()=>finish({kind:'deferred',reason:'cancelled',retryAfterMs:2000});
      pending.set(key,{gameId,candidateId,signal,finish});
      signal.addEventListener('abort',onAbort,{once:true});
    });
  };
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:scheduled,league:'nfl',at:clock}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:scheduled.filter(game=>game.id!==todayId||!todayHidden).map(game=>({
      id:`event-${game.id}`,sourceId:'fixture',url:`https://fixture.example/event/${game.id}`,
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:Date.parse(game.date??''),
      rawTime:'',observedAt:clock,parserVersion:2,
    }))}),enrichObservation:observation=>observation,
    compatiblePlayers:gameId=>Array.from({length:counts.get(gameId)??0},(_,index)=>({id:`route-${index}`,label:`Route ${index}`,
      locator:{provider:'gooz',playerId:`${gameId}${index}`}})),probeCandidate:Object.assign(probe,{concurrency:options.concurrency??2}),
  });
  return {coordinator,calls,pending,publishToday(){todayHidden=false;},
    async refresh(elapsed=clock-at){clock=at+elapsed;await coordinator.refresh(true);await drain();},
    async finish(gameId:string,result:CandidateProbeResult=unavailable){
      const job=[...pending.values()].find(value=>value.gameId===gameId);
      assert.ok(job,`Expected an active check for ${gameId}`);
      job.finish(result);await drain();
    },
    async snapshot(){const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected sources');return reply.snapshot;},
    async stop(){await coordinator.stop();rmSync(directory,{recursive:true,force:true});},
  };
}

test('every today sibling receives a first attempt before tomorrow while due today retries share slots',async()=>{
  const run=fixture({today:24,tomorrow:2});
  try{
    await run.refresh();
    assert.deepEqual(run.calls.map(call=>call.gameId),[todayId,todayId]);
    for(let index=0;index<48&&new Set(run.calls.filter(call=>call.gameId===todayId).map(call=>call.candidateId)).size<24;index++){
      await run.refresh((index+1)*20_000);
      await run.finish(todayId,incomplete);
      if(new Set(run.calls.filter(call=>call.gameId===todayId).map(call=>call.candidateId)).size<24)
        assert.ok(run.calls.every(call=>call.gameId===todayId),'Tomorrow must wait for every today first attempt');
    }
    assert.equal(new Set(run.calls.filter(call=>call.gameId===todayId).map(call=>call.candidateId)).size,24);
    assert.ok(run.calls.filter(call=>call.gameId===todayId).length>24,'Due today retries receive fair turns');
  }finally{await run.stop();}
});

test('a due today retry gets a turn while first attempts remain queued',async()=>{
  const run=fixture({today:8,tomorrow:2,concurrency:1});
  try{
    await run.refresh();
    const retried=run.calls[0]?.candidateId;
    assert.ok(retried);
    await run.finish(todayId,incomplete);
    await run.refresh(30_000);
    await run.finish(todayId,unavailable);
    await run.finish(todayId,unavailable);
    assert.equal(run.calls.filter(call=>call.candidateId===retried).length,2,
      'A due today retry should share the first-pass frontier');
    assert.ok(new Set(run.calls.filter(call=>call.gameId===todayId).map(call=>call.candidateId)).size<8);
    assert.ok(run.calls.every(call=>call.gameId===todayId),'Tomorrow waits for today first attempts');
  }finally{await run.stop();}
});

for(const reason of ['capacity','cancelled'] as const)test(`${reason} does not finish today's first pass`,async()=>{
  const run=fixture({today:1,tomorrow:1,concurrency:1});
  try{
    await run.refresh();await run.finish(todayId,{kind:'deferred',reason,retryAfterMs:2000});
    assert.deepEqual(run.calls.map(call=>call.gameId),[todayId]);
    await run.refresh(1999);assert.equal(run.calls.length,1);
    await run.refresh(2000);assert.deepEqual(run.calls.map(call=>call.gameId),[todayId,todayId]);
    await run.finish(todayId,incomplete);
    assert.deepEqual(run.calls.map(call=>call.gameId),[todayId,todayId,tomorrowId]);
    await run.finish(tomorrowId,playable);
    assert.equal((await run.snapshot()).games.find(game=>game.gameId===tomorrowId)?.workingChoiceCount,1);
  }finally{await run.stop();}
});

test('an active final today attempt holds tomorrow until its outcome is known',async()=>{
  const run=fixture({today:1,tomorrow:2,concurrency:4});
  try{
    await run.refresh();assert.deepEqual(run.calls.map(call=>call.gameId),[todayId]);
    await run.finish(todayId,unavailable);
    assert.deepEqual(run.calls.map(call=>call.gameId),[todayId,tomorrowId,tomorrowId]);
    await run.finish(tomorrowId,playable);await run.finish(tomorrowId,playable);
    assert.equal((await run.snapshot()).games.find(game=>game.gameId===tomorrowId)?.workingChoiceCount,2);
  }finally{await run.stop();}
});

test('a newly published today feed takes the next slot without cancelling active tomorrow checks',async()=>{
  const run=fixture({today:2,tomorrow:4,todayInitiallyHidden:true});
  try{
    await run.refresh();assert.deepEqual(run.calls.map(call=>call.gameId),[tomorrowId,tomorrowId]);
    run.publishToday();await run.refresh(30*60_000);
    assert.ok([...run.pending.values()].every(job=>!job.signal.aborted));
    await run.finish(tomorrowId,incomplete);
    assert.equal(run.calls[2]?.gameId,todayId);
    await run.finish(todayId,playable);
    assert.equal(run.calls[3]?.gameId,todayId);
    assert.ok([...run.pending.values()].some(job=>job.gameId===tomorrowId&&!job.signal.aborted));
  }finally{await run.stop();}
});

test('an explicit tomorrow retry receives a slot during the automatic today first pass',async()=>{
  const run=fixture({today:3,tomorrow:1,concurrency:1,todayInitiallyHidden:true});
  try{
    await run.refresh();await run.refresh(26*60_000);await run.finish(tomorrowId,unavailable);
    run.publishToday();await run.refresh(30*60_000);
    await run.refresh(31*60_000);
    assert.deepEqual(run.calls.map(call=>call.gameId),[tomorrowId,todayId]);
    await run.coordinator.command({kind:'check-sources',gameIds:[tomorrowId],retry:true});await drain();
    await run.finish(todayId,incomplete);
    assert.equal(run.calls[2]?.gameId,tomorrowId);
    await run.finish(tomorrowId,playable);
    assert.equal(run.calls[3]?.gameId,todayId);
    assert.equal((await run.snapshot()).games.find(game=>game.gameId===tomorrowId)?.workingChoiceCount,1);
  }finally{await run.stop();}
});

test('a newly published today feed starts after active tomorrow maintenance drains',async()=>{
  const run=fixture({today:3,tomorrow:1,concurrency:1,todayInitiallyHidden:true});
  try{
    await run.refresh();await run.refresh(60_000);await run.finish(tomorrowId,playable);
    run.publishToday();await run.refresh(30*60_000);
    assert.deepEqual(run.calls.map(call=>call.gameId),[tomorrowId,tomorrowId]);
    await run.finish(tomorrowId,playable);
    assert.equal(run.calls[2]?.gameId,todayId);
    for(let index=0;index<3;index++)await run.finish(todayId,playable);
    assert.deepEqual(run.calls.map(call=>call.gameId),[tomorrowId,tomorrowId,todayId,todayId,todayId]);
    assert.deepEqual((await run.snapshot()).games.map(game=>game.workingChoiceCount),[3,1]);
  }finally{await run.stop();}
});

test('a due healthy recheck follows today first checks before tomorrow first checks',async()=>{
  const run=fixture({today:3,tomorrow:1,concurrency:1});
  try{
    await run.refresh();await run.finish(todayId,playable);
    await run.refresh(30*60_000);
    await run.finish(todayId,incomplete);
    assert.deepEqual(run.calls[2],{gameId:todayId,candidateId:'route-2'});
    await run.finish(todayId,incomplete);
    assert.deepEqual(run.calls[3],{gameId:todayId,candidateId:'route-0'});
    await run.finish(todayId,playable);
    assert.equal(run.calls[4]?.gameId,tomorrowId);
    await run.finish(tomorrowId,playable);
    assert.equal((await run.snapshot()).games.find(game=>game.gameId===todayId)?.workingChoiceCount,1);
  }finally{await run.stop();}
});

test('a still-live game from yesterday shares today first-pass priority',async()=>{
  const run=fixture({today:3,tomorrow:1,concurrency:1,overnight:true});
  try{
    await run.refresh();
    for(let index=0;index<3;index++)await run.finish(todayId,playable);
    assert.deepEqual(run.calls.map(call=>call.gameId),[todayId,todayId,todayId,tomorrowId]);
    assert.equal((await run.snapshot()).games.find(game=>game.gameId===todayId)?.workingChoiceCount,3);
  }finally{await run.stop();}
});
