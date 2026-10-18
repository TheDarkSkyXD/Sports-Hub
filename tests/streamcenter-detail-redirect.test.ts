import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFixtureCollector} from '../lib/football/adapters/sources.ts';
import type {Observation} from '../lib/football/shared.ts';

const endpoint='https://streamcenter.st/api/stream-link/iframe/event-espn-league-basketball-nba-401898401/4389c52b-9489-4be4-97cc-4e872ca059df';
const target='https://streame.center/embed/ch66.php';
const player='<iframe src="//streame.center/embed/hls.php?stream=wfazgsqtrezu66"></iframe>';
const observation:Observation={
  id:'streamcenter-nba:f54a64702a4e655ab5d971a8',sourceId:'streamcenter-nba',url:endpoint,
  title:'Orlando Magic vs Cleveland Cavaliers',league:'nba',teams:['Orlando Magic','Cleveland Cavaliers'],
  kickoff:1791757800000,rawTime:'2026-10-11T22:30:00.000Z',observedAt:1791736673690,parserVersion:2,
};

test('a published Streamcenter event redirect yields its exact NBA player locator',async()=>{
  const collector=createFixtureCollector();
  collector.enqueueFixture({url:endpoint,status:302,headers:{location:target}});
  collector.enqueueFixture({url:target,body:player});
  const detail=await collector.readHtml(endpoint,new AbortController().signal);
  assert.equal(detail,player);
  assert.deepEqual(collector.fixtureRequests().map(request=>request.url),[endpoint,target]);
  const players=collector.compatiblePlayers('nba-401898401',observation,detail);
  assert.equal(players.length,1);
  assert.deepEqual(players[0].locator,{provider:'streamcenter',eventId:'401898401',
    linkId:'4389c52b-9489-4be4-97cc-4e872ca059df',league:'nba'});
  assert.deepEqual(collector.compatiblePlayers('nba-401898402',observation,detail),[]);
});

test('Streamcenter cross-host redirects require the exact event endpoint and channel target',async()=>{
  const cases=[
    [endpoint,'https://streame.center/embed/ch10000.php'],
    [endpoint,'https://streame.center/embed/hls.php?stream=wfazgsqtrezu66'],
    [endpoint,`${target}?stream=66`],
    [endpoint,`${target}#player`],
    [endpoint,'https://streame.center:443/embed/ch66.php'],
    [endpoint,'https://user@streame.center/embed/ch66.php'],
    [endpoint,'http://streame.center/embed/ch66.php'],
    [endpoint,'//streame.center/embed/ch66.php'],
    [endpoint,'https://crichd.pk/event/orlando-magic-vs-cleveland-cavaliers'],
    [endpoint,'https://streamed.st/api/matches/all'],
    ['https://streamcenter.st/nba-streams',target],
    [endpoint.replace('basketball-nba','soccer-epl'),target],
    [endpoint.replace('4389c52b-9489-4be4-97cc-4e872ca059df','invalid-id'),target],
    [`${endpoint}?other=1`,target],
    ['https://crichd.pk/',target],
  ];
  for(const [original,location] of cases){
    const collector=createFixtureCollector();
    collector.enqueueFixture({url:original,status:302,headers:{location}});
    await assert.rejects(collector.readHtml(original,new AbortController().signal),/unsupported-discovery-address/,
      `${original} redirected to ${location}`);
    assert.deepEqual(collector.fixtureRequests().map(request=>request.url),[original]);
  }
});
