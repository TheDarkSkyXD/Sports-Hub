import {createHash,randomUUID} from 'node:crypto';
import {FootballStore} from '../../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../../lib/football/runtime/coordinator.ts';
import {workingFeedOwner} from '../../lib/football/domain/working-feed.ts';
import type {FootballDependencies} from '../../lib/football/domain/ports.ts';
import type {AdvancingVideo,Candidate,Game} from '../../lib/football/shared.ts';

export const rankingAt=Date.parse('2026-10-18T18:00:00Z');
export const rankingProof:AdvancingVideo={kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4};
export function rankingFixture({count=4,scrambled=false,create=(dependencies:FootballDependencies)=>new FootballCoordinator(dependencies)}={}) {
 let now=rankingAt;
 const store=new FootballStore(':memory:');
 const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
 const game:Game={id:'10001',league:'nfl',name:'Away at Home',date:new Date(now).toISOString(),
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],home:team('Home'),away:team('Away')};
 store.savePartition('nfl',{games:[game],at:now});
 for(const index of Array.from({length:count},(_,index)=>scrambled?index*73%count:index)){
  const candidate:Candidate={id:`route-${String(index).padStart(3,'0')}`,gameId:game.id,label:`Route ${index}`,
   sourceIds:['fixture'],observedAt:now,locator:{provider:'gooz',playerId:String(index+100)}};
  const identityHash=createHash('sha256').update(JSON.stringify([game.id,JSON.stringify(candidate.locator)])).digest('hex');
  store.replaceWorkingIdentity(game.id,identityHash,[{version:2,identityHash,candidate,owner:workingFeedOwner(game,['nfl']),checkedAt:now,proof:rankingProof}]);
 }
 const coordinator=create({store,now:()=>now,id:randomUUID,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
  sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
  readSchedule:async()=>({games:[game],league:'nfl',at:now}),readSeasonMembership:async()=>{throw new Error('No membership reads');},
  readHtml:async()=>{throw new Error('No network reads');},parseListings:()=>({outcome:'empty',observations:[]}),
  enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
  probeCandidate:async()=>{throw new Error('Retained proof must not be reprobed');}});
 const partition=store.partition.bind(store);
 let reads=0;
 store.partition=id=>{reads++;return partition(id);};
 return {coordinator,game,reads:()=>reads,resetReads:()=>{reads=0;},setNow:(value:number)=>{now=value;},
  async open(initialCandidateId?:string){
   const reply=await coordinator.command({kind:'open',gameId:game.id,manual:false,...(initialCandidateId?{initialCandidateId}:{})});
   if(reply.kind!=='playback')throw new Error(`Expected playable fixture: ${JSON.stringify(reply)}`);
   return reply.playback;
  },close:()=>coordinator.stop()};
}
