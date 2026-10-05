import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES,compatiblePlayers,enrichObservation,parseListings} from '../lib/football/adapters/sources.ts';
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
