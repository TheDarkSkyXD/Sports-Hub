import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock,test} from 'node:test';
import {parseListings,readHtml,resolvePlayers,missingPlayerReason,SOURCES,allowedDiscoveryUrl} from '../lib/football/adapters/sources.ts';
import {PartialListingReadError} from '../lib/football/domain/ports.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';
import {durableCatalogStream,catalogStreamProvider} from '../lib/playback/providers/catalog-stream.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {CommandSchema,type Game} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T21:10:00Z');
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/broad-sources/${name}`,import.meta.url),'utf8');
const source=(id:string)=>SOURCES.find(item=>item.id===id)!;
const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});

test('captured catalogs normalize dated events and leave stale channels out',()=>{
  const cases=[
    ['streamed','streamed.json'],['livesportpro','livesportpro.json'],
    ['sportsbite','sportsbite.json'],['crichd','crichd-home.html'],
  ] as const;
  for(const [id,name] of cases){
    const result=parseListings(source(id),fixture(name),at);
    assert.equal(result.outcome,'parsed',id);
    assert.ok(result.observations.length>0,id);
    assert.ok(result.observations.every(row=>row.kickoff!==null&&row.kickoff>=Date.UTC(2000,0,1)),id);
  }
  const feed=JSON.stringify([JSON.parse(fixture('sportsfeed24-today.json')),
    JSON.parse(fixture('sportsfeed24-NFL.json')),JSON.parse(fixture('sportsfeed24-F1.json'))]);
  const result=parseListings(source('sportsfeed24'),feed,at);
  assert.equal(result.outcome,'parsed');
  assert.ok(result.observations.length>0);
  assert.ok(result.observations.every(row=>row.url.startsWith('https://sportsfeed24.st/fixture/')));
  assert.ok(result.observations.some(row=>row.title==='F1 Singapore Grand Prix vs Live'&&row.league==='f1'));
});

test('Streamed listing matches one game and resolves a durable player reference',async()=>{
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  assert.ok(observation);
  const game:Game={id:'401892458',league:'nhl',name:observation.title,date:new Date(observation.kickoff!).toISOString(),
    away:team('Buffalo Sabres'),home:team('Dallas Stars'),status:'pre',lifecycle:'scheduled',detail:'',redzone:false};
  assert.deepEqual(matchObservation(observation,[game],at),{kind:'matched',gameId:game.id});
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  const players=await resolvePlayers(game.id,observation,JSON.stringify(event),new AbortController().signal,async url=>{
    if(url.endsWith('/golf/2123'))return JSON.stringify([{id:'2123',streamNo:1,source:'golf',
      embedUrl:'https://embed.st/embed/golf/2123/1'}]);
    return '[]';
  });
  assert.equal(players.length,1,JSON.stringify(observation));
  assert.equal(players[0].locator.provider,'catalog-stream');
  if(players[0].locator.provider==='catalog-stream')assert.equal(durableCatalogStream(players[0].locator),true);
});

test('a captured catalog travels through matching, detail, candidate, and source inventory',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'broad-source-pipeline-'));
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  const game:Game={id:'401892458',league:'nhl',name:observation.title,date:new Date(observation.kickoff!).toISOString(),
    away:team('Buffalo Sabres'),home:team('Dallas Stars'),status:'pre',lifecycle:'scheduled',detail:'',redzone:false};
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,schedules:[{id:'nhl',league:'nhl',path:'',group:null}],sources:[source('streamed')],
    readSchedule:async schedule=>({league:schedule.league,games:[game],at}),
    readHtml:async url=>url===source('streamed').url?body:JSON.stringify(event),
    resolvePlayers:(gameId,row,detail,signal)=>resolvePlayers(gameId,row,detail,signal,async url=>
      url.endsWith('/golf/2123')?JSON.stringify([{id:'2123',streamNo:1,source:'golf',
        embedUrl:'https://embed.st/embed/golf/2123/1'}]):'[]'),
    probeCandidate:async()=>({kind:'unavailable',reason:'no-feed'}),
  });
  try{
    await coordinator.refresh();
    for(let index=0;index<30;index++)await new Promise<void>(resolve=>setImmediate(resolve));
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      const row=reply.snapshot.games.find(item=>item.gameId===game.id)!;
      assert.ok(row);
      assert.equal(row.sourceLinks.some(link=>link.sourceId==='streamed'&&link.evidence.kind==='collected'),true);
      assert.equal(row.candidates.some(candidate=>candidate.label.startsWith('Streamed · golf')),true);
    }
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('catalog playback rejects reassigned event before requesting a stream',async()=>{
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  const players=await resolvePlayers('401892458',observation,JSON.stringify(event),new AbortController().signal,async url=>
    url.endsWith('/golf/2123')?JSON.stringify([{id:'2123',streamNo:1,source:'golf',embedUrl:'https://embed.st/embed/golf/2123/1'}]):'[]');
  const locator=players[0].locator;
  assert.equal(locator.provider,'catalog-stream');
  if(locator.provider!=='catalog-stream')return;
  let reads=0;
  const requester=async()=>{
    reads++;
    const changed=JSON.parse(body);
    const row=changed.find((item:{id:string})=>item.id===locator.eventId);
    row.teams.home.name='Other Team';
    return new Response(JSON.stringify(changed),{headers:{'content-type':'application/json'}});
  };
  await assert.rejects(catalogStreamProvider(requester).open(locator,new AbortController().signal),/event changed/);
  assert.equal(reads,1);
});

test('concurrent catalog candidates share one fresh read and cancel independently',async()=>{
  const event={id:'buffalo-sabres-vs-dallas-stars-2591545',title:'Buffalo Sabres vs Dallas Stars',
    date:Date.parse('2026-10-08T23:00:00Z'),teams:{home:{name:'Buffalo Sabres'},away:{name:'Dallas Stars'}},
    sources:[{source:'sp:golf',id:'2123'}]};
  const locator={provider:'catalog-stream' as const,gameId:'401892458',source:'livesportpro' as const,
    eventUrl:`https://api.kultsport.com/api/matches/all#${event.id}`,eventId:event.id,sourceName:'sp:golf',sourceId:'2123',
    streamNo:1,kickoff:event.date,title:event.title,teams:['Buffalo Sabres','Dallas Stars'] as [string,string]};
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let clock=100_000;
  const nowMock=mock.method(Date,'now',()=>clock);
  let catalogReads=0,streamReads=0;
  const direct='https://lb29.strmd.st/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ingest/stream/streamedbuffalosabres/1/playlist.m3u8';
  const requester=async(url:URL)=>{
    if(url.pathname==='/api/matches/all'){
      catalogReads++;
      if(catalogReads===1)await gate;
      return new Response(JSON.stringify([{...event,title:catalogReads===1?event.title:'Other Event'}]),
        {headers:{'content-type':'application/json'}});
    }
    streamReads++;
    return new Response(JSON.stringify([1,2].map(streamNo=>({id:'2123',streamNo,source:'streamed',embedUrl:direct}))),
      {headers:{'content-type':'application/json'}});
  };
  try{
    const provider=catalogStreamProvider(requester);
    const firstSignal=new AbortController();
    const first=provider.open(locator,firstSignal.signal,'probe');
    const second=provider.open({...locator,streamNo:2},new AbortController().signal,'probe');
    firstSignal.abort(new Error('caller canceled'));
    await assert.rejects(first,/caller canceled/);
    release();
    const playback=await second;
    assert.equal(playback.root.identity,direct);
    assert.equal(catalogReads,1);
    assert.equal(streamReads,1);
    playback.close();
    const next=await provider.open(locator,new AbortController().signal,'probe');
    assert.equal(next.root.identity,direct);
    assert.equal(catalogReads,1);
    next.close();
    await assert.rejects(provider.open(locator,new AbortController().signal),/event changed/);
    assert.equal(catalogReads,2);
    clock+=15_001;
    await assert.rejects(provider.open(locator,new AbortController().signal,'probe'),/event changed/);
    assert.equal(catalogReads,3);
  }finally{nowMock.mock.restore();release();}
});

test('a canceled or failed shared catalog read is discarded before the next open',async()=>{
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  event.sources=[{source:'golf',id:'2123'}];
  const players=await resolvePlayers('401892458',observation,JSON.stringify(event),new AbortController().signal,async()=>
    JSON.stringify([{id:'2123',streamNo:1,source:'golf',embedUrl:'https://embed.st/embed/golf/2123/1'}]));
  const locator=players[0].locator;
  assert.equal(locator.provider,'catalog-stream');
  if(locator.provider!=='catalog-stream')return;
  let reads=0,upstreamAborts=0;
  const requester=async(_url:URL,signal:AbortSignal)=>{
    reads++;
    if(reads===1)return new Promise<Response>((_resolve,reject)=>{
      const abort=()=>{upstreamAborts++;reject(signal.reason);};
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
    if(reads===2)return new Response('{}',{headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify([{...event,title:'Other Event'}]),{headers:{'content-type':'application/json'}});
  };
  const provider=catalogStreamProvider(requester);
  const firstSignal=new AbortController(),secondSignal=new AbortController();
  const first=provider.open(locator,firstSignal.signal,'probe');
  const second=provider.open(locator,secondSignal.signal,'probe');
  firstSignal.abort(new Error('first canceled'));
  await assert.rejects(first,/first canceled/);
  assert.equal(upstreamAborts,0);
  secondSignal.abort(new Error('second canceled'));
  await assert.rejects(second,/second canceled/);
  assert.equal(upstreamAborts,1);
  await assert.rejects(provider.open(locator,new AbortController().signal,'probe'),/Catalog stream changed/);
  await assert.rejects(provider.open(locator,new AbortController().signal,'probe'),/event changed/);
  assert.equal(reads,3);
});

test('LiveSportPro keeps its scoped source reference while direct HLS is resolved only at open',async()=>{
  const body=fixture('livesportpro.json');
  const observation=parseListings(source('livesportpro'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  const players=await resolvePlayers('401892458',observation,JSON.stringify(event),new AbortController().signal,async url=>
    url.endsWith('sp%3Agolf/2123')?JSON.stringify([{id:'2123',streamNo:1,source:'streamed',
      embedUrl:'https://lb29.strmd.st/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ingest/stream/streamedbuffalosabres/1/playlist.m3u8'}]):'[]');
  assert.equal(players.length,1);
  const locator=players[0].locator;
  assert.equal(locator.provider,'catalog-stream');
  if(locator.provider==='catalog-stream'){
    assert.equal(locator.sourceName,'sp:golf');
    assert.equal(JSON.stringify(locator).includes('lb29.strmd.st'),false);
  }
});

test('LiveSportPro retries a validated fresh relay after direct media refuses access',async()=>{
  const direct='https://lb29.strmd.st/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ingest/stream/streamedbuffalosabres/1/playlist.m3u8';
  const relay=new URL('https://api.kultsport.com/api/hls/playlist.m3u8');
  relay.searchParams.set('url',direct);
  relay.searchParams.set('exp',String(Date.now()+60_000));
  relay.searchParams.set('sig','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  relay.searchParams.set('referer','https://exposestrat.com/');
  const locator={provider:'catalog-stream' as const,gameId:'401892458',source:'livesportpro' as const,
    eventUrl:'https://api.kultsport.com/api/matches/all#buffalo-sabres-vs-dallas-stars-2591545',
    eventId:'buffalo-sabres-vs-dallas-stars-2591545',sourceName:'sp:golf',sourceId:'2123',streamNo:1,
    kickoff:Date.parse('2026-10-08T23:00:00Z'),title:'Buffalo Sabres vs Dallas Stars',teams:['Buffalo Sabres','Dallas Stars'] as [string,string]};
  const calls:string[]=[];
  const requester=async(url:URL)=>{
    calls.push(url.href);
    if(url.pathname==='/api/matches/all')return new Response(JSON.stringify([{
      id:locator.eventId,title:locator.title,date:locator.kickoff,
      teams:{home:{name:locator.teams[0]},away:{name:locator.teams[1]}},
      sources:[{source:'sp:golf',id:'2123'}]}]),{headers:{'content-type':'application/json'}});
    if(url.pathname==='/api/stream/sp%3Agolf/2123')return new Response(JSON.stringify([{
      id:'2123',streamNo:1,source:'streamed',embedUrl:direct,relayUrl:relay.href}]),
      {headers:{'content-type':'application/json'}});
    if(url.href===direct)return new Response('Forbidden',{status:403,headers:{'content-type':'text/html'}});
    if(url.href===relay.href)return new Response('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\nsegment.ts',
      {headers:{'content-type':'application/vnd.apple.mpegurl'}});
    throw new Error('Unexpected URL');
  };
  const playback=await catalogStreamProvider(requester).open(locator,new AbortController().signal,'probe');
  const result=await playback.root.read({signal:new AbortController().signal});
  assert.equal(result.status,200);
  assert.deepEqual(calls.map(url=>new URL(url).pathname),['/api/matches/all','/api/stream/sp%3Agolf/2123',
    '/secure/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ingest/stream/streamedbuffalosabres/1/playlist.m3u8','/api/hls/playlist.m3u8']);
  playback.close();
});

test('CricHD detail admits only published same-event Watch links',async()=>{
  const listing=parseListings(source('crichd'),fixture('crichd-home.html'),at);
  const nfl=listing.observations.find(row=>row.url==='https://crichd.pk/event/dallas-cowboys-vs-buccaneers-live');
  assert.deepEqual(nfl?.teams,['Dallas Cowboys','Tampa Bay Buccaneers']);
  assert.equal(nfl?.kickoff,Date.parse('2026-10-09T00:15:00Z'));
  assert.equal((await resolvePlayers('401892458',nfl!,fixture('crichd-nfl-detail.html'),new AbortController().signal)).length,2);
  const observation=listing.observations.find(row=>row.url==='https://crichd.pk/event/motogp-indonesia-grand-prix')!;
  assert.ok(observation);
  const players=await resolvePlayers('motogp-123',observation,fixture('crichd-motogp-page.html'),new AbortController().signal);
  assert.equal(players.length,1,JSON.stringify(observation));
  assert.equal(players[0].locator.provider,'event-page');
  assert.deepEqual(await resolvePlayers('motogp-123',{...observation,title:'Other Race'},
    fixture('crichd-motogp-page.html'),new AbortController().signal),[]);
});

test('empty player reasons distinguish changed events, rejected links, and unpublished details',()=>{
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  assert.equal(missingPlayerReason(observation,JSON.stringify({...event,title:'Other Event',sources:[]})),'conflicting-game');
  assert.equal(missingPlayerReason(observation,JSON.stringify({...event,sources:[]})),'not-yet-published');
  assert.equal(missingPlayerReason(observation,JSON.stringify(event)),'unsupported-player');
  assert.equal(missingPlayerReason(observation,'{'),'parser-changed');
  const lspBody=fixture('livesportpro.json');
  const lsp=parseListings(source('livesportpro'),lspBody,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const lspEvent=JSON.parse(lspBody).find((row:{id:string})=>lsp.url.endsWith(row.id));
  assert.equal(missingPlayerReason(lsp,JSON.stringify({...lspEvent,title:'Other Event'})),'conflicting-game');
  const listing=parseListings(source('crichd'),fixture('crichd-home.html'),at);
  const race=listing.observations.find(row=>row.url==='https://crichd.pk/event/motogp-indonesia-grand-prix')!;
  const detail=fixture('crichd-motogp-page.html');
  assert.equal(missingPlayerReason(race,'<html><body>Changed template</body></html>'),'parser-changed');
  assert.equal(missingPlayerReason({...race,title:'Other Race'},detail),'conflicting-game');
  assert.equal(missingPlayerReason(race,detail.replace(/https:\/\/playerbee\.top\/charlie\/[^" ]+/g,
    'https://other.example/wrong-event')),'unsupported-player');
  assert.equal(missingPlayerReason(race,detail.replace(/<a\b[^>]*>\s*Watch\s*<\/a>/g,'')),'not-yet-published');
});

test('SportsBite uses exact event key and ignores upstream online metadata',async()=>{
  const body=fixture('sportsbite.json');
  const observation=parseListings(source('sportsbite'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).days.flatMap((day:{events:unknown[]})=>day.events).find((row:{event_key:string})=>
    observation.url.endsWith(row.event_key));
  const players=await resolvePlayers('401892458',observation,JSON.stringify(event),new AbortController().signal);
  assert.equal(players.length,2);
  assert.ok(players.every(player=>player.locator.provider==='event-page'));
  for(const player of players){
    assert.equal(CommandSchema.safeParse({kind:'open',gameId:'401892458',initialCandidateId:player.id}).success,true);
    assert.equal(CommandSchema.safeParse({kind:'playback-evidence',sessionId:randomUUID(),candidateId:player.id,
      generation:1,evidence:{kind:'advancing-video',version:1,startupMs:100,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}).success,true);
  }
});

test('SportsFeed24 detail with only fixture mirrors has no compatible player',async()=>{
  const listing=JSON.stringify([JSON.parse(fixture('sportsfeed24-today.json'))]);
  const observation=parseListings(source('sportsfeed24'),listing,at).observations.find(row=>
    row.title==='Baycurrent Classic vs Golf')!;
  assert.ok(observation);
  const detail=JSON.parse(fixture('sportsfeed24-golf-detail.json'));
  assert.ok(detail.game.streamerLinks.length>0);
  assert.deepEqual(await resolvePlayers('motorsport-123',observation,JSON.stringify(detail),new AbortController().signal),[]);
  assert.equal(missingPlayerReason(observation,JSON.stringify(detail)),'unsupported-player');
});

test('source-specific URL pairs reject encoded and unrelated targets',()=>{
  assert.equal(validEventPagePair('https://crichd.pk/event/motogp-indonesia-grand-prix',
    'https://playerbee.top/charlie/motogp-indonesia-grand-prix/2623'),true);
  assert.equal(validEventPagePair('https://crichd.pk/event/motogp-indonesia-grand-prix',
    'https://playerbee.top/charlie/other-grand-prix/2623'),false);
  assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
    'https://sportsbite.org/lol-embed/embed/dallas-stars-vs-buffalo-sabres?v=high&emb=89'),true);
  assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
    'https://sportsbite.org/lol-embed/embed/dallas-stars-vs-buffalo-sabres?v=high&emb=90'),true);
  assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
    'https://sportsbite.org/rs-embed/embed/nhl-streams-3-dallas-stars-vs-buffalo-sabres-nhl3-admin?v=high&emb=89'),true);
  for(const slug of ['x-dallas-stars-vs-buffalo-sabres-y','nhl-streams-3-dallas-stars-vs-buffalo-sabres-wrong-game-admin'])
    assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
      `https://sportsbite.org/rs-embed/embed/${slug}?v=high&emb=89`),false);
  for(const query of ['v=high&emb=abc','v=high&emb=90&token=secret','v=high&emb=0','v=high&emb=1000000',
    'v=high&emb=90&emb=89'])assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
    `https://sportsbite.org/lol-embed/embed/dallas-stars-vs-buffalo-sabres?${query}`),false);
  assert.equal(validEventPagePair('https://sportsbite.org/event/fg-buffalo-sabres-vs-dallas-stars',
    'https://sportsbite.org/lol-embed/embed/boston-celtics-vs-cleveland-cavaliers?v=high&emb=89'),false);
  assert.equal(allowedDiscoveryUrl('https://api.kultsport.com/api/stream/sp%3Agolf/2123'),true);
  assert.equal(allowedDiscoveryUrl('https://api.kultsport.com/api/stream/sp%253Agolf/2123'),false);
});

test('selected catalog details use the validated snapshot and honor cancellation',async()=>{
  const calls:string[]=[];
  const fetchMock=mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    calls.push(String(input));
    throw new Error('Unexpected full catalog fetch');
  });
  try{
    for(const [id,name] of [['streamed','streamed.json'],['livesportpro','livesportpro.json'],
      ['sportsbite','sportsbite.json']] as const){
      const body=fixture(name);
      const listing=parseListings(source(id),body,at);
      const observation=listing.observations[0];
      const detail=await readHtml(observation.url,new AbortController().signal);
      assert.ok(detail.includes(observation.title));
    }
    assert.deepEqual(calls,[]);
    const aborted=new AbortController();
    aborted.abort();
    await assert.rejects(readHtml('https://streamed.st/api/matches/all',aborted.signal));
    assert.deepEqual(calls,[]);
  }finally{fetchMock.mock.restore();}
});

test('a failed stream reference aborts and settles its siblings before returning',async()=>{
  const body=fixture('streamed.json');
  const observation=parseListings(source('streamed'),body,at).observations.find(row=>row.title==='Buffalo Sabres vs Dallas Stars')!;
  const event=JSON.parse(body).find((row:{id:string})=>observation.url.endsWith(row.id));
  event.sources=[1,2,3,4].map(id=>({source:'golf',id:String(id)}));
  let calls=0,settled=0,aborted=0;
  await assert.rejects(resolvePlayers('401892458',observation,JSON.stringify(event),new AbortController().signal,
    async(_url,signal)=>{
      calls++;
      if(calls===1){settled++;throw new Error('stream read failed');}
      return new Promise<string>((_resolve,reject)=>{
        signal.addEventListener('abort',()=>{aborted++;settled++;reject(signal.reason);},{once:true});
      });
    }),/stream read failed/);
  assert.equal(calls,4);
  assert.equal(aborted,3);
  assert.equal(settled,4);
});

test('SportsFeed24 partial category failure retains complete event routing',async()=>{
  const today=JSON.parse(fixture('sportsfeed24-today.json'));
  const full=JSON.stringify({categories:[today],complete:true});
  const listing=parseListings(source('sportsfeed24'),full,at);
  const golf=listing.observations.find(row=>row.title==='Baycurrent Classic vs Golf')!;
  assert.ok(golf);
  const added=structuredClone(today.subCategories[0].games[0]);
  added.sourceLink='https://links.totalsportek1.is/new-york-jets-vs-miami-dolphins/99991/';
  added.teamA='New York Jets';
  added.teamB='Miami Dolphins';
  today.subCategories[0].games.push(added);
  const calls:string[]=[];
  const fetchMock=mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    calls.push(url);
    if(url.endsWith('/api/xrhs'))return new Response(fixture('sportsfeed24-golf-detail.json'),
      {headers:{'content-type':'application/json'}});
    const body=JSON.parse(String(init?.body));
    if(body.categoryName==='F1')return new Response('Unavailable',{status:503});
    return new Response(JSON.stringify(body.categoryName?{categoryName:body.categoryName,subCategories:[]}:today),
      {headers:{'content-type':'application/json'}});
  });
  try{
    await assert.rejects(readHtml(source('sportsfeed24').url,new AbortController().signal),(error:unknown)=>{
      assert.ok(error instanceof PartialListingReadError);
      const partial=parseListings(source('sportsfeed24'),error.html,at);
      assert.equal(partial.outcome,'parsed');
      const newlyListed=partial.observations.find(row=>row.id==='sportsfeed24:99991');
      assert.ok(newlyListed);
      return true;
    });
    const detail=await readHtml(golf.url,new AbortController().signal);
    const newlyListedUrl='https://sportsfeed24.st/fixture/New%20York%20Jets-vs-Miami%20Dolphins';
    await readHtml(newlyListedUrl,new AbortController().signal);
    assert.ok(detail.includes('Baycurrent Classic'));
    assert.equal(calls.filter(url=>url.endsWith('/api/xhr')).length,7);
    assert.equal(calls.filter(url=>url.endsWith('/api/xrhs')).length,2);
  }finally{fetchMock.mock.restore();}
});

test('SportsFeed24 malformed categories retain other complete categories',async()=>{
  const today=JSON.parse(fixture('sportsfeed24-today.json'));
  for(const invalid of ['invalid-json','{}']){
    const fetchMock=mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init?:RequestInit)=>{
      const category=JSON.parse(String(init?.body)).categoryName;
      return new Response(category==='F1'?invalid:JSON.stringify(category?{categoryName:category,subCategories:[]}:today),
        {headers:{'content-type':'application/json'}});
    });
    try{
      await assert.rejects(readHtml(source('sportsfeed24').url,new AbortController().signal),(error:unknown)=>{
        assert.ok(error instanceof PartialListingReadError);
        assert.equal(JSON.parse(error.html).complete,false);
        assert.equal(JSON.parse(error.html).categories.length,6);
        const result=parseListings(source('sportsfeed24'),error.html,at);
        assert.equal(result.outcome,'parsed');
        assert.equal(result.observations.some(row=>row.title==='Baycurrent Classic vs Golf'),true);
        return true;
      });
    }finally{fetchMock.mock.restore();}
  }
});

test('a CricHD redirect cannot cross into another allowed source host',async()=>{
  const calls:string[]=[];
  const fetchMock=mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    calls.push(String(input));
    return new Response(null,{status:301,headers:{location:'https://streamed.st/api/matches/all'}});
  });
  try{
    await assert.rejects(readHtml('https://crichd.pk/',new AbortController().signal),/unsupported-discovery-address/);
    assert.deepEqual(calls,['https://crichd.pk/']);
  }finally{fetchMock.mock.restore();}
});
