import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import {workingFeedOwner} from '../lib/football/domain/working-feed.ts';
import {roomSources} from '../lib/football/domain/source-inventory.ts';

const [baselineBuild,output]=process.argv.slice(2);
assert.match(baselineBuild??'',/^[a-f0-9-]{36}$/,'Provide a preserved local build ID');
const preserved=resolve('.desktop-runtime/local-builds',baselineBuild,'standalone');
const {FootballCoordinator:BaselineCoordinator}=await import(pathToFileURL(resolve(preserved,'lib/football/runtime/coordinator.ts')).href);
const {FootballStore:BaselineStore}=await import(pathToFileURL(resolve(preserved,'lib/football/adapters/store.ts')).href);
const at=Date.parse('2026-10-18T18:00:00Z');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const team=(side,index)=>({name:`${side} Fixture ${index}`,short:`${side} ${index}`,abbreviation:`${side}${index}`,color:'112233',score:'0'});
const games=Array.from({length:96},(_,index)=>({id:`game-${index}`,league:'nfl',name:`Away Fixture ${index} at Home Fixture ${index}`,
  home:team('Home',index),away:team('Away',index),date:new Date(at+(index<8?0:7*86400000)).toISOString(),
  status:index<8?'in':'pre',lifecycle:index<8?'live':'scheduled',detail:'Fixture',redzone:false,partitions:['nfl']}));
const sources=Array.from({length:12},(_,index)=>({id:`fixture-${index}`,url:`https://fixture-${index}.example/list`,family:'fixture',leagues:['nfl']}));
const proof={kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4};
function create(Coordinator,Store){
  const store=new Store(':memory:');
  store.savePartition('nfl',{at,games});
  for(const [sourceIndex,source] of sources.entries()){
    const entries=games.slice(0,8).map(game=>({observation:{id:`${source.id}-${game.id}`,sourceId:source.id,url:`https://fixture-${sourceIndex}.example/event/${game.id}`,title:game.name,
      league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:at,parserVersion:3},result:{kind:'matched',gameId:game.id}}));
    for(let generation=0;generation<40;generation++)store.saveListingAttempt(source.id,{at:at-(40-generation)*60_000,outcome:'parsed',count:8,nextEligibleAt:at+1800000},entries);
    store.saveListingAttempt(source.id,{at,outcome:'parsed',count:8,nextEligibleAt:at+1800000},entries);
  }
  for(const game of games.slice(0,8))for(let index=0;index<24;index++){
    const locator={provider:'gooz',playerId:String(10000+Number(game.id.slice(5))*24+index)};
    const candidate={id:`retained-${String(24-index).padStart(2,'0')}`,gameId:game.id,label:'Fixture player',sourceIds:[sources[index%sources.length].id],observedAt:at-3600000,locator};
    const identityHash=hash([game.id,JSON.stringify(locator)]);
    store.replaceWorkingIdentity(game.id,identityHash,[{version:2,identityHash,candidate,owner:workingFeedOwner(game,['nfl']),checkedAt:at-60000,proof}]);
  }
  return new Coordinator({store,now:()=>at,id:()=> 'fixture',schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],sources,
    readSchedule:async()=>{throw new Error('No external reads');},readSeasonMembership:async()=>{throw new Error('No external reads');},readHtml:async()=>'',
    parseListings:()=>({outcome:'empty',observations:[]}),enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'deferred',reason:'cancelled',retryAfterMs:2000})});
}
const baseline=create(BaselineCoordinator,BaselineStore),changed=create(FootballCoordinator,FootballStore);
const samples=[];
const tasks={
  coldSources:coordinator=>{coordinator.inventoryCache=undefined;return coordinator.sourcesSnapshot();},
  cachedSources:coordinator=>coordinator.sourcesSnapshot(),
  coldRoom:coordinator=>{coordinator.inventoryCache=undefined;const value=coordinator.sourcesSnapshot('room');return 'sources' in value?roomSources(value):value;},
  cachedRoom:coordinator=>{const value=coordinator.sourcesSnapshot('room');return 'sources' in value?roomSources(value):value;},
};
try{
  assert.deepEqual(changed.sourcesSnapshot(),baseline.sourcesSnapshot());
  assert.equal(changed.sourcesSnapshot().games.flatMap(game=>game.candidates).length,192);
  for(const [task,run] of Object.entries(tasks)){
    for(let warmup=0;warmup<3;warmup++){run(baseline);run(changed);}
    for(let round=0;round<7;round++)for(const [mode,coordinator] of round%2?[['changed',changed],['baseline',baseline]]:[['baseline',baseline],['changed',changed]]){
      const iterations=task.startsWith('cold')?3:20;
      const start=performance.now(),cpu=process.cpuUsage();let value;
      for(let iteration=0;iteration<iterations;iteration++)value=run(coordinator);
      const used=process.cpuUsage(cpu);
      samples.push({task,mode,round,ms:(performance.now()-start)/iterations,cpuMs:(used.user+used.system)/1000/iterations,hash:hash(value)});
    }
    assert.equal(new Set(samples.filter(sample=>sample.task===task).map(sample=>sample.hash)).size,1,`${task} output changed`);
  }
  const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  const summary=Object.fromEntries(Object.keys(tasks).map(task=>[task,Object.fromEntries(['baseline','changed'].map(mode=>{
    const rows=samples.filter(sample=>sample.task===task&&sample.mode===mode);
    return [mode,{medianMs:median(rows.map(row=>row.ms)),medianCpuMs:median(rows.map(row=>row.cpuMs)),hash:rows[0].hash}];
  }))]));
  const result={baselineBuild,fixture:{games:96,liveGames:8,sources:12,retainedPlayableCandidates:192,catalogAttempts:492},rounds:7,summary,samples};
  if(output)await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
}finally{await baseline.stop();await changed.stop();}