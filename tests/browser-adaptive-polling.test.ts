import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {DetailEvidenceSchema,type Game,type SportsurgeCatalog} from '../lib/football/shared.ts';
import {browserCategoryDeadline} from '../lib/football/domain/browser-polling.ts';
import {FootballStore} from '../lib/football/adapters/store.ts';
const require=createRequire(import.meta.url);
test('rejected browser listings stay on failure cadence instead of becoming an empty success',()=>{
  const at=Date.parse('2026-10-04T12:00:00Z');
  const catalog:SportsurgeCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,state:{kind:'complete',at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'pending'}},events:[],rejectedGames:[{league:'nfl',title:'Invalid event',reason:'invalid-detail-url'}],catalogIssues:[]};
  assert.equal(browserCategoryDeadline(catalog,'nfl',[],at),at+5*60_000);
  const store=new FootballStore(':memory:');
  try{store.saveSportsurgeCatalog({receivedAt:at,catalog},[]);assert.equal(store.collectionHistory(at)[0].outcome,'parser-changed');}
  finally{store.close();}
});
test('native browser sweeps reuse sleeping category evidence without refetching or dating it anew',async()=>{
  const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
  const originalAt=Date.parse('2026-10-04T12:00:00Z'),now=originalAt+30*60_000;
  const categories=SOURCE_REGISTRY.find(row=>row.id==='sportsurge-v2')?.browserCategories??[];
  const seen:string[]=[];
  const catalog=await runSportsurgeSweep({now:()=>now,signal:new AbortController().signal,
    read:async(_url:string,_role:string,league:string)=>{seen.push(league);return '<div id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></div>';},
    send:async(value:{sequence:number})=>({kind:'catalog-ack',skipDetailEventIds:[],nextSweepAt:now+5*60*60_000,
      ...(value.sequence===0?{reuseCategories:{kind:'sportsurge-v2',categories:categories.filter(row=>row.league!=='nfl').map(row=>({league:row.league,at:originalAt})),events:[]}}:{})})});
  assert.deepEqual(seen,['nfl']);
  assert.equal(catalog.categories.nfl.at,now);
  assert.equal(catalog.categories.ncaaf.at,originalAt);
  assert.equal(catalog.state.kind,'complete');
});

for(const name of ['sportsurge','streameast'])for(const rateLimited of [false,true])
test(`${name} local deadline query wakes an idle collector${rateLimited?' after provider cooldown':''}`,async()=>{
  let clock=0,calls=0,timerId=0,wake=false,acknowledged=false;
  let heartbeat:(()=>Promise<void>)|undefined;
  const timers=new Map<number,{at:number;work:()=>void}>();
  const file=resolve(`desktop/${name}-collector.cjs`),actualRequire=createRequire(file),exported={exports:{}};
  const sweepName=name==='sportsurge'?'runSportsurgeSweep':'runStreameastSweep';
  const createName=name==='sportsurge'?'createSportsurgeCollector':'createStreameastCollector';
  let networkHook:unknown;
  const session={webRequest:{onBeforeRequest(hook:unknown){networkHook=hook;}},setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){}};
  runInNewContext(readFileSync(file,'utf8'),{module:exported,Buffer,AbortController,AbortSignal,
    Date:{now:()=>clock},require:(id:string)=>id==='electron'?{session:{fromPartition:()=>session}}:
      id===`./${name}-sweep.cjs`?{[sweepName]:async({send}:{send:(catalog:object)=>Promise<unknown>})=>{
        calls++;await send({events:[],sequence:0});acknowledged=true;return {state:{kind:rateLimited?'partial':'complete',...(rateLimited?{reason:'rate-limited'}:{})}};
      }}:actualRequire(id),
    fetch:async(_url:string,options:{method?:string})=>Response.json(options.method==='POST'?
      {kind:'catalog-ack',skipDetailEventIds:[],skipDetailEventUrls:['https://public.example/reused'],reuseCategories:{kind:name==='sportsurge'?'sportsurge-v2':'streameast',categories:[],events:[{url:'https://public.example/reused'}]},nextSweepAt:clock+5*60*60_000}:
      {kind:'collector-polling',nextSweepAt:wake?clock:5*60*60_000}),
    setTimeout:(work:()=>void,ms:number)=>{const id=++timerId;timers.set(id,{at:clock+ms,work});return id;},
    clearTimeout:(id:number)=>timers.delete(id),setInterval:(work:()=>Promise<void>)=>{heartbeat=work;return 1;},clearInterval:()=>{heartbeat=undefined;}});
  const create=Reflect.get(exported.exports,createName),collector=create({origin:'http://127.0.0.1:1',controlToken:'unused'});
  try{
    assert.equal(typeof networkHook,'function');
    collector.start();await collector.requestSweep();assert.equal(calls,1);
    assert.equal(acknowledged,true,'reused category event URLs are valid acknowledgement targets');
    assert.deepEqual([...timers.values()].map(row=>row.at),[5*60*60_000]);
    clock=30_000;await heartbeat?.();assert.equal(calls,1,'local plan checks do not fetch source pages');
    wake=true;await heartbeat?.();
    assert.deepEqual([...timers.values()].map(row=>row.at),[rateLimited?5*60_000:clock]);
    if(rateLimited)clock=5*60_000;
    for(const [id,row] of timers)if(row.at<=clock){timers.delete(id);row.work();}
    await collector.requestSweep();assert.equal(calls,2);
  }finally{collector.stop();assert.equal(networkHook,null);assert.equal(heartbeat,undefined);assert.equal(timers.size,0);}
});

for(const published of [false,true])
test(`coordinator and native sweeps keep category and ${published?'published':'empty'} detail schedules separate`,async()=>{
  const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
  const dir=mkdtempSync(join(tmpdir(),'browser-adaptive-')),path=join(dir,'state.sqlite');
  const start=Date.parse('2026-10-04T12:00:00Z'),kickoff=start+10*60*60_000;
  let clock=start,details=0;
  const categoryReads=new Map<string,number>();
  const source=SOURCE_REGISTRY.find(row=>row.id==='sportsurge-v2');assert.ok(source);
  const game:Game={id:'401872973',league:'nfl',name:'Titans at Ravens',date:new Date(kickoff).toISOString(),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:'Baltimore Ravens',short:'Ravens',abbreviation:'BAL',color:'112233',score:null},away:{name:'Tennessee Titans',short:'Titans',abbreviation:'TEN',color:'332211',score:null}};
  const coordinator=createFootballCoordinator(path,{now:()=>clock,sources:[source],browserCollectorsAvailable:true,
    readSchedule:async partition=>({games:partition.id==='nfl'?[game]:[],league:partition.league,at:clock}),probeCandidate:async()=>({kind:'unavailable',reason:'no-feed'})});
  const empty='<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>';
  const sweep=async(minutes:number)=>{
    clock=start+minutes*60_000;await coordinator.refresh();
    return await runSportsurgeSweep({now:()=>clock,signal:new AbortController().signal,
      read:async(_url:string,role:string,league:string)=>{
        if(role==='category'){
          categoryReads.set(league,(categoryReads.get(league)??0)+1);
          return league==='nfl'?`<main id="match-list-container"><a class="match-row" href="watch-12345-nfl-tennessee-titans-baltimore-ravens/"><span class="match-row-team-name">Tennessee Titans</span><span class="match-row-team-name">Baltimore Ravens</span><time class="match-time" data-timestamp="${kickoff/1000}"></time><span>${published?1:0} Streams</span></a></main>`:empty;
        }
        details++;
        return published?'<div class="stream-list"><div class="stream-item" data-href="https://public.example/game/1"><span class="stream-row-site-name">Public</span><button class="stream-vote" id="stream-12345-0"></button></div></div>':'<div class="stream-list">No streams available</div>';
      },send:async(catalog:SportsurgeCatalog)=>{const reply=await coordinator.command({kind:'sportsurge-catalog',catalog});assert.equal(reply.kind,'catalog-ack');return reply;}});
  };
  const saved=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return DetailEvidenceSchema.parse(JSON.parse(String(db.prepare('SELECT payload FROM details').get()?.payload)));}finally{db.close();}};
  try{
    await sweep(0);assert.equal(details,1);assert.equal(saved().polling?.unchangedChecks,0);
    await sweep(30);await sweep(60);await sweep(90);assert.equal(details,4);assert.equal(saved().polling?.unchangedChecks,3);
    assert.equal(saved().nextEligibleAt,clock+(published?30*60_000:5*60*60_000));
    await sweep(120);assert.equal(details,published?5:4);assert.equal(categoryReads.get('nfl'),5);assert.equal(categoryReads.get('ncaaf'),1);
    const plan=await coordinator.command({kind:'collector-polling',source:'sportsurge-v2'});assert.equal(plan.kind,'collector-polling');
    if(plan.kind==='collector-polling')assert.equal(plan.nextSweepAt,start+150*60_000);
    await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:true});
    const forced=await coordinator.command({kind:'collector-polling',source:'sportsurge-v2'});
    if(forced.kind==='collector-polling')assert.equal(forced.nextSweepAt,clock+1000);
    await sweep(120+1/60);assert.equal(details,published?6:5);assert.equal(categoryReads.get('nfl'),5);
  }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
