import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';
import { SOURCES, compatiblePlayers, parseListings, tvappPlayers } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { BoardSchema, CandidateLocatorSchema } from '../lib/football/shared.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { tvappProvider } from '../lib/playback/providers/tvapp.ts';
import type { Requester } from '../lib/playback/providers/public-page.ts';
import { parseScoreboard, validGameId } from '../lib/sunday.ts';

const now=Date.parse('2026-10-08T02:00:00Z');
const scoreboard=(id:string,away:string,home:string,at=now,awayId='1',homeId='2')=>({events:[{
  id,date:new Date(at).toISOString(),name:`${away} at ${home}`,
  status:{type:{name:'STATUS_SCHEDULED',state:'pre',shortDetail:'10:00 PM ET'}},
  competitions:[{competitors:[
    {homeAway:'away',team:{id:awayId,displayName:away,shortDisplayName:away,abbreviation:'AWY'}},
    {homeAway:'home',team:{id:homeId,displayName:home,shortDisplayName:home,abbreviation:'HME'}},
  ]}],
}]});
const nhl=parseScoreboard(scoreboard('401892456','Edmonton Oilers','Anaheim Ducks'),'nhl')[0];
const men=parseScoreboard(scoreboard('401904793','Merrimack Warriors','New Hampshire Wildcats',now,'59','60'),'ncaah')[0];
const women=parseScoreboard(scoreboard('401904103','St. Lawrence Saints','Clarkson Golden Knights',now,'2779','2810'),'ncaawh')[0];

test('three hockey schedules keep ESPN identities and use independent hockey endpoints',async()=>{
  for(const [league,path,game] of [
    ['nhl','nhl',nhl],['ncaah','mens-college-hockey',men],['ncaawh','womens-college-hockey',women],
  ] as const){
    assert.equal(game.id,`${league}-${league==='nhl'?'401892456':league==='ncaah'?'401904793':'401904103'}`);
    assert.match(game.away.id||'',new RegExp(`^espn:${league}:`));
    assert.equal(game.redzone,false);
    assert.equal(game.down,undefined);
    assert.equal(game.possession,undefined);
    assert.equal(validGameId(game.id),true);
    const partition=SCHEDULES.find(source=>source.id===league);
    assert.ok(partition);
    assert.equal(partition.sport,'hockey');
    assert.equal(partition.path,path);
  }
  const partition=SCHEDULES.find(source=>source.id==='nhl');
  assert.ok(partition);
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);
    requested.push(url);
    return Response.json(new URL(url).searchParams.get('dates')==='20261008'?
      scoreboard('401892456','Edmonton Oilers','Anaheim Ducks'):{events:[]});
  };
  try{
    const result=await readSchedule(partition,now,new AbortController().signal);
    assert.deepEqual(result.games.map(game=>game.id),['nhl-401892456']);
    assert.equal(requested.length,9);
    assert.ok(requested.every(url=>new URL(url).pathname==='/apis/site/v2/sports/hockey/nhl/scoreboard'));
  }finally{globalThis.fetch=original;}
});

test('hockey catalogs and gendered event sections match only their own schedule games',()=>{
  const tvapp=SOURCES.find(source=>source.id==='tvapp-nhl');
  const meth=SOURCES.find(source=>source.id==='methstreams-nhl');
  const football=SOURCES.find(source=>source.id==='tvapp');
  assert.ok(tvapp&&meth&&football);
  const rows=[
    {id:'ppv-nhl-network',title:'NHL Network',category:'hockey',date:0},
    {id:'anaheim-ducks-vs-edmonton-oilers-2591539',title:'Anaheim Ducks vs Edmonton Oilers',category:'hockey',date:now,
      teams:{home:{name:'Anaheim Ducks'},away:{name:'Edmonton Oilers'}}},
    {id:'live_ncaa-women_saint-lawrence-saints-clarkson-golden-knights-live-streaming-653940000',
      title:'Saint Lawrence Saints vs Clarkson Golden Knights',category:'hockey',date:now},
    {id:'live_college_merrimack-new-hampshire-wildcats-live-streaming-653938272',
      title:'Merrimack Warriors vs New Hampshire Wildcats',category:'hockey',date:now},
  ];
  const result=parseListings(tvapp,JSON.stringify(rows),now);
  assert.equal(result.outcome,'parsed');
  assert.equal(result.observations.length,3);
  const matches=result.observations.map(observation=>matchObservation(observation,[nhl,men,women],now));
  assert.deepEqual(matches.map(match=>match.kind==='matched'?match.gameId:null),
    ['nhl-401892456','ncaawh-401904103','ncaah-401904793']);
  assert.equal(parseListings(football,JSON.stringify(rows),now).observations.length,0);
  const listing=`<section class="lg" id="g-lg-womens-college-hockey-20261008"><a class="ev" href="/event/saint-lawrence-saints-vs-clarkson-golden-knights" data-start="${now/1000}" title="Saint Lawrence Saints vs Clarkson Golden Knights"><span class="ev-side"><span class="nm-l">Saint Lawrence Saints</span></span><span class="ev-side"><span class="nm-l">Clarkson Golden Knights</span></span></a></section>
    <section class="lg" id="g-lg-mens-college-hockey-20261008"><a class="ev" href="/event/merrimack-warriors-vs-new-hampshire-wildcats" data-start="${now/1000}" title="Merrimack Warriors vs New Hampshire Wildcats"><span class="ev-side"><span class="nm-l">Merrimack Warriors</span></span><span class="ev-side"><span class="nm-l">New Hampshire Wildcats</span></span></a></section>`;
  const events=parseListings(meth,listing,now);
  assert.deepEqual(events.observations.map(observation=>observation.league),['ncaawh','ncaah']);
  assert.deepEqual(events.observations.map(observation=>matchObservation(observation,[nhl,men,women],now)).map(match=>match.kind==='matched'?match.gameId:null),
    ['ncaawh-401904103','ncaah-401904793']);
});

test('NHL providers publish exact locators and reject mixed-sport player routes',()=>{
  const streamcenter=SOURCES.find(source=>source.id==='streamcenter-nhl');
  const ppv=SOURCES.find(source=>source.id==='ppv');
  const buffstream=SOURCES.find(source=>source.id==='buffstream-nhl');
  assert.ok(streamcenter&&ppv&&buffstream);
  const link='/api/stream-link/iframe/event-espn-league-hockey-nhl-401892456/dbf33b39-195b-4ff1-b5c1-23447b0980ec';
  const card=`<article class="game-card-row"><p class="game-card-league">NHL</p><time datetime="${new Date(now).toISOString()}"></time><span class="game-card-team" title="Edmonton Oilers"></span><span class="game-card-team" title="Anaheim Ducks"></span><a class="game-card-open-link" href="${link}">English</a></article>`;
  const row=parseListings(streamcenter,card,now);
  assert.equal(row.outcome,'parsed');
  assert.deepEqual(matchObservation(row.observations[0],[nhl,men,women],now),{kind:'matched',gameId:nhl.id});
  const streamPlayers=compatiblePlayers(nhl.id,row.observations[0],'<iframe src="https://streame.center/embed/hls.php?stream=nhl52"></iframe>');
  assert.equal(streamPlayers.length,1);
  assert.deepEqual(streamPlayers[0].locator,{provider:'streamcenter',eventId:'401892456',linkId:'dbf33b39-195b-4ff1-b5c1-23447b0980ec',league:'nhl'});
  assert.equal(CandidateLocatorSchema.safeParse(streamPlayers[0].locator).success,true);
  const ppvEvent={id:30088,name:'Edmonton Oilers vs. Anaheim Ducks',tag:'NHL',uri_name:'nhl/2026-10-07/edm-ana',starts_at:now/1000,
    iframe:'https://embedindia.st/embed/nhl/2026-10-07/edm-ana',substreams:[]};
  const ppvRow=parseListings(ppv,JSON.stringify({success:true,streams:[{category:'Ice Hockey',streams:[ppvEvent]}]}),now);
  assert.equal(ppvRow.observations[0].league,'nhl');
  assert.deepEqual(matchObservation(ppvRow.observations[0],[nhl],now),{kind:'matched',gameId:nhl.id});
  assert.equal(compatiblePlayers(nhl.id,ppvRow.observations[0],JSON.stringify(ppvEvent)).length,1);
  assert.equal(validEventPagePair(ppvRow.observations[0].url,ppvEvent.iframe),true);
  assert.equal(validEventPagePair(ppvRow.observations[0].url,ppvEvent.iframe.replace('/nhl/','/nba/')),false);
  const first='https://ms.buffstream.io/nhl-streams/edmonton-oilers-live-stream';
  const buff=parseListings(buffstream,`<table><tr><td><a href="${first}">Edmonton Oilers Live Stream</a></td><td><h4>2026-10-07</h4><h4>10:00 pm ET</h4></td><td><a href="https://ms.buffstream.io/nhl-streams/anaheim-ducks-live-stream">Anaheim Ducks Live Stream</a></td></tr></table>`,now);
  assert.equal(buff.observations[0].kickoff,now);
  const player='https://embedsports.me/ice-hockey/anaheim-ducks-vs-edmonton-oilers-stream-2';
  assert.equal(compatiblePlayers(nhl.id,buff.observations[0],`<link rel="canonical" href="${first}"><iframe src="${player}"></iframe>`).length,1);
  assert.equal(validEventPagePair(first,player.replace('/ice-hockey/','/basketball/')),false);
  assert.equal(validEventPagePair('https://vipbox.fm/onair/nhl/anaheim-ducks-vs-edmonton-oilers',
    'https://vipbox.fm/live/nhl/anaheim-ducks-vs-edmonton-oilers-1'),true);
  assert.equal(validEventPagePair('https://strikeout.im/nhl/stream-anaheim-ducks-vs-edmonton-oilers-live',
    'https://strikeout.im/nhl/1/anaheim-ducks-vs-edmonton-oilers-stream'),true);
  assert.equal(validEventPagePair('https://methstreams.st/event/m-edmonton-oilers-vs-anaheim-ducks-1008',
    'https://fxtrend.st/event/m-edmonton-oilers-vs-anaheim-ducks-1008/main/1'),true);
});

test('NCAA hockey TVApp candidate and playback revalidate against the hockey catalog',async()=>{
  const source=SOURCES.find(source=>source.id==='tvapp-nhl');
  assert.ok(source);
  const match={id:'live_ncaa-women_saint-lawrence-saints-clarkson-golden-knights-live-streaming-653940000',
    title:'Saint Lawrence Saints vs Clarkson Golden Knights',category:'hockey',date:now,
    sources:[{source:'delta',id:'live_ncaa-women_saint-lawrence-saints-clarkson-golden-knights-live-streaming-653940000'}]};
  const observation=parseListings(source,JSON.stringify([match]),now).observations[0];
  assert.deepEqual(matchObservation(observation,[men,women],now),{kind:'matched',gameId:women.id});
  const watch='https://tvapp1.pk/watch/653940000';
  const page=`<link rel="canonical" href="${watch}"><meta property="og:url" content="${watch}">
    <meta property="og:title" content="${match.title} - Live Stream Free in HD | TheTVApp">
    <meta name="description" content="Watch ${match.title} live stream free in HD on TheTVApp.">
    <div id="player-frame"></div>`;
  const ref=match.sources[0];
  const stream={id:ref.id,source:ref.source,streamNo:1,language:'English',hd:true,
    embedUrl:`https://embed.st/embed/${ref.source}/${ref.id}/1`};
  const urls:string[]=[];
  const read=async(url:string)=>{
    urls.push(url);
    return JSON.stringify(url.endsWith('/matches/sport/hockey')?[match]:[stream]);
  };
  const players=await tvappPlayers(women.id,observation,page,new AbortController().signal,read);
  assert.equal(players.length,1);
  assert.equal(players[0].locator.provider,'tvapp');
  assert.deepEqual(urls,[source.url,`https://api-backups.handleapi.win/streams/delta/${ref.id}`]);
  if(players[0].locator.provider!=='tvapp')return;
  const requests:string[]=[];
  const requester:Requester=async address=>{
    requests.push(address.href);
    return new Response(JSON.stringify(address.href.endsWith('/matches/sport/hockey')?[match]:[stream]),
      {headers:{'content-type':'application/json'}});
  };
  const playback={root:{kind:'playlist' as const,identity:'hockey-fixture',
    async read(){return {status:200 as const,body:null,contentType:'application/vnd.apple.mpegurl'};},
    resolve(){return null;}},close(){}};
  const provider=tvappProvider(requester,async destination=>{
    assert.equal(destination.href,stream.embedUrl);
    return playback;
  });
  await provider.open(players[0].locator,new AbortController().signal,'probe');
  assert.deepEqual(requests,[source.url,`https://api-backups.handleapi.win/streams/delta/${ref.id}`]);
});

test('an older persisted board gains empty hockey status while preserving its metadata',()=>{
  const status={scoresAt:'2026-10-08T02:00:00.000Z',sourceAt:null,errors:[]};
  const board=BoardSchema.parse({schemaVersion:2,revision:7,scheduleState:'ready',games:[],updatedAt:status.scoresAt,
    aliases:{},leagues:{nfl:status,ncaaf:status,nba:status,wnba:status,ncaab:status}});
  assert.deepEqual(board.leagues.nhl,{scoresAt:null,sourceAt:null,errors:[]});
  assert.deepEqual(board.leagues.ncaah,{scoresAt:null,sourceAt:null,errors:[]});
  assert.deepEqual(board.leagues.ncaawh,{scoresAt:null,sourceAt:null,errors:[]});
  assert.equal(board.revision,7);
});
