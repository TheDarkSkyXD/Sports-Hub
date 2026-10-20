import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {SportsurgeCatalog,StreameastCatalog} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
type State='empty'|'pending'|'failed';
function catalog(state:State){
 const category=state==='empty'?{kind:'collected' as const,at}:state==='failed'?{kind:'failed' as const,at,reason:'timeout' as const}:{kind:'pending' as const};
 return {runId:randomUUID(),sequence:0,startedAt:at,state:state==='pending'?{kind:'collecting' as const}:state==='failed'?{kind:'partial' as const,at,reason:'timeout' as const}:{kind:'complete' as const,at},
  categories:{nfl:category,ncaaf:category},events:[],rejectedGames:[]};
}
function fixture(){
 const store=new FootballStore(':memory:');
 const coordinator=new FootballCoordinator({store,now:()=>at,id:randomUUID,schedules:[],
  sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/',family:'sportsurge',kind:'browser-catalog',leagues:['nfl','ncaaf']},
   {id:'streameast',url:'https://v2.streameast.ga/',family:'streameast',kind:'browser-catalog',leagues:['nfl','ncaaf']}],
  readSchedule:async()=>{throw new Error('No schedule reads expected');},readSeasonMembership:async()=>{throw new Error('No membership reads expected');},
  readHtml:async()=>{throw new Error('No network reads expected');},parseListings:()=>({outcome:'empty',observations:[]}),
  enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
  probeCandidate:async()=>{throw new Error('No probes expected');}});
 return {store,coordinator};
}

for(const source of ['sportsurge-v2','streameast'] as const)for(const state of ['empty','pending','failed'] as const){
 const nextSweepAt=at+(state==='empty'?18_000_000:state==='failed'?300_000:1000);
 test(`${source} polling ${state} catalogs preserves its deadline and saved details`,async()=>{
  const {store,coordinator}=fixture(),value=catalog(state);
  try{
   const event={id:'nfl:10001',league:'nfl' as const,title:'Away at Home',teams:['Away','Home'] as [string,string],kickoff:at,detail:{kind:'pending' as const}};
   if(source==='sportsurge-v2')store.saveSportsurgeCatalog({catalog:{...value,catalogIssues:[],events:state==='pending'?
    [{...event,url:'https://v2.sportsurge.net/watch-10001-nfl-away-home/',sourceStatus:'live',advertisedLinkCount:1}]:[]},receivedAt:at},[]);
   else store.saveStreameastCatalog({catalog:{...value,events:state==='pending'?
    [{...event,url:'https://v2.streameast.ga/nfl/away-vs-home/',espnEventId:null}]:[]},receivedAt:at},[]);
   assert.deepEqual(await coordinator.command({kind:'collector-polling',source}),{kind:'collector-polling',nextSweepAt});
   assert.deepEqual(store.detailEvidence(),[]);
  }finally{await coordinator.stop();}
 });
 test(`${source} accepts ${state} checkpoints without detail persistence or reuse setup`,async()=>{
  const {store,coordinator}=fixture(),value=catalog(state);
  try{
   const command=source==='sportsurge-v2'?{kind:'sportsurge-catalog' as const,catalog:{...value,catalogIssues:[]} satisfies SportsurgeCatalog}:
    {kind:'streameast-catalog' as const,catalog:value satisfies StreameastCatalog};
   assert.deepEqual(await coordinator.command(command),{kind:'catalog-ack',nextSweepAt,skipDetailEventIds:[]});
   assert.deepEqual(await coordinator.command({kind:'collector-polling',source}),{kind:'collector-polling',nextSweepAt});
   assert.deepEqual(store.detailEvidence(),[]);
  }finally{await coordinator.stop();}
 });
}
