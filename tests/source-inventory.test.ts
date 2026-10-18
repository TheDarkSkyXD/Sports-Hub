import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { SourcesSnapshotSchema, type Candidate, type DetailEvidence, type Game, type Observation } from '../lib/football/shared.ts';
import { SOURCE_REGISTRY } from '../lib/football/source-registry.ts';
import {detailIdentity} from '../lib/football/domain/source-policy.ts';

const at=Date.parse('2026-09-26T21:30:00Z');
const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const florida:Game={id:'ncaaf-401856699',league:'ncaaf',name:'Ole Miss at Florida',date:'2026-09-26T19:30:00Z',
  home:team('Florida Gators','espn:ncaaf:57'),away:team('Ole Miss Rebels','espn:ncaaf:145'),
  status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fbs']};
const georgia:Game={...florida,id:'ncaaf-401856700',name:'Oklahoma at Georgia',
  home:team('Georgia Bulldogs','espn:ncaaf:61'),away:team('Oklahoma Sooners','espn:ncaaf:201')};
const finished:Game={...florida,id:'ncaaf-401856701',status:'post',lifecycle:'final',
  name:'Indiana State at North Dakota',home:team('North Dakota Fighting Hawks','espn:ncaaf:155'),
  away:team('Indiana State Sycamores','espn:ncaaf:282'),
  finalObservedAt:at-1000,graceEndsAt:at+299000};
const observed=(id:string,sourceId:string,url:string,teams:[string,string],observedAt=at):Observation=>({
  id,sourceId,url,title:teams.join(' vs '),league:'ncaaf',teams,kickoff:Date.parse('2026-09-26T19:30:00Z'),
  rawTime:'2026-09-26T19:30:00Z',observedAt,parserVersion:1,
});
const candidate=(id:string,sourceIds:string[],observedAt=at):Candidate=>({
  id,gameId:florida.id,label:'Primary',sourceIds,observedAt,locator:{provider:'gooz',playerId:'57069'},
});

test('resolved link evidence stays collected through its settle deadline without extending failed details',()=>{
  const observation=observed('fixture:one','fixture','https://fixture.example/game',
    ['Ole Miss Rebels','Florida Gators'],at+60000);
  const feed=candidate('resolved',['fixture']);
  const detail:DetailEvidence={outcome:'resolved',observationId:observation.id,generation:'fixture',identity:detailIdentity(observation),
    at,players:[{id:feed.id,label:feed.label,locator:feed.locator}],nextEligibleAt:at+1800000,event:{gameId:florida.id,date:florida.date??null}};
  const inspect=(elapsed:number,value:DetailEvidence)=>sourceInventory({at:at+elapsed,revision:1,lastDiscoveryAt:at+60000,browserCollectorsAvailable:false,
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['ncaaf']}],observations:[observation],games:[florida],
    candidates:new Map([[florida.id,[feed]]]),candidateEligible:()=>true,availability:()=>({kind:'unknown'}),details:[value],
    attempts:{fixture:{at:at+60000,outcome:'parsed',count:1,failures:0,nextEligibleAt:at+1860000}},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}});
  for(const [elapsed,expected] of [[1800000,'collected'],[1860000,'collected'],[1860001,'pending']] as const){
    const snapshot=inspect(elapsed,detail);
    assert.equal(snapshot.sources[0].scopes[0].read.kind,'complete');
    assert.equal(snapshot.sources[0].links[0].evidence.kind,expected,`detail age ${elapsed}`);
    assert.equal(snapshot.games[0].candidates.length,1);
  }
  const generation=JSON.stringify([observation.sourceId,observation.url,observation.teams,observation.kickoff,observation.observedAt,observation.parserVersion]);
  const failed:DetailEvidence={outcome:'failed',observationId:observation.id,generation,at,failures:1,failure:'network-unavailable',nextEligibleAt:at+1800000};
  assert.equal(inspect(1800000,failed).sources[0].links[0].evidence.kind,'failed');
  assert.equal(inspect(1800001,failed).sources[0].links[0].evidence.kind,'pending');
  assert.equal(inspect(1800000,{...detail,at:at+1860001}).sources[0].links[0].evidence.kind,'pending');
  assert.equal(inspect(1800000,{...detail,identity:'changed-owner'}).sources[0].links[0].evidence.kind,'pending');
});

test('source league scopes open their public category while retaining collector endpoints',()=>{
  const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:null,browserCollectorsAvailable:true,
    sources:SOURCE_REGISTRY,observations:[],games:[],candidates:new Map(),attempts:{},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}});
  const expected=[
    ['sportsfeed24','nfl',['https://sportsfeed24.st/streams/nfl']],
    ['sportsfeed24','ncaaf',['https://sportsfeed24.st/']],
    ['sportsfeed24','nascar-cup',['https://sportsfeed24.st/streams/F1']],
    ['sportsfeed24','ufc',['https://sportsfeed24.st/streams/mma']],
    ['sportsfeed24','boxing',['https://sportsfeed24.st/streams/Boxing']],
    ['tvapp','nfl',['https://tvapp1.pk/nfl-streams','https://thetvapp.st/nfl-streams']],
    ['tvapp','ncaaf',['https://tvapp1.pk/cfb-streams','https://thetvapp.st/cfb-streams']],
    ['tvapp-nba','nba',['https://tvapp1.pk/nba-streams','https://thetvapp.st/nba-streams']],
    ['tvapp-nba','wnba',['https://tvapp1.pk/','https://thetvapp.st/']],
    ['ppv','nba',['https://ppv.st/#37','https://ppv.tj/#37','https://ppvs.pk/#37','https://ppv.rw/#37','https://ppv.ms/#37','https://ppv.bi/#37','https://ppv.ug/#37']],
    ['ppv','nhl',['https://ppv.st/#39','https://ppv.tj/#39','https://ppvs.pk/#39','https://ppv.rw/#39','https://ppv.ms/#39','https://ppv.bi/#39','https://ppv.ug/#39']],
    ['streameast','nfl',['https://v2.streameast.ga/nfl-streams/']],
    ['sportsurge-v2','nba',['https://v2.sportsurge.net/watch-basketball-streams/']],
    ['streamed','ufc',['https://streamed.st/category/fight']],
    ['livesportpro','nfl',['https://livesportpro.com/#american-football']],
    ['crichd','motogp',['https://crichd.pk/sports/motogp-streams']],
    ['streamcenter-nba','nba',['https://streame.center/']],
  ] as const;
  for(const [id,league,urls] of expected) {
    const source=snapshot.sources.find(source=>source.id===id);
    assert.ok(source,id);
    assert.deepEqual(source.scopes.find(scope=>scope.league===league)?.publicUrls,[...urls],`${id}/${league}`);
  }
  const sportsfeed=snapshot.sources.find(source=>source.id==='sportsfeed24');
  assert.equal(sportsfeed?.catalogUrl,'https://bestfreestreaming.app/api/xhr');
  assert.deepEqual(sportsfeed?.publicUrls,['https://sportsfeed24.st/']);
  assert.equal(SourcesSnapshotSchema.safeParse(snapshot).success,true);
  for(const source of snapshot.sources) {
    assert.deepEqual(source.scopes.map(scope=>scope.league),source.leagues);
    for(const scope of source.scopes)assert.ok(scope.publicUrls.length>0,`${source.id}/${scope.league}`);
  }
});

test('source scopes preserve an explicit absence of public links',()=>{
  const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:null,browserCollectorsAvailable:false,
    sources:[{id:'private-catalog',family:'catalog',url:'https://api.example/events',publicUrls:[],leagues:['nfl']}],
    observations:[],games:[],candidates:new Map(),attempts:{},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}});
  assert.equal(snapshot.sources[0].catalogUrl,'https://api.example/events');
  assert.deepEqual(snapshot.sources[0].publicUrls,[]);
  assert.deepEqual(snapshot.sources[0].scopes[0].publicUrls,[]);
});

test('source snapshot retains stale live listings without counting them as compatible feeds',()=>{
  const sources=[
    {id:'tvapp',url:'https://api-backups.handleapi.win/matches/sport/american-football',family:'tvapp',kind:'catalog' as const,
      name:'TVApp',publicUrls:['https://tvapp1.com/cfb-streams','https://thetvapp67.st/cfb-streams']},
    {id:'sportsurge',url:'https://isportsurge.ws/index6',family:'sportsurge'},
    {id:'old-source',url:'https://old.example/schedule',family:'unknown'},
    {id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'pending' as const},
  ];
  const first='https://tvapp1.com/watch/2498829';
  const second='https://isportsurge.ws/watch/cfb/florida-ole-miss/123';
  const observations=[
    observed('tvapp:one','tvapp',first,['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:duplicate','tvapp',first,['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:query','tvapp',first+'?channel=backup',['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:safe-query','tvapp',first+'?stream=alt&start=10',['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:fragment-one','tvapp',first+'#feed=one',['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:fragment-two','tvapp',first+'#feed=two',['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:private','tvapp',first+'?token=private',['Florida Gators','Ole Miss Rebels']),
    observed('tvapp:private-fragment','tvapp',first+'#token=private',['Florida Gators','Ole Miss Rebels']),
    observed('sportsurge:one','sportsurge',second,['Florida Gators','Ole Miss Rebels']),
    observed('old:stale','old-source','https://old.example/watch/1',['Florida Gators','Ole Miss Rebels'],at-31*60_000),
    observed('tvapp:georgia','tvapp','https://tvapp1.com/watch/2498830',['Georgia Bulldogs','Oklahoma Sooners']),
    observed('tvapp:final','tvapp','https://tvapp1.com/watch/final',['North Dakota Fighting Hawks','Indiana State Sycamores']),
    observed('tvapp:stale','tvapp','https://tvapp1.com/watch/stale',['Florida Gators','Ole Miss Rebels'],at-31*60_000),
    observed('tvapp:unsafe','tvapp','https://edgestream4.pro/hls/private.m3u8?st=secret',['Florida Gators','Ole Miss Rebels']),
  ];
  const snapshot=sourceInventory({at,revision:7,lastDiscoveryAt:at-1000,sources,observations,
    availability:()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}),
    games:[florida,georgia,finished],candidates:new Map([[florida.id,[candidate('gooz-57069',['tvapp','sportsurge','old-source']),
      candidate('gooz-57069',['tvapp']),candidate('old',['tvapp'],at-31*60_000)]]]),
    attempts:{tvapp:{at,outcome:'parsed'},sportsurge:{at,outcome:'failed'}},browserCollectorsAvailable:false,
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}});
  assert.equal(SourcesSnapshotSchema.safeParse(snapshot).success,true);
  assert.equal(snapshot.browserCollectorsAvailable,false);
  assert.equal(snapshot.sources[0].listingCount,7);
  assert.equal(snapshot.sources[0].staleListingCount,1);
  assert.equal(snapshot.sources[0].links.find(link=>link.url==='https://tvapp1.com/watch/stale')?.freshness,'stale-live');
  assert.ok(snapshot.sources[0].links.some(link=>link.url===first+'?channel=backup'));
  assert.ok(snapshot.sources[0].links.some(link=>link.url===first+'?stream=alt&start=10'));
  assert.ok(snapshot.sources[0].links.some(link=>link.url===first+'#feed=one'));
  assert.ok(snapshot.sources[0].links.some(link=>link.url===first+'#feed=two'));
  assert.equal(snapshot.sources[0].matchedGameCount,2);
  assert.equal(snapshot.sources[1].listingCount,1);
  assert.equal(snapshot.sources[2].listingCount,1);
  assert.equal(snapshot.sources[2].staleListingCount,1);
  assert.equal(snapshot.sources[2].compatibleFeedCount,0);
  assert.equal(snapshot.sources[3].pending,true);
  assert.equal(snapshot.sources[3].lastAttempt,null);
  assert.equal(snapshot.games.find(game=>game.gameId===florida.id)?.sourceCount,3);
  assert.equal(snapshot.games.find(game=>game.gameId===florida.id)?.uniqueFeedCount,1);
  assert.equal(snapshot.games.find(game=>game.gameId===georgia.id)?.uniqueFeedCount,0);
  assert.equal(snapshot.games.some(game=>game.gameId===finished.id),false);
  const serialized=JSON.stringify(snapshot);
  assert.equal(serialized.includes('token=private'),false);
  assert.equal(serialized.includes('edgestream4.pro'),false);
  assert.equal(serialized.includes('playerId'),false);
});

test('scheduled games publish fresh selectable servers without exposing locators',()=>{
  const scheduled:Game={...florida,status:'pre',lifecycle:'scheduled'};
  const fresh={...candidate('fresh',['sportsurge-v2']),gameId:scheduled.id};
  const stale={...candidate('stale',['sportsurge-v2'],at-31*60_000),gameId:scheduled.id};
  const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:null,browserCollectorsAvailable:true,
    availability:()=>({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}),
    sources:[],observations:[],games:[scheduled,finished],candidates:new Map([[scheduled.id,[fresh,stale]],
      [finished.id,[{...fresh,gameId:finished.id}]]]),attempts:{},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}});
  assert.equal(SourcesSnapshotSchema.safeParse(snapshot).success,true);
  assert.deepEqual(snapshot.games.map(game=>game.gameId),[scheduled.id]);
  assert.deepEqual(snapshot.games[0].candidates,[{id:fresh.id,gameId:scheduled.id,label:fresh.label,
    sourceIds:fresh.sourceIds,observedAt:fresh.observedAt,availability:{kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at}}]);
  assert.equal(JSON.stringify(snapshot).includes('playerId'),false);
});

test('LiveSportPro keeps distinct event links for matched and unclassified listings',()=>{
  const urls=[
    'https://api.kultsport.com/api/matches/all#florida-ole-miss-a',
    'https://api.kultsport.com/api/matches/all#florida-ole-miss-b',
    'https://api.kultsport.com/api/matches/all#unknown-game-a',
    'https://api.kultsport.com/api/matches/all#unknown-game-b',
  ];
  const observations=[
    observed('lsp:one','livesportpro',urls[0],['Florida Gators','Ole Miss Rebels']),
    observed('lsp:two','livesportpro',urls[1],['Florida Gators','Ole Miss Rebels']),
    observed('lsp:three','livesportpro',urls[2],['Unknown A','Unknown B']),
    observed('lsp:four','livesportpro',urls[3],['Unknown C','Unknown D']),
  ];
  const snapshot=sourceInventory({at,revision:1,lastDiscoveryAt:at,browserCollectorsAvailable:true,
    sources:[{id:'livesportpro',url:'https://api.kultsport.com/api/matches/all',family:'livesportpro',
      kind:'catalog',publicUrls:['https://livesportpro.com/'],leagues:['ncaaf']}],
    observations,games:[florida],candidates:new Map(),attempts:{livesportpro:{at,outcome:'parsed'}},
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},
    streameastCatalog:{current:null,lastComplete:null,previous:null}});
  assert.deepEqual(snapshot.sources[0].links.map(link=>link.url),urls);
  assert.deepEqual(snapshot.games[0].sourceLinks.map(link=>link.url),urls.slice(0,2));
  assert.deepEqual(snapshot.sources[0].links.filter(link=>link.gameId===null).map(link=>link.url),urls.slice(2));
});
