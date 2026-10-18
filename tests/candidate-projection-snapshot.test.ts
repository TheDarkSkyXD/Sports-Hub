import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mock,test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import {sportsurgeObservation} from '../lib/football/domain/sportsurge-catalog.ts';
import type {Game,Observation,SportsurgeCatalog,StreameastCatalog} from '../lib/football/shared.ts';

for(const failedAtStart of [false,true])test(failedAtStart?
  'a standalone catalog refresh reads resolved evidence after a failed cold snapshot':
  'cold projection shares one validated detail snapshot across restored HTTP and catalog feeds',async()=>{
  const at=Date.parse('2026-10-17T18:00:00Z');
  let clock=at;
  const updatedAt=at+1000;
  const kickoff=at+30*60_000;
  const team=(name:string)=>({name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'game',league:'nfl',name:'Kansas City Chiefs at Buffalo Bills',date:new Date(kickoff).toISOString(),
    away:team('Kansas City Chiefs'),home:team('Buffalo Bills'),status:'pre',lifecycle:'scheduled',detail:'',redzone:false,partitions:['nfl']};
  const observation:Observation={id:'http-event',sourceId:'fixture',url:'https://fixture.example/game',
    title:game.name,teams:[game.away.name,game.home.name],league:'nfl',kickoff,rawTime:'',observedAt:at,parserVersion:3};
  const sportsurge:SportsurgeCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at}},events:[{
      id:'nfl:22222',url:'https://v2.sportsurge.net/watch-22222-nfl-kansas-city-chiefs-buffalo-bills/',league:'nfl',
      title:game.name,teams:[game.away.name,game.home.name],kickoff,sourceStatus:'upcoming',advertisedLinkCount:1,
      detail:{kind:'collected',at,providers:[{id:'provider',label:'Provider',observedAt:at,destination:{kind:'link',url:'https://media.example/game'}}]},
    }],rejectedGames:[],catalogIssues:[]};
  const streameast:StreameastCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at}},events:[{
      id:'nfl:33333',url:'https://v2.streameast.ga/nfl/kansas-city-chiefs-vs-buffalo-bills/',league:'nfl',
      title:game.name,teams:[game.away.name,game.home.name],kickoff,espnEventId:null,
      detail:{kind:'collected',at,servers:[{id:'1',label:'Free 1',url:'https://v2.streameast.ga/nfl/kansas-city-chiefs-vs-buffalo-bills/1',availability:{kind:'free-channel',channelId:'33'}}]},
    }],rejectedGames:[]};
  const store=new FootballStore(':memory:');
  store.savePartition('nfl',{games:[game],at});
  store.observe(observation,{kind:'matched',gameId:game.id});
  store.saveDetailEvidence({outcome:'resolved',observationId:observation.id,generation:'fixture',identity:detailIdentity(observation),at,
    players:[{id:'http-feed',label:'HTTP feed',locator:{provider:'gooz',playerId:'123'}}],nextEligibleAt:at+30*60_000});
  store.saveSportsurgeCatalog({catalog:sportsurge,receivedAt:at},[
    {observation:sportsurgeObservation(sportsurge.events[0],at),result:{kind:'matched',gameId:game.id}},
  ]);
  store.saveStreameastCatalog({catalog:streameast,receivedAt:at},[]);
  const sportsurgeDetailId=`sportsurge-v2:${sportsurge.events[0].url}`;
  if(failedAtStart)store.saveDetailEvidence({outcome:'failed',observationId:sportsurgeDetailId,generation:'failed',
    at:updatedAt,failure:'timed-out',failures:1,nextEligibleAt:updatedAt+5*60_000});
  const reads=mock.method(store,'detailEvidence');
  const coordinator=new FootballCoordinator({store,now:()=>clock,id:randomUUID,
    schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'},
      {id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-nfl-streams/',family:'sportsurge',kind:'browser-catalog'},
      {id:'streameast',url:'https://v2.streameast.ga/nfl-streams/',family:'streameast',kind:'browser-catalog'}],
    readSchedule:async()=>({games:[game],league:'nfl',at}),readHtml:async()=>{throw new Error('No source fetch expected');},
    readSeasonMembership:async()=>{throw new Error('No membership fetch expected');},
    parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,compatiblePlayers:()=>[],
    retryAfterMs:()=>0,probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),
  });
  const projectionReads=reads.mock.callCount();
  const drain=async()=>{for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
  const sourceChoices=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind!=='sources')throw new Error('Expected source inventory');
    const row=reply.snapshot.games.find(row=>row.gameId===game.id);
    assert.ok(row);
    return {working:row.workingChoiceCount,sources:row.candidates.filter(candidate=>candidate.availability.kind==='playable')
      .flatMap(candidate=>candidate.sourceIds).sort()};
  };
  try{
    await drain();
    assert.deepEqual(await sourceChoices(),failedAtStart?{working:2,sources:['fixture','streameast']}:
      {working:3,sources:['fixture','sportsurge-v2','streameast']});
    assert.equal(projectionReads,1,'One full projection must decode saved detail evidence once');
    clock=updatedAt;
    if(failedAtStart)store.saveDetailEvidence({outcome:'resolved',observationId:sportsurgeDetailId,generation:'resolved',
      at:updatedAt,players:[],nextEligibleAt:updatedAt+30*60_000});
    const expanded:SportsurgeCatalog={...sportsurge,runId:'33333333-3333-4333-8333-333333333333',sequence:0,startedAt:updatedAt,
      state:{kind:'complete',at:updatedAt},categories:{nfl:{kind:'collected',at:updatedAt},ncaaf:{kind:'collected',at:updatedAt}},
      events:sportsurge.events.map(event=>({...event,detail:{kind:'collected',at:updatedAt,providers:[
        {id:'provider',label:'Provider',observedAt:updatedAt,destination:{kind:'link',url:'https://media.example/game'}},
        {id:'second',label:'Second provider',observedAt:updatedAt,destination:{kind:'link',url:'https://media.example/game-two'}},
      ]}}))};
    const accepted=await coordinator.command({kind:'sportsurge-catalog',catalog:expanded});
    assert.equal(accepted.kind,'catalog-ack');
    await drain();
    assert.deepEqual(await sourceChoices(),{working:4,sources:['fixture','sportsurge-v2','sportsurge-v2','streameast']});
  }finally{await coordinator.stop();reads.mock.restore();}
});
