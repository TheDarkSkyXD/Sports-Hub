import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const currentRoot = resolve(here, '..');
const goldenPath = join(here, 'fixtures', 'collector-parity.json');
const args = process.argv.slice(2);
const baselineFlag = args.indexOf('--baseline');
if (args.length && (baselineFlag !== 0 || args.length !== 2)) {
  throw new Error('Usage: node --experimental-strip-types tests/record-collector-parity.mjs [--baseline PATH]');
}
const recording = baselineFlag === 0;
const root = recording ? resolve(args[1]) : currentRoot;
if (!isAbsolute(root)) throw new Error('Expected an absolute repository path');
if (recording) {
  assert.match(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}),/^27abd3a/);
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}),'', 'Baseline worktree must be clean');
}
const at = Date.parse('2026-10-08T21:10:00Z');
const runId = '11111111-1111-4111-8111-111111111111';
const sha = value => createHash('sha256').update(value).digest('hex');
const file = path => readFileSync(join(root, path), 'utf8');
const fixture = name => file(`tests/fixtures/${name}`);
const stable = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map ? [...item] : item));
const requireFromRoot = createRequire(join(root, 'package.json'));
const sources = await import(pathToFileURL(join(root, 'lib/football/adapters/sources.ts')).href);
const surge = requireFromRoot('./desktop/sportsurge-catalog.cjs');
const east = requireFromRoot('./desktop/streameast-catalog.cjs');
const { runSportsurgeSweep } = requireFromRoot('./desktop/sportsurge-sweep.cjs');
const { runStreameastSweep } = requireFromRoot('./desktop/streameast-sweep.cjs');
const byId = id => {
  const found = sources.SOURCES.find(source => source.id === id);
  assert.ok(found, `Missing source ${id}`);
  return found;
};

function inputs() {
  const tvappEvent = { id:'illinois-vs-purdue-2498915', title:'Illinois vs Purdue', category:'american-football',
    date:Date.parse('2026-10-03T19:30:00Z'), teams:{home:{name:'Illinois'},away:{name:'Purdue'}},
    sources:[{source:'delta',id:'live_cfb_illinois-purdue-live-streaming-663664065'}] };
  const tvappUrl = 'https://tvapp1.pk/watch/2498915';
  const tvappDetail = `<link rel="canonical" href="${tvappUrl}"><meta property="og:url" content="${tvappUrl}"><meta property="og:title" content="Illinois vs Purdue - Live Stream Free in HD | TheTVApp"><meta name="description" content="Watch Illinois vs Purdue live stream free in HD on TheTVApp. Multiple Premium stream sources available."><div id="player-frame"></div><script type="module" src="/_astro/_slug_.astro_astro_type_script_index_0_lang._mnRBTCV.js"></script>`;
  const liveCanonical = 'https://livetv.sx/enx/eventinfo/478510070_baffalo_bills_ny_inglend_petriots/';
  const liveMetadata = {'@type':'BroadcastEvent',name:'Buffalo Bills -New England Patriots',url:liveCanonical,
    startDate:'2026-10-04T20:00:00+03:00',broadcastOfEvent:{'@type':'SportsEvent',name:'Buffalo Bills -New England Patriots',
      competitor:[{'@type':'SportsTeam',name:'Buffalo Bills'},{'@type':'SportsTeam',name:'New England Patriots'}]}};
  const liveWrapper = 'https://livetv.sx/webplayer.php?t=ifr&c=3081333&lang=en&eid=478510070&lid=3081333&ci=142&si=27';
  const liveDetail = `<link rel="canonical" href="${liveCanonical}"><meta property="og:url" content="${liveCanonical}"><script type="application/ld+json">${JSON.stringify(liveMetadata)}</script><a href="${liveWrapper.replaceAll('&','&amp;')}"><img alt="free stream"></a>`;
  const streamLink = '/api/stream-link/iframe/event-espn-league-football-college-football-401856699/aef974e2-5ef2-412c-b65e-e6905af1edfa';
  const broad = name => fixture(`broad-sources/${name}`);
  const streamed = JSON.parse(broad('streamed.json'));
  const liveSport = JSON.parse(broad('livesportpro.json'));
  const sportsBite = JSON.parse(broad('sportsbite.json'));
  const selected = rows => rows.find(row => row.title === 'Buffalo Sabres vs Dallas Stars');
  const biteEvent = sportsBite.days.flatMap(day=>day.events).find(event=>event.event_key?.includes('buffalo-sabres-vs-dallas-stars'));
  assert.ok(biteEvent);
  const biteDay = sportsBite.days.find(day=>day.events.some(event=>event.event_key===biteEvent.event_key));
  const biteBody = JSON.stringify({...sportsBite,days:[{...biteDay,events:[biteEvent]}]});
  const sportsfeedToday = JSON.parse(broad('sportsfeed24-today.json'));
  sportsfeedToday.subCategories = sportsfeedToday.subCategories.map(group=>({...group,
    games:group.games.filter(game=>JSON.stringify(game).includes('Baycurrent Classic'))})).filter(group=>group.games.length);
  const sportsfeed = JSON.stringify([sportsfeedToday,
    JSON.parse(broad('sportsfeed24-NFL.json')),JSON.parse(broad('sportsfeed24-F1.json'))]);
  const cases = [
    {id:'sportsurge',sourceId:'sportsurge',body:'<a href="/watch/cfb/brown-harvard/397359440"><span class="team-name-event-row"><img alt="Brown Bears"></span><span class="team-name-event-row"><img alt="Harvard Crimson"></span></a>',detail:'<body><time>2026-09-25 22:30ET</time><iframe src="https://gooz.aapmains.net/new-stream-embed/57069"></iframe></body>',gameId:'ncaaf-1',min:1},
    {id:'buffstream',sourceId:'buffstream-cfb',body:'<table><tr><td>10:30 pm ET</td><td><a href="http://ms.buffstream.io/cfb-streams/montana-state-live-stream">Montana State Live Stream</a></td><td><a href="http://ms.buffstream.io/cfb-streams/idaho-live-stream">Idaho Live Stream</a></td></tr></table>',detail:'<html></html>',min:2},
    {id:'livetv',sourceId:'livetv',body:'<table><tr><td><img alt="USA. NFL"><a href="/enx/eventinfo/478510070__/"><span>Buffalo Bills &ndash; New England Patriots</span></a><span class="evdesc">4 October at 18:00 (USA. NFL)</span></td></tr></table>',detail:liveDetail,gameId:'401872974',min:1},
    {id:'vipbox',sourceId:'strikeout-nfl',body:fixture('strikeout-nfl-current-catalog.html'),detail:fixture('strikeout-nfl-current-detail.html'),min:1},
    {id:'nflstreams',sourceId:'nflstreams',body:fixture('nflstreams-live-2026-10-04.html'),detail:fixture('nflstreams-live-detail-2026-10-04.html'),min:1},
    {id:'event',sourceId:'crackstreams-st',body:fixture('crackstreams-st-nfl-2026-10-04.html'),detail:'<html></html>',min:1},
    {id:'tvapp',sourceId:'tvapp',body:JSON.stringify([tvappEvent,tvappEvent]),detail:tvappDetail,gameId:'ncaaf-401858472',min:1,minPlayers:1,
      reads:{'https://api-backups.handleapi.win/matches/sport/american-football':JSON.stringify([tvappEvent]),
        'https://api-backups.handleapi.win/streams/delta/live_cfb_illinois-purdue-live-streaming-663664065':JSON.stringify([{id:'live_cfb_illinois-purdue-live-streaming-663664065',source:'delta',streamNo:1,language:'English',hd:true,embedUrl:'https://embed.st/embed/delta/live_cfb_illinois-purdue-live-streaming-663664065/1'}])}},
    {id:'ppv',sourceId:'ppv',body:JSON.stringify({success:true,streams:[{category:'American Football',streams:[{id:29446,name:'Ole Miss Rebels at Florida Gators',tag:'College Football',uri_name:'cfb/2026-09-26/miss-fla',starts_at:at/1000}]}]}),detail:'{}',min:1},
    {id:'motorsports',sourceId:'methstreams-f1',body:'<section class="lg" id="g-lg-f1-20261009"><a class="ev ev-plain" href="/event/m-f1-singapore-gp" title="Singapore Grand Prix - Practice" data-start="1791534600"><img alt="Formula 1"></a></section>',detail:'<html></html>',min:1},
    {id:'streamcenter',sourceId:'streamcenter',body:`<article class="game-card-row"><p class="game-card-league">NCAA Football</p><time dateTime="2026-09-26T19:30:00.000Z"></time><span class="game-card-team" title="Ole Miss Rebels"></span><span class="game-card-team" title="Florida Gators"></span><a class="game-card-open-link" href="${streamLink}">English</a></article>`,detail:'<iframe src="//streame.center/embed/hls.php?stream=lmdsjkfgv52"></iframe>',gameId:'ncaaf-401856699',min:1},
    {id:'swac',sourceId:'swac',body:`[${fixture('swac/live-event.json')}]`,detail:fixture('swac/live-event.json'),at:Date.parse('2026-10-04T01:00:00Z'),min:1},
    {id:'streamed',sourceId:'streamed',body:JSON.stringify([selected(streamed)]),detail:JSON.stringify(selected(streamed)),gameId:'401892458',pickTitle:'Buffalo Sabres vs Dallas Stars',min:1,minPlayers:1,
      streamRows:JSON.stringify([{id:'2123',streamNo:1,source:'golf',embedUrl:'https://embed.st/embed/golf/2123/1'}])},
    {id:'livesportpro',sourceId:'livesportpro',body:JSON.stringify([selected(liveSport)]),detail:JSON.stringify(selected(liveSport)),gameId:'401892458',pickTitle:'Buffalo Sabres vs Dallas Stars',min:1,minPlayers:1,
      streamRows:JSON.stringify([{id:'2123',streamNo:1,source:'streamed',embedUrl:'https://lb29.strmd.st/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ingest/stream/streamedbuffalosabres/1/playlist.m3u8'}])},
    {id:'sportsfeed24',sourceId:'sportsfeed24',body:sportsfeed,detail:broad('sportsfeed24-golf-detail.json'),pickTitle:'Baycurrent Classic vs Golf',min:1},
    {id:'crichd',sourceId:'crichd',body:broad('crichd-home.html'),detail:broad('crichd-nfl-detail.html'),min:1},
    {id:'sportsbite',sourceId:'sportsbite',body:biteBody,detail:JSON.stringify(biteEvent),pickTitle:'Buffalo Sabres vs Dallas Stars',min:1,minPlayers:1},
    {id:'tvapp-malformed',sourceId:'tvapp',body:'[{"title":"missing date"}]',min:0},
    {id:'tvapp-empty',sourceId:'tvapp',body:'[]',min:0},
    {id:'sportsurge-unsafe',sourceId:'sportsurge',body:'<a href="https://evil.example/watch/cfb/brown-harvard/397359440">Brown vs Harvard</a>',min:0},
  ];
  const browser = [
    {kind:'surge-category',id:'surge-cfb',league:'ncaaf',html:fixture('sportsurge/cfb.html')},
    {kind:'surge-category',id:'surge-nfl-empty',league:'nfl',html:fixture('sportsurge/nfl.html')},
    {kind:'surge-category',id:'surge-duplicate',league:'ncaaf',html:'<main id="match-list-container"><a class="match-row" href="watch-123-cfb-away-home/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a><a class="match-row" href="watch-123-cfb-away-home-alt/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a><a class="match-row" href="https://bad.example/watch-999-cfb-other/">Bad</a></main>'},
    {kind:'surge-category',id:'surge-blocked',league:'ncaaf',html:'<title>Just a moment...</title>'},
    {kind:'east-category',id:'east-nba',league:'nba',html:fixture('streameast/nba.html')},
    {kind:'east-category',id:'east-nhl',league:'nhl',html:fixture('streameast/nhl.html')},
    {kind:'east-category',id:'east-malformed',league:'ncaaf',html:'<article class="m-card" data-match-id="123"><a class="m-card__link" href="https://evil.example/cfb/wrong/"></a></article>'},
  ];
  return {cases,browser,surgeDetail:fixture('sportsurge/detail.html')};
}

async function capture(data) {
  const results = {registry:stable(sources.SOURCES),listings:{},browser:{},sweeps:{},http:{}};
  const positive = data.cases.filter(item=>item.min>0);
  results.coverage = results.registry.map(source=>({
    sourceId:source.id,
    family:source.family,
    directListingCase:positive.find(item=>item.sourceId===source.id)?.id || null,
    familyListingCase:positive.find(item=>byId(item.sourceId).family===source.family)?.id || null,
    browserParser:source.kind==='browser-catalog' ? source.id : null,
  }));
  assert.ok(results.coverage.every(row=>row.familyListingCase || row.browserParser), 'Uncovered collector family');
  results.policy = {
    urls:['https://crichd.pk/','https://crichd.pk.evil.example/','https://127.0.0.1/','https://api.kultsport.com/api/stream/sp%3Agolf/2123','https://api.kultsport.com/api/stream/sp%253Agolf/2123'].map(url=>[url,sources.allowedDiscoveryUrl(url)]),
    times:['2026-09-26T16:00:00Z','1790438400','2026-09-26T16:00','2026-11-01 01:30 ET'].map(value=>[value,sources.parseKickoff(value)]),
  };
  for (const item of data.cases) {
    const parsed = sources.parseListings(byId(item.sourceId),item.body,item.at || at);
    assert.ok(parsed.observations.length >= item.min, `${item.id} yielded fewer than ${item.min} observations`);
    const row = item.pickTitle ? parsed.observations.find(value=>value.title===item.pickTitle) : parsed.observations[0];
    if (item.pickTitle) assert.ok(row,`${item.id} missing selected event`);
    const result = {parsed};
    if (row && item.detail !== undefined) {
      const enriched = sources.enrichObservation(row,item.detail);
      result.enriched = enriched;
      result.compatible = sources.compatiblePlayers(item.gameId || 'ncaaf-1',enriched,item.detail);
      result.missing = sources.missingPlayerReason(enriched,item.detail);
      const read = async url => item.reads?.[url] || (item.streamRows && (url.endsWith('/golf/2123') || url.endsWith('sp%3Agolf/2123')) ? item.streamRows : '[]');
      try {result.resolved = await sources.resolvePlayers(item.gameId || 'ncaaf-1',enriched,item.detail,new AbortController().signal,read);}
      catch (error) {result.resolveError = error.message;}
      if (item.sourceId === 'tvapp') result.tvapp = await sources.tvappPlayers(item.gameId,enriched,item.detail,new AbortController().signal,read);
      if (item.minPlayers) assert.ok((result.resolved?.length || 0) >= item.minPlayers,`${item.id} resolved fewer than ${item.minPlayers} players`);
    }
    results.listings[item.id] = stable(result);
  }
  for (const item of data.browser) {
    results.browser[item.id] = stable(item.kind === 'surge-category' ? surge.parseCategory(item.html,item.league) : east.parseCategory(item.html,item.league));
  }
  const surgeEvent = surge.parseCategory(data.browser.find(item => item.id === 'surge-cfb').html,'ncaaf').events[0];
  results.browser['surge-detail'] = stable(surge.parseDetail(data.surgeDetail,surgeEvent,at));
  results.browser['surge-duplicate-providers'] = stable(surge.parseDetail('<div class="stream-list"><div class="stream-item" data-href="https://example.com/one"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div><div class="stream-item" data-href="https://example.com/two"><span class="stream-row-site-name">Same</span><button class="stream-vote" id="stream-11"></button></div><div class="stream-item" data-href="https://127.0.0.1/private"></div></div>',surgeEvent,at));
  const eastUrl = 'https://v2.streameast.ga/cfb/montana-state-bobcats-vs-idaho-vandals-1790994600/';
  const eastEvent = {id:'ncaaf:12345',url:eastUrl,league:'ncaaf',title:'Montana State Bobcats vs Idaho Vandals',teams:['Montana State Bobcats','Idaho Vandals'],kickoff:at,espnEventId:null,detail:{kind:'pending'}};
  const eastDetail = `<div class="stream-alt-list"><a class="stream-alt-item" href="${eastUrl}1"><span class="stream-alt-name">Free 1</span><span class="stream-alt-free-badge">Free</span></a><a class="stream-alt-item stream-alt-item-pro" href="${eastUrl}2"><span class="stream-alt-name">Paid</span><span class="stream-alt-pro-icon"></span></a></div>`;
  results.browser['east-detail'] = stable(east.parseDetail(eastDetail,eastEvent,at,new Map([[`${eastUrl}1`,{kind:'channel',id:'33'}]])));
  results.browser['east-detail-missing'] = stable(east.parseDetail('<div></div>',eastEvent,at,new Map()));
  results.browser['east-free-urls'] = stable(east.freeServerUrls(eastDetail,eastEvent));
  results.browser['east-active-free'] = stable(east.activeFreeServerUrl(eastDetail,eastEvent));
  results.browser['east-published-player'] = stable(east.publishedFreePlayer(`<main class="streameast-video-page"><div class="se-board" data-match-id="12345"></div><div class="stream-alt-list"><a class="stream-alt-item active" href="${eastUrl}1"><span class="stream-alt-free-badge">Free</span></a></div><div id="se-player-root" class="se-player"><iframe src="https://streame.center/stream-east/ch33.php"></iframe></div></main>`,eastEvent,`${eastUrl}1`));
  const surgeEmpty = '<main id="match-list-container"><div class="watch-empty-state">There are no live or upcoming games here right now.</div></main>';
  const surgePositive = '<main id="match-list-container"><a class="match-row" href="watch-123-cfb-away-home/"><span class="match-row-team-name">Away</span><span class="match-row-team-name">Home</span></a></main>';
  const surgeCheckpoints = [];
  const checkpoint = value => stable({sequence:value.sequence,state:value.state,categories:value.categories,
    eventIds:value.events.map(event=>event.id),detailKinds:value.events.map(event=>event.detail.kind),
    rejectedGames:value.rejectedGames.length,catalogIssues:value.catalogIssues?.length});
  const surgeRead = async (_url,page,league) => page === 'category' ? league === 'ncaaf' ? surgePositive : surgeEmpty : '<div class="stream-list"><div class="stream-item" data-href="https://example.com/watch"><span class="stream-row-site-name">Example</span></div></div>';
  const surgeSweep = await runSportsurgeSweep({read:surgeRead,send:async value=>{surgeCheckpoints.push(checkpoint(value));},signal:new AbortController().signal,now:()=>at,runId});
  results.sweeps.sportsurge = stable({final:surgeSweep,checkpoints:surgeCheckpoints});
  const surgePartialCheckpoints = [];
  const surgePartial = await runSportsurgeSweep({read:async (url,page,league)=>{
    if (page === 'category' && league === 'nfl') throw new Error('timeout');
    return surgeRead(url,page,league);
  },send:async value=>{surgePartialCheckpoints.push(checkpoint(value));},signal:new AbortController().signal,now:()=>at,runId});
  results.sweeps['sportsurge-partial'] = stable({final:surgePartial,checkpoints:surgePartialCheckpoints});
  const eastCategory = `<article class="m-card" data-match-id="12345" data-team-names="Montana State Bobcats|Idaho Vandals" data-time="1790994600"><a class="m-card__link" aria-label="Montana State Bobcats vs Idaho Vandals" href="${eastUrl}"></a></article>`;
  const eastCheckpoints = [];
  const eastRead = async (_url,page,league) => {
    if (page === 'category') return league === 'ncaaf' ? eastCategory : `<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">No ${league === 'f1' ? 'F1 races' : `${league.toUpperCase()} games`} available</h2></div>`;
    if (page === 'detail') return eastDetail;
    return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
  };
  const eastSweep = await runStreameastSweep({read:eastRead,send:async value=>{eastCheckpoints.push(checkpoint(value));},signal:new AbortController().signal,now:()=>at,runId});
  results.sweeps.streameast = stable({final:eastSweep,checkpoints:eastCheckpoints});
  const eastPartialCheckpoints = [];
  const eastPartial = await runStreameastSweep({read:async (url,page,league)=>{
    if (page === 'category' && league === 'nfl') throw new Error('timeout');
    return eastRead(url,page,league);
  },send:async value=>{eastPartialCheckpoints.push(checkpoint(value));},signal:new AbortController().signal,now:()=>at,runId});
  results.sweeps['streameast-partial'] = stable({final:eastPartial,checkpoints:eastPartialCheckpoints});
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('parity-body',{status:200});
    results.http.body = await sources.readHtml(byId('nflstreams').url,new AbortController().signal);
    globalThis.fetch = async () => new Response(null,{status:429,headers:{'Retry-After':'5'}});
    try {await sources.readHtml(byId('nflstreams').url,new AbortController().signal);}
    catch (error) {results.http.backoff = {name:error.constructor.name,message:error.message,retryAfterMs:error.retryAfterMs};}
    globalThis.fetch = async () => new Response(null,{status:301,headers:{location:'https://streamed.st/api/matches/all'}});
    try {await sources.readHtml('https://crichd.pk/',new AbortController().signal);}
    catch (error) {results.http.crossHostRedirect = error.message;}
    const today = JSON.parse(data.cases.find(item=>item.id==='sportsfeed24').body)[0];
    globalThis.fetch = async (_url,init) => {
      const category = JSON.parse(init.body).categoryName;
      if (category === 'F1') return new Response('Unavailable',{status:503});
      return new Response(JSON.stringify(category ? {categoryName:category,subCategories:[]} : today),{headers:{'content-type':'application/json'}});
    };
    try {await sources.readHtml(byId('sportsfeed24').url,new AbortController().signal);}
    catch (error) {results.http.partial = {name:error.constructor.name,message:error.message,retryAfterMs:error.retryAfterMs || null,
      listing:sources.parseListings(byId('sportsfeed24'),error.html,at)};}
  } finally {globalThis.fetch = originalFetch;}
  return results;
}

function compare(actual,expected) {
  const differences = [];
  for (const section of new Set([...Object.keys(actual),...Object.keys(expected)])) {
    if (section === 'listings' || section === 'browser' || section === 'sweeps' || section === 'http') {
      for (const key of new Set([...Object.keys(actual[section] || {}),...Object.keys(expected[section] || {})])) {
        if (!isDeepStrictEqual(actual[section]?.[key],expected[section]?.[key])) differences.push(`${section}.${key}`);
      }
    } else if (!isDeepStrictEqual(actual[section],expected[section])) differences.push(section);
  }
  if (differences.length) throw new Error(`Collector parity differs in ${differences.slice(0,8).join(', ')}${differences.length>8?` and ${differences.length-8} more`:''}`);
}

if (recording) {
  const data = inputs();
  const expected = await capture(data);
  const document = {version:1,baseline:'27abd3a',at,inputs:data,expected};
  writeFileSync(goldenPath,JSON.stringify(document,null,2)+'\n');
  console.log(`Recorded ${data.cases.length} listing cases, ${data.browser.length} browser categories, 4 sweeps, and ${expected.registry.length} enumerated source entries.`);
  console.log(`Golden SHA-256 ${sha(JSON.stringify(expected))}`);
} else {
  const document = JSON.parse(readFileSync(goldenPath,'utf8'));
  assert.equal(document.version,1);
  const actual = await capture(document.inputs);
  compare(actual,document.expected);
  const positive = document.inputs.cases.filter(item => item.min > 0);
  const families = new Set(positive.map(item => byId(item.sourceId).family));
  console.log(`Collector parity passed: ${positive.length} positive listing kernels across ${families.size} families plus 2 browser parsers; ${document.inputs.cases.length} listing cases, ${document.inputs.browser.length} browser categories, 4 sweeps, ${actual.registry.length} enumerated source entries.`);
}
