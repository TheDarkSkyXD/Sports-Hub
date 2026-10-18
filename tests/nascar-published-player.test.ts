import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compatiblePlayers} from '../lib/football/adapters/sources.ts';
import type {Observation} from '../lib/football/shared.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const slug='charlotte-motor-speedway-the-chase-race-bank-of-america-400';
const title='Charlotte Motor Speedway \u2014 The Chase - Race: Bank of America 400';
const kickoff='2026-10-11T19:00:00+00:00';
const gameId='nascar-cup-202610110021';
const server=`https://foxiy.st/event/${slug}-nascar-cup-series-1791745200/hotel/1`;

function fixture(sourceId:'methstreams-f1'|'crackstreams-f1'){
  const host=sourceId==='methstreams-f1'?'methstreams.st':'crackstreams.st';
  const url=`https://${host}/event/${slug}`;
  const observation:Observation={id:`${sourceId}:charlotte`,sourceId,url,title,league:'nascar-cup',teams:null,
    kickoff:Date.parse(kickoff),rawTime:kickoff,observedAt:1791736671416,parserVersion:2};
  const metadata={'@type':'SportsEvent',name:title,url,startDate:kickoff,sport:'NASCAR Cup Series',
    performer:[{name:title}],offers:{price:'0'}};
  const body=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
    <script type="application/ld+json">${JSON.stringify(metadata)}</script>
    <a class="sl-row" href="${server}" aria-label="Watch ${title} on Relay A1 opens the player">
      <span class="sl-nm">Relay A1</span></a>`;
  return {observation,body};
}

test('current Charlotte NASCAR Cup details emit the exact published race player',()=>{
  for(const sourceId of ['methstreams-f1','crackstreams-f1'] as const){
    const {observation,body}=fixture(sourceId);
    const players=compatiblePlayers(gameId,observation,body);
    assert.equal(players.length,1,sourceId);
    assert.deepEqual(players[0].locator,{provider:'event-page',gameId,eventUrl:observation.url,serverUrl:server});
  }
});

test('the NASCAR player URL policy binds only the published exact event and route',()=>{
  const {observation}=fixture('methstreams-f1');
  assert.equal(validEventPagePair(observation.url,server),true);
  for(const wrong of [server.replace('charlotte-motor-speedway','las-vegas-motor-speedway'),
    server.replace('nascar-cup-series','nascar-truck-series'),server.replace('/hotel/1','/hotel/0'),
    server.replace('/hotel/1','/main/1'),server.replace('1791745200','17917452000'),
    server.replace('foxiy.st','foxiy.st.evil.test'),server.replace('https:','http:'),`${server}?stream=1`,`${server}#player`]){
    assert.equal(validEventPagePair(observation.url,wrong),false,wrong);
  }
});

test('current NASCAR details retain every published numbered relay for each channel catalog',()=>{
  const routes=['hotel/1','hotel/2','hotel/3','hotel/4','hotel/5'];
  for(const [sourceId,host] of [['methstreams-f1','methstreams.st'],['crackstreams-f1','crackstreams.st'],
    ['methstreams-vg-f1','methstreams.vg'],['buffstreams-f1','buffstreams.ch']] as const){
    const {observation:base}=fixture('methstreams-f1');
    const observation={...base,sourceId,url:`https://${host}/event/${slug}`};
    const metadata={'@type':'SportsEvent',name:title,url:observation.url,startDate:kickoff,
      sport:'NASCAR Cup Series',performer:[{name:title}],offers:{price:'0'}};
    const urls=routes.map(route=>server.replace('hotel/1',route));
    const body=`<link rel="canonical" href="${observation.url}"><meta property="og:url" content="${observation.url}">
      <script type="application/ld+json">${JSON.stringify(metadata)}</script>
      ${urls.map((url,index)=>`<a class="sl-row" href="${url}" aria-label="Watch ${title} on Relay A${index+1} opens the player">
        <span class="sl-nm">Relay A${index+1}</span></a>`).join('')}`;
    const players=compatiblePlayers(gameId,observation,body);
    assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:null),urls,sourceId);
    for(const url of urls)assert.equal(validEventPagePair(observation.url,url),true,`${sourceId}: ${url}`);
    for(const [original,wrong] of [['1791745200','1791745201'],['nascar-cup-series','nascar-truck-series'],
      ['charlotte-motor-speedway','las-vegas-motor-speedway']] as const){
      assert.deepEqual(compatiblePlayers(gameId,observation,body.replaceAll(original,wrong)),[],`${sourceId}: ${wrong}`);
    }
  }
});

test('NASCAR player routes must retain the observation event, kickoff, and series',()=>{
  for(const sourceId of ['methstreams-f1','crackstreams-f1'] as const){
    const {observation,body}=fixture(sourceId);
    for(const wrong of [server.replace('charlotte-motor-speedway','las-vegas-motor-speedway'),
      server.replace('1791745200','1791745201'),server.replace('1791745200','1791831600'),
      server.replace('nascar-cup-series','nascar-truck-series')]){
      assert.deepEqual(compatiblePlayers(gameId,observation,body.replace(server,wrong)),[],wrong);
    }
    assert.deepEqual(compatiblePlayers(gameId,{...observation,kickoff:Date.parse(kickoff)+86_400_000},body),[]);
    const truckDetail=body.replace('NASCAR Cup Series','NASCAR Truck Series');
    assert.deepEqual(compatiblePlayers(gameId,{...observation,league:'nascar-truck'},truckDetail),[]);
  }
});
