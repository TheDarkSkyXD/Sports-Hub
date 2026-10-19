import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');

for(const mode of ['sources','room-sources'] as const)test(`${mode} projection reads persisted inputs once across the deadline-cache interval`,async()=>{
  let now=at,advance=false,attemptReads=0,observationReads=0;
  const store=new FootballStore(':memory:');
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const game:Game={id:'game',league:'nfl',name:'Away at Home',home:team('Home'),away:team('Away'),
    date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Live',redzone:false,partitions:['nfl']};
  store.savePartition('nfl',{at,games:[game]});
  const sources=Array.from({length:8},(_,index)=>({id:`fixture-${index}`,family:'fixture',url:`https://fixture-${index}.example/list`,leagues:['nfl'] as const}));
  for(const source of sources)store.saveListingAttempt(source.id,{at,outcome:'parsed',count:4},Array.from({length:4},(_,index)=>({
    observation:{id:`${source.id}-${index}`,sourceId:source.id,url:`${source.url}/${index}`,title:game.name,league:'nfl',
      teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:at,parserVersion:3},result:{kind:'matched',gameId:game.id}})));
  const attempts=store.sourceAttempts.bind(store),observations=store.observations.bind(store);
  store.sourceAttempts=()=>{attemptReads++;if(advance)now+=1100;return attempts();};
  store.observations=()=>{observationReads++;return observations();};
  const coordinator=new FootballCoordinator({store,now:()=>now,id:()=> 'fixture',schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],sources,
    readSchedule:async()=>({games:[game],league:'nfl',at:now}),readSeasonMembership:async()=>{throw new Error('No external reads');},readHtml:async()=>'',
    parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'deferred',reason:'cancelled',retryAfterMs:2000})});
  try{
    now=at+2000;advance=true;attemptReads=0;observationReads=0;
    const reply=await coordinator.command({kind:mode});
    assert.equal(reply.kind,mode);
    if(reply.kind==='sources'){
      assert.equal(reply.snapshot.at,at+2000);
      assert.deepEqual(reply.snapshot.games.map(row=>({id:row.gameId,candidates:row.candidates.length,links:row.sourceLinks.length})),[{id:'game',candidates:0,links:32}]);
      assert.ok(reply.snapshot.games[0].sourceLinks.every(link=>link.freshness==='fresh'&&link.evidence.kind==='pending'));
      assert.deepEqual(reply.snapshot.sources.map(source=>source.lastAttempt?.nextEligibleAt),Array(8).fill(at+30*60_000));
    }else if(reply.kind==='room-sources'){
      assert.deepEqual(reply.snapshot.games,[{gameId:'game',candidates:[],pending:true}]);
      assert.equal(reply.snapshot.collecting,false);
    }else throw new Error('Expected source projection');
    assert.equal(attemptReads,1,`One projection reread persisted attempts ${attemptReads} times`);
    assert.equal(observationReads,1,`One projection reread observations ${observationReads} times`);
  }finally{await coordinator.stop();}
});