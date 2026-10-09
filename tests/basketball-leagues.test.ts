import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';
import { SOURCES, allowedDiscoveryUrl, compatiblePlayers, parseListings } from '../lib/football/adapters/sources.ts';
import { createSourceEventMatcher, matchObservation } from '../lib/football/domain/matching.ts';
import { isBasketballLeague, parseScoreboard, validGameId } from '../lib/sunday.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';

const tipoff = Date.parse('2026-10-08T01:30:00Z');
const scoreboard = (id: string, away: string, home: string, at = tipoff, awayId = '1', homeId = '2') => ({events:[{
  id,date:new Date(at).toISOString(),name:`${away} at ${home}`,
  status:{type:{name:'STATUS_SCHEDULED',state:'pre',shortDetail:'9:30 PM ET'}},
  competitions:[{competitors:[
    {homeAway:'away',team:{id:awayId,displayName:away,shortDisplayName:away,abbreviation:'AWY'}},
    {homeAway:'home',team:{id:homeId,displayName:home,shortDisplayName:home,abbreviation:'HME'}},
  ]}],
}]});
const wnba = parseScoreboard(scoreboard('401918298','Las Vegas Aces','Golden State Valkyries'),'wnba')[0];

test('WNBA uses its ESPN partition, ID, and team identities',async()=>{
  assert.equal(wnba.league,'wnba');
  assert.equal(wnba.id,'wnba-401918298');
  assert.equal(wnba.away.id,'espn:wnba:1');
  assert.equal(wnba.redzone,false);
  assert.equal(wnba.down,undefined);
  assert.equal(validGameId(wnba.id),true);
  assert.equal(isBasketballLeague('wnba'),true);
  assert.equal(isBasketballLeague('ncaaf'),false);
  const partition=SCHEDULES.find(item=>item.id==='wnba');
  assert.ok(partition);
  assert.equal(partition.sport,'basketball');
  assert.equal(partition.path,'wnba');
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);
    requested.push(url);
    return Response.json(new URL(url).searchParams.get('dates')==='20261008'?
      scoreboard('401918298','Las Vegas Aces','Golden State Valkyries'):{events:[]});
  };
  try {
    const result=await readSchedule(partition,tipoff+60_000,new AbortController().signal);
    assert.deepEqual(result.games.map(game=>game.id),['wnba-401918298']);
    assert.ok(requested.every(url=>new URL(url).pathname==='/apis/site/v2/sports/basketball/wnba/scoreboard'));
  } finally {globalThis.fetch=original;}
});

test('WNBA PPV and Streamcenter listings bind only to the WNBA schedule game',()=>{
  const ppv=SOURCES.find(item=>item.id==='ppv');
  const streamcenter=SOURCES.find(item=>item.id==='streamcenter-nba');
  assert.ok(ppv&&streamcenter);
  const event='wnba/2026-10-07/lv-gs';
  const url=`https://ppv.st/live/${event}`;
  assert.equal(allowedDiscoveryUrl(url),true);
  const ppvResult=parseListings(ppv,JSON.stringify({success:true,streams:[
    {category:'Basketball',streams:[{id:30097,name:'Las Vegas Aces vs. Golden State Valkyries',tag:'WNBA',uri_name:event,starts_at:tipoff/1000}]},
  ]}),tipoff);
  assert.equal(ppvResult.outcome,'parsed');
  assert.equal(ppvResult.observations.length,1);
  assert.equal(ppvResult.observations[0].league,'wnba');
  assert.deepEqual(matchObservation(ppvResult.observations[0],[wnba],tipoff),{kind:'matched',gameId:wnba.id});
  const player='https://embedindia.st/embed/wnba/2026-10-07/lv-gs';
  assert.equal(validEventPagePair(url,player),true);
  assert.equal(validEventPagePair(url,player.replace('/wnba/','/nba/')),false);
  const detail=JSON.stringify({id:30097,name:'Las Vegas Aces vs. Golden State Valkyries',tag:'WNBA',
    uri_name:event,starts_at:tipoff/1000,iframe:player,substreams:[]});
  const players=compatiblePlayers(wnba.id,ppvResult.observations[0],detail);
  assert.equal(players.length,1);
  assert.equal(players[0].locator.provider,'event-page');
  const link='/api/stream-link/iframe/event-espn-league-basketball-wnba-401918298/7bd8aeb5-7758-4a38-9487-a7c48f13288e';
  const listing=`<article class="game-card-row"><p class="game-card-league">WNBA</p><time datetime="${new Date(tipoff).toISOString()}"></time><span class="game-card-team" title="Las Vegas Aces"></span><span class="game-card-team" title="Golden State Valkyries"></span><a class="game-card-open-link" href="${link}">English</a></article>`;
  const streamResult=parseListings(streamcenter,listing,tipoff);
  assert.equal(streamResult.outcome,'parsed');
  assert.equal(streamResult.observations.length,1);
  assert.equal(streamResult.observations[0].league,'wnba');
  assert.deepEqual(matchObservation(streamResult.observations[0],[wnba],tipoff),{kind:'matched',gameId:wnba.id});
  assert.equal(compatiblePlayers(wnba.id,streamResult.observations[0],'<html></html>').length,0);
});

test('TVApp football scope rejects basketball while an unknown source keeps both sports ambiguous',()=>{
  const source=SOURCES.find(item=>item.id==='tvapp');
  assert.ok(source);
  const basketball=parseScoreboard(scoreboard('401999900','Duke Blue Devils','North Carolina Tar Heels'),'nba')[0];
  const football=parseScoreboard(scoreboard('401999901','Duke Blue Devils','North Carolina Tar Heels',tipoff,'150','153'),'ncaaf')[0];
  const result=parseListings(source,JSON.stringify([{
    id:'duke-vs-north-carolina-12345',title:'Duke Blue Devils vs North Carolina Tar Heels',
    category:'american-football',date:tipoff,
    teams:{away:{name:'Duke Blue Devils'},home:{name:'North Carolina Tar Heels'}},
  }]),tipoff);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  const observation=result.observations[0];
  assert.equal(observation.league,null);
  const evidence={undated:'none' as const,externalGameId:null};
  assert.deepEqual(createSourceEventMatcher([basketball])(observation,evidence,tipoff).match,
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  assert.deepEqual(createSourceEventMatcher([basketball,football])(observation,evidence,tipoff).match,
    {kind:'matched',gameId:football.id});
  assert.deepEqual(createSourceEventMatcher([basketball,football])({...observation,sourceId:'fixture'},evidence,tipoff).match,
    {kind:'unmatched',reason:'ambiguous-matchup',possibleGameIds:[basketball.id,football.id]});
});

test('TVApp basketball rows cannot attach to college football games with the same team names',()=>{
  const source=SOURCES.find(item=>item.id==='tvapp-nba');
  assert.ok(source);
  const basketball=parseScoreboard(scoreboard('401920982','Notre Dame Fighting Irish','Villanova Wildcats',Date.parse('2026-11-01T14:30:00Z')),'nba')[0];
  const collegeFootball=parseScoreboard(scoreboard('401920982','Notre Dame Fighting Irish','Villanova Wildcats',Date.parse('2026-11-01T14:30:00Z')),'ncaaf')[0];
  const result=parseListings(source,JSON.stringify([{
    id:'notre-dame-vs-villanova-2612957',title:'Notre Dame Fighting Irish vs Villanova Wildcats',category:'basketball',
    date:Date.parse('2026-11-01T14:30:00Z'),teams:{away:{name:'Notre Dame Fighting Irish'},home:{name:'Villanova Wildcats'}},
  }]),Date.parse('2026-11-01T14:30:00Z'));
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations[0].league,null);
  assert.deepEqual(createSourceEventMatcher([collegeFootball,basketball])(result.observations[0],
    {undated:'none',externalGameId:null},Date.parse('2026-11-01T14:30:00Z')).match,{kind:'matched',gameId:basketball.id});
});
