import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatiblePlayers, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { readSchedule, SCHEDULES } from '../lib/football/adapters/schedule.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { wrestlingEventKey, wrestlingPromotion, wrestlingShowKey } from '../lib/football/domain/wrestling-events.ts';
import { feedEligible } from '../lib/football/domain/feed-eligibility.ts';
import { GameSchema, isWrestlingGame } from '../lib/football/shared.ts';
import { validGameId } from '../lib/sunday.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { validStreamTarget } from '../lib/playback/providers/catalog-stream-policy.ts';

const start=1791590400000;
const now=start-60_000;
const id='ppv-wwe-friday-night-smackdown';
const streamed={id,title:'WWE Friday Night Smackdown',category:'fight',date:start,popular:true,
  sources:[{source:'admin',id}]};
const lsp={id,title:'WWE Friday Night Smackdown',category:'wrestling',date:start,popular:true,teams:null,
  sources:[{source:'ppv:s',id:'wwe/2026-10-09'},{source:'sp:admin',id}],league:null};
const ppvEvent={id:29976,name:'WWE Friday Night Smackdown',tag:'Wrestling',source_tag:'USA',
  uri_name:'wwe/2026-10-09',starts_at:start/1000,ends_at:start/1000+10800,always_live:0,
  iframe:'https://taifood-blog.asia/embed/wwe/2026-10-09',substreams:[]};
const ppv={success:true,streams:[{category:'Wrestling',streams:[ppvEvent,
  {...ppvEvent,id:29977,name:'AEW Grand Slam: Collision',uri_name:'aew/2026-10-10',starts_at:start/1000+86400}]}]};
function source(id:string){const value=SOURCES.find(row=>row.id===id);assert.ok(value);return value;}
function partition(id:'wwe'|'tna'){const value=SCHEDULES.find(row=>row.id===id);assert.ok(value);return value;}
const reader=async(url:string)=>JSON.stringify(url.includes('streamed.st')?[streamed]:
  url.includes('kultsport.com')?[lsp]:ppv);

test('native listing boundary accepts real WWE mirrors and excludes unrelated catalog channels and AEW',()=>{
  const unrelated={id:'NHLNetwork.us',title:'NHL Network',category:'hockey',date:0,sources:[]};
  const observations=[
    parseListings(source('streamed'),JSON.stringify([unrelated,streamed]),now),
    parseListings(source('livesportpro'),JSON.stringify([unrelated,lsp]),now),
    parseListings(source('ppv'),JSON.stringify(ppv),now),
  ];
  for(const result of observations){assert.equal(result.outcome,'parsed');assert.equal(result.observations.length,1);
    assert.equal(result.observations[0].league,'wwe');assert.equal(result.observations[0].teams,null);}
  assert.equal(observations[0].observations[0].url,`https://streamed.st/watch/${id}`);
  assert.equal(observations[2].observations[0].url,'https://ppv.st/live/wwe/2026-10-09');
  assert.equal(parseListings(source('streamed'),JSON.stringify([{...streamed,sources:'broken'}]),now).outcome,'parser-changed');
  for(const [category,title,league] of [['fight','WWE Monday Night Raw','wwe'],['wrestling','NXT No Mercy','wwe'],
    ['fight','Impact Wrestling Bound For Glory','tna'],['wrestling','TNA Impact','tna'],
    ['fight','Raw',null],['fight','Impact',null],['fight','AEW Collision',null],
    ['motor-sports','WWE Friday Night Smackdown',null]] as const){
    const result=parseListings(source('streamed'),JSON.stringify([{...streamed,category,title}]),now);
    assert.equal(result.observations[0]?.league??null,league,title);
  }
});

test('Chicago episode identity and tight matching merge three real SmackDown listings',async()=>{
  const {games}=await readSchedule(partition('wwe'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,reader);
  assert.equal(games.length,1);
  const game=games[0];
  assert.ok(isWrestlingGame(game));
  assert.equal(game.id,'wwe-107515955124440');
  assert.equal(game.date,'2026-10-10T00:00:00.000Z');
  assert.equal(game.status,'pre');
  assert.equal('home' in game,false);
  assert.equal(validGameId(game.id),true);
  assert.equal(wrestlingEventKey('wwe','Smackdown',Date.parse('2026-10-10T03:30:00Z')),
    wrestlingEventKey('wwe','WWE Friday Night Smackdown',start));
  for(const [id,body] of [['streamed',[streamed]],['livesportpro',[lsp]],['ppv',ppv]] as const){
    const observation=parseListings(source(id),JSON.stringify(body),now).observations[0];
    assert.deepEqual(matchObservation(observation,games,now),{kind:'matched',gameId:game.id});
  }
  const shifted=parseListings(source('streamed'),JSON.stringify([{...streamed,date:start+91*60_000}]),now).observations[0];
  assert.equal(matchObservation(shifted,games,now).kind,'unmatched');
  assert.notEqual(wrestlingEventKey('wwe','Smackdown',start+86400000),wrestlingEventKey('wwe','Smackdown',start));
});

test('TNA Impact mirrors match while NXT and Impact specials remain separate weekly cards',async()=>{
  const tnaA={...streamed,id:'tna-impact',title:'Impact Wrestling',category:'fight',sources:[]};
  const tnaB={...lsp,id:'tna-impact',title:'TNA Impact',sources:[]};
  const tnaReader=async(url:string)=>JSON.stringify(url.includes('streamed.st')?[tnaA]:[tnaB]);
  const {games}=await readSchedule(partition('tna'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,tnaReader);
  assert.equal(games.length,1);
  assert.equal(games[0].league,'tna');
  for(const [id,row] of [['streamed',tnaA],['livesportpro',tnaB]] as const){
    const observation=parseListings(source(id),JSON.stringify([row]),now).observations[0];
    assert.deepEqual(matchObservation(observation,games,now),{kind:'matched',gameId:games[0].id});
  }
  assert.notEqual(wrestlingShowKey('wwe','NXT'),wrestlingShowKey('wwe','NXT No Mercy'));
  assert.equal(wrestlingShowKey('wwe','NXT No Mercy'),wrestlingShowKey('wwe','WWE NXT No Mercy'));
  assert.notEqual(wrestlingShowKey('tna','Impact Wrestling'),wrestlingShowKey('tna','TNA Bound For Glory'));
  assert.equal(wrestlingShowKey('tna','Impact Wrestling Bound For Glory'),wrestlingShowKey('tna','TNA Bound For Glory'));
  for(const title of ['Raw','Impact','AEW Collision'])assert.equal(wrestlingPromotion(title),null);
});

test('conflicting same-show starts fail and PPV success cannot mask failed TNA catalogs',async()=>{
  await assert.rejects(readSchedule(partition('wwe'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,async url=>JSON.stringify(url.includes('kultsport.com')?
      [{...lsp,date:start+3*3600000}]:url.includes('streamed.st')?[streamed]:ppv)),
    /source-schedule-conflicting-event/);
  const onlyPpv=async(url:string)=>{if(!url.includes('ppv.st'))throw new Error('offline');return JSON.stringify(ppv);};
  assert.equal((await readSchedule(partition('wwe'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,onlyPpv)).games.length,1);
  await assert.rejects(readSchedule(partition('tna'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,onlyPpv),/source-schedule-unavailable/);
});

test('published WWE route and LiveSportPro PPV target require exact dated host and path',()=>{
  const event='https://ppv.st/live/wwe/2026-10-09';
  const player='https://taifood-blog.asia/embed/wwe/2026-10-09';
  assert.equal(validEventPagePair(event,player),true);
  assert.equal(validEventPagePair('https://ppv.st/live/wwe/2026-10-10',player),false);
  assert.equal(validStreamTarget('livesportpro','ppv:s','wwe/2026-10-09',1,player),true);
  assert.equal(validStreamTarget('streamed','ppv:s','wwe/2026-10-09',1,player),false);
  assert.equal(validStreamTarget('livesportpro','ppv:s','aew/2026-10-09',1,
    'https://taifood-blog.asia/embed/aew/2026-10-09'),false);
  const observation=parseListings(source('ppv'),JSON.stringify(ppv),now).observations[0];
  const resolved=compatiblePlayers('wwe-123',observation,JSON.stringify(ppvEvent));
  assert.equal(resolved.length,1);
  assert.equal(resolved[0].locator.provider,'event-page');
});

test('source-backed unknown wrestling has six-hour grace without claiming live status',()=>{
  const game=GameSchema.parse({id:'wwe-123',league:'wwe',name:'WWE Friday Night Smackdown',
    date:new Date(start).toISOString(),wrestling:{eventId:'123'},status:'unknown',lifecycle:'unknown',
    detail:'Status unavailable'});
  assert.equal(game.status,'unknown');
  assert.equal(feedEligible(game,start+5*3600000),true);
  assert.equal(feedEligible(game,start+6*3600000+1),false);
});
