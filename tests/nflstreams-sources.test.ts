import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {SOURCES,parseListings,enrichObservation,compatiblePlayers} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const now=Date.parse('2026-10-05T02:30:00Z');
const listing=readFileSync(new URL('./fixtures/nflstreams-live-2026-10-04.html',import.meta.url),'utf8');
const detail=readFileSync(new URL('./fixtures/nflstreams-live-detail-2026-10-04.html',import.meta.url),'utf8');
const saintsDetail=readFileSync(new URL('./fixtures/nflstreams-saints-2026-10-05.html',import.meta.url),'utf8');
const source=SOURCES.find(item=>item.id==='nflstreams');
assert.ok(source);
const team=(name:string,id:string)=>({name,id,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const game:Game={id:'401872978',league:'nfl',name:'Detroit Lions at Carolina Panthers',date:'2026-10-05T00:20:00Z',
  home:team('Carolina Panthers','espn:nfl:29'),away:team('Detroit Lions','espn:nfl:8'),
  status:'in',lifecycle:'live',detail:'Q3',redzone:false};

test('NFLStreams publishes one dated free WATCH event matched to the live game',()=>{
  assert.equal('name' in source && source.name,'NFLStreams');
  const parsed=parseListings(source,listing,now);
  assert.equal(parsed.outcome,'parsed');
  assert.equal(parsed.observations.length,1);
  const event=parsed.observations[0];
  assert.equal(event.url,'https://nflstreams.org/teams/carolina-panthers-live/');
  assert.deepEqual(event.teams,['Detroit Lions','Carolina Panthers']);
  assert.equal(event.kickoff,Date.parse('2026-10-05T00:20:00Z'));
  assert.deepEqual(matchObservation(event,[game],now),{kind:'matched',gameId:game.id});
  assert.equal(enrichObservation(event,detail).kickoff,event.kickoff);
});

test('NFLStreams active detail yields six distinct free choices and excludes paid HD',()=>{
  const event=parseListings(source,listing,now).observations[0];
  const players=compatiblePlayers(game.id,event,detail);
  assert.deepEqual(players.map(player=>player.label),[
    'NFLStreams · Link 1','NFLStreams · Link 2','NFLStreams · Link 3',
    'NFLStreams · Link 4','NFLStreams · Link 5','NFLStreams · Link 6',
  ]);
  assert.equal(new Set(players.map(player=>player.id)).size,6);
  assert.deepEqual(players.map(player=>player.locator.provider),Array(6).fill('event-page'));
  for(const player of players){
    assert.equal(player.locator.provider,'event-page');
    assert.equal(player.locator.eventUrl,event.url);
    assert.equal(validEventPagePair(player.locator.eventUrl,player.locator.serverUrl),true);
    assert.equal(new URL(player.locator.serverUrl).pathname,'/sports/player.php');
  }
  assert.deepEqual(compatiblePlayers(game.id,event,detail).map(player=>player.id),players.map(player=>player.id));
});

test('NFLStreams accepts the published Saints channel identifiers',()=>{
  const eventUrl='https://nflstreams.org/teams/new-orleans-saints-live/';
  const event:Observation={...parseListings(source,listing,now).observations[0],
    id:'nflstreams:saints',url:eventUrl,title:'Atlanta Falcons vs New Orleans Saints',
    teams:['Atlanta Falcons','New Orleans Saints'],kickoff:Date.parse('2026-10-06T00:15:00Z'),
    rawTime:'2026-10-06T00:15:00Z'};
  const players=compatiblePlayers('401872979',event,saintsDetail);
  assert.equal(players.length,6);
  for(let number=1;number<=6;number++){
    const serverUrl=`https://piratecat.store/sports/player.php?hd=new-orleans-saints=ch0${number}`;
    assert.equal(validEventPagePair(eventUrl,serverUrl),true,serverUrl);
    assert.equal(players[number-1].locator.provider,'event-page');
    assert.equal(players[number-1].locator.serverUrl,serverUrl);
  }
  for(const invalid of [
    'https://piratecat.store/sports/player.php?hd=new%2Dorleans-saints=ch01',
    'https://piratecat.store/sports/player.php?hd=new-orleans-saints%3Dch01',
    'https://piratecat.store/sports/player.php?hd=new-orleans-saints=ch01=extra',
    'https://piratecat.store/sports/player.php?hd=abcdefghijklmnopqrstu=ch01',
    'https://piratecat.store/sports/player.php?hd=new-orleans-saints=ch01&hd=new-orleans-saints=ch02',
  ])assert.equal(validEventPagePair(eventUrl,invalid),false,invalid);
});

test('NFLStreams rejects a rolled-over detail and unrelated player destinations',()=>{
  const event=parseListings(source,listing,now).observations[0];
  assert.deepEqual(compatiblePlayers(game.id,event,detail.replace('data-kickoff-ts="1791159600000"',
    'data-kickoff-ts="1791246000000"')),[]);
  assert.deepEqual(compatiblePlayers(game.id,event,detail.replace('fixture-active','fixture-inactive')),[]);
  assert.deepEqual(compatiblePlayers(game.id,event,detail.replace('data-home-slug="carolina-panthers"',
    'data-home-slug="new-orleans-saints"')),[]);
  const server='https://piratecat.store/sports/player.php?hd=fixture-server-01=live';
  for(const invalid of [server.replace('piratecat.store','piratecat.store.evil.test'),
    server.replace('/sports/player.php','/premium.php'),`${server}&paid=true`,
    server.replace('https://','http://'),server.replace('fixture-server-01=live','invalid'),
    server.replace('piratecat.store','user@piratecat.store'),`${server}#premium`])
    assert.equal(validEventPagePair(event.url,invalid),false);
});
