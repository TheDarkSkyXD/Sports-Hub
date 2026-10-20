import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

test('restored detail publications survive a snapshot clock rollover',async()=>{
  const at=Date.parse('2026-10-18T18:00:00Z');
  let now=at;
  const store=new FootballStore(':memory:');
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const game:Game={id:'game',league:'nfl',name:'Away at Home',home:team('Home'),away:team('Away'),
    date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Live',redzone:false,partitions:['nfl']};
  const source={id:'fixture',family:'fixture',url:'https://fixture.example/list',leagues:['nfl'] as const};
  store.savePartition('nfl',{at,games:[game]});
  const observations:Observation[]=Array.from({length:8},(_,index)=>({id:'event-'+index,sourceId:source.id,
    url:source.url+'/'+index,title:game.name,league:'nfl',teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:at,parserVersion:3}));
  store.saveListingAttempt(source.id,{at,outcome:'parsed',count:8},observations.map(observation=>({observation,result:{kind:'matched',gameId:game.id}})));
  for(const observation of observations)store.saveDetailEvidence({outcome:'resolved',observationId:observation.id,
    generation:'saved',identity:detailIdentity(observation),at,nextEligibleAt:at+30*60_000,
    players:Array.from({length:4},(_,index)=>({id:observation.id+'-'+index,label:'Feed '+index,locator:{provider:'gooz',playerId:String(1000+Number(observation.id.split('-')[1])*4+index)}}))});
  const coordinator=new FootballCoordinator({store,now:()=>now,id:randomUUID,sources:[source],
    schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    readSchedule:async()=>({games:[game],league:'nfl',at:now}),readSeasonMembership:async()=>{throw new Error('No external reads');},
    readHtml:async()=>'',parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,
    compatiblePlayers:()=>[],retryAfterMs:()=>0,probeCandidate:async()=>({kind:'deferred',reason:'cancelled',retryAfterMs:2000})});
  try{
    now=at+1100;
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind!=='sources')throw new Error('Expected source inventory');
    assert.deepEqual(reply.snapshot.games.flatMap(row=>row.candidates.map(candidate=>candidate.id)).sort(),
      Array.from({length:8},(_,event)=>Array.from({length:4},(_,feed)=>'event-'+event+'-'+feed)).flat().sort());
    now=at+2200;
    const later=await coordinator.command({kind:'sources'});
    assert.equal(later.kind,'sources');
    if(later.kind!=='sources')throw new Error('Expected source inventory');
    assert.deepEqual(later.snapshot.games.flatMap(row=>row.candidates.map(candidate=>candidate.id)).sort(),
      Array.from({length:8},(_,event)=>Array.from({length:4},(_,feed)=>'event-'+event+'-'+feed)).flat().sort());
  }finally{await coordinator.stop();}
});
