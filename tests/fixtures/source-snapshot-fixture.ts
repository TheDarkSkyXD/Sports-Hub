import {FootballStore} from '../../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../../lib/football/runtime/coordinator.ts';
import type {Game} from '../../lib/football/shared.ts';
import assert from 'node:assert/strict';

export const at=Date.parse('2026-10-18T18:00:00Z');
export function snapshotFixture(){
  let now=at;
  const store=new FootballStore(':memory:');
  const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const games:Game[]=Array.from({length:80},(_,index)=>({id:`game-${index}`,league:'nfl',name:`Fixture ${index}`,
    home:team('Home'),away:team('Away'),date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Live',redzone:false,partitions:['nfl']}));
  store.savePartition('nfl',{at,games});
  const coordinator=new FootballCoordinator({store,now:()=>now,id:()=> 'fixture',schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],sources:[],
    readSchedule:async()=>({games,league:'nfl',at:now}),readSeasonMembership:async()=>{throw new Error('No external reads');},readHtml:async()=>'',
    parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'deferred',reason:'cancelled',retryAfterMs:2000})});
  const snapshot=async()=>{const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');if(reply.kind!=='sources')throw new Error('Expected sources');return reply.snapshot;};
  return {coordinator,store,snapshot,setClock:(value:number)=>{now=value;}};
}
