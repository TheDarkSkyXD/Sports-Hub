import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES,compatiblePlayers,enrichObservation,parseListings,tvappPlayers} from '../lib/football/adapters/sources.ts';
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

test('TVApp exposes each published match source with a stable source identity',async()=>{
  const at=Date.parse('2026-10-05T19:00:00Z');
  const starts=Date.parse('2026-10-06T00:15:00Z');
  const match={id:'new-orleans-saints-vs-atlanta-falcons-2475437',title:'New Orleans Saints vs Atlanta Falcons',
    category:'american-football',date:starts,teams:{home:{name:'New Orleans Saints'},away:{name:'Atlanta Falcons'}},
    sources:[
      {source:'admin',id:'ppv-atlanta-falcons-at-new-orleans-saints'},
      {source:'delta',id:'live_nfl_saints-falcons-live-streaming-663788304'},
      {source:'golf',id:'1936'},
      {source:'hotel',id:'atlanta-falcons-vs-new-orleans-saints-nfl-1791245700'},
    ]};
  const event=parseListings(source,JSON.stringify([match]),at).observations[0];
  assert.ok(event);
  const watch='https://tvapp1.pk/watch/2475437';
  const page=`<link rel="canonical" href="${watch}"><meta property="og:url" content="${watch}">
    <meta property="og:title" content="${match.title} - Live Stream Free in HD | TheTVApp">
    <meta name="description" content="Watch ${match.title} live stream free in HD on TheTVApp.">
    <div id="player-frame"></div>`;
  const rows=match.sources.flatMap(item=>{
    const count=item.source==='delta'?5:item.source==='admin'||item.source==='golf'?2:1;
    return Array.from({length:count},(_,index)=>({id:item.id,source:item.source,streamNo:index+1,
      language:'English',hd:item.source!=='golf'||index===0,
      embedUrl:`https://embed.st/embed/${item.source}/${item.id}/${index+1}`}));
  });
  const read=async(address:string)=>address.endsWith('/matches/sport/american-football')?
    JSON.stringify([match]):JSON.stringify(rows.filter(row=>address.endsWith(`/streams/${row.source}/${row.id}`)));
  const candidates=await tvappPlayers('401872979',event,page,new AbortController().signal,read);
  assert.equal(candidates.length,10);
  assert.equal(new Set(candidates.map(row=>row.id)).size,10);
  assert.ok(candidates.every(row=>row.locator.provider==='tvapp'&&row.locator.eventUrl===watch));
  assert.ok(candidates.some(row=>row.locator.provider==='tvapp'&&row.locator.source==='golf'&&
    row.locator.sourceId==='1936'&&row.locator.streamNo===2));
  assert.ok(candidates.every(row=>JSON.stringify(row.locator).includes('embed.st')===false));
});
