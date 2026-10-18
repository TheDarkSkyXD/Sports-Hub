import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import type {Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-12T14:00:00Z');
const eventUrl='https://ms.buffstream.io/mma-streams/dana-whites-contender-series-season-10-week-10-live-stream';
const playerUrl='https://embedsports.me/boxing/dana-white-s-contender-series-season-10-week-10-stream-1';
const listing=`<a href="${eventUrl}"><h4>Dana Whites Contender Series Season 10 Week 10 vs Live Broadcast</h4><p>2026-10-13, Tuesday - 07:00 pm ET</p></a>`;
const detail=`<link rel="canonical" href="${eventUrl.replace('https:','http:')}"><h1>Dana Whites Contender Series Season 10 Week 10 Live Stream</h1><iframe src="${playerUrl}"></iframe>`;

for(const id of ['markkystreams-ufc','ecrackstreams-ufc','crackstreams-so-ufc','crackstreams-ws-ufc','streameasthd-ufc']) {
  test(`${id} resolves its captured UFC player through native and playback policies`,async()=>{
    const source=SOURCES.find(source=>source.id===id);
    assert.ok(source);
    const collector=createFixtureCollector();
    const parsed=collector.parseListings(source,listing,at);
    assert.equal(parsed.outcome,'parsed');
    const observation=parsed.observations[0];
    assert.equal(observation.league,'ufc');
    const players=await collector.resolvePlayers('ufc-contender-series',observation,detail,new AbortController().signal);
    assert.equal(players.length,1);
    assert.deepEqual(players[0].locator,{provider:'event-page',gameId:'ufc-contender-series',eventUrl,serverUrl:playerUrl});
    assert.equal(validEventPagePair(eventUrl,playerUrl),true);
    for(const invalid of [detail.replace('rel="canonical"','rel="alternate"'),
      detail.replace(playerUrl,playerUrl.replace('week-10','week-9')),
      detail.replace('embedsports.me/','embedsports.me.attacker.test/'),
      detail.replace('embedsports.me/boxing/','embedsports.me/baseball/')])
      assert.deepEqual(collector.compatiblePlayers('ufc-contender-series',observation,invalid),[]);
    assert.equal(validEventPagePair(eventUrl,playerUrl.replace('week-10','week-9')),false);
    assert.equal(validEventPagePair(eventUrl,`${playerUrl}?redirect=https://example.com`),false);
  });
}

const eventCases=[
  {ids:['markkystreams-boxing','ecrackstreams-boxing','crackstreams-so-boxing','crackstreams-ws-boxing','streameasthd-boxing'],
    league:'boxing',title:'Luis Castillo vs Jorge Zarate',path:'boxing-streams/luis-castillo',player:'boxing/luis-castillo-vs-jorge-zarate'},
  {ids:['streameasthd-wwe'],league:'wwe',title:'Monday Night RAW',path:'wwe-streams/monday-night-raw',player:'boxing/monday-night-raw'},
  {ids:['streameasthd-ufc'],league:'aew',title:'AEW Dynamite',path:'mma-streams/aew-dynamite',player:'boxing/aew-dynamite'},
  {ids:['streameasthd-f1'],league:'f1',title:'F1 Singapore Grand Prix',path:'motor-streams/f1-singapore-grand-prix',player:'motorsports/sky-sports-f1-sky-f1'},
  {ids:['buffstream-motogp'],league:'motogp',title:'MotoGP Indonesia GP Free Practice Nr 1',path:'motor-streams/motogp-indonesia-gp-free-practice-nr-1',player:'motorsports/motogp-qualifying-motogp-main-race'},
] satisfies Array<{ids:string[];league:Observation['league'];title:string;path:string;player:string}>;

for(const fixture of eventCases)for(const sourceId of fixture.ids) {
  test(`${sourceId} resolves its captured ${fixture.league} player without team fields`,async()=>{
    const collector=createFixtureCollector();
    const url=`https://${sourceId==='streameasthd-wwe'||fixture.league==='aew'?'streameasthd.app':'ms.buffstream.io'}/${fixture.path}-live-stream`;
    const serverUrl=`https://embedsports.me/${fixture.player}-stream-1`;
    const observation:Observation={id:`${sourceId}:event`,sourceId,url,title:fixture.title,
      league:fixture.league,teams:null,kickoff:at,rawTime:new Date(at).toISOString(),observedAt:at,parserVersion:3};
    const body=`<link rel="canonical" href="${url}"><h1>${fixture.title} Live Stream</h1><iframe src="${serverUrl}"></iframe>`;
    const players=await collector.resolvePlayers('event',observation,body,new AbortController().signal);
    assert.equal(players.length,1);
    assert.deepEqual(players[0].locator,{provider:'event-page',gameId:'event',eventUrl:url,serverUrl});
    assert.equal(validEventPagePair(url,serverUrl),true);
    assert.deepEqual(collector.compatiblePlayers('event',observation,body.replace('rel="canonical"','rel="alternate"')),[]);
    assert.equal(validEventPagePair(url,serverUrl.replace('embedsports.me/','embedsports.me.attacker.test/')),false);
    assert.deepEqual(collector.compatiblePlayers('event',observation,body.replace(serverUrl,'https://embedsports.me/baseball/unrelated-stream-1')),[]);
    if(fixture.league==='boxing') {
      assert.deepEqual(collector.compatiblePlayers('event',{...observation,title:'Luis Castillo vs Someone Else'},body),[]);
    }
  });
}
