import assert from 'node:assert/strict';
import test from 'node:test';
import {parseListings,allowedDiscoveryUrl,compatiblePlayers,createFixtureCollector} from '../lib/football/adapters/sources.ts';
import {SOURCE_REGISTRY} from '../lib/football/source-registry.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {sourceInventory} from '../lib/football/domain/source-inventory.ts';
import type {Game} from '../lib/football/shared.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const at=Date.parse('2026-10-12T14:00:00Z');
const capturedWnbaEventCard='<section class="lg" id="g-cat-nba-20261019"><a class="ev ev-plain" href="/event/m-atlanta-dream-vs-golden-state-valkyries-wnba-finals-game-2-1020" title="Atlanta Dream vs Golden State Valkyries (WNBA Finals Game 2)" data-start="1792454400"><span class="ev-t">Atlanta Dream vs Golden State Valkyries (WNBA Finals Game 2)</span><time datetime="2026-10-20T00:00:00Z">00:00 UTC</time></a></section>';

function source(id:string){
  const value=SOURCE_REGISTRY.find(source=>source.id===id);
  assert.ok(value,`Registered source ${id}`);
  return value;
}

test('PPV inventory exposes every published mirror in each supported category without duplicate collectors',()=>{
  const ppv=source('ppv');
  const item=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,sources:[ppv],
    observations:[],games:[],candidates:new Map(),attempts:{},sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}}).sources[0];
  assert.deepEqual(item.scopes.find(scope=>scope.league==='nba')?.publicUrls,
    ['https://ppv.st/#37','https://ppv.tj/#37','https://ppvs.pk/#37','https://ppv.rw/#37','https://ppv.ms/#37','https://ppv.bi/#37','https://ppv.ug/#37']);
  assert.equal(SOURCE_REGISTRY.filter(row=>row.family==='ppv').length,1);
});

test('Buffstreams collects dated NBA cards and preserves basketball coverage from its mirror',()=>{
  const html='<section class="hs" id="s-nba"><a class="hr hr-m" href="/event/m-washington-wizards-vs-brooklyn-nets-1012" title="Washington Wizards vs Brooklyn Nets" data-start="1791838800"><span class="hr-nm">Washington Wizards</span><span class="hr-nm">Brooklyn Nets</span><time datetime="2026-10-12T21:00:00Z"></time></a></section>';
  const result=parseListings(source('buffstreams'),html,at);
  assert.deepEqual(result.observations.map(row=>[row.league,row.teams,row.url,row.kickoff]),
    [['nba',['Washington Wizards','Brooklyn Nets'],'https://buffstreams.ch/event/m-washington-wizards-vs-brooklyn-nets-1012',1791838800000]]);
});

test('Trend48 inline schedule excludes soccer and permanent channels from supported dated events',()=>{
  const html='<script>var EVENTS={"byDate":{"2026-10-12":{"basketball":[{"t":"Washington Wizards vs Brooklyn Nets","pathPart":"m-washington-wizards-vs-brooklyn-nets-1012","start":1791838800000}],"football":[{"t":"Coventry City vs Newcastle United","pathPart":"soccer-123","start":1791838800000}],"american-football":[{"t":"NFL Network","pathPart":"ppv-nfl-network","start":0}]}},"dates":["2026-10-12"]};</script>';
  const result=parseListings(source('trend48'),html,at);
  assert.deepEqual(result.observations.map(row=>[row.league,row.title,row.kickoff]),[['nba','Washington Wizards vs Brooklyn Nets',1791838800000]]);
});

test('NBABitez collects published team cards and rejects navigation links',()=>{
  const html='<a class="match-card" href="/Washington-Wizards-vs-Brooklyn-Nets/74857"><span class="team-name">Washington Wizards</span><span class="team-name">Brooklyn Nets</span></a><a href="/teams/Atlanta-Hawks-live-stream/">Atlanta Hawks</a>';
  const result=parseListings(source('nbabitez'),html,at);
  assert.deepEqual(result.observations.map(row=>[row.league,row.teams,row.kickoff]),[['nba',['Washington Wizards','Brooklyn Nets'],null]]);
});

test('new discovery policies admit published catalogs and reject unrelated paths',()=>{
  for(const url of ['https://buffstreams.ch/','https://buffstreams.ch/NBA','https://trend48.st/',
    'https://trend48.st/event/m-washington-wizards-vs-brooklyn-nets-1012','https://nbabitez.com/Washington-Wizards-vs-Brooklyn-Nets/74857'])
    assert.equal(allowedDiscoveryUrl(url),true,url);
  for(const url of ['https://buffstreams.ch/login','https://trend48.st/login','https://nbabitez.com/teams/Atlanta-Hawks-live-stream/'])
    assert.equal(allowedDiscoveryUrl(url),false,url);
});

test('IHD microdata and Dude articles preserve published match times rather than post dates',()=>{
  const ihd='<article class="game-card"><a href="watch/oklahoma-city-thunder-at-atlanta-hawks"><meta itemprop="name" content="Oklahoma City Thunder at Atlanta Hawks"></a><div data-event-time="1791846000"></div></article>';
  const dude='<article class="category-nba category-schedule"><a class="link-div" href="https://dudestream1.com/nba1/"></a><h4 class="entry-title"><a href="https://dudestream1.com/nba1/">Oklahoma City Thunder vs Atlanta Hawks</a></h4><span class="mg-blog-date">October 12, 2026</span></article>';
  assert.deepEqual(parseListings(source('ihdstreams-nba'),ihd,at).observations.map(row=>[row.league,row.teams,row.kickoff]),
    [['nba',['Oklahoma City Thunder','Atlanta Hawks'],1791846000000]]);
  assert.deepEqual(parseListings(source('dudestream-nba'),dude,at).observations.map(row=>[row.league,row.teams,row.kickoff]),
    [['nba',['Oklahoma City Thunder','Atlanta Hawks'],null]]);
});

test('mirror catalogs reuse Buffstream events and expose the existing vetted player',()=>{
  const listing='<a href="https://ms.buffstream.io/nba-streams/washington-wizards-live-stream"><h4>Washington Wizards vs Brooklyn Nets</h4><p>2026-10-12, Monday - 07:00 pm ET</p></a>';
  const result=parseListings(source('markkystreams-nba'),listing,at);
  assert.deepEqual(result.observations.map(row=>[row.league,row.kickoff]),[['nba',1791846000000]]);
  const detail='<link rel="canonical" href="https://ms.buffstream.io/nba-streams/washington-wizards-live-stream"><iframe src="https://embedsports.me/basketball/washington-wizards-vs-brooklyn-nets-stream-1"></iframe>';
  assert.equal(compatiblePlayers('nba-game',result.observations[0],detail)[0]?.locator.provider,'event-page');
});

test('SportSupa keeps its API origin when resolving catalog details',async()=>{
  const collector=createFixtureCollector();
  const catalog=JSON.stringify([{id:'nba-wizards-nets',title:'Washington Wizards vs Brooklyn Nets',category:'nba',date:1791846000000,
    teams:{home:{name:'Washington Wizards'},away:{name:'Brooklyn Nets'}},sources:[{source:'hotel',id:'nba-wizards-nets'}]}]);
  assert.equal(collector.allowedDiscoveryUrl(source('sportsupa').url),true);
  collector.enqueueFixture({url:source('sportsupa').url,body:catalog});
  assert.equal(await collector.readHtml(source('sportsupa').url,new AbortController().signal),catalog);
  const result=collector.parseListings(source('sportsupa'),catalog,at);
  assert.equal(result.observations[0]?.url,'https://streamed.pk/watch/nba-wizards-nets');
  const detail=await collector.readHtml('https://streamed.pk/watch/nba-wizards-nets',new AbortController().signal);
  assert.equal(JSON.parse(detail).id,'nba-wizards-nets');
  const reads:string[]=[];
  const players=await collector.resolvePlayers('nba-game',result.observations[0],detail,new AbortController().signal,async url=>{
    reads.push(url);
    return JSON.stringify([{id:'nba-wizards-nets',streamNo:1,embedUrl:'https://embed.st/embed/hotel/nba-wizards-nets/1',source:'hotel'}]);
  });
  assert.deepEqual(reads,['https://streamed.pk/api/stream/hotel/nba-wizards-nets']);
  assert.equal(players[0]?.locator.provider,'catalog-stream');
});

test('Sportsurgei retains the published date and separates mixed fight and racing listings',()=>{
  const card=(path:string,left:string,right:string,date:string)=>`<a href="https://sportsurgei.is/${path}/74857"><div class="col-4 text-right"><span>${left}</span></div><div class="col-3 text-center">${date} 11:00 PM</div><div class="col-5 text-left"><span>${right}</span></div></a>`;
  const result=parseListings(source('sportsurgei-nba'),card('Wizards-vs-Nets','Washington Wizards','Brooklyn Nets','2026-10-12')+
    card('Wizards-vs-Nets-future','Washington Wizards','Brooklyn Nets','2026-12-12'),at);
  assert.deepEqual(result.observations.map(row=>[row.league,row.kickoff]),[['nba',1791846000000]]);
  const fights=parseListings(source('sportsurgei-boxing'),card('UFC-Fight-Night','UFC Fight Night Buckley','Mike Malott','2026-10-17')+
    card('Daniel-Dubois-vs-Fabio-Wardley','Daniel Dubois','Fabio Wardley','2026-10-17'),at);
  assert.deepEqual(fights.observations.map(row=>row.league),['ufc','boxing']);
});

test('IOHIT exposes its published hotel and numeric provider feeds',()=>{
  const row=parseListings(source('iohit'),'<a class="event-card" data-href="https://iohit.st/event/washington-wizards-vs-brooklyn-nets-2601641"><div><span>Basketball</span></div><h3>Washington Wizards vs Brooklyn Nets</h3></a>',at).observations[0];
  assert.ok(row);
  const hotel='https://embed.st/embed-noads/hotel/brooklyn-nets-vs-washington-wizards-nba-1791846000/1#player=clappr';
  const html=`<iframe src="https://embed.st/embed-noads/golf/2193/1#player=clappr"></iframe><button class="feed-btn" data-url="${hotel}">Server 2</button>`;
  assert.deepEqual(compatiblePlayers('nba-game',row,html).map(player=>player.locator.provider),['event-page','event-page']);
  assert.equal(validEventPagePair(row.url,hotel),true);
  assert.equal(validEventPagePair(row.url,'https://embed.st/embed-noads/golf/2193/1#player=clappr'),true);
});

test('MLBBite reports its motorsport channel-only board as an empty event catalog',()=>{
  const html='<section class="panel"><h2 class="panel-title">Motorsports Streams</h2><a class="gc" href="/formula-1-live-channel">Formula 1 Live Channel</a></section>';
  const result=parseListings(source('mlbbite-motor-sports'),html,at);
  assert.deepEqual(result,{observations:[],outcome:'empty'});
});

test('published NBA catalogs classify an explicit WNBA Finals card without changing NBA cards',()=>{
  const now=Date.parse('2026-10-18T14:00:00Z');
  const wnbaTitle='Atlanta Dream vs Golden State Valkyries (WNBA Finals Game 2)';
  const mlbbite=`<section class="panel"><h2 class="panel-title">NBA Streams</h2>
    <a class="gc" href="/atlanta-dream-vs-golden-state-valkyries-wnba-finals-game-2" title="${wnbaTitle}" data-ts="1792454400">
      <span class="gc-name">Atlanta Dream</span><span class="gc-name">Golden State Valkyries</span>
      <time datetime="2026-10-20T00:00:00Z">8:00 PM ET</time><div class="gc-kick">WNBA Finals Game 2</div>
    </a>
    <a class="gc" href="/boston-celtics-vs-detroit-pistons" title="Boston Celtics vs Detroit Pistons" data-ts="1792458000">
      <span class="gc-name">Boston Celtics</span><span class="gc-name">Detroit Pistons</span>
    </a></section>`;
  const rows=parseListings(source('mlbbite-nba'),mlbbite,now).observations;
  assert.deepEqual(rows.map(row=>[row.league,row.teams,row.kickoff]),[
    ['wnba',['Atlanta Dream','Golden State Valkyries'],1792454400000],
    ['nba',['Boston Celtics','Detroit Pistons'],1792458000000],
  ]);

  const team=(id:string,name:string):Game['home']=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:null});
  const game:Game={id:'wnba-401918306',league:'wnba',name:'Atlanta Dream at Golden State Valkyries',
    date:'2026-10-20T00:00Z',away:team('espn:wnba:20','Atlanta Dream'),home:team('espn:wnba:21','Golden State Valkyries'),
    status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,partitions:['wnba']};
  assert.deepEqual(matchObservation(rows[0], [game], now),{kind:'matched',gameId:game.id});
});

test('event-family NBA catalogs use an explicit WNBA title and remove its competition suffix from team identity',()=>{
  const now=Date.parse('2026-10-18T14:00:00Z');
  const rows=parseListings(source('methstreams-nba'),capturedWnbaEventCard,now).observations;
  assert.deepEqual(rows.map(row=>[row.league,row.teams,row.kickoff]),
    [['wnba',['Atlanta Dream','Golden State Valkyries'],1792454400000]]);
});

test('an NFL event catalog cannot emit an explicit WNBA card',()=>{
  const rows=parseListings(source('methstreams'),capturedWnbaEventCard,Date.parse('2026-10-18T14:00:00Z')).observations;
  assert.deepEqual(rows,[]);
});
