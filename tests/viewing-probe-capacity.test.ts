import assert from 'node:assert/strict';
import {test} from 'node:test';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {Observation,VerificationTarget} from '../lib/football/shared.ts';
import verificationPolicy from '../lib/playback/verification-policy.json' with {type:'json'};
import {rankingAt,rankingFixture,rankingProof} from './fixtures/ranking-fixture.ts';

async function drain() {
  for(let turn=0;turn<40;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
}

function fixture(concurrency=verificationPolicy.concurrency) {
  const pending=new Map<string,{signal:AbortSignal;finish:(result?:CandidateProbeResult)=>void}>();
  const started:string[]=[];
  const aborted:string[]=[];
  let store:FootballDependencies['store']|undefined;
  const run=rankingFixture({count:1,create:dependencies=>{
    store=dependencies.store;
    const observation:Observation={id:'viewing-capacity',sourceId:'fixture',url:'https://fixture.example/viewing-capacity',
      title:'Away at Home',league:'nfl',teams:['Away','Home'],kickoff:rankingAt,rawTime:'',observedAt:rankingAt,parserVersion:3};
    dependencies.store.saveDetailEvidence({outcome:'resolved',observationId:observation.id,generation:'viewing-capacity',
      identity:detailIdentity(observation),at:rankingAt,nextEligibleAt:rankingAt+30*60_000,
      players:Array.from({length:32},(_,index)=>({id:`pending-${String(index).padStart(2,'0')}`,label:`Pending ${index}`,
        locator:{provider:'gooz' as const,playerId:String(index+1000)}}))},
    {observation,result:{kind:'matched',gameId:'10001'}});
    const probeCandidate:FootballDependencies['probeCandidate']=Object.assign(
      (_locator:Parameters<FootballDependencies['probeCandidate']>[0],signal:AbortSignal,
        onProgress:Parameters<FootballDependencies['probeCandidate']>[2],target:VerificationTarget)=>{
        started.push(target.candidateId);
        onProgress({kind:'active',since:rankingAt});
        return new Promise<CandidateProbeResult>(resolve=>{
          const finish=(result:CandidateProbeResult={kind:'playable',proof:rankingProof})=>{
            signal.removeEventListener('abort',cancel);
            pending.delete(target.candidateId);
            resolve(result);
          };
          const cancel=()=>{aborted.push(target.candidateId);finish({kind:'deferred',reason:'cancelled',retryAfterMs:2000});};
          pending.set(target.candidateId,{signal,finish});
          signal.addEventListener('abort',cancel,{once:true});
        });
      },{concurrency});
    return new FootballCoordinator({...dependencies,probeCandidate});
  }});
  const sources=async()=>{
    const reply=await run.coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind!=='sources')throw new Error('Expected source diagnostics');
    assert.ok(reply.snapshot.checks);
    return reply.snapshot.checks;
  };
  const finish=async(count:number)=>{
    for(const job of [...pending.values()].slice(0,count))job.finish();
    await drain();
  };
  const finishAll=async()=>{
    for(let batch=0;started.length<32||pending.size;batch++){
      assert.ok(batch<8,'All pending first attempts should finish');
      for(const job of [...pending.values()])job.finish();
      await drain();
    }
  };
  const freshenSchedule=(at:number)=>{
    if(!store)throw new Error('Expected the coordinator store');
    store.savePartition('nfl',{games:[run.game],at});
  };
  return {...run,pending,started,aborted,sources,finish,finishAll,freshenSchedule};
}

test('a viewer lets existing checks drain to four and close refills idle capacity',async()=>{
  const run=fixture();
  try{
    await drain();
    assert.equal(run.pending.size,16);
    assert.equal((await run.sources()).limit,16);
    const playback=await run.open();
    await run.finish(12);
    assert.equal(run.pending.size,4);
    assert.equal(run.started.length,16);
    assert.deepEqual(run.aborted,[]);
    const viewing=await run.sources();
    assert.equal(viewing.limit,4);
    assert.equal(viewing.active,4);
    assert.equal(viewing.completed,12);
    await run.coordinator.command({kind:'close',sessionId:playback.session.id});
    await drain();
    assert.equal(run.pending.size,16);
    assert.equal((await run.sources()).limit,16);
  }finally{await run.close();}
});

test('diagnostic limits follow cached viewer leases and expire after ninety seconds',async()=>{
  const run=fixture();
  try{
    await drain();
    await run.finishAll();
    assert.equal(run.pending.size,0);
    const finished=await run.sources();
    assert.equal(finished.limit,16);
    assert.equal(finished.completed,32);
    assert.equal(new Set(run.started).size,32);
    const playback=await run.open();
    assert.equal((await run.sources()).limit,4);
    run.setNow(rankingAt+90_001);
    assert.equal((await run.sources()).limit,16);
    await run.coordinator.command({kind:'close',sessionId:playback.session.id});
  }finally{await run.close();}
});

test('an expired viewer lease refills queued first attempts without cancelling work',async()=>{
  const run=fixture();
  try{
    await drain();
    await run.open();
    await run.finish(12);
    assert.equal(run.pending.size,4);
    run.setNow(rankingAt+90_001);
    run.freshenSchedule(rankingAt+90_001);
    await run.coordinator.command({kind:'check-sources',gameIds:[run.game.id],retry:false});
    await drain();
    const checks=await run.sources();
    assert.equal(run.pending.size,16);
    assert.equal(checks.limit,16);
    assert.equal(checks.completed,12);
    assert.deepEqual(run.aborted,[]);
  }finally{await run.close();}
});

test('viewing admission never exceeds a smaller configured verifier capacity',async()=>{
  const run=fixture(2);
  try{
    await drain();
    assert.equal(run.pending.size,2);
    await run.open();
    assert.equal((await run.sources()).limit,2);
    await run.finish(1);
    assert.equal(run.pending.size,2);
  }finally{await run.close();}
});
