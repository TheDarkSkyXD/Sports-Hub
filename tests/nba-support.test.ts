import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';
import { SOURCES, compatiblePlayers, parseListings } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { provisionalLiveChannel, resolvedLiveChannelMatch } from '../lib/football/domain/live-channel.ts';
import { detailIdentity } from '../lib/football/domain/source-policy.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { parseScoreboard, validGameId } from '../lib/sunday.ts';

const tipoff = Date.parse('2026-10-08T02:00:00Z');
const teams = ['Golden State Warriors','Portland Trail Blazers'] as const;
const scoreboard = {events:[{
  id:'401914129',date:new Date(tipoff).toISOString(),name:`${teams[0]} at ${teams[1]}`,
  status:{type:{name:'STATUS_SCHEDULED',state:'pre',shortDetail:'10:00 PM ET'}},
  competitions:[{competitors:[
    {homeAway:'away',team:{id:'9',displayName:teams[0],shortDisplayName:'Warriors',abbreviation:'GS'}},
    {homeAway:'home',team:{id:'22',displayName:teams[1],shortDisplayName:'Trail Blazers',abbreviation:'POR'}},
  ]}],
}]};
const game = parseScoreboard(scoreboard,'nba')[0];

test('NBA schedule uses the basketball endpoint and a distinct ESPN game ID',async()=>{
  assert.equal(game.id,'nba-401914129');
  assert.equal(game.league,'nba');
  assert.equal(game.redzone,false);
  assert.equal(game.away.id,'espn:nba:9');
  assert.equal(validGameId(game.id),true);
  assert.equal(validGameId('nba-source-401914129'),false);
  const partition=SCHEDULES.find(source=>source.id==='nba');
  assert.ok(partition);
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);
    requested.push(url);
    return Response.json(new URL(url).searchParams.get('dates')==='20261008'?scoreboard:{events:[]});
  };
  try {
    const result=await readSchedule(partition,tipoff+60_000,new AbortController().signal);
    assert.deepEqual(result.games.map(item=>item.id),['nba-401914129']);
    assert.equal(result.league,'nba');
    assert.equal(requested.length,9);
    assert.ok(requested.every(url=>new URL(url).pathname==='/apis/site/v2/sports/basketball/nba/scoreboard'));
  } finally {globalThis.fetch=original;}
});

test('NBA TVApp listing skips its schedule row and matches the NBA game',()=>{
  const source=SOURCES.find(item=>item.id==='tvapp-nba');
  assert.ok(source);
  const body=JSON.stringify([
    {id:'nflstreams_live',title:'NFL Streams Schedule',category:'basketball',date:0},
    {id:'portland-trail-blazers-vs-golden-state-warriors-2601630',title:'Portland Trail Blazers vs Golden State Warriors',
      category:'basketball',date:tipoff,teams:{home:{name:teams[1]},away:{name:teams[0]}}},
  ]);
  const result=parseListings(source,body,tipoff);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].league,'nba');
  assert.deepEqual(matchObservation(result.observations[0],[game],tipoff),{kind:'matched',gameId:game.id});
});

test('NBA Streamcenter card and PPV basketball event retain league identity',()=>{
  const streamcenter=SOURCES.find(item=>item.id==='streamcenter-nba');
  const ppv=SOURCES.find(item=>item.id==='ppv');
  assert.ok(streamcenter&&ppv);
  const html=`<article class="game-card-row"><p class="game-card-league">NBA</p>
    <time datetime="${new Date(tipoff).toISOString()}"></time>
    <span class="game-card-team" title="${teams[0]}"></span><span class="game-card-team" title="${teams[1]}"></span>
    <a class="game-card-open-link" href="/api/stream-link/iframe/event-espn-league-basketball-nba-401914129/5566bee6-9708-490c-9e61-5c64d0b4b3c0">English</a></article>
    <article class="game-card-row"><p class="game-card-league">WNBA</p></article>`;
  const streamResult=parseListings(streamcenter,html,tipoff);
  assert.equal(streamResult.outcome,'parsed');
  assert.equal(streamResult.observations.length,1);
  assert.deepEqual(matchObservation(streamResult.observations[0],[game],tipoff),{kind:'matched',gameId:game.id});
  const ppvResult=parseListings(ppv,JSON.stringify({success:true,streams:[
    {category:'American Football',streams:[]},
    {category:'Basketball',streams:[
      {id:37,name:'Golden State Warriors vs Portland Trail Blazers',tag:'NBA',uri_name:'nba/2026-10-07/gs-por',starts_at:tipoff/1000},
      {id:38,name:'Las Vegas Aces vs Golden State Valkyries',tag:'WNBA',uri_name:'wnba/2026-10-07/lv-gs',starts_at:tipoff/1000},
    ]},
  ]}),tipoff);
  assert.equal(ppvResult.outcome,'parsed');
  assert.equal(ppvResult.observations.length,1);
  assert.deepEqual(matchObservation(ppvResult.observations[0],[game],tipoff),{kind:'matched',gameId:game.id});
});

test('NBA event page validators accept exact provider routes only',()=>{
  const event='https://ppv.st/live/nba/2026-10-07/gs-por';
  assert.equal(validEventPagePair(event,'https://embedindia.st/embed/nba/2026-10-07/gs-por'),true);
  assert.equal(validEventPagePair(event,'https://embedindia.st/embed/nfl/2026-10-07/gs-por'),false);
  const buff='https://ms.buffstream.io/nba-streams/golden-state-warriors-live-stream';
  assert.equal(validEventPagePair(buff,'https://embedsports.me/basketball/portland-trail-blazers-vs-golden-state-warriors-stream-2'),true);
  assert.equal(validEventPagePair(buff,'https://embedsports.me/american-football/portland-trail-blazers-vs-golden-state-warriors-stream-2'),false);
  const meth='https://methstreams.st/event/ppv-golden-state-warriors-vs-portland-trail-blazers';
  assert.equal(validEventPagePair(meth,'https://fxtrend.st/event/ppv-golden-state-warriors-vs-portland-trail-blazers/core/1'),true);
  assert.equal(validEventPagePair(meth,'https://fxtrend.st/event/ppv-celtics-vs-cavaliers/core/1'),false);
  const vip='https://vipbox.fm/onair/nba/portland-trail-blazers-vs-golden-state-warriors';
  assert.equal(validEventPagePair(vip,'https://vipbox.fm/live/nba/portland-trail-blazers-vs-golden-state-warriors-1'),true);
  assert.equal(validEventPagePair(vip,'https://vipbox.fm/live/nfl/portland-trail-blazers-vs-golden-state-warriors-1'),false);
  const strikeout='https://strikeout.im/nba/stream-portland-trail-blazers-vs-golden-state-warriors-live';
  assert.equal(validEventPagePair(strikeout,'https://strikeout.im/nba/1/portland-trail-blazers-vs-golden-state-warriors-stream'),true);
  assert.equal(validEventPagePair(strikeout,'https://strikeout.im/nfl/1/portland-trail-blazers-vs-golden-state-warriors-stream'),false);
});

test('legacy Sportsurge accepts its NBA preseason matchup and ignores WNBA',()=>{
  const source=SOURCES.find(item=>item.id==='sportsurge');
  assert.ok(source);
  const html=`<a href="/watch/nba-preseason/golden-state-warriors-portland-trail-blazers/445773332">
    <span class="team-name-event-row"><img alt="Golden State Warriors"></span>
    <span class="team-name-event-row"><img alt="Portland Trail Blazers"></span></a>
    <a href="/watch/wnba/las-vegas-aces-golden-state-valkyries/9999">WNBA</a>`;
  const result=parseListings(source,html,tipoff);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].league,'nba');
  assert.deepEqual(result.observations[0].teams,teams);
});

test('NBA Buffstream team channels require the matching clock and published basketball player',()=>{
  const source=SOURCES.find(item=>item.id==='buffstream-nba');
  assert.ok(source);
  const first='https://ms.buffstream.io/nba-streams/golden-state-warriors-live-stream';
  const second='https://ms.buffstream.io/nba-streams/portland-trail-blazers-live-stream';
  const listing=`<table><tr><td>10:00 pm ET</td><td>
    <a href="${first}">Golden State Warriors Live Stream</a>
    <a href="${second}">Portland Trail Blazers Live Stream</a></td></tr></table>`;
  const listed=parseListings(source,listing,tipoff);
  assert.equal(listed.outcome,'parsed');
  assert.equal(listed.observations.length,2);
  assert.deepEqual(listed.observations.map(item=>item.teams),[teams,teams]);
  const observation=listed.observations.find(item=>item.url===first);
  assert.ok(observation);
  const live={...game,lifecycle:'live' as const,status:'in' as const};
  const raw=matchObservation(observation,[live],tipoff);
  assert.deepEqual(raw,{kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:[game.id]});
  assert.equal(provisionalLiveChannel(observation,raw,[live],tipoff)?.id,game.id);
  assert.equal(provisionalLiveChannel({...observation,rawTime:'09:00 pm ET'},raw,[live],tipoff),null);
  const player='https://embedsports.me/basketball/portland-trail-blazers-vs-golden-state-warriors-stream-2';
  const html=`<link rel="canonical" href="${first}"><iframe src="${player}"></iframe>`;
  const players=compatiblePlayers(game.id,observation,html);
  assert.equal(players.length,1);
  assert.equal(compatiblePlayers(game.id,observation,html.replace(player,player.replace('basketball','american-football'))).length,0);
  const detail={outcome:'resolved' as const,observationId:observation.id,generation:'fixture',
    identity:detailIdentity(observation),at:tipoff,players,nextEligibleAt:tipoff+300_000};
  assert.deepEqual(resolvedLiveChannelMatch(observation,raw,[live],detail,tipoff),{kind:'matched',gameId:game.id});
});

test('NBA Buffstream discovery publishes both matched player choices',async()=>{
  const source=SOURCES.find(item=>item.id==='buffstream-nba');
  const schedule=SCHEDULES.find(item=>item.id==='nba');
  assert.ok(source&&schedule);
  const first='https://ms.buffstream.io/nba-streams/golden-state-warriors-live-stream';
  const second='https://ms.buffstream.io/nba-streams/portland-trail-blazers-live-stream';
  const listing=`<table><tr><td>10:00 pm ET</td><td>
    <a href="${first}">Golden State Warriors Live Stream</a>
    <a href="${second}">Portland Trail Blazers Live Stream</a></td></tr></table>`;
  const detail=(url:string)=>`<link rel="canonical" href="${url}"><iframe src="https://embedsports.me/basketball/portland-trail-blazers-vs-golden-state-warriors-stream-${url===first?2:1}"></iframe>`;
  const directory=mkdtempSync(join(tmpdir(),'nba-buffstream-'));
  const live={...game,lifecycle:'live' as const,status:'in' as const,partitions:['nba']};
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>tipoff+60_000,sources:[source],schedules:[schedule],
    readSchedule:async()=>({games:[live],league:'nba',at:tipoff+60_000}),
    readHtml:async url=>url===source.url?listing:detail(url),
    probeCandidate:async()=>({kind:'unavailable',reason:'upstream'}),
  });
  try {
    await coordinator.refresh();
    let reply=await coordinator.command({kind:'sources'});
    for(let attempt=0;attempt<80&&reply.kind==='sources'&&
      reply.snapshot.games.find(item=>item.gameId===game.id)?.candidates.length!==2;attempt++){
      await new Promise<void>(resolve=>setImmediate(resolve));
      reply=await coordinator.command({kind:'sources'});
    }
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      const row=reply.snapshot.games.find(item=>item.gameId===game.id);
      assert.equal(reply.snapshot.sources[0].matchedGameCount,1);
      assert.equal(row?.candidates.length,2);
      assert.ok(row?.candidates.every(candidate=>candidate.sourceIds.includes('buffstream-nba')));
    }
  } finally {await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
