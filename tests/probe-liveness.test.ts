import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock,test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-03T18:00:00Z');
function game(index:number):Game {
  return {id:String(100+index),league:'nfl',name:`Away ${index} at Home ${index}`,
    date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null}};
}
function fixture(count:number,probe:FootballDependencies['probeCandidate']) {
  const games=Array.from({length:count},(_,index)=>game(index));
  const directory=mkdtempSync(join(tmpdir(),'source-probe-progress-'));
  let clock=at;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at:clock}),
    readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:games.map(row=>({
      id:`listing-${row.id}`,sourceId:'fixture',url:`https://fixture.example/detail/${row.id}`,
      title:row.name,teams:[row.away.name,row.home.name],league:'nfl',kickoff:at,
      rawTime:'',observedAt:clock,parserVersion:2,
    } satisfies Observation))}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`server-${gameId}`,label:'Server',locator:{provider:'gooz',playerId:gameId}}],
    probeCandidate:probe,
  });
  return {coordinator,games,setClock:(value:number)=>{clock=value;},cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}
async function until(read:()=>Promise<boolean>|boolean,message:string):Promise<void> {
  for(let index=0;index<150;index++){
    if(await read())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}
async function sources(coordinator:ReturnType<typeof createFootballCoordinator>) {
  const reply=await coordinator.command({kind:'sources'});
  assert.equal(reply.kind,'sources');
  if(reply.kind!=='sources')throw new Error('Expected sources');
  return reply.snapshot;
}
function hold() {
  let release:(result:CandidateProbeResult)=>void=()=>{};
  const promise=new Promise<CandidateProbeResult>(resolve=>{release=resolve;});
  return {promise,release};
}
async function withFakeDeadline(run:(advance:(ms:number)=>void)=>Promise<void>) {
  const original=AbortSignal.timeout;
  mock.timers.enable({apis:['setTimeout']});
  AbortSignal.timeout=(ms:number)=>{
    const controller=new AbortController();
    setTimeout(()=>controller.abort(new DOMException('Probe timed out','TimeoutError')),ms);
    return controller.signal;
  };
  try {await run(ms=>mock.timers.tick(ms));}
  finally {AbortSignal.timeout=original;mock.timers.reset();}
}

test('four stalled probes time out, free a slot, and use the saved five-minute retry',async()=>{
  const held:Array<ReturnType<typeof hold>>=[],started:string[]=[];
  const run=fixture(5,async locator=>{
    assert.equal(locator.provider,'gooz');
    if(locator.provider!=='gooz')throw new Error('Expected gooz');
    started.push(locator.playerId);
    if(started.length===5)return {kind:'playable',proof:'media'};
    const gate=hold();held.push(gate);return gate.promise;
  });
  try {
    await withFakeDeadline(async advance=>{
      await run.coordinator.refresh(true);
      await until(()=>started.length===4,'four checks should occupy the probe slots');
      run.setClock(at+65_000);
      advance(65_000);
      await until(()=>started.length===5,'the fifth check should start after the 65-second budget');
      await until(async()=>{
        const snapshot=await sources(run.coordinator);
        return snapshot.games.find(row=>row.gameId===run.games[4].id)?.candidates[0]?.availability.kind==='playable';
      },'the fifth candidate should become playable');
      const snapshot=await sources(run.coordinator);
      for(const row of snapshot.games.filter(row=>row.gameId!==run.games[4].id)){
        const availability=row.candidates[0]?.availability;
        assert.deepEqual(availability,{kind:'unavailable',reason:'timeout',checkedAt:at+65_000,retryAt:at+365_000});
      }
    });
  } finally {
    for(const gate of held)gate.release({kind:'playable',proof:'media'});
    await run.coordinator.stop();run.cleanup();
  }
});

test('stop settles after abort even when a provider never answers',async()=>{
  const gate=hold();let started=false;
  const run=fixture(1,async()=>{started=true;return gate.promise;});
  let stopping:Promise<void>|undefined;
  try {
    await run.coordinator.refresh(true);
    await until(()=>started,'the probe should begin');
    stopping=run.coordinator.stop();
    let settled=false;
    void stopping.then(()=>{settled=true;});
    await until(()=>settled,'stop should settle without the provider answering');
  } finally {
    gate.release({kind:'playable',proof:'media'});
    await (stopping??run.coordinator.stop());run.cleanup();
  }
});

test('a late playable result cannot replace a newer check result',async()=>{
  const first=hold();let calls=0;
  const run=fixture(1,async()=>{calls++;return calls===1?first.promise:{kind:'playable',proof:'decoded'};});
  try {
    await withFakeDeadline(async advance=>{
      await run.coordinator.refresh(true);
      await until(()=>calls===1,'the first check should begin');
      run.setClock(at+65_000);
      advance(65_000);
      await until(async()=>{
        const availability=(await sources(run.coordinator)).games[0]?.candidates[0]?.availability;
        return availability?.kind==='unavailable'&&availability.reason==='timeout';
      },'the first check should time out');
      assert.deepEqual(await run.coordinator.command({kind:'check-sources',gameIds:[run.games[0].id],retry:true}),{kind:'ok'});
      await until(()=>calls===2,'the replacement check should begin');
      await until(async()=>{
        const availability=(await sources(run.coordinator)).games[0]?.candidates[0]?.availability;
        return availability?.kind==='playable'&&availability.proof==='decoded';
      },'the replacement should record decoded proof');
      first.release({kind:'playable',proof:'media'});
      for(let index=0;index<20;index++)await new Promise<void>(resolve=>setImmediate(resolve));
      const availability=(await sources(run.coordinator)).games[0]?.candidates[0]?.availability;
      assert.equal(availability?.kind,'playable');
      if(availability?.kind==='playable')assert.equal(availability.proof,'decoded');
    });
  } finally {
    first.release({kind:'playable',proof:'media'});
    await run.coordinator.stop();run.cleanup();
  }
});
