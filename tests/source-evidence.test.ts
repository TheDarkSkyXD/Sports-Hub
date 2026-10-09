import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';
import {sportsurgeCandidates} from '../lib/football/domain/sportsurge-catalog.ts';
import type {Candidate, CollectionAttempt, DetailEvidence, Game, Observation, SportsurgeCatalog, StreameastCatalog} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-03T03:10:00Z');
const team=(name:string)=>({name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const game:Game={id:'ncaaf-401868094',league:'ncaaf',name:'Montana State at Idaho',date:new Date(at).toISOString(),
  home:{...team('Idaho Vandals'),id:'espn:ncaaf:70'},
  away:{...team('Montana State Bobcats'),id:'espn:ncaaf:147'},status:'in',lifecycle:'live',
  detail:'Q1',redzone:false,partitions:['fcs']};
const source={id:'fixture',name:'Fixture',url:'https://fixture.example/list',family:'fixture'};
const observation:Observation={id:'fixture:event',sourceId:'fixture',url:'https://fixture.example/game',
  title:'Montana State at Idaho',league:'ncaaf',teams:['Montana State Bobcats','Idaho Vandals'],
  kickoff:at,rawTime:new Date(at).toISOString(),observedAt:at,parserVersion:2};
const generation=(value:Observation)=>JSON.stringify([value.sourceId,value.url,value.teams,value.kickoff,
  value.observedAt,value.parserVersion]);
const candidate:Candidate={id:'gooz-33',gameId:game.id,label:'Free server',sourceIds:['fixture'],observedAt:at,
  locator:{provider:'gooz',playerId:'33'}};
const resolved:DetailEvidence={outcome:'resolved',observationId:observation.id,generation:generation(observation),
  at,players:[{id:candidate.id,label:candidate.label,locator:candidate.locator}],nextEligibleAt:at+120_000,
  lastSuccess:{identity:detailIdentity(observation),at,count:1}};
const emptyCatalogs={sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
  streameastCatalog:{current:null,lastComplete:null,previous:null}};
const inventory=(options:{at?:number;observations?:Observation[];details?:DetailEvidence[];
  candidates?:Candidate[];history?:CollectionAttempt[];availability?:'playable'|'unavailable'})=>sourceInventory({
  at:options.at??at,revision:1,lastDiscoveryAt:at,sources:[source],browserCollectorsAvailable:true,
  observations:options.observations??[observation],games:[game],
  candidates:new Map([[game.id,options.candidates??[candidate]]]),details:options.details,
  collectionHistory:options.history,attempts:{fixture:{at,outcome:'parsed',count:1}},
  availability:()=>options.availability==='playable'?{kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}:
    options.availability==='unavailable'?{kind:'unavailable',reason:'upstream',checkedAt:at,retryAt:at+120_000}:
      {kind:'unknown'},...emptyCatalogs,
});

test('listed, free, and working counts keep separate proof and check clocks',()=>{
  const unknown=inventory({details:[resolved]});
  assert.equal(unknown.sources[0].listingCount,1);
  assert.equal(unknown.sources[0].freeChoiceCount,1);
  assert.equal(unknown.sources[0].workingChoiceCount,0);
  assert.equal(unknown.games[0].freeChoiceCount,1);
  assert.deepEqual(unknown.games[0].sourceLinks[0].evidence,
    {kind:'collected',checkedAt:at,candidateIds:['gooz-33']});
  const playable=inventory({details:[resolved],availability:'playable'});
  assert.equal(playable.sources[0].workingChoiceCount,1);
  assert.equal(playable.sources[0].compatibleFeedCount,1);
  assert.equal(playable.games[0].workingChoiceCount,1);
  assert.equal(playable.games[0].uniqueFeedCount,1);
  const retained=inventory({at:at+600_001,details:[resolved],availability:'playable'});
  assert.equal(retained.sources[0].workingChoiceCount,1);
  const failure=inventory({details:[resolved],availability:'unavailable'});
  assert.equal(failure.sources[0].freeChoiceCount,1);
  assert.equal(failure.sources[0].workingChoiceCount,0);
  assert.equal(failure.games[0].candidates[0].availability.kind,'unavailable');
  assert.equal(JSON.stringify(playable).includes('playerId'),false);
});

test('pending, conflict, missing, failure, and same-event player loss have explicit evidence',()=>{
  assert.deepEqual(inventory({}).games[0].sourceLinks[0].evidence,{kind:'pending'});
  const conflict=inventory({observations:[{...observation,kickoff:at+24*3600000}],candidates:[]});
  assert.equal(conflict.sources[0].links[0].evidence.kind,'unmatched');
  const missing:DetailEvidence={outcome:'unresolved',observationId:observation.id,generation:generation(observation),
    at:at+60_000,reason:'not-yet-published',failures:0,nextEligibleAt:at+180_000,
    lastSuccess:{identity:detailIdentity(observation),at,count:1}};
  const waiting=inventory({at:at+60_000,details:[missing],candidates:[]});
  assert.deepEqual(waiting.games[0].sourceLinks[0].evidence,
    {kind:'missing',checkedAt:at+60_000,reason:'not-yet-published',retryAt:at+180_000});
  assert.equal(waiting.sources[0].collectionHealth.kind,'no-baseline');
  const lost=inventory({at:at+60_000,details:[{...missing,reason:'no-published-player'}],candidates:[]});
  assert.deepEqual(lost.sources[0].collectionHealth,{kind:'attention',reason:'player-drop',
    currentAt:at+60_000,currentCount:0,baselineAt:at,baselineCount:1});
  const unrelated=inventory({at:at+60_000,details:[{...missing,reason:'no-published-player',
    lastSuccess:{identity:detailIdentity({...observation,title:'Other game'}),at,count:1}}],candidates:[]});
  assert.equal(unrelated.sources[0].collectionHealth.kind,'no-baseline');
  const failed:DetailEvidence={outcome:'failed',observationId:observation.id,generation:generation(observation),
    at,failure:'timed-out',failures:1,nextEligibleAt:at+120_000};
  assert.deepEqual(inventory({details:[failed]}).games[0].sourceLinks[0].evidence,
    {kind:'failed',checkedAt:at,failure:'timed-out',retryAt:at+120_000});
});

test('listing history compares source and league separately and requires positive prior evidence',()=>{
  const history:CollectionAttempt[]=[
    {sourceId:'fixture',league:'ncaaf',at:at-60_000,outcome:'parsed',count:4},
    {sourceId:'fixture',league:'ncaaf',at,outcome:'parser-changed',count:0},
    {sourceId:'fixture',league:'nfl',at:at-60_000,outcome:'parsed',count:3},
    {sourceId:'fixture',league:'nfl',at,outcome:'parsed',count:3},
  ];
  assert.deepEqual(inventory({history}).sources[0].collectionHealth,{kind:'attention',reason:'parser-changed',
    currentAt:at,currentCount:0,baselineAt:at-60_000,baselineCount:4});
  assert.equal(inventory({history:[history[1]]}).sources[0].collectionHealth.kind,'no-baseline');
  assert.equal(inventory({history:[{...history[0],count:0},{...history[1],outcome:'empty'}]})
    .sources[0].collectionHealth.kind,'no-baseline');
});

test('listing evidence counts only admitted current choices and preserves parser failures',()=>{
  const withoutChoices=inventory({details:[resolved],candidates:[]});
  assert.equal(withoutChoices.games[0].freeChoiceCount,0);
  assert.deepEqual(withoutChoices.games[0].sourceLinks[0].evidence,
    {kind:'collected',checkedAt:at,candidateIds:[]});
  const stale=inventory({at:at+31*60_000,details:[resolved]});
  assert.equal(stale.games[0].freeChoiceCount,0);
  assert.notEqual(stale.games[0].sourceLinks[0]?.evidence.kind,'collected');
  const parseFailure:DetailEvidence={outcome:'unresolved',observationId:observation.id,
    generation:generation(observation),at:at+60_000,reason:'parser-changed',failures:1,
    nextEligibleAt:at+180_000,lastSuccess:resolved.lastSuccess};
  const failed=inventory({at:at+60_000,details:[parseFailure],candidates:[]});
  assert.deepEqual(failed.games[0].sourceLinks[0].evidence,
    {kind:'missing',checkedAt:at+60_000,reason:'parser-changed',retryAt:at+180_000});
  assert.equal(failed.sources[0].collectionHealth.kind,'attention');
  if(failed.sources[0].collectionHealth.kind==='attention')
    assert.equal(failed.sources[0].collectionHealth.reason,'parser-changed');
});

test('existing diagnostics provide bounded source and league history and last success survives an empty result',()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-evidence-'));
  const store=new FootballStore(join(directory,'state.sqlite'));
  try {
    store.saveListingAttempt('fixture',{at:at-60_000,outcome:'parsed',count:4},[]);
    store.saveListingAttempt('fixture',{at,outcome:'parser-changed',count:0},[]);
    const history=store.collectionHistory(at).filter(row=>row.sourceId==='fixture');
    assert.deepEqual(history.map(row=>[row.league,row.outcome,row.count]),
      [[null,'parser-changed',0],[null,'parsed',4]]);
    store.saveDetailEvidence(resolved);
    store.saveDetailEvidence({outcome:'unresolved',observationId:observation.id,generation:generation(observation),
      at:at+60_000,reason:'no-published-player',failures:0,nextEligibleAt:at+180_000,
      lastSuccess:resolved.lastSuccess});
    assert.deepEqual(store.detailEvidence()[0]?.lastSuccess,resolved.lastSuccess);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('catalog attempts persist source challenges separately from rate limits',()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-catalog-failure-'));
  const store=new FootballStore(join(directory,'state.sqlite'));
  try {
    for(const [index,reason] of (['blocked','rate-limited'] as const).entries()) {
      const receivedAt=at+index;
      const catalog:StreameastCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:index,
        startedAt:at,state:{kind:'partial',at:receivedAt,reason},
        categories:{ncaaf:{kind:'failed',at:receivedAt,reason},nfl:{kind:'pending'}},events:[],rejectedGames:[]};
      store.saveStreameastCatalog({receivedAt,catalog},[]);
      store.saveSportsurgeCatalog({receivedAt,catalog:{...catalog,catalogIssues:[]}},[]);
      const attempts=store.sourceAttempts();
      assert.equal(attempts.streameast.failure,reason);
      assert.equal(attempts['sportsurge-v2'].failure,reason);
    }
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('saved resolved evidence survives only an unchanged identity and its original freshness window',()=>{
  const saved={...resolved,identity:detailIdentity(observation)};
  const renewed={...observation,observedAt:at+121_000};
  assert.equal(inventory({at:at+121_000,observations:[renewed],details:[saved]})
    .games[0].sourceLinks[0].evidence.kind,'collected');
  const changed={...observation,title:'Changed event identity'};
  assert.equal(inventory({observations:[changed],details:[saved]})
    .games[0].sourceLinks[0].evidence.kind,'pending');
  const expired={...renewed,observedAt:at+31*60_000};
  assert.equal(inventory({at:at+31*60_000,observations:[expired],details:[saved],candidates:[]})
    .games[0].sourceLinks[0].evidence.kind,'pending');
});

test('a fresh checked browser player counts as working when its dated live listing is older',()=>{
  const listingAt=at-31*60_000;
  const eventUrl='https://v2.sportsurge.net/watch-12345-cfb-montana-state-idaho/';
  const catalog:SportsurgeCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,
    startedAt:listingAt,state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at:listingAt},
      nfl:{kind:'collected',at:listingAt}},rejectedGames:[],catalogIssues:[],events:[{
        id:'ncaaf:12345',url:eventUrl,league:'ncaaf',title:game.name,teams:[game.away.name,game.home.name],
        kickoff:at,sourceStatus:'live',advertisedLinkCount:1,detail:{kind:'collected',at,providers:[{
          id:'provider-1',label:'Free',observedAt:at,destination:{kind:'link',
            url:'https://v2.streameast.ga/cfb/montana-state-idaho-1790997000/1'}}]}}]};
  const stored={receivedAt:at,catalog};
  const admitted=sportsurgeCandidates({current:stored,previous:null,lastComplete:null,games:[game],now:at});
  assert.equal(admitted.length,1);
  const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,
    sources:[{id:'sportsurge-v2',url:eventUrl,family:'sportsurge',kind:'browser-catalog'}],
    observations:[],games:[game],candidates:new Map([[game.id,admitted]]),attempts:{},
    availability:()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}),
    sportsurgeCatalog:{current:stored,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}});
  assert.equal(snapshot.sources[0].workingChoiceCount,1);
  assert.equal(snapshot.games[0].workingChoiceCount,1);
  assert.equal(snapshot.games[0].sourceLinks[0].freshness,'stale-live');
});

test('shared route requires the exact current published free server URL and retains two working choices',()=>{
  const eventUrl='https://v2.streameast.ga/cfb/montana-state-idaho-1790997000/';
  const freeServer=`${eventUrl}1`;
  const directCatalog:StreameastCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,
    startedAt:at,state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},
    rejectedGames:[],events:[{id:'ncaaf:12345',league:'ncaaf',url:eventUrl,title:game.name,
      teams:[game.away.name,game.home.name],kickoff:at,espnEventId:null,
      detail:{kind:'collected',at,servers:[{id:'1',label:'Server 1',url:freeServer,
        availability:{kind:'free-channel',channelId:'33'}}]}}]};
  const sportsurgeUrl='https://v2.sportsurge.net/watch-12345-cfb-montana-state-idaho/';
  const surgeCatalog:SportsurgeCatalog={runId:'22222222-2222-4222-8222-222222222222',sequence:0,
    startedAt:at,state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},
    rejectedGames:[],catalogIssues:[],events:[{id:'ncaaf:12345',url:sportsurgeUrl,league:'ncaaf',
      title:game.name,teams:[game.away.name,game.home.name],kickoff:at,sourceStatus:'live',
      advertisedLinkCount:1,detail:{kind:'collected',at,providers:[{id:'provider-1',label:'StreamEast',
        observedAt:at,destination:{kind:'link',url:freeServer}}]}}]};
  const direct:Candidate={id:'streameast:33',gameId:game.id,label:'Direct',sourceIds:['streameast'],
    observedAt:at,locator:{provider:'streameast',channelId:'33'}};
  const routed:Candidate={id:'sportsurge-v2:route',gameId:game.id,label:'Route',sourceIds:['sportsurge-v2'],
    observedAt:at,locator:{provider:'sportsurge-v2',eventId:'ncaaf:12345',providerId:'provider-1',url:freeServer}};
  const snapshot=(url:string)=>sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,
    sources:[{id:'streameast',url:eventUrl,family:'streameast',kind:'browser-catalog'},
      {id:'sportsurge-v2',url:sportsurgeUrl,family:'sportsurge',kind:'browser-catalog'}],
    observations:[],games:[game],candidates:new Map([[game.id,[direct,{...routed,
      locator:{...routed.locator,url}}]]]),attempts:{},availability:()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},
      checkedAt:at}),sportsurgeCatalog:{current:{catalog:surgeCatalog,receivedAt:at},
      lastComplete:null,previous:null},streameastCatalog:{current:{catalog:directCatalog,receivedAt:at},
      lastComplete:null,previous:null}});
  const exact=snapshot(freeServer);
  assert.equal(exact.games[0].sharedRoutes.length,1);
  assert.deepEqual(exact.games[0].sharedRoutes[0].candidateIds,['streameast:33','sportsurge-v2:route']);
  assert.equal(exact.games[0].workingChoiceCount,2);
  assert.equal(exact.games[0].uniqueFeedCount,2);
  assert.equal(JSON.stringify(exact.games[0].sharedRoutes).includes('streameast.ga'),false);
  assert.equal(snapshot(eventUrl).games[0].sharedRoutes.length,0);
  for(const reason of ['blocked','rate-limited'] as const) {
    directCatalog.events[0].detail={kind:'failed',at,reason};
    surgeCatalog.events[0].detail={kind:'failed',at,reason};
    const failed=snapshot(freeServer);
    for(const sourceId of ['streameast','sportsurge-v2']) {
      assert.deepEqual(failed.games[0].sourceLinks.find(link=>link.sourceId===sourceId)?.evidence,
        {kind:'failed',checkedAt:at,failure:reason,retryAt:null});
    }
  }
});
