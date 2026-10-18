import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {DetailEvidenceSchema} from '../lib/football/shared.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {type Game,type Observation} from '../lib/football/shared.ts';

const start=Date.parse('2026-10-04T12:00:00Z');
const source={id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['nfl'] as const};
const scheduled=(kickoff:number):Game=>({id:'401872973',league:'nfl',name:'Titans at Ravens',date:new Date(kickoff).toISOString(),
  status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['nfl'],
  home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:null},
  away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:null}});
const settle=async()=>{for(let index=0;index<40;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
async function fixture(run:(state:{advance:(ms:number)=>Promise<void>;reads:()=>number;coordinator:ReturnType<typeof createFootballCoordinator>})=>Promise<void>,kickoff?:number,listed=false){
  const dir=mkdtempSync(join(tmpdir(),'automatic-polling-'));
  let clock=start,reads=0;
  const game=scheduled(kickoff??start+10*60*60_000);
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{now:()=>clock,sources:[source],
    readSchedule:async partition=>({games:kickoff!==undefined&&partition.id==='nfl'?[game]:[],league:partition.league,at:clock}),
    readHtml:async url=>{if(url===source.url)reads++;return '<main>recognized fixture</main>';},
    parseListings:()=>({outcome:listed?'parsed':'empty',observations:listed?[{id:'fixture-event',sourceId:source.id,url:'https://fixture.example/detail',title:game.name,
      league:'nfl',teams:[game.away.name,game.home.name],kickoff:kickoff??null,rawTime:'',observedAt:clock,parserVersion:2} satisfies Observation]:[]}),
    enrichObservation:value=>value,compatiblePlayers:()=>[],probeCandidate:async()=>({kind:'unavailable',reason:'no-feed'})});
  try{await coordinator.refresh();await settle();await run({coordinator,reads:()=>reads,advance:async ms=>{clock=start+ms;await coordinator.refresh();await settle();}});}
  finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
}

test('confirmed empty category sleeps for five hours and remains complete',async()=>{
  await fixture(async({advance,reads,coordinator})=>{assert.equal(reads(),1);await advance(30*60_000);assert.equal(reads(),1);
    const snapshot=await coordinator.command({kind:'sources'});assert.equal(snapshot.kind,'sources');
    if(snapshot.kind==='sources'){assert.equal(snapshot.snapshot.sources[0].lastAttempt?.outcome,'empty');assert.equal(snapshot.snapshot.sources[0].scopes[0].read.kind,'complete');}
    await advance(5*60*60_000);assert.equal(reads(),2);});
});
test('active category discovers new listings every thirty minutes',async()=>{
  await fixture(async({advance,reads})=>{await advance(29*60_000);assert.equal(reads(),1);await advance(30*60_000);assert.equal(reads(),2);},start+10*60*60_000,true);
});
test('missing event wakes an empty category two hours before official kickoff',async()=>{
  await fixture(async({advance,reads})=>{await advance(3*60*60_000-30_001);assert.equal(reads(),1);await advance(3*60*60_000);assert.equal(reads(),2);
    await advance(3.5*60*60_000);assert.equal(reads(),3);},start+5*60*60_000);
});
for(const published of [false,true])
test(`unchanged ${published?'published':'empty'} details survive restart and follow their refresh cadence`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stable-details-')),path=join(dir,'state.sqlite');
  let clock=start,details=0,playerId='1',fail=false;
  const game=scheduled(start+12*60*60_000);
  const options={now:()=>clock,sources:[source],readSchedule:async(partition:{id:string;league:Game['league']})=>({games:partition.id==='nfl'?[game]:[],league:partition.league,at:clock}),
    readHtml:async(url:string)=>{if(url!==source.url){details++;if(fail)throw new Error('network');}return '<main>fixture</main>';},
    parseListings:()=>({outcome:'parsed' as const,observations:[{id:'fixture-event',sourceId:source.id,url:'https://fixture.example/detail',title:game.name,
      league:'nfl' as const,teams:[game.away.name,game.home.name] as [string,string],kickoff:Date.parse(game.date!),rawTime:'',observedAt:clock,parserVersion:2 as const}]}),
    enrichObservation:(value:Observation)=>value,compatiblePlayers:()=>published||playerId==='2'?[{id:'server',label:'Server',locator:{provider:'gooz' as const,playerId}}]:[],
    missingPlayerReason:()=> 'no-published-player' as const,
    probeCandidate:async()=>({kind:'unavailable' as const,reason:'no-feed' as const})};
  let coordinator=createFootballCoordinator(path,options);
  const step=async(minutes:number)=>{clock=start+minutes*60_000;await coordinator.refresh();await settle();};
  const saved=()=>{const db=new DatabaseSync(path,{readOnly:true});try{const row=db.prepare('SELECT payload FROM details').get();return DetailEvidenceSchema.parse(JSON.parse(String(row?.payload)));}finally{db.close();}};
  try{
    await step(0);assert.equal(details,1);
    await step(30);await step(60);await step(90);assert.equal(details,4);assert.equal(saved().polling?.unchangedChecks,3);
    assert.equal(saved().nextEligibleAt,clock+(published?30*60_000:5*60*60_000));
    await coordinator.stop();coordinator=createFootballCoordinator(path,options);
    await step(120);assert.equal(details,published?5:4);
    await step(390);assert.equal(details,published?6:5);
    playerId='2';await step(600);assert.equal(details,published?7:6);assert.equal(saved().polling?.unchangedChecks,0);
    fail=true;await step(630);assert.equal(saved().outcome,'failed');assert.equal(saved().polling,undefined);
    fail=false;await step(635);assert.equal(saved().polling?.unchangedChecks,0);
    await step(665);assert.equal(saved().polling?.unchangedChecks,1);
    fail=true;
    await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:true});await settle();
    assert.equal(saved().outcome,'failed');
    const forcedReads=details;
    await step(666);assert.equal(details,forcedReads,'one forced failure must respect the normal retry deadline');
  }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
