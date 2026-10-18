import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {z} from 'zod';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {sanitizeStreameastCatalog,streameastCandidates,streameastCatalogView,streameastObservation} from '../lib/football/domain/streameast-catalog.ts';
import {StreameastCatalogSchema,StreameastEventSchema} from '../lib/football/shared.ts';
import type {Game} from '../lib/football/shared.ts';
import {browserCategory,sourceCoverage} from '../lib/football/source-registry.ts';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';

const {parseCategory,parseDetail,eventUrl}=createRequire(import.meta.url)('../desktop/streameast-catalog.cjs');
const at=Date.parse('2026-10-11T17:25:00Z');
const url='https://v2.streameast.ga/other-events/charlotte-motor-speedway-1791745200/';
const title='Charlotte Motor Speedway';
const card=`<a class="m-card m-card--brand m-card--event" href="${url}" data-mac-id="46620" data-cat-id="23"
  data-pro-only="1" data-time="1791745200" data-sport-tag="motorsport"><span class="m-card__title">${title}</span></a>`;
const event=StreameastEventSchema.parse({id:'motorsport:46620',url,league:'motorsport',title,teams:null,
  kickoff:1791745200000,espnEventId:null,detail:{kind:'pending'}});
const categorySchema=z.object({kind:z.literal('collected'),events:z.array(StreameastEventSchema),rejectedGames:z.array(z.unknown())});
const game:Game={id:'nascar-cup-202610110021',league:'nascar-cup',name:'NASCAR Cup Series at Charlotte',date:'2026-10-11T19:00Z',
  race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},
  season:2026,partitions:['nascar-cup'],detail:'Scheduled',status:'pre',lifecycle:'scheduled'};

test('StreamEast collects only tagged motorsport events from its mixed Other category',()=>{
  const html=`<a class="m-card m-card--event" href="/other-events/bad-darts/" data-sport-tag="darts"><span class="m-card__title">Darts</span></a>${card}`;
  const category=categorySchema.parse(parseCategory(html,'motorsport'));
  assert.deepEqual(category.events,[event]);
  assert.deepEqual(category.rejectedGames,[]);
  assert.equal(browserCategory('streameast','motorsport')?.url,'https://v2.streameast.ga/other-events-streams/');
  assert.equal(sourceCoverage('streameast').includes('nascar-cup'),true);
  assert.equal(sourceCoverage('streameast').includes('nascar-truck'),true);
  for(const sport of ['golf','racing','darts','cricket'])assert.deepEqual(
    categorySchema.parse(parseCategory(card.replace('data-sport-tag="motorsport"',`data-sport-tag="${sport}"`),'motorsport')).events,[]);
});

test('the actual upcoming motorsport detail stays matched without claiming a playable or premium server',()=>{
  const upcoming='<main class="streameast-video-page"><div class="se-board" data-match-id="46620"></div>'+ 
    '<h2 class="se-countdown__title">Stream starting soon</h2><nav class="se-streams se-streams--share-only">'+
    '<ul class="se-streams__list"><li class="se-stream se-stream--share"><button>Share</button></li></ul></nav></main>';
  const detail=StreameastEventSchema.shape.detail.parse(parseDetail(upcoming,event,at,new Map()));
  assert.deepEqual(detail,{kind:'collected',at,servers:[],publication:{premium:0,unknown:0}});
  const catalog=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'complete',at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at},motorsport:{kind:'collected',at}},
    events:[{...event,detail}],rejectedGames:[]});
  assert.deepEqual(sanitizeStreameastCatalog(catalog,at),catalog);
  assert.deepEqual(streameastCandidates({...event,detail},game.id),[]);
  assert.deepEqual(matchObservation(streameastObservation(event,at),[game],at),{kind:'matched',gameId:game.id});
  assert.equal(matchObservation(streameastObservation({...event,kickoff:1791831600000},at),[game],at).kind,'unmatched');
  const truck={...game,id:'nascar-truck-202610110022',league:'nascar-truck' as const,
    name:'NASCAR Truck Series at Charlotte',race:{...game.race,eventId:'202610110022',sessionId:'202610110022'}};
  assert.equal(matchObservation(streameastObservation(event,at),[game,truck],at).kind,'unmatched');
  assert.equal(sanitizeStreameastCatalog({...catalog,events:[{...event,detail,kickoff:1791831600000}]},at),null);
});

test('motorsport cards reject different route types, hosts, URL times, and malformed event identifiers',()=>{
  assert.equal(eventUrl(url,'motorsport'),url);
  for(const invalid of [url.replace('/other-events/','/nba/'),url.replace('-1791745200/','/'),
    url.replace('v2.streameast.ga','v2.streameast.ga.evil.test'),`${url}?other=1`,`${url}#player`]){
    assert.equal(eventUrl(invalid,'motorsport'),null,invalid);
  }
  for(const invalid of [card.replace('-1791745200/','-1791831600/'),card.replace('data-mac-id="46620"','data-mac-id="bad"'),
    card.replace('data-time="1791745200"','data-time="bad"')]){
    const category=categorySchema.parse(parseCategory(invalid,'motorsport'));
    assert.deepEqual(category.events,[]);
    assert.equal(category.rejectedGames.length,1);
  }
});

test('normal StreamEast NFL matchup cards retain their existing identity and teams',()=>{
  const html='<article class="m-card" data-match-id="12345" data-team-names="Chicago Bears|Green Bay Packers" data-time="1791745200">'+
    '<a class="m-card__link" href="/nfl/chicago-bears-vs-green-bay-packers-1791745200/" aria-label="Chicago Bears vs Green Bay Packers"></a></article>';
  const category=categorySchema.parse(parseCategory(html,'nfl'));
  assert.equal(category.events.length,1);
  assert.equal(category.events[0].id,'nfl:12345');
  assert.deepEqual(category.events[0].teams,['Chicago Bears','Green Bay Packers']);
});

test('NASCAR inventory scopes report the generic motorsport read and retain unresolved evidence',()=>{
  const catalog=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'collecting'},categories:{nfl:{kind:'pending'},ncaaf:{kind:'pending'},motorsport:{kind:'collected',at}},events:[event],rejectedGames:[]});
  const source=SOURCE_REGISTRY.find(source=>source.id==='streameast');
  assert.ok(source);
  const scopes=(games:Game[],current=catalog,now=at)=>sourceInventory({at:now,revision:1,lastDiscoveryAt:at,
    browserCollectorsAvailable:true,sources:[source],observations:[],games,candidates:new Map(),attempts:{},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:{catalog:current,receivedAt:at},lastComplete:null,previous:null}}).sources[0].scopes
      .filter(scope=>scope.league==='nascar-cup'||scope.league==='nascar-truck');
  const matched=scopes([game]);
  assert.deepEqual(matched.map(scope=>scope.read),[{kind:'complete',checkedAt:at},{kind:'complete',checkedAt:at}]);
  assert.deepEqual(matched.map(scope=>scope.eventCount),[1,0]);
  assert.deepEqual(matched.map(scope=>scope.publicUrls),[
    ['https://v2.streameast.ga/other-events-streams/'],['https://v2.streameast.ga/other-events-streams/'],
  ]);
  const truck:Game={...game,id:'nascar-truck-202610110022',league:'nascar-truck'};
  assert.deepEqual(scopes([game,truck]).map(scope=>scope.read),[
    {kind:'incomplete',reason:'partial',checkedAt:at},{kind:'incomplete',reason:'partial',checkedAt:at},
  ]);
  for(const [current,now,reason] of [
    [{...catalog,categories:{...catalog.categories,motorsport:{kind:'failed' as const,at,reason:'timeout' as const}}},at,'failed'],
    [catalog,at+31*60_000+1,'stale'],
    [{...catalog,rejectedGames:[{league:'motorsport' as const,title:'Unknown race',reason:'invalid-detail-url' as const}]},at,'partial'],
  ] as const) {
    assert.deepEqual(scopes([game],current,now).map(scope=>scope.read),[
      {kind:'incomplete',reason,checkedAt:at},{kind:'incomplete',reason,checkedAt:at},
    ]);
  }
});

test('the current StreamEast NASCAR inventory exposes its matched race and actual collection checkpoint',()=>{
  const catalog=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'partial',at,reason:'rate-limited'},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at},
      motorsport:{kind:'collected',at}},events:[event],rejectedGames:[]});
  const view=streameastCatalogView({catalog,receivedAt:at},[game],at);
  const current=view.games.filter(row=>row.league==='nascar-cup');
  assert.equal(current.length,1);
  assert.equal(current[0].gameId,game.id);
  assert.equal(current[0].title,'NASCAR Cup Series at Charlotte');
  assert.deepEqual(current[0].detail,{kind:'pending'});
  assert.deepEqual(view.categories['nascar-cup'],{kind:'collected',at});
  assert.deepEqual(view.categories['nascar-truck'],{kind:'collected',at});
  assert.equal(view.games.filter(row=>row.league==='nascar-truck').length,0);
  assert.equal(view.games.filter(row=>row.league==='motorsport').length,0);
  assert.equal(catalog.events[0].league,'motorsport');
});

test('StreamEast inventory keeps ambiguous motor events unclassified and reports failed or pending NASCAR collection',()=>{
  const catalog=StreameastCatalogSchema.parse({runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'collecting'},categories:{nfl:{kind:'pending'},ncaaf:{kind:'pending'},motorsport:{kind:'pending'}},
    events:[event],rejectedGames:[]});
  const truck:Game={...game,id:'nascar-truck-202610110022',league:'nascar-truck'};
  for(const category of [{kind:'pending' as const},{kind:'failed' as const,at,reason:'timeout' as const}]){
    const view=streameastCatalogView({catalog:{...catalog,categories:{...catalog.categories,motorsport:category}},receivedAt:at},[game,truck],at);
    assert.equal(view.games[0].league,'motorsport');
    assert.equal(view.games[0].gameId,null);
    assert.deepEqual(view.categories['nascar-cup'],category);
    assert.deepEqual(view.categories['nascar-truck'],category);
  }
});
