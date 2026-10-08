import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SOURCE_REGISTRY, browserCategory } from '../lib/football/source-registry.ts';
import { CandidateLocatorSchema, SportsurgeCatalogSchema, StreameastCatalogSchema } from '../lib/football/shared.ts';
import { sanitizeSportsurgeCatalog } from '../lib/football/domain/sportsurge-catalog.ts';
import { sanitizeStreameastCatalog, streameastCandidates } from '../lib/football/domain/streameast-catalog.ts';
import { streameastServerUrl } from '../lib/playback/providers/streameast-server.ts';
import { FootballStore } from '../lib/football/adapters/store.ts';

const require=createRequire(import.meta.url);
const surge=require('../desktop/sportsurge-catalog.cjs');
const east=require('../desktop/streameast-catalog.cjs');
const { runSportsurgeSweep }=require('../desktop/sportsurge-sweep.cjs');
const { runStreameastSweep }=require('../desktop/streameast-sweep.cjs');
const { createNavigationPolicy }=require('../desktop/sportsurge-observer.cjs');
const at=Date.parse('2026-10-08T17:00:00Z');
const runId='11111111-1111-4111-8111-111111111111';
const fixture=(provider:string,league:string)=>readFileSync(new URL(`./fixtures/${provider}/${league}.html`,import.meta.url),'utf8');
const pendingCategories={ncaaf:{kind:'pending'},nfl:{kind:'pending'}};

test('captured Sportsurge NBA, NHL, MLB and F1 rows retain league, kickoff and event identity',()=>{
  for(const [league,id,title] of [
    ['nba','66211','Boston Celtics vs Cleveland Cavaliers'],
    ['nhl','66218','Philadelphia Flyers vs Ottawa Senators'],
    ['mlb','66217','Cleveland Guardians vs Chicago White Sox'],
    ['f1','66228','Singapore Airlines Singapore Grand Prix Free Practice 1'],
  ]) {
    const result=surge.parseCategory(fixture('sportsurge',league),league);
    assert.equal(result.kind,'collected');
    assert.equal(result.events.length,1);
    assert.deepEqual(result.rejectedGames,[]);
    const event=result.events[0];
    assert.equal(event.id,`${league}:${id}`);
    assert.equal(event.title,title);
    assert.ok(event.kickoff>at);
    if(league==='f1')assert.equal(event.teams,null);
    const catalog=SportsurgeCatalogSchema.parse({runId,sequence:0,startedAt:at,state:{kind:'collecting'},
      categories:{...pendingCategories,[league]:{kind:'collected',at}},events:[event],rejectedGames:[],catalogIssues:[]});
    assert.ok(sanitizeSportsurgeCatalog(catalog));
    const wrongLeague=league==='nba'?'nhl':'nba';
    assert.equal(surge.detailUrl(event.url,wrongLeague),null);
    assert.equal(sanitizeSportsurgeCatalog({...catalog,events:[{...event,league:wrongLeague}]}),null);
    assert.equal(sanitizeSportsurgeCatalog({...catalog,categories:pendingCategories}),null);
  }
});

test('captured StreamEast nonfootball rows become valid same-event selected server locators',()=>{
  for(const [league,id,espnId] of [['nba','46315','401898392'],['nhl','46321','401891820'],['mlb','46331','401907993']]) {
    const result=east.parseCategory(fixture('streameast',league),league);
    assert.equal(result.kind,'collected');
    const event=result.events[0];
    assert.equal(event.id,`${league}:${id}`);
    assert.equal(event.espnEventId,espnId);
    event.detail={kind:'collected',at,servers:[{id:'2',label:'Server 2',url:`${event.url}2`,availability:{kind:'free-page'}}]};
    const catalog=StreameastCatalogSchema.parse({runId,sequence:0,startedAt:at,state:{kind:'collecting'},
      categories:{...pendingCategories,[league]:{kind:'collected',at}},events:[event],rejectedGames:[]});
    assert.ok(sanitizeStreameastCatalog(catalog,at));
    const candidates=streameastCandidates(catalog.events[0],`${league}-${espnId}`);
    assert.equal(candidates.length,1);
    const locator=CandidateLocatorSchema.parse(candidates[0].locator);
    assert.equal(locator.provider,'streameast-server');
    if(locator.provider!=='streameast-server')return;
    const selected=streameastServerUrl(locator)?.href;
    assert.ok(selected);
    assert.equal(selected,`${event.url}2`);
    assert.equal(streameastServerUrl({...locator,gameId:`ncaaf-${espnId}`}),null);
    assert.equal(east.eventUrl(event.url,'nfl'),null);
    const handoff=`https://auth.streamea.st/SsoHandoff.php?${new URLSearchParams({h:'v2.streameast.ga',p:new URL(selected).pathname})}`;
    assert.equal(createNavigationPolicy(selected,true)(handoff),true);
    assert.equal(createNavigationPolicy(selected,true)(handoff.replace('%2F2','%2F3')),false);
  }
});

test('a sweep reads every registered category and does not turn an unverified event path into empty',async()=>{
  const reads:string[]=[];
  const checkpoints:unknown[]=[];
  const catalog=StreameastCatalogSchema.parse(await runStreameastSweep({now:()=>at,runId,
    signal:new AbortController().signal,send:async(value:unknown)=>{checkpoints.push(structuredClone(value));},
    read:async(url:string,page:string,league:string)=>{
      reads.push(url);
      assert.equal(page,'category');
      if(league==='f1')return '<article class="m-card" data-match-id="777"><a class="m-card__link" href="/f1/unverified-race/" aria-label="Race"></a></article>';
      const title=browserCategory('streameast',league)?.emptyTitles?.[0];
      return `<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">${title}</h2></div>`;
    },
  }));
  assert.deepEqual(reads,Object.values(east.CATEGORY_URLS));
  assert.ok(checkpoints.every(value=>StreameastCatalogSchema.safeParse(value).success));
  assert.equal(catalog.state.kind,'partial');
  assert.equal(catalog.rejectedGames[0].league,'f1');
  assert.equal(catalog.rejectedGames[0].reason,'invalid-detail-url');
  assert.equal(east.eventUrl('https://v2.streameast.ga/f1/unverified-race/','f1'),null);
});

test('Sportsurge shares one physical NASCAR category read and retains failures by league',async()=>{
  const reads:string[]=[];
  const catalog=SportsurgeCatalogSchema.parse(await runSportsurgeSweep({now:()=>at,runId,
    signal:new AbortController().signal,send:async()=>{},read:async(url:string)=>{
      reads.push(url);
      if(url==='https://v2.sportsurge.net/watch-nascar-streams/')throw new Error('timeout');
      return '<main id="match-list-container"><div class="watch-empty-state">There are no live or upcoming games here right now.</div></main>';
    },
  }));
  assert.equal(reads.filter(url=>url==='https://v2.sportsurge.net/watch-nascar-streams/').length,1);
  assert.equal(catalog.categories['nascar-cup'].kind,'failed');
  assert.equal(catalog.categories['nascar-truck'].kind,'failed');
  assert.equal(catalog.categories.nba.kind,'collected');
  assert.equal(catalog.state.kind,'partial');
});

test('legacy two-category checkpoints remain readable without claiming new categories were collected',()=>{
  const catalog=StreameastCatalogSchema.parse({runId,sequence:0,startedAt:at,state:{kind:'collecting'},
    categories:pendingCategories,events:[],rejectedGames:[]});
  assert.equal(catalog.categories.nba,undefined);
  assert.ok(sanitizeStreameastCatalog(catalog,at));
  assert.equal(StreameastCatalogSchema.safeParse({...catalog,categories:{...pendingCategories,unknown:{kind:'pending'}}}).success,false);
  assert.equal(sanitizeStreameastCatalog({...catalog,categories:{...catalog.categories,motorsport:{kind:'collected',at}}},at),null);
  for(const source of SOURCE_REGISTRY.filter(source=>source.kind==='browser-catalog'))
    assert.deepEqual(source.browserCategories?.map(category=>category.league),source.leagues);
});

test('nonfootball browser category attempts persist their league and replay does not duplicate history',()=>{
  const store=new FootballStore(':memory:');
  try {
    const catalog=SportsurgeCatalogSchema.parse({runId,sequence:0,startedAt:at,state:{kind:'collecting'},
      categories:{...pendingCategories,nba:{kind:'collected',at},f1:{kind:'failed',at,reason:'timeout'}},
      events:[],rejectedGames:[],catalogIssues:[]});
    store.saveSportsurgeCatalog({catalog,receivedAt:at},[]);
    store.saveSportsurgeCatalog({catalog,receivedAt:at},[]);
    assert.deepEqual(store.collectionHistory(at).map(row=>({league:row.league,outcome:row.outcome}))
      .sort((left,right)=>(left.league||'').localeCompare(right.league||'')),[
      {league:'f1',outcome:'failed'},{league:'nba',outcome:'parsed'},
    ]);
    assert.equal(store.sportsurgeCatalog().current?.catalog.categories.f1.kind,'failed');
  } finally {store.close();}
});

test('unclassified and paid StreamEast rows survive as publication counts without playable locators',()=>{
  const event=east.parseCategory(fixture('streameast','nba'),'nba').events[0];
  const html=`<div class="stream-alt-list">
    <a class="stream-alt-item stream-alt-item-pro" href="${event.url}1"><span class="stream-alt-name">Premium</span></a>
    <a class="stream-alt-item" href="${event.url}2"><span class="stream-alt-name">Unclassified</span></a>
  </div>`;
  const detail=east.parseDetail(html,event,at,new Map());
  assert.deepEqual(detail,{kind:'collected',at,servers:[],publication:{premium:1,unknown:1}});
  assert.deepEqual(streameastCandidates({...event,detail},'nba-401898392'),[]);
});
