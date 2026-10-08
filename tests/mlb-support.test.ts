import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULES, readSchedule } from '../lib/football/adapters/schedule.ts';
import { SOURCES, compatiblePlayers, enrichObservation, parseListings, tvappPlayers } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { BoardSchema, CandidateLocatorSchema } from '../lib/football/shared.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';
import { tvappProvider } from '../lib/playback/providers/tvapp.ts';
import { parseScoreboard, validGameId } from '../lib/sunday.ts';

const now=Date.parse('2026-10-08T21:00:00Z');
const espnTime=Date.parse('2026-10-09T00:00:00Z');
const scoreboard=(id:string,date:number)=>({events:[{
  id,date:new Date(date).toISOString(),name:'Cleveland Guardians at Chicago White Sox',
  status:{type:{name:'STATUS_SCHEDULED',state:'pre',shortDetail:'8:00 PM ET'}},
  competitions:[{competitors:[
    {homeAway:'away',team:{id:'5',displayName:'Cleveland Guardians',shortDisplayName:'Guardians',abbreviation:'CLE'}},
    {homeAway:'home',team:{id:'4',displayName:'Chicago White Sox',shortDisplayName:'White Sox',abbreviation:'CHW'}},
  ]}],
}]});
const game=parseScoreboard(scoreboard('401907993',espnTime),'mlb')[0];
const source=(id:string)=>{
  const row=SOURCES.find(item=>item.id===id);
  assert.ok(row);
  return row;
};

test('MLB has an independent seven-day ESPN schedule and no football situation',async()=>{
  assert.equal(game.id,'mlb-401907993');
  assert.equal(game.redzone,false);
  assert.equal(game.down,undefined);
  assert.equal(game.possession,undefined);
  assert.equal(validGameId(game.id),true);
  const partition=SCHEDULES.find(row=>row.id==='mlb');
  assert.ok(partition);
  assert.equal(partition.sport,'baseball');
  assert.equal(partition.path,'mlb');
  const original=globalThis.fetch;
  const requested:string[]=[];
  globalThis.fetch=async input=>{
    const url=String(input);
    requested.push(url);
    return Response.json(new URL(url).searchParams.get('dates')==='20261009'?
      scoreboard('401907993',espnTime):{events:[]});
  };
  try {
    const result=await readSchedule(partition,now,new AbortController().signal);
    assert.deepEqual(result.games.map(row=>row.id),['mlb-401907993']);
    assert.equal(requested.length,9);
    assert.ok(requested.every(url=>new URL(url).pathname==='/apis/site/v2/sports/baseball/mlb/scoreboard'));
  } finally {globalThis.fetch=original;}
});

test('MLB source catalogs and Streamcenter card match the game',()=>{
  const tvappEvent={id:'ppv-cleveland-guardians-vs-chicago-white-sox',
    title:'Cleveland Guardians vs. Chicago White Sox',category:'baseball',date:now,
    teams:{home:{name:'Cleveland Guardians'},away:{name:'Chicago White Sox'}},sources:[]};
  const tvapp=parseListings(source('tvapp-mlb'),JSON.stringify([tvappEvent]),now);
  assert.equal(tvapp.outcome,'parsed');
  assert.equal(tvapp.observations[0].league,'mlb');
  assert.equal(tvapp.observations[0].url,'https://tvapp1.pk/watch/ppv-cleveland-guardians-vs-chicago-white-sox');
  assert.equal(validEventPagePair(tvapp.observations[0].url,tvapp.observations[0].url),true);
  assert.deepEqual(matchObservation(tvapp.observations[0],[game],now),{kind:'matched',gameId:game.id});
  const ppvEvent={id:31289,name:tvappEvent.title,tag:'MLB',uri_name:'mlb/2026-10-08/cle-chw',
    starts_at:now/1000,iframe:'https://embedindia.st/embed/mlb/2026-10-08/cle-chw',substreams:[]};
  const ppv=parseListings(source('ppv'),JSON.stringify({success:true,streams:[{category:'Baseball',streams:[ppvEvent]}]}),now);
  assert.equal(ppv.outcome,'parsed');
  assert.deepEqual(matchObservation(ppv.observations[0],[game],now),{kind:'matched',gameId:game.id});
  assert.equal(compatiblePlayers(game.id,ppv.observations[0],JSON.stringify(ppvEvent)).length,1);
  assert.equal(validEventPagePair(ppv.observations[0].url,ppvEvent.iframe),true);
  assert.equal(validEventPagePair(ppv.observations[0].url,ppvEvent.iframe.replace('/mlb/','/nhl/')),false);
  const link='/api/stream-link/iframe/event-espn-league-baseball-mlb-401907993/b953ed0c-6da3-4d0a-ae35-7e7db3e8072e';
  const card=`<article class="game-card-row"><p class="game-card-league">MLB</p><time datetime="${new Date(now).toISOString()}"></time><span class="game-card-team" title="Cleveland Guardians"></span><span class="game-card-team" title="Chicago White Sox"></span><a class="game-card-open-link" href="${link}">English</a></article>`;
  const center=parseListings(source('streamcenter-mlb'),card,now);
  assert.equal(center.outcome,'parsed');
  assert.deepEqual(matchObservation(center.observations[0],[game],now),{kind:'matched',gameId:game.id});
  const players=compatiblePlayers(game.id,center.observations[0],'<iframe src="https://streame.center/embed/hls.php?stream=dazhfiach15"></iframe>');
  assert.equal(players.length,1);
  assert.deepEqual(players[0].locator,{provider:'streamcenter',eventId:'401907993',linkId:'b953ed0c-6da3-4d0a-ae35-7e7db3e8072e',league:'mlb'});
  assert.equal(CandidateLocatorSchema.safeParse(players[0].locator).success,true);
});

test('MLB pages use verified routes and reject stale dated Buffstream rows',()=>{
  const event=`<section class="lg" id="g-cat-mlb-20261008"><a class="ev" href="/event/m-cleveland-guardians-vs-chicago-white-sox-1008" data-start="${now/1000}">Cleveland Guardians vs Chicago White Sox</a></section>`;
  for(const id of ['methstreams-mlb','crackstreams-mlb']){
    const row=parseListings(source(id),event,now);
    assert.equal(row.outcome,'parsed');
    assert.deepEqual(matchObservation(row.observations[0],[game],now),{kind:'matched',gameId:game.id});
  }
  const strikeout=parseListings(source('strikeout-mlb'),'<a href="/mlb/stream-cleveland-guardians-vs-chicago-white-sox-live">Cleveland Guardians vs Chicago White Sox</a>',now);
  assert.equal(strikeout.observations[0].league,'mlb');
  assert.equal(validEventPagePair(strikeout.observations[0].url,'https://strikeout.im/mlb/1/cleveland-guardians-vs-chicago-white-sox-stream'),true);
  const surge=parseListings(source('sportsurge'),'<a href="/watch/mlb-playoffs/cleveland-guardians-chicago-white-sox/453186920">Chicago White Sox vs Cleveland Guardians</a>',now);
  const datedSurge=enrichObservation(surge.observations[0],'<body>2026-10-08 17:00ET</body>');
  assert.equal(datedSurge.league,'mlb');
  assert.deepEqual(matchObservation(datedSurge,[game],now),{kind:'matched',gameId:game.id});
  const box=parseListings(source('mlbbox-mlb'),'<a href="/mlb/cleveland-guardians-vs-chicago-white-sox-stream"><h2>Cleveland Guardians vs Chicago White Sox</h2><time content="2026-10-08T22:00:00Z">6:00</time></a>',now);
  assert.equal(box.observations[0].league,'mlb');
  assert.deepEqual(box.observations[0].teams,['Cleveland Guardians','Chicago White Sox']);
  const channel=parseListings(source('mlbbox-mlb'),'<a href="/mlb/mlb-network-stream"><h2>MLB Network</h2></a>',now);
  assert.equal(channel.outcome,'parsed');
  assert.equal(channel.observations.length,1);
  assert.equal(channel.observations[0].teams,null);
  assert.deepEqual(matchObservation(channel.observations[0],[game],now),
    {kind:'unmatched',reason:'not-a-matchup',possibleGameIds:[]});
  const boxPage='<meta property="og:url" content="https://mlbbox.me/mlb/cleveland-guardians-vs-chicago-white-sox-stream"><h1>MLB Live: Cleveland Guardians vs Chicago White Sox Online</h1><script>const siteConfig = {"loaded_page":"stream","event_start_ts":1791493200};</script><textarea><iframe src="https://embedsports.me/baseball/cleveland-guardians-vs-chicago-white-sox-stream-1"></iframe></textarea>';
  const boxPlayers=compatiblePlayers(game.id,{...box.observations[0],kickoff:now},boxPage);
  assert.equal(boxPlayers.length,1);
  assert.equal(boxPlayers[0].locator.provider,'event-page');
  assert.equal(validEventPagePair(box.observations[0].url,'https://embedsports.me/ice-hockey/cleveland-guardians-vs-chicago-white-sox-stream-1'),false);
  const first='https://ms.buffstream.io/mlb-streams/cleveland-guardians-live-stream';
  const buff=parseListings(source('buffstream-mlb'),`<table><tr><td><a href="${first}">Cleveland Guardians Live Stream</a></td><td><h4>2026-10-07</h4><h4>04:00 pm ET</h4></td><td><a href="https://ms.buffstream.io/mlb-streams/chicago-white-sox-live-stream">Chicago White Sox Live Stream</a></td></tr></table>`,now);
  assert.equal(buff.observations[0].league,'mlb');
  assert.equal(matchObservation(buff.observations[0],[game],now).kind,'unmatched');
  const player='https://embedsports.me/baseball/chicago-white-sox-vs-cleveland-guardians-stream-2';
  assert.equal(validEventPagePair(first,player),true);
  assert.equal(validEventPagePair(first,player.replace('/baseball/','/ice-hockey/')),false);
});

test('MLB TVApp player keeps its baseball catalog identity through playback',async()=>{
  const match={id:'ppv-cleveland-guardians-vs-chicago-white-sox',title:'Cleveland Guardians vs Chicago White Sox',
    category:'baseball',date:now,sources:[{source:'admin',id:'ppv-cleveland-guardians-vs-chicago-white-sox'}]};
  const observation=parseListings(source('tvapp-mlb'),JSON.stringify([match]),now).observations[0];
  const watch=observation.url;
  const page=`<link rel="canonical" href="${watch}"><meta property="og:url" content="${watch}"><meta property="og:title" content="${match.title} - Live Stream Free in HD | TheTVApp"><meta name="description" content="Watch ${match.title} live stream free in HD on TheTVApp."><div id="player-frame"></div>`;
  const ref=match.sources[0];
  const stream={id:ref.id,source:ref.source,streamNo:1,language:'English',hd:true,
    embedUrl:`https://embed.st/embed/${ref.source}/${ref.id}/1`};
  const requested:string[]=[];
  const read=async(url:string)=>{requested.push(url);return JSON.stringify(url.endsWith('/matches/sport/baseball')?[match]:[stream]);};
  const players=await tvappPlayers(game.id,observation,page,new AbortController().signal,read);
  assert.equal(players.length,1);
  assert.deepEqual(requested,[source('tvapp-mlb').url,`https://api-backups.handleapi.win/streams/${ref.source}/${ref.id}`]);
  const locator=players[0].locator;
  assert.equal(locator.provider,'tvapp');
  if(locator.provider!=='tvapp')return;
  const playback={root:{kind:'playlist' as const,identity:'mlb-test',
    async read(){return {status:200 as const,body:null,contentType:'application/vnd.apple.mpegurl'};},
    resolve(){return null;}},close(){}};
  const provider=tvappProvider(async address=>{
    requested.push(address.href);
    return new Response(JSON.stringify(address.href.endsWith('/matches/sport/baseball')?[match]:[stream]),
      {headers:{'content-type':'application/json'}});
  },async destination=>{assert.equal(destination.href,stream.embedUrl);return playback;});
  await provider.open(locator,new AbortController().signal,'probe');
  assert.deepEqual(requested.slice(2),requested.slice(0,2));
});

test('same-team MLB doubleheaders stay ambiguous when source time fits both games',()=>{
  const second=parseScoreboard(scoreboard('401907994',espnTime-3600000),'mlb')[0];
  const row=parseListings(source('tvapp-mlb'),JSON.stringify([{id:'ppv-cleveland-guardians-vs-chicago-white-sox',
    title:'Cleveland Guardians vs Chicago White Sox',category:'baseball',date:now}]),now).observations[0];
  assert.deepEqual(matchObservation(row,[game,second],now),{kind:'unmatched',reason:'ambiguous-matchup',
    possibleGameIds:[game.id,second.id]});
});

test('older board values gain an empty MLB feed status',()=>{
  const status={scoresAt:new Date(now).toISOString(),sourceAt:null,errors:[]};
  const board=BoardSchema.parse({schemaVersion:2,revision:4,scheduleState:'ready',games:[],updatedAt:status.scoresAt,
    aliases:{},leagues:{nfl:status,ncaaf:status}});
  assert.deepEqual(board.leagues.mlb,{scoresAt:null,sourceAt:null,errors:[]});
});
