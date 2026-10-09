import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { FootballCoordinator } from '../lib/football/runtime/coordinator.ts';
import type { FootballDependencies, CandidateProbeResult } from '../lib/football/domain/ports.ts';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { catalogDecision, sanitizeSportsurgeCatalog, sportsurgeCandidates, sportsurgeCatalogView, sportsurgeObservation } from '../lib/football/domain/sportsurge-catalog.ts';
import { SportsurgeCatalogSchema } from '../lib/football/shared.ts';
import type { Game, SportsurgeCatalog } from '../lib/football/shared.ts';

const require=createRequire(import.meta.url);
const {CATEGORY_URLS,parseCategory,parseDetail,destination}=require('../desktop/sportsurge-catalog.cjs');
const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
const fixture=(name:string)=>readFileSync(join(process.cwd(),'tests','fixtures','sportsurge',`${name}.html`),'utf8');
const at=Date.parse('2026-09-26T21:00:00Z');
const runId='11111111-1111-4111-8111-111111111111';

test('captured Sportsurge pages preserve all category games and provider rows',()=>{
  const college=parseCategory(fixture('cfb'),'ncaaf');
  const nfl=parseCategory(fixture('nfl'),'nfl');
  assert.equal(college.kind,'collected');
  assert.equal(college.events.length,47);
  assert.equal(college.events[0].id,'ncaaf:65345');
  assert.equal(college.events[0].sourceStatus,'live');
  assert.equal(college.events[0].kickoff,null);
  assert.equal(college.events[0].advertisedLinkCount,17);
  assert.equal(nfl.kind,'collected');
  assert.equal(nfl.events.length,0);
  const detail=parseDetail(fixture('detail'),college.events[0],at);
  assert.equal(detail.kind,'collected');
  assert.equal(detail.providers.length,17);
  assert.equal(detail.providers[0].label,'Streameast');
  assert.equal(detail.providers[0].id,'stream-1303403-0');
  assert.equal(detail.providers[0].destination.kind,'link');
  assert.equal(parseCategory('<title>Just a moment...</title>','ncaaf').reason,'blocked');
  assert.equal(parseCategory('<main id="match-list-container"><p class="match-filter-empty">No matches found</p></main>','nfl').kind,'failed');
});

test('malformed and repeated provider DOM rows remain separate while unsafe links stay private',()=>{
  const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
  const html=`<div class="stream-list">
    <div class="stream-item" data-href="https://example.com/one"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div>
    <div class="stream-item" data-href="https://example.com/two"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div>
    <div class="stream-item"><span class="stream-row-site-name">Missing</span></div>
    <div class="stream-item" data-href="https://[::1]/private"><span class="stream-row-site-name">Local</span></div>
    <div class="stream-item" data-href="https://example.com/watch?token=private"><span class="stream-row-site-name">Signed</span></div>
  </div>`;
  const detail=parseDetail(html,event,at);
  assert.equal(detail.providers.length,5);
  assert.equal(new Set(detail.providers.map((row:{id:string})=>row.id)).size,5);
  assert.deepEqual(detail.providers.map((row:{destination:{kind:string}})=>row.destination.kind),['link','link','malformed','rejected','rejected']);
  assert.equal(detail.providers[2].destination.reason,'missing');
  assert.equal(detail.providers[3].destination.reason,'private-host');
  assert.equal(detail.providers[4].destination.reason,'credential-query');
  assert.equal(JSON.stringify(detail).includes('token=private'),false);
  assert.equal(destination('https://127.0.0.1/watch').reason,'private-host');
  assert.equal(destination('https://[::1]/watch').reason,'private-host');
});

test('every distinct detail is visited beyond the generic 80-slot budget and a late failure stays partial',async()=>{
  const category=`<main id="match-list-container">${Array.from({length:85},(_,index)=>
    `<a class="match-row" href="watch-${10000+index}-cfb-away-home-${index}/"><span class="match-row-team-name">Away ${index}</span><span class="match-row-team-name">Home ${index}</span><time class="match-time" data-timestamp="1790461800"></time>1 Stream</a>`).join('')}</main>`;
  const empty='<main id="match-list-container"><div class="watch-empty-state">There are no live or upcoming games here right now.</div></main>';
  const detail='<div class="stream-list"><div class="stream-item" data-href="https://example.com/watch"><span class="stream-row-site-name">Example</span></div></div>';
  const reads:string[]=[];
  const checkpoints:SportsurgeCatalog[]=[];
  const read=async(url:string,page:string)=>{
    reads.push(url);
    if (page==='category') return url===CATEGORY_URLS.ncaaf ? category : empty;
    if (url.includes('watch-10084-')) throw new Error('timeout');
    return detail;
  };
  const send=async(value:SportsurgeCatalog)=>{checkpoints.push(structuredClone(value));};
  const result=await runSportsurgeSweep({read,send,signal:new AbortController().signal,now:()=>at,runId});
  assert.equal(reads.filter(url=>url.includes('/watch-1') && url.includes('-cfb-')).length,85);
  assert.equal(result.events.length,85);
  assert.equal(result.events.filter((event:SportsurgeCatalog['events'][number])=>event.detail.kind==='collected').length,84);
  assert.equal(result.events[84].detail.kind,'failed');
  assert.equal(result.state.kind,'partial');
  assert.equal(checkpoints.at(-1)?.events.length,85);
  assert.deepEqual(Object.keys(checkpoints[0].categories),Object.keys(CATEGORY_URLS));
  assert.equal(checkpoints.every(checkpoint=>SportsurgeCatalogSchema.safeParse(checkpoint).success),true);
  const verified=SportsurgeCatalogSchema.safeParse(checkpoints.at(-1));
  assert.equal(verified.success,true);
});

test('distinct canonical URLs with one numeric ID are both retained and diagnosed',()=>{
  const html=`<main id="match-list-container">
    <a class="match-row" href="watch-123-cfb-away-home/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a>
    <a class="match-row" href="watch-123-cfb-away-home-alt/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a>
    <a class="match-row" href="https://bad.example/watch-999-cfb-other/"><span class="match-row-team-name">Bad</span><span class="match-row-team-name">Other</span></a>
  </main>`;
  const result=parseCategory(html,'ncaaf');
  assert.equal(result.kind,'failed');
  assert.equal(result.events.length,2);
  assert.equal(result.catalogIssues.length,1);
  assert.equal(result.rejectedGames.length,1);
});

test('checkpoint replay, prior partial retention, removed links, and ESPN final isolation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'sportsurge-catalog-'));
  const store=new FootballStore(join(dir,'state.sqlite'));
  try {
    const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
    event.detail=parseDetail(fixture('detail'),event,at);
    const partial:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'partial',at,reason:'timeout'},
      categories:{ncaaf:{kind:'collected',at},nfl:{kind:'failed',at,reason:'timeout'}},events:[event],rejectedGames:[],catalogIssues:[]};
    assert.ok(sanitizeSportsurgeCatalog(partial));
    assert.equal(catalogDecision(null,partial),'accepted');
    const observation=sportsurgeObservation(event,at);
    const unrelated={...observation,id:'tvapp:unrelated',sourceId:'tvapp',url:'https://tvapp1.com/watch/unrelated'};
    const unmatched={kind:'unmatched' as const,reason:'unverified-kickoff',possibleGameIds:[]};
    store.saveSportsurgeCatalog({catalog:partial,receivedAt:at},[{observation,result:unmatched},{observation:unrelated,result:unmatched}]);
    assert.equal(store.observations().length,2);
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,partial),'replay');
    const replacement:SportsurgeCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,startedAt:at+1,
      state:{kind:'collecting'},categories:{ncaaf:{kind:'pending'},nfl:{kind:'pending'}},events:[],rejectedGames:[],catalogIssues:[]};
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,replacement),'accepted');
    store.saveSportsurgeCatalog({catalog:replacement,receivedAt:at+1},[]);
    assert.equal(store.sportsurgeCatalog().previous?.catalog.events.length,1);
    assert.deepEqual(store.observations().map(row=>row.id),['tvapp:unrelated']);
    assert.equal(catalogDecision(store.sportsurgeCatalog().current,partial),'rejected');
    const completed:SportsurgeCatalog={...replacement,sequence:1,state:{kind:'complete',at:at+2},
      categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event]};
    store.saveSportsurgeCatalog({catalog:completed,receivedAt:at+2},[{observation,result:unmatched}]);
    assert.equal(store.sportsurgeCatalog().lastComplete?.catalog.events.length,1);
    const nextPartial:SportsurgeCatalog={...replacement,runId:'33333333-3333-4333-8333-333333333333',startedAt:at+3,
      sequence:0,state:{kind:'partial',at:at+3,reason:'timeout'},events:[]};
    store.saveSportsurgeCatalog({catalog:nextPartial,receivedAt:at+3},[]);
    assert.equal(store.sportsurgeCatalog().lastComplete?.catalog.runId,completed.runId);
    const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
    const final:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
      home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
      status:'post',lifecycle:'final',detail:'Final',redzone:false,finalObservedAt:at,graceEndsAt:at+300000};
    const view=sportsurgeCatalogView({catalog:partial,receivedAt:at},[final],at);
    assert.equal(view.games[0].gameId,null);
    assert.equal(view.providerRows,17);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('every safe provider row becomes a stable custom-player candidate through partial sweeps',()=>{
  const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
  event.detail=parseDetail(fixture('detail'),event,at);
  const complete:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'complete',at},
    categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]};
  const stored={catalog:complete,receivedAt:at};
  const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const live:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
    home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
    status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fcs']};
  const input={current:stored,previous:null,lastComplete:null,games:[live],now:at+60_000};
  const candidates=sportsurgeCandidates(input);
  assert.equal(candidates.length,17);
  assert.equal(new Set(candidates.map(candidate=>candidate.id)).size,17);
  assert.equal(candidates[0].locator.provider,'sportsurge-v2');
  assert.equal(JSON.stringify(candidates.map(candidate=>candidate.label)).includes('example.com'),false);
  const publicView=sportsurgeCatalogView(stored,[live],at+60_000);
  assert.equal(publicView.games[0].gameId,live.id);
  assert.equal(JSON.stringify(publicView).includes('example.com'),false);
  if(event.detail.kind!=='collected')throw new Error('Fixture detail was not collected');
  const repeated={...event,detail:{...event.detail,providers:[
    {...event.detail.providers[0],id:'same-0',label:'Same'},
    {...event.detail.providers[0],id:'same-1',label:'Same'},
    {...event.detail.providers[0],id:'unsafe',destination:{kind:'rejected' as const,reason:'private-host' as const,display:'localhost'}},
  ]}};
  const repeatedRows=sportsurgeCandidates({...input,current:{catalog:{...complete,events:[repeated]},receivedAt:at}});
  assert.equal(repeatedRows.length,2);
  assert.notEqual(repeatedRows[0].id,repeatedRows[1].id);
  const partial:SportsurgeCatalog={...complete,runId:'22222222-2222-4222-8222-222222222222',
    sequence:0,startedAt:at+30_000,state:{kind:'collecting'},
    categories:{ncaaf:{kind:'pending'},nfl:{kind:'pending'}},events:[]};
  assert.deepEqual(sportsurgeCandidates({...input,current:{catalog:partial,receivedAt:at+30_000},lastComplete:stored})
    .map(candidate=>candidate.id),candidates.map(candidate=>candidate.id));
  const collectingDetail:SportsurgeCatalog={...partial,categories:{...partial.categories,ncaaf:{kind:'collected',at:at+30_000}},
    events:[{...event,detail:{kind:'pending'}}]};
  assert.deepEqual(sportsurgeCandidates({...input,current:{catalog:collectingDetail,receivedAt:at+30_000},lastComplete:stored})
    .map(candidate=>candidate.id),candidates.map(candidate=>candidate.id));
  const staleDetail:SportsurgeCatalog={...collectingDetail,events:[event]};
  assert.deepEqual(sportsurgeCandidates({...input,current:{catalog:staleDetail,receivedAt:at+30_000},lastComplete:stored})
    .map(candidate=>candidate.id),candidates.map(candidate=>candidate.id));
  const inventoryInput={at:at+60_000,revision:1,lastDiscoveryAt:null,browserCollectorsAvailable:false,
    availability:()=>({kind:'playable' as const,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const,checkedAt:at}),
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog' as const}],
    observations:[],games:[live],candidates:new Map([[live.id,candidates]]),attempts:{},
    sportsurgeCatalog:{current:{catalog:partial,receivedAt:at+30_000},previous:null,lastComplete:stored},
    streameastCatalog:{current:null,lastComplete:null,previous:null}};
  const retainedInventory=sourceInventory(inventoryInput);
  assert.equal(retainedInventory.sources[0].matchedGameCount,1);
  assert.equal(retainedInventory.sources[0].compatibleFeedCount,17);
  const completedEmpty:SportsurgeCatalog={...partial,sequence:1,state:{kind:'complete',at:at+60_000},
    categories:{ncaaf:{kind:'collected',at:at+60_000},nfl:{kind:'collected',at:at+60_000}}};
  assert.equal(sportsurgeCandidates({...input,current:{catalog:completedEmpty,receivedAt:at+60_000},lastComplete:stored}).length,0);
  assert.equal(sourceInventory({...inventoryInput,sportsurgeCatalog:{...inventoryInput.sportsurgeCatalog,
    current:{catalog:completedEmpty,receivedAt:at+60_000}}}).sources[0].listingCount,0);
  assert.equal(sportsurgeCandidates({...input,games:[{...live,status:'post',lifecycle:'final',finalObservedAt:at,graceEndsAt:at+300_000}]}).length,0);
  assert.equal(sportsurgeCandidates({...input,now:at+30*60_000}).length,0);
});

test('an undated source event matches a unique scheduled game throughout the feed window',()=>{
  const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
  event.detail=parseDetail(fixture('detail'),event,at);
  const catalog:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'complete',at},
    categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]};
  const stored={catalog,receivedAt:at};
  const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
    home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),status:'pre',lifecycle:'scheduled',
    detail:'Scheduled',redzone:false,partitions:['fcs']};
  const candidates=sportsurgeCandidates({current:stored,previous:null,lastComplete:null,games:[game],now:at+6*60_000});
  assert.equal(candidates.length,17);
  const inventory=sourceInventory({at:at+6*60_000,revision:1,lastDiscoveryAt:null,browserCollectorsAvailable:true,
    availability:()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}),
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog'}],
    observations:[],games:[game],candidates:new Map([[game.id,candidates]]),attempts:{},
    sportsurgeCatalog:{current:stored,previous:null,lastComplete:null},
    streameastCatalog:{current:null,previous:null,lastComplete:null}});
  assert.equal(inventory.sources[0].matchedGameCount,1);
  assert.equal(inventory.sources[0].compatibleFeedCount,17);
  assert.equal(inventory.sportsurgeV2.current?.games[0].gameId,game.id);
  for(const date of [at-31*60_000,at+31*60_000]) {
    const other={...game,date:new Date(date).toISOString()};
    assert.equal(sportsurgeCandidates({current:stored,previous:null,lastComplete:null,games:[other],now:at}).length,17);
  }
  assert.equal(sportsurgeCandidates({current:stored,previous:null,lastComplete:null,games:[{...game,date:undefined}],now:at}).length,0);
  const duplicate={...game,id:'ncaaf-other'};
  assert.equal(sportsurgeCandidates({current:stored,previous:null,lastComplete:null,games:[game,duplicate],now:at}).length,0);
  const upcoming:SportsurgeCatalog={...catalog,events:[{...event,sourceStatus:'upcoming'}]};
  assert.equal(sportsurgeCandidates({current:{catalog:upcoming,receivedAt:at},previous:null,lastComplete:null,games:[game],now:at}).length,17);
});

test('an accepted v2 checkpoint opens and authorizes a custom-player session',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'sportsurge-playback-'));
  const store=new FootballStore(join(dir,'state.sqlite'));
  const events=parseCategory(fixture('cfb'),'ncaaf').events;
  const event=events[0];
  const otherEvent=events[1];
  event.detail=parseDetail(fixture('detail'),event,at);
  otherEvent.detail=parseDetail(fixture('detail'),otherEvent,at);
  const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
    home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
    status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fcs']};
  const otherGame:Game={...game,id:'ncaaf-998',name:'Incarnate Word at Texas State',
    home:team('Texas State Bobcats','espn:ncaaf:326'),away:team('Incarnate Word Cardinals','espn:ncaaf:2916')};
  let scheduled:Game[]=[game,otherGame];
  let clock=at+60_000;
  store.savePartition('fcs',{games:scheduled,at});
  const coordinator=new FootballCoordinator({store,browserCollectorsAvailable:false,
    schedules:[{id:'fcs',league:'ncaaf',path:'',group:null}],
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog'}],
    readSchedule:async()=>({games:scheduled,at:clock,league:'ncaaf'}),
    readSeasonMembership:async()=>{throw new Error('unused');},
    readHtml:async()=>{throw new Error('unused');},
    parseListings:()=>({observations:[],outcome:'empty'}),
    enrichObservation:observation=>observation,compatiblePlayers:()=>[],retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),
    now:()=>clock,id:()=>runId});
  try {
    const catalog:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'complete',at},
      categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event,otherEvent],rejectedGames:[],catalogIssues:[]};
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    clock=at+89_000;
    const freshInventory=await coordinator.command({kind:'sources'});
    assert.equal(freshInventory.kind,'sources');
    if(freshInventory.kind==='sources')assert.equal(freshInventory.snapshot.games.find(row=>row.gameId===game.id)?.candidates.length,17);
    clock=at+91_000;
    const staleInventory=await coordinator.command({kind:'sources'});
    assert.equal(staleInventory.kind,'sources');
    if(staleInventory.kind==='sources')assert.equal(staleInventory.snapshot.games.find(row=>row.gameId===game.id)?.candidates.length||0,0);
    const staleScheduleOpen=await coordinator.command({kind:'open',gameId:game.id,manual:false});
    assert.equal(staleScheduleOpen.kind,'error');
    if(staleScheduleOpen.kind==='error')assert.equal(staleScheduleOpen.status,409);
    clock=at+60_000;
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[game.id,otherGame.id],retry:false}),{kind:'ok'});
    for(let attempt=0;attempt<20;attempt++) {
      const snapshot=await coordinator.command({kind:'sources'});
      if(snapshot.kind==='sources'&&snapshot.snapshot.games.find(row=>row.gameId===game.id)?.candidates.every(candidate=>candidate.availability.kind==='playable'))break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    const opened=await coordinator.command({kind:'open',gameId:game.id,manual:false});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    assert.equal(opened.playback.candidates.length,17);
    const candidateId=opened.playback.candidates[4].id;
    assert.deepEqual(await coordinator.command({kind:'close',sessionId:opened.playback.session.id}),{kind:'ok'});
    const otherOpened=await coordinator.command({kind:'open',gameId:otherGame.id,manual:false});
    assert.equal(otherOpened.kind,'playback');
    if(otherOpened.kind==='playback') {
      assert.equal(otherOpened.playback.candidates.length,17);
      assert.deepEqual(await coordinator.command({kind:'close',sessionId:otherOpened.playback.session.id}),{kind:'ok'});
    }
    const wrongGame=await coordinator.command({kind:'open',gameId:otherGame.id,manual:false,initialCandidateId:candidateId});
    assert.equal(wrongGame.kind,'error');
    if(wrongGame.kind==='error')assert.equal(wrongGame.status,404);
    const staleId=await coordinator.command({kind:'open',gameId:game.id,manual:false,initialCandidateId:'sportsurge-v2:stale'});
    assert.equal(staleId.kind,'error');
    if(staleId.kind==='error')assert.equal(staleId.status,404);
    const explicitlyOpened=await coordinator.command({kind:'open',gameId:game.id,manual:false,requestId:runId,initialCandidateId:candidateId});
    assert.equal(explicitlyOpened.kind,'playback');
    if(explicitlyOpened.kind!=='playback')return;
    assert.equal(explicitlyOpened.playback.session.candidateId,candidateId);
    const replay=await coordinator.command({kind:'open',gameId:game.id,manual:false,requestId:runId,
      initialCandidateId:opened.playback.candidates[0].id});
    assert.equal(replay.kind,'playback');
    if(replay.kind==='playback')assert.equal(replay.playback.session.candidateId,candidateId);
    const switchedId=opened.playback.candidates[5].id;
    const selected=await coordinator.command({kind:'session',sessionId:explicitlyOpened.playback.session.id,
      generation:0,candidateId:switchedId,failure:false,retry:false});
    assert.equal(selected.kind,'session');
    if(selected.kind!=='session')return;
    assert.equal(selected.session.candidateId,switchedId);
    const authorized=await coordinator.command({kind:'authorize',sessionId:selected.session.id,
      candidateId:switchedId,generation:selected.session.generation});
    assert.equal(authorized.kind,'authorized');
    if(authorized.kind==='authorized')assert.equal(authorized.candidate.locator.provider,'sportsurge-v2');
    scheduled=[{...game,status:'post',lifecycle:'final',detail:'Final'},otherGame];
    clock=at+120_000;
    await coordinator.refresh(true);
    const duringGrace=await coordinator.command({kind:'authorize',sessionId:selected.session.id,
      candidateId:switchedId,generation:selected.session.generation});
    assert.equal(duringGrace.kind,'authorized');
    clock+=5*60_000+1;
    const afterGrace=await coordinator.command({kind:'authorize',sessionId:selected.session.id,
      candidateId:switchedId,generation:selected.session.generation});
    assert.equal(afterGrace.kind,'error');
    if(afterGrace.kind==='error')assert.equal(afterGrace.status,410);
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

function probeFixture(probeCandidate:FootballDependencies['probeCandidate']) {
  const dir=mkdtempSync(join(tmpdir(),'sportsurge-probe-'));
  const store=new FootballStore(join(dir,'state.sqlite'));
  const event=parseCategory(fixture('cfb'),'ncaaf').events[0];
  const detail=parseDetail(fixture('detail'),event,at);
  if(detail.kind!=='collected')throw new Error('Missing provider fixture');
  event.detail={...detail,providers:detail.providers.slice(0,2)};
  const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'ncaaf-999',league:'ncaaf',name:'Delaware at Virginia',date:new Date(at).toISOString(),
    home:team('Virginia Cavaliers','espn:ncaaf:258'),away:team('Delaware Blue Hens','espn:ncaaf:48'),
    status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fcs']};
  const clock={value:at+60_000};
  store.savePartition('fcs',{games:[game],at:clock.value});
  const coordinator=new FootballCoordinator({store,schedules:[{id:'fcs',league:'ncaaf',path:'',group:null}],
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog'}],
    readSchedule:async()=>({games:[game],at:clock.value,league:'ncaaf'}),readSeasonMembership:async()=>{throw new Error('unused');},
    readHtml:async()=>{throw new Error('unused');},parseListings:()=>({observations:[],outcome:'empty'}),
    enrichObservation:observation=>observation,compatiblePlayers:()=>[],retryAfterMs:()=>0,probeCandidate,
    now:()=>clock.value,id:()=>runId});
  const catalog:SportsurgeCatalog={runId,sequence:0,startedAt:at,state:{kind:'complete',at},
    categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]};
  return {dir,coordinator,clock,game,catalog,event};
}

test('an obsolete saved game does not block checks for a listed game',async()=>{
  let probes=0;
  const {dir,coordinator,game,catalog}=probeFixture(async()=>{probes++;return {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};});
  try {
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:['obsolete-game',game.id],retry:false}),{kind:'ok'});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const sources=await coordinator.command({kind:'sources'});
    assert.equal(sources.kind,'sources');
    if(sources.kind==='sources') {
      const candidates=sources.snapshot.games.find(row=>row.gameId===game.id)?.candidates;
      assert.ok(candidates);
      assert.equal(candidates.length,2);
      assert.equal(candidates.every(row=>row.availability.kind==='playable'),true);
    }
    assert.equal(probes,2);
    const obsolete=await coordinator.command({kind:'check-sources',gameIds:['obsolete-game'],retry:false});
    assert.equal(obsolete.kind,'error');
    if(obsolete.kind==='error')assert.equal(obsolete.status,404);
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('availability gates open and switch while expired proof requires re-verification',async()=>{
  let resolveFirst!:(result:CandidateProbeResult)=>void;
  const firstProbe=new Promise<CandidateProbeResult>(resolve=>{resolveFirst=resolve;});
  let calls=0;
  const setup=probeFixture(async locator=>{
    if(locator.provider!=='sportsurge-v2')return {kind:'unavailable',reason:'unsupported'};
    if(locator.providerId!==setup.event.detail.providers[0].id)return {kind:'unavailable',reason:'invalid-media'};
    return ++calls===1?firstProbe:{kind:'deferred',retryAfterMs:60_000};
  });
  const {coordinator,clock,game,catalog,dir}=setup;
  try {
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:false}),{kind:'ok'});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const checking=await coordinator.command({kind:'sources'});
    assert.equal(checking.kind,'sources');
    if(checking.kind!=='sources')return;
    const rows=checking.snapshot.games.find(row=>row.gameId===game.id)?.candidates||[];
    assert.equal(rows.length,2);
    assert.equal(rows.find(row=>row.availability.kind==='checking')?.id!==undefined,true);
    const rejected=rows.find(row=>row.availability.kind==='unavailable');
    assert.equal(rejected?.availability.kind,'unavailable');
    assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false})).kind,'error');
    resolveFirst({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const verified=await coordinator.command({kind:'sources'});
    assert.equal(verified.kind,'sources');
    if(verified.kind!=='sources')return;
    const playable=verified.snapshot.games.find(row=>row.gameId===game.id)?.candidates.find(row=>row.availability.kind==='playable');
    assert.ok(playable);
    assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false,initialCandidateId:rejected!.id})).kind,'error');
    const opened=await coordinator.command({kind:'open',gameId:game.id,manual:false,initialCandidateId:playable.id});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    assert.equal(opened.playback.session.candidateId,playable.id);
    const switchRejected=await coordinator.command({kind:'session',sessionId:opened.playback.session.id,generation:0,
      candidateId:rejected!.id,failure:false,retry:false});
    assert.equal(switchRejected.kind,'error');
    for(let minute=0;minute<9;minute++) {
      clock.value+=60_000;
      await coordinator.refresh(true);
      assert.equal((await coordinator.command({kind:'authorize',sessionId:opened.playback.session.id,candidateId:playable.id,generation:0})).kind,'authorized');
    }
    clock.value+=59_999;
    await coordinator.refresh(true);
    const beforeExpiry=await coordinator.command({kind:'sources'});
    assert.equal(beforeExpiry.kind,'sources');
    if(beforeExpiry.kind==='sources')assert.equal(beforeExpiry.snapshot.games.find(row=>row.gameId===game.id)?.candidates.find(row=>row.id===playable.id)?.availability.kind,'checking');
    clock.value++;
    await coordinator.refresh(true);
    const retained=await coordinator.command({kind:'sources'});
    assert.equal(retained.kind,'sources');
    if(retained.kind==='sources')assert.equal(retained.snapshot.games.find(row=>row.gameId===game.id)?.candidates.find(row=>row.id===playable.id)?.availability.kind,'checking');
    assert.equal(calls,3,'the playable route is rechecked at each five-minute deadline');
    assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false})).kind,'error');
    assert.equal((await coordinator.command({kind:'authorize',sessionId:opened.playback.session.id,candidateId:playable.id,generation:0})).kind,'authorized');
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a replaced catalog cancels its probe and ignores a late playable result',async()=>{
  let resolveProbe!:(result:CandidateProbeResult)=>void;
  const pending=new Promise<CandidateProbeResult>(resolve=>{resolveProbe=resolve;});
  const setup=probeFixture(async()=>pending);
  const {coordinator,game,catalog,dir}=setup;
  try {
    await coordinator.command({kind:'sportsurge-catalog',catalog});
    await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:false});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const empty:SportsurgeCatalog={...catalog,runId:'22222222-2222-4222-8222-222222222222',startedAt:at+60_000,
      sequence:0,state:{kind:'complete',at:at+60_000},
      categories:{ncaaf:{kind:'collected',at:at+60_000},nfl:{kind:'collected',at:at+60_000}},events:[]};
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:empty}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    resolveProbe({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}});
    await new Promise<void>(resolve=>setImmediate(resolve));
    const sources=await coordinator.command({kind:'sources'});
    assert.equal(sources.kind,'sources');
    if(sources.kind==='sources')assert.equal(sources.snapshot.games.find(row=>row.gameId===game.id)?.candidates.length||0,0);
    const board=await coordinator.command({kind:'board'});
    if(board.kind==='board')assert.equal(board.board.games.find(row=>row.id===game.id)?.sourceUrl,undefined);
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a duplicate Sportsurge ID skips only the out-of-window detail URL',async()=>{
  const clock=Date.parse('2026-10-03T23:30:00Z');
  const later=clock+7*24*60*60_000;
  const eligibleUrl='https://v2.sportsurge.net/watch-10001-cfb-alpha-beta/';
  const excludedUrl='https://v2.sportsurge.net/watch-10001-cfb-gamma-delta/';
  const team=(name:string)=>({id:`espn:${name}`,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game=(id:string,away:string,home:string,date:number):Game=>({id,league:'ncaaf',name:`${away} at ${home}`,
    date:new Date(date).toISOString(),away:team(away),home:team(home),status:'pre',lifecycle:'scheduled',
    detail:'Scheduled',redzone:false,partitions:['fcs']});
  const games=[game('ncaaf-eligible','Alpha','Beta',clock),game('ncaaf-future','Gamma','Delta',later)];
  const row=(url:string,away:string,home:string,date:number)=>`<a class="match-row" href="${url}">`+
    `<span class="match-row-team-name">${away}</span><span class="match-row-team-name">${home}</span>`+
    `<span class="match-time" data-timestamp="${Math.floor(date/1000)}"></span></a>`;
  const category=`<main id="match-list-container">${row(eligibleUrl,'Alpha','Beta',clock)}`+
    `${row(excludedUrl,'Gamma','Delta',later)}</main>`;
  assert.equal(parseCategory(category,'ncaaf').catalogIssues[0]?.reason,'duplicate-game-id');
  const dir=mkdtempSync(join(tmpdir(),'sportsurge-duplicate-window-'));
  const store=new FootballStore(join(dir,'state.sqlite'));
  store.savePartition('fcs',{games,at:clock});
  const coordinator=new FootballCoordinator({store,browserCollectorsAvailable:false,
    schedules:[{id:'fcs',league:'ncaaf',path:'',group:null}],
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog'}],
    readSchedule:async()=>({games,at:clock,league:'ncaaf'}),readSeasonMembership:async()=>{throw new Error('unused');},
    readHtml:async()=>{throw new Error('unused');},parseListings:()=>({observations:[],outcome:'empty'}),
    enrichObservation:observation=>observation,compatiblePlayers:()=>[],retryAfterMs:()=>0,
    probeCandidate:async()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),now:()=>clock,id:()=>runId});
  const reads:string[]=[];
  const acknowledgedUrls:string[]=[];
  try {
    const result:SportsurgeCatalog=await runSportsurgeSweep({
      read:async(url:string,page:string)=>{
        reads.push(url);
        if(page==='category')return url===CATEGORY_URLS.ncaaf?category:
          '<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>';
        assert.equal(url,eligibleUrl);
        return fixture('detail');
      },
      send:async(catalog:SportsurgeCatalog)=>{
        const reply=await coordinator.command({kind:'sportsurge-catalog',catalog});
        assert.equal(reply.kind,'catalog-ack');
        if(reply.kind==='catalog-ack')acknowledgedUrls.push(...(reply.skipDetailEventUrls||[]));
        return reply;
      },
      signal:new AbortController().signal,now:()=>clock,runId,
    });
    assert.ok(acknowledgedUrls.includes(excludedUrl));
    assert.deepEqual(reads.filter(url=>url===eligibleUrl||url===excludedUrl),[eligibleUrl]);
    assert.deepEqual(result.events.map(event=>event.url),[eligibleUrl]);
    assert.equal(result.events[0].detail.kind,'collected');
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
