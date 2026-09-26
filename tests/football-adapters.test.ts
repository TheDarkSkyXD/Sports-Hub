import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, SourceFetchError, compatiblePlayers, enrichObservation, parseKickoff, parseListings, readHtml } from '../lib/football/adapters/sources.ts';
import { SCHEDULES, readSchedule, readSeasonMembership } from '../lib/football/adapters/schedule.ts';
import { matchObservation, mergeSchedulePartitions } from '../lib/football/domain/matching.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const now = Date.parse('2026-09-26T16:00:00Z');
const team = (id: string, name: string, short = name) => ({id,name,short,abbreviation:name.slice(0,3),color:'112233',score:null,aliases:[name,short]});
const game = (id: string, home: Game['home'], away: Game['away'], league: Game['league'] = 'ncaaf'): Game =>
  ({id,league,name:`${away.name} at ${home.name}`,date:'2026-09-26T16:00:00Z',home,away,status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false});
const observation = (teams: [string,string], kickoff: number | null = now): Observation =>
  ({id:'source:event',sourceId:'source',url:'https://isportsurge.ws/watch/cfb/a-b/1',title:teams.join(' vs '),teams,league:'ncaaf',rawTime:'2026-09-26T16:00:00Z',kickoff,observedAt:now,parserVersion:1});

test('source times require explicit timezone evidence and handle DST and epochs', () => {
  assert.equal(parseKickoff('2026-09-26T16:00:00Z'),now);
  assert.equal(parseKickoff('2026-09-26T16:00:00.000Z'),now);
  assert.equal(parseKickoff('1790438400'),now);
  assert.equal(parseKickoff('1790438400000'),now);
  assert.equal(parseKickoff('2026-09-26T16:00'),null);
  assert.equal(parseKickoff('2026-09-25, Friday - 04:00 pm ET'),Date.parse('2026-09-25T20:00:00Z'));
  assert.equal(parseKickoff('2026-01-10 04:00 pm ET'),Date.parse('2026-01-10T21:00:00Z'));
  assert.equal(parseKickoff('2026-11-01 01:30 ET'),null);
});

test('source HTTP backoff honors Retry-After without exposing the URL',async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null,{status:429,headers:{'Retry-After':'5'}});
  try {
    await assert.rejects(readHtml(SOURCES[1].url,new AbortController().signal),error =>
      error instanceof SourceFetchError && error.message === 'http-429' && error.retryAfterMs === 5000);
  } finally { globalThis.fetch = original; }
});

test('CrackStreams separates the matchup from its published ET time', () => {
  const source = SOURCES.find(item => item.id === 'crackstreams-cfb');
  assert.ok(source);
  const html = '<a href="https://ms.buffstream.io/cfb-streams/army-west-point-live-stream">Army West Point vs Temple2026-09-25, Friday - 04:00 pm ET</a>';
  const result = parseListings(source,html,now);
  assert.equal(result.outcome,'parsed');
  assert.deepEqual(result.observations[0].teams,['Army West Point','Temple']);
  assert.equal(result.observations[0].kickoff,Date.parse('2026-09-25T20:00:00Z'));
});

test('Sportsurge category navigation is not an event and detail time can resolve a game', () => {
  const source = SOURCES[0];
  const html = '<a href="/nfl/livestreams3">NFL</a><a href="/cfb/livestreams2">NCAAF</a>' +
    '<a href="/watch/cfb/brown-harvard/397359440"><span class="team-name-event-row"><img alt="Brown Bears"></span><span class="team-name-event-row"><img alt="Harvard Crimson"></span></a>';
  const result = parseListings(source,html,now);
  assert.equal(result.observations.length,1);
  assert.deepEqual(result.observations[0].teams,['Brown Bears','Harvard Crimson']);
  const enriched = enrichObservation(result.observations[0],'<body><time>2026-09-25 22:30ET</time><iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe></body>');
  assert.equal(enriched.kickoff,Date.parse('2026-09-26T02:30:00Z'));
  assert.deepEqual(compatiblePlayers('ncaaf-1',enriched,'<iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe>',now).map(player => player.playerId),['57069']);
});

test('event pages use machine timestamps and duplicate controls produce one observation', () => {
  const source = SOURCES.find(item => item.id === 'methstreams');
  assert.ok(source);
  const html = '<article data-start="1790438400"><a href="/event/m-brown-vs-harvard">Brown vs HarvardLiveWatch→</a><a href="/event/m-brown-vs-harvard">Watch</a></article>';
  const result = parseListings(source,html,now);
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].kickoff,now);
  assert.deepEqual(result.observations[0].teams,['Brown','Harvard']);
  assert.equal(result.observations[0].league,null);
});

test('known empty schedules differ from unsupported pages and parser changes', () => {
  const hunter = SOURCES.find(item => item.id === 'nflhunter');
  const buff = SOURCES.find(item => item.id === 'buffstream-nfl');
  assert.ok(hunter && buff);
  assert.equal(parseListings(hunter,'<body><h2>NFL Schedule Update</h2>No matches available right now.</body>',now).outcome,'empty');
  assert.equal(parseListings(hunter,'<body><h2>NFL Schedule Update</h2></body>',now).outcome,'unsupported');
  assert.equal(parseListings(buff,'<body><h2>NFL Schedule Update</h2></body>',now).outcome,'parser-changed');
});

test('matching rejects ambiguous aliases, stale rows, uncertain times, and final games', () => {
  const pit = game('ncaaf-1',team('pitt','Pittsburgh Panthers','Pitt'),team('buck','Bucknell Bison','Bucknell'));
  assert.deepEqual(matchObservation(observation(['Bucknell','Pitt']),[pit],now),{kind:'matched',gameId:pit.id});
  assert.equal(matchObservation(observation(['Bucknell','Pitt'],null),[pit],now).kind,'unmatched');
  assert.equal(matchObservation({...observation(['Bucknell','Pitt']),observedAt:now-31*60_000},[pit],now).kind,'unmatched');
  assert.deepEqual(matchObservation(observation(['Bucknell','Pitt']),[{...pit,lifecycle:'final'}],now),{kind:'unmatched',reason:'finished-game',possibleGameIds:[pit.id]});
  const ohio = game('ncaaf-2',team('miami-oh','Miami RedHawks','Miami'),team('uconn','UConn Huskies','UConn'));
  const florida = game('ncaaf-3',team('miami-fl','Miami Hurricanes','Miami'),team('central','Central Michigan Chippewas','Central Michigan'));
  assert.deepEqual(matchObservation(observation(['UConn','Miami']),[ohio,florida],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});

test('FBS and FCS crossover is one game with both partitions, conflicting IDs are quarantined', () => {
  const crossover = game('ncaaf-401858236',team('espn:ncaaf:221','Pittsburgh'),team('espn:ncaaf:2083','Bucknell'));
  assert.deepEqual(mergeSchedulePartitions([[{...crossover,partitions:['fbs']}],[{...crossover,partitions:['fcs']}]]).map(item => [item.id,item.partitions]),[[crossover.id,['fbs','fcs']]]);
  assert.deepEqual(mergeSchedulePartitions([[crossover],[{...crossover,home:team('wrong','Elsewhere')}]]),[]);
});

test('Sportsurge collection visits both categories sequentially under its one source identity', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async input => {
    urls.push(String(input));
    return new Response('<html><body><a href="/watch/nfl/a-b/1">A vs B</a></body></html>',{headers:{'Content-Type':'text/html'}});
  };
  try {
    const html = await readHtml(SOURCES[0].url,new AbortController().signal);
    assert.deepEqual(urls,['https://isportsurge.ws/index6','https://isportsurge.ws/nfl/livestreams3','https://isportsurge.ws/cfb/livestreams2']);
    assert.equal(parseListings(SOURCES[0],html,now).observations.length,1);
  } finally { globalThis.fetch = original; }
});

test('schedule requests both college groups and rejects partial event parsing', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const event = {id:'401858236',date:'2026-09-26T16:00:00Z',competitions:[{competitors:[
    {homeAway:'home',team:{id:'221',displayName:'Pittsburgh'}},
    {homeAway:'away',team:{id:'2083',displayName:'Bucknell'}},
  ]}]};
  globalThis.fetch = async input => {
    urls.push(String(input));
    return Response.json({events:[event],week:{number:4}});
  };
  try {
    const college = await Promise.all(SCHEDULES.slice(1).map(partition => readSchedule(partition,now,new AbortController().signal)));
    assert.equal(urls.filter(value => new URL(value).searchParams.get('groups') === '80').length,9);
    assert.equal(urls.filter(value => new URL(value).searchParams.get('groups') === '81').length,9);
    assert.ok(urls.every(value => /^\d{8}$/.test(new URL(value).searchParams.get('dates') || '')));
    assert.ok(urls.every(value => new URL(value).searchParams.get('limit') === '200'));
    assert.equal(new URL(urls[0]).searchParams.get('dates'),'20260925');
    assert.equal(new URL(urls[16]).searchParams.get('dates'),'20261003');
    assert.deepEqual(mergeSchedulePartitions(college.map(result => result.games))[0].partitions,['fbs','fcs']);
    globalThis.fetch = async () => Response.json({events:[event,{id:'broken'}]});
    await assert.rejects(readSchedule(SCHEDULES[1],now,new AbortController().signal),/schedule-incomplete-or-duplicate/);
  } finally { globalThis.fetch = original; }
});

test('season membership parses complete ESPN Core group refs and rejects overlap', async () => {
  const original = globalThis.fetch;
  const ref = (id: string) => ({'$ref':`http://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/2026/teams/${id}?lang=en&region=us`});
  globalThis.fetch = async input => Response.json({count:1,pageCount:1,pageIndex:1,items:[ref(String(input).includes('/groups/80/') ? '221' : '2083')]});
  try {
    const membership = await readSeasonMembership(2026,new AbortController().signal);
    assert.deepEqual(membership.teams,{'221':'fbs','2083':'fcs'});
    globalThis.fetch = async () => Response.json({count:1,pageCount:1,pageIndex:1,items:[ref('221')]});
    await assert.rejects(readSeasonMembership(2026,new AbortController().signal),/membership-overlapping-groups/);
    globalThis.fetch = async () => Response.json({count:2,pageCount:1,pageIndex:1,items:[ref('221')]});
    await assert.rejects(readSeasonMembership(2026,new AbortController().signal),/membership-incomplete/);
  } finally { globalThis.fetch = original; }
});
