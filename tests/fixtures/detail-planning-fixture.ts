import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {FootballStore} from '../../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../../lib/football/runtime/coordinator.ts';
import type {FootballDependencies,ListingSource} from '../../lib/football/domain/ports.ts';
import type {Game,Observation} from '../../lib/football/shared.ts';

const at=Date.parse('2026-10-18T12:00:00Z');
function gate(){
 let release=()=>{};
 const promise=new Promise<void>(resolve=>{release=resolve;});
 return {promise,release};
}
export async function planningSettled(){
 for(let turn=0;turn<4;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
}
async function until(read:()=>boolean,message:string){
 for(let turn=0;turn<500;turn++){
  if(read())return;
  await new Promise<void>(resolve=>setImmediate(resolve));
 }
 assert.fail(message);
}
function game(index:number,live=false):Game{
 const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:null});
 return {id:String(100+index),league:'nfl',name:`Away ${index} at Home ${index}`,
  date:new Date(at+(live?0:360+index)*60_000).toISOString(),home:team(`Home ${index}`),away:team(`Away ${index}`),
  status:live?'in':'pre',lifecycle:live?'live':'scheduled',detail:live?'Q1':'Scheduled',redzone:false,partitions:['nfl']};
}
type Collector=Pick<FootballCoordinator,'refresh'|'command'|'stop'>;
export function detailPlanningFixture({count=64,create=(dependencies:FootballDependencies):Collector=>new FootballCoordinator(dependencies)}={}){
 const store=new FootballStore(':memory:');
 const games=Array.from({length:count},(_,index)=>game(index)),live=game(99,true);
 const listing=gate(),pending=new Map<string,ReturnType<typeof gate>>(),reads:string[]=[];
 const hosts=new Map<string,number>(),hostPeaks=new Map<string,number>();
 let active=0,peak=0,hold=true,scans=0;
 const observations=store.observations.bind(store);
 store.observations=()=>{scans++;return observations();};
 const publicUrls=Array.from({length:4},(_,index)=>`https://host${index}.example/list`);
 const sources:ListingSource[]=['background','urgent'].map(id=>({id,url:`https://${id}.example/list`,family:id,publicUrls}));
 const observation=(match:Game,source:ListingSource,index:number):Observation=>({id:`${source.id}:${match.id}`,
  sourceId:source.id,url:`https://host${index%4}.example/detail/${match.id}`,title:match.name,league:'nfl',
  teams:[match.away.name,match.home.name],kickoff:Date.parse(match.date||''),rawTime:'',observedAt:at,parserVersion:2});
 const coordinator=create({store,now:()=>at,id:randomUUID,sources,
  schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
  readSchedule:async()=>({games:[...games,live],league:'nfl',at}),
  readSeasonMembership:async()=>({season:2026,at,teams:{}}),
  readHtml:async(url,signal)=>{
   if(url==='https://urgent.example/list'){await listing.promise;return '<main>fixture</main>';}
   if(url.endsWith('/list'))return '<main>fixture</main>';
   reads.push(url);active++;peak=Math.max(peak,active);
   const host=new URL(url).hostname;
   hosts.set(host,(hosts.get(host)||0)+1);hostPeaks.set(host,Math.max(hostPeaks.get(host)||0,hosts.get(host)||0));
   try{
    if(hold&&!url.endsWith('/199')){
     const wait=gate();pending.set(url,wait);
     signal?.addEventListener('abort',wait.release,{once:true});
     await wait.promise;
    }
    return '<main>fixture</main>';
   }finally{active--;hosts.set(host,(hosts.get(host)||1)-1);}
  },
  parseListings:source=>({outcome:'parsed',observations:source.id==='urgent'?[observation(live,source,0)]:games.map((match,index)=>observation(match,source,index))}),
  enrichObservation:value=>value,
  compatiblePlayers:gameId=>['a','b'].map((suffix,index)=>({id:`route-${gameId}-${suffix}`,label:suffix,
   locator:{provider:'gooz',playerId:`${gameId}${index}`}})),
  missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
  probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),
 });
 return {coordinator,reads,live,scans:()=>scans,peak:()=>peak,hostPeaks,
  async start(){await coordinator.refresh(true);await until(()=>reads.length===8,'Eight detail slots should fill');await planningSettled();},
  async insertLive(){listing.release();await until(()=>!!store.sourceAttempts().urgent,'Late listing should persist');await planningSettled();},
  releaseSlot(){const next=[...pending].find(([url])=>new URL(url).hostname==='host0.example');assert.ok(next);next[1].release();},
  async finish(){hold=false;for(const wait of pending.values())wait.release();await until(()=>store.detailEvidence().length===count+1,'Every admitted observation should publish details');await planningSettled();},
  async close(){listing.release();hold=false;for(const wait of pending.values())wait.release();await coordinator.stop();},
 };
}
