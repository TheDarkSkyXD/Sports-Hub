import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {Game,VerificationTarget} from '../lib/football/shared.ts';

test('simultaneous incomplete retry deadlines share an inventory pass while commands see current grants and terminal state',async context=>{
  const at=Date.parse('2026-10-17T18:00:00Z');
  const game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'HOM',color:'112233',score:null},away:{name:'Away',short:'Away',abbreviation:'AWY',color:'332211',score:null}};
  const proof={kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} satisfies Extract<CandidateProbeResult,{kind:'playable'}>['proof'];
  const partition=FootballStore.prototype.partition;
  let reads=0;
  context.mock.method(FootballStore.prototype,'partition',function(this:FootballStore,id:string){reads++;return partition.call(this,id);});
  const drain=async()=>{for(let turn=0;turn<8;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
  const wave=async(deferredCount:number)=>{
    context.mock.timers.enable({apis:['setTimeout']});
    let clock=at;
    const pending:Array<{target:VerificationTarget;finish:(result:CandidateProbeResult)=>void}>=[];
    const probe:FootballDependencies['probeCandidate']=(_locator,signal,_progress,target)=>new Promise(resolve=>{
      const finish=(result:CandidateProbeResult)=>{signal.removeEventListener('abort',abort);resolve(result);};
      const abort=()=>finish({kind:'deferred',reason:'cancelled',retryAfterMs:2000});
      signal.addEventListener('abort',abort,{once:true});pending.push({target,finish});
    });
    const coordinator=createFootballCoordinator(':memory:',{now:()=>clock,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
      sources:[{id:'fixture',url:'https://fixture.invalid/list',family:'fixture'}],
      readSchedule:async()=>({games:[game],league:'nfl',at:clock}),readHtml:async()=>'<main/>',
      parseListings:()=>({outcome:'parsed',observations:[{id:'listing',sourceId:'fixture',url:'https://fixture.invalid/game',title:game.name,
        league:'nfl',teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:clock,parserVersion:3}]}),
      enrichObservation:value=>value,compatiblePlayers:()=>Array.from({length:40},(_,index)=>({id:`server-${index}`,label:`Server ${index}`,locator:{provider:'gooz',playerId:String(index)}})),
      probeCandidate:Object.assign(probe,{concurrency:8})});
    try{
      await coordinator.refresh(true);await drain();assert.equal(pending.length,8);
      const completed=pending[0];completed.finish({kind:'playable',proof});
      for(const job of pending.slice(1,deferredCount+1))job.finish({kind:'deferred',reason:'unverified',phase:'capture',retryAfterMs:30000});
      await drain();
      const state=await coordinator.command({kind:'sources'});assert.equal(state.kind,'sources');
      if(state.kind==='sources')assert.equal(state.snapshot.games[0].candidates.find(candidate=>candidate.id===completed.target.candidateId)?.availability.kind,'playable');
      const ended=await coordinator.command({kind:'authorize',sessionId:completed.target.sessionId,candidateId:completed.target.candidateId,generation:0});
      assert.equal(ended.kind,'error');if(ended.kind==='error')assert.equal(ended.status,410);
      const active=pending.at(-1);assert.ok(active);
      clock=at+30000;reads=0;context.mock.timers.tick(30000);await drain();
      const inventoryReads=reads;
      const authorized=await coordinator.command({kind:'authorize',sessionId:active.target.sessionId,candidateId:active.target.candidateId,generation:0});
      assert.equal(authorized.kind,'verification-authorized');
      assert.ok(pending.length>8,'The released slots must admit more first checks');
      return inventoryReads;
    }finally{await coordinator.stop();context.mock.timers.reset();}
  };
  const one=await wave(1),seven=await wave(7);
  assert.ok(seven<=one*2,`One retry wave must have bounded inventory reads: one=${one}, seven=${seven}`);
});
