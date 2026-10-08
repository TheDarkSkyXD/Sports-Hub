import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCES, SourceFetchError, compatiblePlayers, enrichObservation, parseKickoff, parseListings, readHtml } from '../lib/football/adapters/sources.ts';
import { PartialListingReadError } from '../lib/football/domain/ports.ts';
import { SCHEDULES, readSchedule, readSeasonMembership } from '../lib/football/adapters/schedule.ts';
import { matchObservation, mergeSchedulePartitions } from '../lib/football/domain/matching.ts';
import { parseScoreboard } from '../lib/sunday.ts';
import { GameSchema, ScheduleGameSchema, SessionSchema } from '../lib/football/shared.ts';
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
  assert.deepEqual(compatiblePlayers('ncaaf-1',enriched,'<iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe>')
    .map(player => player.locator.provider === 'gooz' ? player.locator.playerId : null),['57069']);
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

test('rich college schedule rows retain both full team names and UTC kickoff', () => {
  for (const id of ['methstreams','crackstreams-st']) {
    const source = SOURCES.find(item => item.id === id);
    assert.ok(source);
    const html = `<section class="lg" id="college-football-live"><article class="ev-match" data-start="1790438400">
      <a href="/event/brown-vs-harvard"><div class="ev-side"><span class="nm-l">Brown Bears</span></div>
      <div class="ev-side"><span class="nm-l">Harvard Crimson</span></div>Live Watch</a></article></section>`;
    const result = parseListings(source,html,now);
    assert.equal(result.observations.length,1);
    assert.deepEqual(result.observations[0].teams,['Brown Bears','Harvard Crimson']);
    assert.equal(result.observations[0].league,'ncaaf');
    assert.equal(result.observations[0].kickoff,now);
    assert.equal(matchObservation(result.observations[0],[game('ncaaf-1',team('espn:ncaaf:108','Harvard Crimson'),team('espn:ncaaf:225','Brown Bears'))],now).kind,'matched');
  }
});

test('Buffstream upgrades published CFB team links while retaining uncertain kickoff', () => {
  const source = SOURCES.find(item => item.id === 'buffstream-cfb');
  assert.ok(source);
  const result = parseListings(source,`<table><tr><td>10:30 pm ET</td>
    <td><a href="http://ms.buffstream.io/cfb-streams/montana-state-live-stream">Montana State Live Stream</a></td>
    <td><a href="http://ms.buffstream.io/cfb-streams/idaho-live-stream">Idaho Live Stream</a></td></tr></table>`,now);
  assert.equal(result.observations.length,2);
  assert.ok(result.observations.every(item => item.url.startsWith('https://ms.buffstream.io/')));
  assert.deepEqual(result.observations[0].teams,['Montana State','Idaho']);
  assert.equal(result.observations[0].kickoff,null);
  for (const url of ['http://ms.buffstream.io.evil.test/cfb-streams/idaho-live-stream',
    'http://user@ms.buffstream.io/cfb-streams/idaho-live-stream',
    'http://ms.buffstream.io:8080/cfb-streams/idaho-live-stream',
    'http://ms.buffstream.io/cfb-streams/idaho-live-stream?paid=true',
    'http://ms.buffstream.io/other/idaho-live-stream']) {
    assert.equal(parseListings(source,`<a href="${url}">Idaho vs Montana State</a>`,now).observations.length,0);
  }
});

test('all published VIP-family routes survive while unrelated routes do not', () => {
  const cases = [
    ['vipbox-cfb','https://vipbox.fm/onair/ncaaf/montana-state-vs-idaho', (n:number)=>`/live/ncaaf/montana-state-vs-idaho-${n}`],
    ['vipboxtv-cfb','https://www.vipboxtv.sk/cfb/montana-state-vs-idaho-stream-live',(n:number)=>`/cfb/${n}/stream-montana-state-vs-idaho-live`],
    ['strikeout-cfb','https://strikeout.im/college-football/stream-montana-state-vs-idaho-live',(n:number)=>`/college-football/${n}/montana-state-vs-idaho-stream`],
  ] as const;
  for (const [sourceId,url,server] of cases) {
    const observed = {...observation(['Montana State','Idaho']),sourceId,url};
    const title = sourceId === 'vipbox-cfb' ? 'Montana State vs Idaho Streaming Online' :
      sourceId === 'vipboxtv-cfb' ? 'Watch Montana State vs Idaho Online' : 'Live Montana State vs. Idaho Streams Online';
    const metadata = `<meta property="og:url" content="${url}"><script>const siteConfig = {"loaded_page":"stream","event_start_ts":1790438400};</script>`;
    const controls = [1,2,3,4,5,1].map(n=>`<button data-uri="${server(n)}">Stream ${n}</button>`).join('') +
      `<button data-uri="${server(6)}">Premium Stream</button><div class="paid"><button data-uri="${server(7)}">Stream 7</button></div>` +
      `<button data-uri="${server(8)}" data-premium="true">Stream 8</button>` +
      `<button data-uri="${server(9).replace('montana-state','other-team')}">Stream 9</button>` +
      '<button data-uri="https://evil.test/player">Stream 10</button>';
    const detail = `${metadata}<body><h1>${title}</h1>${controls}<footer>freely available online</footer></body>`;
    const players = compatiblePlayers('ncaaf-401868094',observed,detail);
    assert.equal(players.length,8);
    assert.equal(new Set(players.map(player=>player.id)).size,8);
    assert.deepEqual(players.map(player=>player.locator.provider === 'event-page' ? player.locator.serverUrl : null),
      [1,2,3,4,5,6,7,8].map(n=>new URL(server(n),url).href));
    assert.deepEqual(compatiblePlayers('ncaaf-401868094',observed,detail),players);
    assert.notEqual(compatiblePlayers('ncaaf-other',observed,detail)[0].id,players[0].id);
    assert.deepEqual(compatiblePlayers('ncaaf-401868094',observed,detail.replace('freely available online','subscription required')),players);
    for (const invalid of [detail.replace('"loaded_page":"stream"','"loaded_page":"schedule"'),
      detail.replace('1790438400','1790524800'),detail.replace(metadata,''),
      detail.replace(`content="${url}"`,'content="https://evil.test/event"'),
      detail.replace(`<h1>${title}</h1>`,`<h1>${title.replace('Idaho','Other Team')}</h1>`)]) {
      assert.deepEqual(compatiblePlayers('ncaaf-401868094',observed,invalid),[]);
    }
    const mixed = `${detail}<iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe>` +
      '<div class="paid"><iframe src="https://gooz.aapmains.net/new-stream-embed/57070"></iframe></div>';
    assert.deepEqual(compatiblePlayers('ncaaf-401868094',observed,mixed).map(player=>player.id),
      [...players.map(player=>player.id),'gooz-57069','gooz-57070']);
  }
});

test('VIP-family NFL pages retain every published Gooz route for media checks',()=>{
  const observed = {...observation(['Buffalo Bills','Miami Dolphins']),league:'nfl' as const,sourceId:'strikeout-nfl',
    url:'https://strikeout.im/nfl/stream-buffalo-bills-vs-miami-dolphins-live'};
  const detail = '<iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe>' +
    '<div data-access="premium"><iframe src="https://gooz.aapmains.net/new-stream-embed/57070"></iframe></div>' +
    '<button onclick="changeStream(57071)">Paid server</button><script>changeStream(57070)</script>';
  assert.deepEqual(compatiblePlayers('nfl-1',observed,detail).map(player=>player.id),['gooz-57069','gooz-57070','gooz-57071']);
});

test('PPV retains all exact routes while rejecting wrong-game records', () => {
  const parent = {id:29554,name:'Notre Dame Fighting Irish at North Carolina Tar Heels',tag:'College Football',
    uri_name:'cfb/2026-10-03/nd-unc',starts_at:now/1000,source_tag:'ESPN',
    iframe:'https://embedindia.st/embed/cfb/2026-10-03/nd-unc'};
  const backup = {...parent,id:29555,source_tag:'SkyCast',uri_name:`${parent.uri_name}/skycast`,iframe:`${parent.iframe}/skycast`};
  const observed = {...observation(['Notre Dame Fighting Irish','North Carolina Tar Heels']),sourceId:'ppv',
    url:`https://ppv.st/live/${parent.uri_name}`};
  const players = compatiblePlayers('ncaaf-1',observed,JSON.stringify({...parent,substreams:[backup,backup]}));
  assert.deepEqual(players.map(player=>player.label),['PPV · ESPN','PPV · SkyCast']);
  assert.equal(new Set(players.map(player=>player.id)).size,2);
  assert.deepEqual(compatiblePlayers('ncaaf-1',observed,JSON.stringify({...parent,paid:true,substreams:[backup]})),players);
  assert.deepEqual(compatiblePlayers('ncaaf-1',{...observed,kickoff:now+86400000},JSON.stringify(parent)),[]);
  for (const invalid of [{...backup,paid:true},{...backup,premium:true},{...backup,name:'Other teams'},
    {...backup,tag:'NFL'},{...backup,source_tag:'Pro'},{...backup,iframe:'https://evil.test/embed'},
    {...backup,iframe:backup.iframe.replace('nd-unc','other-game')},{...backup,iframe:undefined}]) {
    assert.equal(compatiblePlayers('ncaaf-1',observed,JSON.stringify({...parent,substreams:[invalid]})).length,
      invalid.paid||invalid.premium||invalid.source_tag==='Pro'?2:1);
  }
  assert.deepEqual(compatiblePlayers('ncaaf-1',observed,JSON.stringify({...parent,iframe:undefined})),[]);
});

test('catalog detail collection selects the exact PPV parent and preserves API game dates', async () => {
  const original = globalThis.fetch;
  const parent = {id:29554,name:'Notre Dame at North Carolina',tag:'College Football',uri_name:'cfb/2026-10-03/nd-unc',starts_at:now/1000};
  const observed = {...observation(['Notre Dame','North Carolina']),sourceId:'ppv',url:`https://ppv.st/live/${parent.uri_name}`};
  const requests:string[] = [];
  globalThis.fetch = async input => {requests.push(String(input)); return Response.json({success:true,
    streams:[{category:'American Football',streams:[parent,{...parent,id:2,uri_name:'cfb/2026-10-03/other-game'}]}]});};
  try {
    assert.deepEqual(JSON.parse(await readHtml(observed.url,new AbortController().signal)),parent);
    assert.deepEqual(requests,['https://api.ppv.st/api/streams']);
    await assert.rejects(readHtml('https://ppv.st/live/cfb/2026-10-03/missing',new AbortController().signal),/parser-changed/);
  } finally {globalThis.fetch = original;}
  for (const sourceId of ['ppv','tvapp']) {
    const catalogObservation = {...observed,sourceId};
    assert.deepEqual(enrichObservation(catalogObservation,'<time datetime="2026-10-04T16:00:00Z"></time>'),catalogObservation);
  }
  assert.deepEqual(compatiblePlayers('ncaaf-1',{...observed,sourceId:'tvapp'},'<main>Stream will be available shortly...</main>'),[]);
});

test('known empty schedules differ from unsupported pages and parser changes', () => {
  const unsupported = {id:'unknown-fixture',url:'https://unknown.example/list',family:'unknown'};
  const nflstreams = SOURCES.find(item => item.id === 'nflstreams');
  const buff = SOURCES.find(item => item.id === 'buffstream-nfl');
  assert.ok(nflstreams && buff);
  assert.equal(parseListings(unsupported,'<body><h2>NFL Schedule Update</h2>No matches available right now.</body>',now).outcome,'empty');
  assert.equal(parseListings(unsupported,'<body><h2>NFL Schedule Update</h2></body>',now).outcome,'unsupported');
  assert.equal(parseListings(nflstreams,'<body><h2>NFL Schedule Update</h2></body>',now).outcome,'parser-changed');
  assert.equal(parseListings(buff,'<body><h2>NFL Schedule Update</h2></body>',now).outcome,'parser-changed');
});

test('shared TVApp catalog keeps dated match identities without treating mirror labels as leagues', () => {
  const source = SOURCES.find(item => item.id === 'tvapp');
  assert.ok(source);
  const row = {id:'south-alabama-kentucky-1681',title:'South Alabama Jaguars - Kentucky Wildcats',category:'american-football',date:now,
    teams:{home:{name:'South Alabama Jaguars'},away:{name:'Kentucky Wildcats'}},sources:[{source:'admin',id:'one'}]};
  const result = parseListings(source,JSON.stringify([row,row,
    {id:'ppv-nfl-network',title:'NFL Network',category:'american-football',date:0}]),now);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  assert.deepEqual(result.observations[0].teams,['South Alabama Jaguars','Kentucky Wildcats']);
  assert.equal(result.observations[0].league,null);
  assert.equal(result.observations[0].kickoff,now);
  assert.equal(result.observations[0].url,'https://tvapp1.pk/watch/1681');
  assert.equal(parseListings(source,'[]',now).outcome,'empty');
  assert.equal(parseListings(source,JSON.stringify([row,{...row,date:now+60000}]),now).outcome,'parser-changed');
  assert.equal(parseListings(source,'[{"title":"missing date"}]',now).outcome,'parser-changed');
  const aliases = parseListings(source,JSON.stringify([{...row,id:'utah-state-troy-1739',
    title:'Utah State Aggies vs Troy Trojans',teams:{home:{name:'Utah State'},away:{name:'Troy'}},date:now-5*3600000}]),now);
  assert.equal(aliases.outcome,'parsed');
  assert.deepEqual(aliases.observations[0].teams,['Utah State Aggies','Troy Trojans']);
  assert.equal(aliases.observations[0].kickoff,now-5*3600000);
  const contradictory = parseListings(source,JSON.stringify([{...row,id:'conflicting-1740',
    title:'Ole Miss Rebels vs Florida Gators',teams:{home:{name:'Houston Cougars'},away:{name:'Georgia Southern Eagles'}}}]),now);
  assert.equal(contradictory.outcome,'parsed');
  assert.equal(contradictory.observations[0].teams,null);
});

test('PPV catalog admits college and NFL games, excludes CFL and channels, and inherits parent kickoff', () => {
  const source = SOURCES.find(item => item.id === 'ppv');
  assert.ok(source);
  const event = {id:29446,name:'Ole Miss Rebels at Florida Gators',tag:'College Football',uri_name:'cfb/2026-09-26/miss-fla',starts_at:now/1000,
    substreams:[{id:29447,name:'SkyCast',starts_at:0}]};
  const result = parseListings(source,JSON.stringify({success:true,streams:[{category:'American Football',streams:[
    event,{...event,id:29128,name:'Los Angeles Chargers at Buffalo Bills',tag:'NFL',uri_name:'nfl/2026-09-26/lac-buf'},
    {...event,id:29157,tag:'Canadian Football',uri_name:'cfl/2026-09-26/cgy-ott'},
    {...event,id:18172,tag:'24/7 channel',uri_name:'nfl-network',starts_at:0},
  ]}]}),now);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,2);
  assert.deepEqual(result.observations.map(item => item.league),['ncaaf','nfl']);
  assert.deepEqual(result.observations[0].teams,['Florida Gators','Ole Miss Rebels']);
  assert.equal(result.observations[0].kickoff,now);
  assert.equal(result.observations[0].url,'https://ppv.st/live/cfb/2026-09-26/miss-fla');
  assert.equal(parseListings(source,JSON.stringify({success:true,streams:[{category:'American Football',streams:[{...event,starts_at:0}]}]}),now).outcome,'empty');
});

test('Streamcenter published game cards create exact ESPN-bound source locators',()=>{
  const source=SOURCES.find(item=>item.id==='streamcenter');
  assert.ok(source);
  const link='/api/stream-link/iframe/event-espn-league-football-college-football-401856699/aef974e2-5ef2-412c-b65e-e6905af1edfa';
  const html=`<article class="game-card-row"><p class="game-card-league">NCAA Football</p>
    <time dateTime="2026-09-26T19:30:00.000Z"></time>
    <span class="game-card-team" title="Ole Miss Rebels"></span><span class="game-card-team" title="Florida Gators"></span>
    <a class="game-card-open-link" href="${link}">English</a></article>
    <article class="game-card-row"><a class="game-card-open-link" href="/api/stream-link/iframe/custom-channel/abc">Channel</a></article>`;
  const result=parseListings(source,html,now);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  assert.deepEqual(result.observations[0].teams,['Ole Miss Rebels','Florida Gators']);
  assert.equal(result.observations[0].kickoff,Date.parse('2026-09-26T19:30:00.000Z'));
  assert.equal(result.observations[0].url,`https://streamcenter.st${link}`);
  const detail='<iframe src="//streame.center/embed/hls.php?stream=lmdsjkfgv52"></iframe>';
  const candidates=compatiblePlayers('ncaaf-401856699',result.observations[0],detail);
  assert.equal(candidates.length,1);
  assert.deepEqual(candidates[0].locator,{provider:'streamcenter',eventId:'401856699',linkId:'aef974e2-5ef2-412c-b65e-e6905af1edfa'});
  assert.deepEqual(compatiblePlayers('ncaaf-401856700',result.observations[0],detail),[]);
  assert.deepEqual(compatiblePlayers('ncaaf-401856699',result.observations[0],'<iframe src="https://attacker.test/embed/hls.php?stream=lmdsjkfgv52"></iframe>'),[]);
  assert.equal(compatiblePlayers('ncaaf-401856699',result.observations[0],
    '<iframe src="//streame.center/embed/hls2.php?stream=jkhfsgqghjqsd85"></iframe>').length,1);
});

test('matching rejects ambiguous aliases, stale rows, uncertain times, and final games', () => {
  const pit = game('ncaaf-1',team('espn:ncaaf:221','Pittsburgh Panthers','Pitt'),team('espn:ncaaf:2083','Bucknell Bison','Bucknell'));
  assert.deepEqual(matchObservation(observation(['Bucknell','Pitt']),[pit],now),{kind:'matched',gameId:pit.id});
  assert.equal(matchObservation(observation(['Bucknell','Pitt'],null),[pit],now).kind,'unmatched');
  assert.equal(matchObservation({...observation(['Bucknell','Pitt']),observedAt:now-31*60_000},[pit],now).kind,'unmatched');
  assert.deepEqual(matchObservation(observation(['Bucknell','Pitt']),[{...pit,status:'post',lifecycle:'final',finalObservedAt:now,graceEndsAt:now+300000}],now),{kind:'unmatched',reason:'finished-game',possibleGameIds:[pit.id]});
  const ohio = game('ncaaf-2',team('miami-oh','Miami RedHawks','Miami'),team('uconn','UConn Huskies','UConn'));
  const florida = game('ncaaf-3',team('miami-fl','Miami Hurricanes','Miami'),team('central','Central Michigan Chippewas','Central Michigan'));
  assert.deepEqual(matchObservation(observation(['UConn','Miami']),[ohio,florida],now),{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});

test('North Dakota historical name resolves only its ESPN team and verified kickoff', () => {
  const event = (id: string, teamId: string, name: string, short: string) => ({
    id,date:'2026-09-26T17:00:00Z',status:{type:{state:'pre',name:'STATUS_SCHEDULED'}},competitions:[{competitors:[
      {homeAway:'home',team:{id:teamId,displayName:name,shortDisplayName:short,abbreviation:teamId === '155' ? 'UND' : 'NDSU'}},
      {homeAway:'away',team:{id:'282',displayName:'Indiana State Sycamores',shortDisplayName:'Indiana State',abbreviation:'INST'}},
    ]}],
  });
  const [northDakota, northDakotaState] = parseScoreboard({events:[
    event('401867858','155','North Dakota Fighting Hawks','North Dakota'),
    event('401867859','2449','North Dakota State Bison','North Dakota State'),
  ]},'ncaaf');
  assert.equal(northDakota.home.id,'espn:ncaaf:155');
  assert.equal(northDakota.home.name,'North Dakota Fighting Hawks');
  assert.equal(northDakota.home.short,'North Dakota');
  assert.equal(northDakota.home.abbreviation,'UND');
  assert.deepEqual(matchObservation(observation(['Indiana State Sycamores','North Dakota Fighting Sioux'],null),[northDakota,northDakotaState],now),
    {kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:['ncaaf-401867858']});
  assert.deepEqual(matchObservation(observation(['North Dakota Fighting Sioux','Indiana State Sycamores'],Date.parse('2026-09-26T17:00:00Z')),[northDakota,northDakotaState],now),
    {kind:'matched',gameId:'ncaaf-401867858'});
  assert.deepEqual(matchObservation(observation(['Indiana State Sycamores','North Dakota Fighting Sioux'],Date.parse('2026-09-27T17:00:00Z')),[northDakota,northDakotaState],now),
    {kind:'unmatched',reason:'conflicting-date',possibleGameIds:['ncaaf-401867858']});
  assert.deepEqual(matchObservation(observation(['Indiana State Sycamores','North Dakota Fighting Sioux'],Date.parse('2026-09-26T17:00:00Z')),[northDakotaState],now),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  const [otherId] = parseScoreboard({events:[event('401867860','9999','North Dakota Fighting Hawks','North Dakota')]},'ncaaf');
  assert.deepEqual(matchObservation(observation(['Indiana State Sycamores','North Dakota Fighting Sioux'],Date.parse('2026-09-26T17:00:00Z')),[otherId],now),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
  const [nfl] = parseScoreboard({events:[event('401867861','155','North Dakota Fighting Hawks','North Dakota')]},'nfl');
  assert.equal(nfl.home.aliases?.includes('North Dakota Fighting Sioux'),false);
});

test('FBS and FCS crossover is one game with both partitions, conflicting IDs are quarantined', () => {
  const crossover = game('ncaaf-401858236',team('espn:ncaaf:221','Pittsburgh'),team('espn:ncaaf:2083','Bucknell'));
  assert.deepEqual(mergeSchedulePartitions([[{...crossover,partitions:['fbs']}],[{...crossover,partitions:['fcs']}]]).map(item => [item.id,item.partitions]),[[crossover.id,['fbs','fcs']]]);
  assert.deepEqual(mergeSchedulePartitions([[crossover],[{...crossover,home:team('wrong','Elsewhere')}]]),[]);
});

test('game and session states reject contradictory final and grace fields', () => {
  const scheduled = game('ncaaf-1',team('home','Home'),team('away','Away'));
  const rawFinal = {...scheduled,status:'post',lifecycle:'final'};
  assert.equal(ScheduleGameSchema.safeParse(rawFinal).success,true);
  assert.equal(GameSchema.safeParse(rawFinal).success,false);
  assert.equal(GameSchema.safeParse({...scheduled,finalObservedAt:now,graceEndsAt:now+300000}).success,false);
  assert.equal(GameSchema.safeParse({...rawFinal,finalObservedAt:now,graceEndsAt:now+300000}).success,true);
  assert.equal(GameSchema.safeParse({...rawFinal,sourceUrl:'/play/ncaaf-1',finalObservedAt:now,graceEndsAt:now+300000}).success,true);
  assert.equal(GameSchema.safeParse({...rawFinal,sourceUrls:['/play/ncaaf-1'],finalObservedAt:now,graceEndsAt:now+300000}).success,false);
  const session = {id:'1',gameId:'ncaaf-1',candidateId:'gooz-1',generation:0};
  assert.equal(SessionSchema.safeParse({...session,state:'active',graceEndsAt:now}).success,false);
  assert.equal(SessionSchema.safeParse({...session,state:'draining',graceEndsAt:null}).success,false);
  assert.equal(SessionSchema.safeParse({...session,state:'draining',graceEndsAt:now}).success,true);
});

test('Sportsurge collection includes matchups from both category pages under one source', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const url=String(input);
    const league=url.includes('/cfb/')?'cfb':'nfl';
    const teams=league==='cfb'?['Indiana Hoosiers','Purdue Boilermakers']:['Kansas City Chiefs','Buffalo Bills'];
    return new Response(`<html><body><a href="/watch/${league}/a-b/${league==='cfb'?'2':'1'}" datetime="2026-09-26T16:00:00Z">`+
      `<span class="team-name-event-row"><img alt="${teams[0]}"></span>`+
      `<span class="team-name-event-row"><img alt="${teams[1]}"></span></a></body></html>`);
  };
  try {
    const html = await readHtml(SOURCES[0].url,new AbortController().signal);
    assert.deepEqual(parseListings(SOURCES[0],html,now).observations.map(row=>[row.league,row.teams]),[
      ['nfl',['Kansas City Chiefs','Buffalo Bills']],['ncaaf',['Indiana Hoosiers','Purdue Boilermakers']]]);
  } finally { globalThis.fetch = original; }
});

test('Sportsurge partial category failure carries healthy listings and retry delay',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>String(input).includes('/nfl/')?
    new Response(null,{status:429,headers:{'Retry-After':'9'}}):
    new Response('<html><body><a href="/watch/cfb/indiana-purdue/2" datetime="2026-09-26T16:00:00Z">Indiana Hoosiers vs Purdue Boilermakers</a></body></html>');
  try {
    await assert.rejects(readHtml(SOURCES[0].url,new AbortController().signal),error=>{
      assert.ok(error instanceof PartialListingReadError);
      assert.equal(error.message,'http-429');
      assert.equal(error.retryAfterMs,9000);
      assert.deepEqual(parseListings(SOURCES[0],error.html,now).observations.map(row=>row.league),['ncaaf']);
      return true;
    });
  } finally {globalThis.fetch=original;}
});

test('Sportsurge reports a rate limit and the longest retry delay when both categories fail',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async input=>new Response(null,{status:String(input).includes('/nfl/')?429:503,
    headers:{'Retry-After':String(input).includes('/nfl/')?'9':'20'}});
  try {
    await assert.rejects(readHtml(SOURCES[0].url,new AbortController().signal),error=>
      error instanceof SourceFetchError&&error.message==='http-429'&&error.retryAfterMs===20_000);
  } finally {globalThis.fetch=original;}
});

test('Sportsurge discards partial results when its parent request is canceled',async()=>{
  const original=globalThis.fetch;
  const controller=new AbortController();
  globalThis.fetch=async input=>{
    if(String(input).includes('/nfl/')){
      controller.abort(new DOMException('Canceled','AbortError'));
      throw controller.signal.reason;
    }
    return new Response('<html><body><a href="/watch/cfb/indiana-purdue/2">Indiana vs Purdue</a></body></html>');
  };
  try {
    await assert.rejects(readHtml(SOURCES[0].url,controller.signal),error=>error instanceof DOMException&&error.name==='AbortError');
  } finally {globalThis.fetch=original;}
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
    const college = await Promise.all(SCHEDULES.filter(partition=>partition.league==='ncaaf').map(partition => readSchedule(partition,now,new AbortController().signal)));
    assert.equal(urls.filter(value => new URL(value).searchParams.get('groups') === '80').length,9);
    assert.equal(urls.filter(value => new URL(value).searchParams.get('groups') === '81').length,9);
    assert.ok(urls.every(value => /^\d{8}$/.test(new URL(value).searchParams.get('dates') || '')));
    assert.ok(urls.every(value => new URL(value).searchParams.get('limit') === '200'));
    assert.equal(new URL(urls[0]).searchParams.get('dates'),'20260926');
    assert.ok(urls.some(value=>new URL(value).searchParams.get('dates')==='20261003'));
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
