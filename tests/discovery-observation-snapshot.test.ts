import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

test('idle sources preserve due publication and viewer authorization',async context=>{
  const at=Date.parse('2026-10-17T18:00:00Z');
  const game:Game={id:'fixture-game',league:'nfl',name:'Kansas City Chiefs at Buffalo Bills',date:new Date(at).toISOString(),
    away:{name:'Kansas City Chiefs',short:'Chiefs',abbreviation:'KC',color:'112233',score:'0'},
    home:{name:'Buffalo Bills',short:'Bills',abbreviation:'BUF',color:'112233',score:'0'},
    status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl']};
  for(const count of [2,32]){
    const store=new FootballStore(':memory:');
    store.savePartition('nfl',{games:[game],at});
    const sources=Array.from({length:count},(_,index)=>({id:`source-${index}`,url:`https://source-${index}.example/list`,family:`fixture-${index}`}));
    const observations:Observation[]=sources.map((source,index)=>({id:`event-${index}`,sourceId:source.id,
      url:`https://source-${index}.example/event`,title:game.name,teams:[game.away.name,game.home.name],league:'nfl',
      kickoff:at,rawTime:'',observedAt:index===count-1?at-30*60_000-1:at,parserVersion:3}));
    for(const [index,observation] of observations.entries()){
      store.saveListingAttempt(observation.sourceId,{at:observation.observedAt,outcome:'parsed',count:1,failures:0,
        parserVersion:3,nextEligibleAt:observation.observedAt+30*60_000},[{observation,result:{kind:'matched',gameId:game.id}}]);
      store.saveDetailEvidence({outcome:'resolved',observationId:observation.id,generation:'saved',identity:detailIdentity(observation),
        at:observation.observedAt,nextEligibleAt:observation.observedAt+30*60_000,
        players:[{id:`saved-${index}`,label:`Saved ${index}`,locator:{provider:'gooz',playerId:String(100+index)}}]});
    }
    const fetched:string[]=[];
    const coordinator=new FootballCoordinator({store,now:()=>at,id:randomUUID,sources,
      schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
      readSchedule:async()=>({games:[game],league:'nfl',at}),
      readSeasonMembership:async()=>{throw new Error('Membership fetch is not expected');},
      readHtml:async url=>{fetched.push(url);return '<main>Published player</main>';},
      parseListings:source=>({outcome:'parsed',observations:observations.filter(row=>row.sourceId===source.id).map(row=>({...row,observedAt:at}))}),
      enrichObservation:row=>row,
      compatiblePlayers:()=>[{id:'new-publication',label:'New publication',locator:{provider:'gooz',playerId:'999'}}],
      missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
      probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,
        observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),
    });
    const drain=async()=>{for(let turn=0;turn<30;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
    try{
      await drain();
      const opened=await coordinator.command({kind:'open',gameId:game.id,initialCandidateId:'saved-0',manual:false});
      assert.equal(opened.kind,'playback');
      if(opened.kind!=='playback')throw new Error('Expected a verified viewer session');
      fetched.length=0;
      const started=performance.now(),cpu=process.cpuUsage();
      await coordinator.refresh(true);await drain();
      assert.deepEqual(fetched,[`https://source-${count-1}.example/list`,`https://source-${count-1}.example/event`]);
      const session=opened.playback.session;
      const authorized=await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:'saved-0',generation:session.generation});
      assert.equal(authorized.kind,'authorized');
      if(authorized.kind!=='authorized')throw new Error('Expected the same viewer authorization');
      assert.equal(authorized.candidate.id,'saved-0');
      assert.equal(authorized.session.id,session.id);
      assert.equal(authorized.session.generation,0);
      const inventory=await coordinator.command({kind:'sources'});
      assert.equal(inventory.kind,'sources');
      if(inventory.kind!=='sources')throw new Error('Expected source inventory');
      const candidates=inventory.snapshot.games.find(row=>row.gameId===game.id)?.candidates;
      assert.equal(candidates?.find(row=>row.id==='new-publication')?.availability.kind,'playable');
      assert.equal(candidates?.find(row=>row.id==='saved-0')?.availability.kind,'playable');
      const used=process.cpuUsage(cpu);
      context.diagnostic(JSON.stringify({sources:count,workload:'refresh-authorize-inventory',
        wallMs:performance.now()-started,cpuMs:(used.user+used.system)/1000}));
    }finally{await coordinator.stop();}
  }
});
