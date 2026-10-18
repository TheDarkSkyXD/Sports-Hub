import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,VerificationTarget} from '../lib/football/shared.ts';

const initial=Date.parse('2026-10-13T23:00:00Z');
const playable:CandidateProbeResult={kind:'playable',proof:{kind:'advancing-video',version:1,
  startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
const drain=async()=>{for(let index=0;index<80;index++)await new Promise<void>(resolve=>setImmediate(resolve));};

function fixture(days:number[],start=initial){
  let now=start;
  const games:Game[]=days.map((day,index)=>({id:String(100+index),league:'nfl',
    name:`Away ${index} at Home ${index}`,date:new Date(start+day*86_400_000).toISOString(),
    lifecycle:day>0?'scheduled':'live',status:day>0?'pre':'in',detail:'',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:'0'},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:'0'}}));
  const pending=new Map<string,{target:VerificationTarget;finish:()=>void}>();
  const started:VerificationTarget[]=[];
  const probe:FootballDependencies['probeCandidate']=Object.assign((_locator,signal,onProgress,target)=>{
    started.push(target);onProgress({kind:'active',since:now});
    return new Promise<CandidateProbeResult>(resolve=>{
      const finish=()=>{signal.removeEventListener('abort',abort);pending.delete(target.sessionId);resolve(playable);};
      const abort=()=>{pending.delete(target.sessionId);resolve({kind:'deferred',retryAfterMs:2000});};
      pending.set(target.sessionId,{target,finish});signal.addEventListener('abort',abort,{once:true});
    });
  },{concurrency:4});
  const directory=mkdtempSync(join(tmpdir(),'per-game-checks-'));
  const sources=['one','two'].map(id=>({id,url:`https://${id}.example/list`,family:'fixture'}));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],sources,
    readSchedule:async()=>({games,league:'nfl',at:now}),readHtml:async url=>url,
    parseListings:source=>({outcome:'parsed',observations:games.map(game=>({
      id:`${source.id}-${game.id}`,sourceId:source.id,url:`https://${source.id}.example/${game.id}`,
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:Date.parse(game.date??''),
      rawTime:'',observedAt:now,parserVersion:3}))}),enrichObservation:value=>value,
    compatiblePlayers:(gameId,observation)=>Array.from({length:7},(_,index)=>({
      id:`${observation.sourceId}-${index}`,label:`Feed ${index}`,
      locator:{provider:'gooz',playerId:`${gameId}${observation.sourceId==='one'?1:2}${index}`}})),probeCandidate:probe,
  });
  return {coordinator,pending,started,games,count:(gameId:string)=>[...pending.values()].filter(job=>job.target.gameId===gameId).length,
    setNow(value:number){now=value;},async stop(){await coordinator.stop();rmSync(directory,{recursive:true,force:true});}};
}

test('four global checks finish today before tomorrow and exhaust every source after playable results',async()=>{
  const run=fixture([0,0,1,1]);
  try{
    await run.coordinator.refresh(true);await drain();
    assert.equal(run.pending.size,4);
    assert.ok(run.count('100')>0&&run.count('101')>0,'Both live games receive a check');
    assert.deepEqual(run.games.map(game=>run.count(game.id)),[2,2,0,0]);
    for(let batch=0;run.pending.size||run.started.length<56;batch++){
      assert.ok(batch<30,'Every available feed must finish');
      for(const job of [...run.pending.values()])job.finish();await drain();
      assert.ok(run.pending.size<=4);
    }
    assert.equal(new Set(run.started.map(target=>target.gameId+'/'+target.candidateId)).size,56);
    assert.equal(run.started.slice(0,28).filter(target=>target.gameId==='100'||target.gameId==='101').length,28);
    assert.equal(run.started.slice(28).filter(target=>target.gameId==='102'||target.gameId==='103').length,28);
    const reply=await run.coordinator.command({kind:'sources'});assert.ok(reply.kind==='sources');
    assert.deepEqual(reply.snapshot.games.map(game=>game.workingChoiceCount),[14,14,14,14]);
  }finally{await run.stop();}
});

test('Chicago midnight preserves one global coordinator budget',async()=>{
  const start=Date.parse('2026-10-14T04:59:00Z');
  const run=fixture([0,0,1],start);
  try{
    await run.coordinator.refresh(true);await drain();
    assert.equal(run.pending.size,4);
    run.setNow(Date.parse('2026-10-14T05:01:00Z'));
    await run.coordinator.refresh(true);await drain();
    assert.equal(run.pending.size,4);
    assert.ok(run.started.every(target=>Number.isInteger(target.gameDay)));
  }finally{await run.stop();}
});

test('games beyond the first checker batch receive a turn before earlier games exhaust their feeds',async()=>{
  const run=fixture(Array(27).fill(0));
  try{
    await run.coordinator.refresh(true);await drain();
    assert.equal(run.pending.size,4);
    for(let batch=0;new Set(run.started.map(target=>target.gameId)).size<27;batch++){
      assert.ok(batch<10,'Every game receives a first check promptly');
      for(const job of [...run.pending.values()])job.finish();await drain();
      assert.ok(run.pending.size<=4);
    }
    assert.equal(new Set(run.started.map(target=>target.gameId)).size,27);
    assert.ok(run.games.every(game=>run.started.filter(target=>target.gameId===game.id).length<14));
  }finally{await run.stop();}
});
