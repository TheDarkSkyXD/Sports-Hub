import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES,compatiblePlayers,enrichObservation,parseListings} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import type {Game} from '../lib/football/shared.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const source=SOURCES.find(source=>source.id==='tvapp');
assert.ok(source);
const kickoff=Date.parse('2026-10-03T19:30:00Z');
const listing={id:'illinois-vs-purdue-2498915',title:'Illinois vs Purdue',category:'american-football',date:kickoff,
  teams:{home:{name:'Illinois'},away:{name:'Purdue'}},sources:[{source:'delta',id:'live_cfb_illinois-purdue-live-streaming-663664065'}]};
const parsed=parseListings(source,JSON.stringify([listing]),kickoff);
assert.equal(parsed.outcome,'parsed');
const observation=parsed.observations[0];
assert.ok(observation);
const url='https://tvapp1.pk/watch/2498915';
const html=`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">
  <meta property="og:title" content="Illinois vs Purdue - Live Stream Free in HD | TheTVApp">
  <meta name="description" content="Watch Illinois vs Purdue live stream free in HD on TheTVApp. Multiple Premium stream sources available.">
  <div id="player-frame"></div><script type="module" src="/_astro/_slug_.astro_astro_type_script_index_0_lang._mnRBTCV.js"></script>`;

test('TVApp publishes its exact free watch page as a candidate before media probing',()=>{
  assert.equal(validEventPagePair(url,url),true);
  const rows=compatiblePlayers('ncaaf-401858472',enrichObservation(observation,html),html);
  assert.equal(rows.length,1);
  assert.deepEqual(rows[0].locator,{provider:'event-page',gameId:'ncaaf-401858472',eventUrl:url,serverUrl:url});
  assert.equal(enrichObservation(observation,html).kickoff,kickoff);
});

test('TVApp candidates require catalog timing, the same matchup and a free public player page',()=>{
  const variants=[html.replace('rel="canonical"','rel="other"'),html.replace('property="og:url"','property="og:other"'),
    html.replace('Illinois vs Purdue - Live Stream','Other vs Game - Live Stream'),
    html.replace('Watch Illinois vs Purdue live stream free in HD','Subscribe to watch Illinois vs Purdue'),
    html.replace('id="player-frame"','id="other"'),html.replaceAll(url,'https://tvapp1.pk/watch/9999999')];
  for(const page of variants)assert.deepEqual(compatiblePlayers('ncaaf-401858472',observation,page),[]);
  assert.deepEqual(compatiblePlayers('ncaaf-401858472',{...observation,kickoff:null},html),[]);
  assert.deepEqual(compatiblePlayers('ncaaf-401858472',{...observation,teams:null},html),[]);
  assert.deepEqual(compatiblePlayers('ncaaf-401858472',{...observation,sourceId:'methstreams'},html),[]);
  for(const value of [url.replace('2498915','9999999'),url.replace('tvapp1.pk','tvapp1.pk.attacker.test'),`${url}?channel=1`,`${url}#player`,url.replace('https:','http:')])
    assert.equal(validEventPagePair(url,value),false,value);
});

test('TVApp keeps a football matchup when the catalog also contains a standalone broadcast',()=>{
  const at=Date.parse('2026-10-05T19:00:00Z');
  const starts=Date.parse('2026-10-06T00:15:00Z');
  const broadcast={id:'live-event_manningcast-live-stream',title:'ManningCast',category:'american-football',
    date:starts,teams:null};
  const matchup={id:'new-orleans-saints-vs-atlanta-falcons-2475437',
    title:'New Orleans Saints vs Atlanta Falcons',category:'american-football',date:starts,
    teams:{home:{name:'New Orleans Saints'},away:{name:'Atlanta Falcons'}}};
  const result=parseListings(source,JSON.stringify([broadcast,matchup]),at);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,1);
  const event=result.observations[0];
  assert.equal(event.url,'https://tvapp1.pk/watch/2475437');
  assert.deepEqual(event.teams,['New Orleans Saints','Atlanta Falcons']);
  const team=(name:string,id:string)=>({name,id,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
  const game:Game={id:'401872979',league:'nfl',name:'Atlanta Falcons at New Orleans Saints',
    date:'2026-10-06T00:15:00Z',home:team('New Orleans Saints','espn:nfl:18'),
    away:team('Atlanta Falcons','espn:nfl:1'),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false};
  assert.deepEqual(matchObservation(event,[game],at),{kind:'matched',gameId:'401872979'});
});

test('TVApp rejects malformed matchup identifiers and dates despite standalone broadcasts',()=>{
  const at=Date.parse('2026-10-05T19:00:00Z');
  const broadcast={id:'live-event_manningcast-live-stream',title:'ManningCast',category:'american-football',
    date:Date.parse('2026-10-06T00:15:00Z'),teams:null};
  const matchup={id:'new-orleans-saints-vs-atlanta-falcons',title:'New Orleans Saints vs Atlanta Falcons',
    category:'american-football',date:broadcast.date,
    teams:{home:{name:'New Orleans Saints'},away:{name:'Atlanta Falcons'}}};
  assert.equal(parseListings(source,JSON.stringify([broadcast,matchup]),at).outcome,'parser-changed');
  assert.equal(parseListings(source,JSON.stringify([{...broadcast,date:0},matchup]),at).outcome,'parser-changed');
});
