import assert from 'node:assert/strict';
import test from 'node:test';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {sourceCoverage} from '../lib/football/source-registry.ts';
import type {Observation,RaceGame} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-11T17:50:00Z');
const category='https://isportsurge.ws/f1/livestreams2';
const url='https://isportsurge.ws/event/nascar/2026-nascar-cup-series-playoff-at-charlotte-road-course-live-streaming-links';
const title='2026 NASCAR Cup Series Playoff at Charlotte Road Course';
const card=`<a class="row MaclariListele align-items-center align-content-center" href="${url}">
  <span class="time-badge schedule-ss MobildeShow">2 hours from now</span>
  <div><img alt="Nascar"><h4>${title}</h4></div><div>Nascar</div><div>2 hours from now</div></a>`;
const detail=`<body><h1>${title}</h1><dl><dt>Stadium:</dt><dd>Charlotte Motor Speedway Road Course</dd>
  <dt>Date:</dt><dd>2026-10-11 16:00ET</dd><dt>League:</dt><dd>Nascar</dd></dl>
  <iframe src="https://gooz.aapmains.net/new-stream-embed/57903"></iframe></body>`;
const cup:RaceGame={id:'nascar-cup-202610110021',league:'nascar-cup',name:'NASCAR Cup Series at Charlotte',
  date:'2026-10-11T19:00:00Z',race:{eventId:'202610110021',sessionId:'202610110021',session:'race',round:'Charlotte'},
  status:'pre',lifecycle:'scheduled',detail:'Scheduled'};
const source=SOURCES.find(row=>row.id==='sportsurge');
assert.ok(source);

test('the existing Sportsurge source covers NASCAR through its published F1 category',()=>{
  for(const league of ['nascar-cup','nascar-truck']){
    assert.equal(sourceCoverage('sportsurge').includes(league),true);
    assert.equal(source.publicCategories?.some(row=>row.league===league&&row.url===category),true);
  }
});

test('Sportsurge collection fetches its NASCAR category once alongside existing categories',async()=>{
  const collector=createFixtureCollector();
  const categories=['https://isportsurge.ws/nfl/livestreams3','https://isportsurge.ws/cfb/livestreams2',
    'https://isportsurge.ws/nba/livestreams3','https://isportsurge.ws/nhl/livestreams3',
    'https://isportsurge.ws/mlb/livestreams2',category];
  for(const target of categories)collector.enqueueFixture({url:target,body:`<html><body>${target===category?card:''}</body></html>`});
  const html=await collector.readHtml(source.url,new AbortController().signal);
  assert.deepEqual(collector.fixtureRequests().map(row=>row.url).sort(),categories.sort());
  assert.equal(collector.parseListings(source,html,at).observations.some(row=>row.url===url&&row.league==='nascar-cup'),true);
});

test('the captured Charlotte row keeps race identity through its actual dated detail and Gooz choice',()=>{
  const collector=createFixtureCollector();
  const result=collector.parseListings(source,card,at);
  assert.equal(result.observations.length,1);
  const row=result.observations[0];
  assert.equal(row.title,title);
  assert.equal(row.league,'nascar-cup');
  assert.equal(row.teams,null);
  assert.equal(row.kickoff,null);
  const enriched=collector.enrichObservation(row,detail);
  assert.equal(enriched.kickoff,Date.parse('2026-10-11T20:00:00Z'));
  assert.equal(enriched.rawTime,'2026-10-11 16:00ET');
  assert.equal(enriched.league,'nascar-cup');
  assert.equal(enriched.teams,null);
  assert.deepEqual(matchObservation(enriched,[cup],at),{kind:'matched',gameId:cup.id});
  assert.deepEqual(collector.compatiblePlayers(cup.id,enriched,detail),[
    {id:'gooz-57903',label:'Primary',locator:{provider:'gooz',playerId:'57903'}},
  ]);
  for(const changed of [{...enriched,kickoff:Date.parse('2026-10-12T20:00:00Z')},
    {...enriched,title:title.replace('Charlotte','Phoenix')}, {...enriched,league:'nascar-truck' as const},
    {...enriched,observedAt:at-31*60_000}])assert.equal(matchObservation(changed,[cup],at).kind,'unmatched');
});

test('published Truck rows remain distinct while conflicting NASCAR routes and titles reject',()=>{
  const collector=createFixtureCollector();
  const truck=card.replaceAll('2026-nascar-cup-series-playoff-at-charlotte-road-course','2026-truck-playoff-at-phoenix')
    .replace(title,'2026 Truck Playoff at Phoenix');
  const row=collector.parseListings(source,truck,at).observations[0];
  assert.ok(row);
  assert.equal(row.league,'nascar-truck');
  assert.equal(row.teams,null);
  assert.equal(row.title,'2026 Truck Playoff at Phoenix');
  for(const invalid of [card.replace(title,'2026 Truck Playoff at Charlotte Road Course'),
    card.replace('/event/nascar/','/event/nascar-cup-series-extra/'),
    card.replace('isportsurge.ws','isportsurge.ws.evil.test'),card.replace(url,`${url}?date=2026-10-12`),
    card.replace(url,`${url}#player`),card.replace('https://isportsurge.ws','http://isportsurge.ws'),
    card.replace(title,'2026 NASCAR Xfinity Series Playoff at Charlotte Road Course')]){
    assert.equal(collector.parseListings(source,invalid,at).observations.length,0,invalid);
  }
});

test('NASCAR Gooz choices require the bound event heading, series, route, and exact detail date',()=>{
  const collector=createFixtureCollector();
  const row:Observation={id:'sportsurge:6da110d17c67bcddcd00bc0e',sourceId:'sportsurge',url,title,
    league:'nascar-cup',teams:null,kickoff:Date.parse('2026-10-11T20:00:00Z'),rawTime:'2026-10-11 16:00ET',
    observedAt:at,parserVersion:2};
  assert.equal(collector.compatiblePlayers(cup.id,row,detail).length,1);
  for(const changed of [detail.replace(title,title.replace('Charlotte','Phoenix')),
    detail.replace(title,'2026 Truck Playoff at Charlotte Road Course'),
    detail.replace('Nascar</dd>','NASCAR Truck Series</dd>'),
    detail.replace(`<h1>${title}</h1>`,'').replace('Nascar</dd>','NASCAR Truck Series</dd>'),
    detail.replace(`<h1>${title}</h1>`,`<h1>${title}</h1><h1>${title}</h1>`),
    detail.replace('2026-10-11','2026-10-12'),detail.replace('2026-10-11 16:00ET','Time unavailable')]){
    assert.deepEqual(collector.compatiblePlayers(cup.id,row,changed),[],changed);
    assert.equal(collector.enrichObservation(row,changed).kickoff,null);
  }
  for(const changed of [{...row,url:url.replace('charlotte','phoenix')},
    {...row,url:url.replace('isportsurge.ws','isportsurge.ws.evil.test')}, {...row,url:`${url}?other=1`},
    {...row,league:'nascar-truck' as const}, {...row,kickoff:Date.parse('2026-10-12T20:00:00Z')},
    {...row,teams:['Other','Teams'] satisfies [string,string]}]){
    assert.deepEqual(collector.compatiblePlayers(cup.id,changed,detail),[],JSON.stringify(changed));
  }
  assert.equal(collector.enrichObservation({...row,kickoff:null,rawTime:''},detail).kickoff,row.kickoff);
  assert.equal(collector.enrichObservation({...row,kickoff:Date.parse('2026-10-12T20:00:00Z')},detail).kickoff,null);
});

test('Sportsurge NFL and college matchup rows keep their teams and league classification',()=>{
  const collector=createFixtureCollector();
  const html='<a href="/watch/nfl/chicago-green-bay/1"><span class="team-name-event-row"><img alt="Chicago Bears"></span>'+ 
    '<span class="team-name-event-row"><img alt="Green Bay Packers"></span></a>'+ 
    '<a href="/watch/cfb/brown-harvard/2"><span class="team-name-event-row"><img alt="Brown Bears"></span>'+ 
    '<span class="team-name-event-row"><img alt="Harvard Crimson"></span></a>';
  assert.deepEqual(collector.parseListings(source,html,at).observations.map(row=>({league:row.league,teams:row.teams})),[
    {league:'nfl',teams:['Chicago Bears','Green Bay Packers']},
    {league:'ncaaf',teams:['Brown Bears','Harvard Crimson']},
  ]);
});
