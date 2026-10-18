import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

for(const change of ['quarter','kickoff'] as const)test(`a ${change} update during detail resolution keeps collection freshness and current game ownership`,async()=>{
  const at=Date.parse('2026-10-17T18:00:00Z');
  let clock=at+29*60_000+59_000;
  let game:Game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
    home:{name:'Home',short:'Home',abbreviation:'H',color:'112233',score:null},away:{name:'Away',short:'Away',abbreviation:'A',color:'332211',score:null}};
  const observation:Observation={id:'listing',sourceId:'fixture',url:'https://fixture.example/detail',title:game.name,
    league:'nfl',teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:at,parserVersion:3};
  const store=new FootballStore(':memory:');
  store.savePartition('nfl',{games:[game],at:clock});
  store.saveListingAttempt('fixture',{at,outcome:'parsed',count:1,parserVersion:3,nextEligibleAt:at+30*60_000},
    [{observation,result:{kind:'matched',gameId:game.id}}]);
  const detail=Promise.withResolvers<string>(),listing=Promise.withResolvers<string>();
  let detailReads=0;
  const coordinator=new FootballCoordinator({store,now:()=>clock,id:randomUUID,
    schedules:[{id:'nfl',league:'nfl',path:'',group:null}],sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[game],league:'nfl',at:clock}),readHtml:url=>{
      if(url.endsWith('/detail')){detailReads++;return detail.promise;}return listing.promise;},
    readSeasonMembership:async()=>{throw new Error('No membership expected');},
    parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,
    compatiblePlayers:()=>[{id:'server',label:'Server',locator:{provider:'gooz',playerId:'1'}}],
    probeCandidate:async()=>({kind:'deferred',retryAfterMs:30_000}),retryAfterMs:()=>0});
  const drain=async()=>{for(let turn=0;turn<60;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    await coordinator.refresh(true);await drain();assert.equal(detailReads,1,'The original resolution must be waiting on its detail read');
    clock=at+30*60_000+52_000;
    game=change==='quarter'?{...game,detail:'Q2'}:{...game,date:new Date(at+24*60*60_000).toISOString()};
    await coordinator.refresh(true);await drain();
    assert.equal(store.partition('nfl')?.games[0].detail,game.detail);
    detail.resolve('<main/>');await drain();
    const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.deepEqual(reply.snapshot.games.find(row=>row.gameId===game.id)?.candidates.map(row=>row.id),change==='quarter'?['server']:[]);
    if(change==='quarter'){
      const published=store.detailEvidence()[0];assert.equal(published?.outcome,'resolved');
      assert.deepEqual(published?.event,{gameId:game.id,date:game.date});
      assert.equal(store.sourceAttempts().fixture.at,at,'The listing refresh must still be pending inside its settle window');
    }
  }finally{detail.resolve('<main/>');listing.resolve('<main/>');await coordinator.stop();}
});
