import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createFixtureCollector,SOURCES} from '../lib/football/adapters/sources.ts';
import {streamcenterProvider} from '../lib/playback/providers/streamcenter.ts';
import {ProviderDeferredError} from '../lib/playback/provider.ts';

import fixture from './fixtures/source-api-review.json' with {type:'json'};
const at=Date.parse('2026-10-14T12:00:00Z');
const eventId='event-espn-league-football-college-football-401862800';
const watch=`https://streamcenter.st/watch/${eventId}`;
const catalog='https://streamcenter.st/api/matches/football';
const streams=`https://streamcenter.st/api/stream/iframe/${eventId}`;


test('StreamCenter JSON catalog and advertised group produce only the exact ESPN event player',async()=>{
  const collector=createFixtureCollector(),source=SOURCES.find(row=>row.id==='streamcenter');
  assert.ok(source);
  assert.equal(source.url,catalog);
  const parsed=collector.parseListings(source,JSON.stringify(fixture.matches),at);
  const row=parsed.observations.find(row=>row.url===watch);
  assert.ok(row);
  assert.equal(row.kickoff,1792107000000);
  assert.ok(row.kickoff!==null);
  assert.deepEqual(row.teams,['UAB Blazers','East Carolina Pirates']);
  collector.enqueueFixture({url:streams,body:JSON.stringify(fixture.streams)});
  const detail=await collector.readHtml(watch,new AbortController().signal);
  assert.deepEqual(collector.compatiblePlayers('ncaaf-401862800',row,detail).map(player=>player.locator),[
    {provider:'streamcenter',eventId:'401862800',linkId:'999f2d14-a516-42cc-847d-d9ce8e83e6dd'},
  ]);
  assert.deepEqual(collector.compatiblePlayers('ncaaf-401862801',row,detail),[]);
  assert.deepEqual(collector.compatiblePlayers('ncaaf-401862800',{...row,kickoff:row.kickoff+1},detail),[]);
  assert.deepEqual(collector.fixtureRequests().map(row=>row.url),[streams]);
});

test('StreamCenter API playback rejects authoritative absence and conflicting stream identities before loading pages',async()=>{
  for(const reply of [[],[...fixture.streams,...fixture.streams],fixture.streams.map(row=>({...row,webUrl:watch+'-wrong'})),
    fixture.streams.map(row=>({...row,embedUrl:'https://127.0.0.1/embed/ch31.php'}))]){
    const requests:string[]=[];
    const fetcher:typeof fetch=async(input)=>{
      const url=String(input);requests.push(url);
      if(url===catalog)return Response.json(fixture.matches);
      if(url===streams)return Response.json(reply);
      throw new Error('An invalid API reply reached a page');
    };
    await assert.rejects(streamcenterProvider(fetcher).open({provider:'streamcenter',eventId:'401862800',
      linkId:'999f2d14-a516-42cc-847d-d9ce8e83e6dd'},new AbortController().signal));
    assert.deepEqual(requests,[catalog,streams]);
  }
});

test('StreamCenter rate limits retain the provider retry interval without opening a page',async()=>{
  const requests:string[]=[];
  const fetcher:typeof fetch=async input=>{
    requests.push(String(input));
    if(String(input)===catalog)return Response.json(fixture.matches);
    return new Response(null,{status:429,headers:{'Retry-After':'45'}});
  };
  await assert.rejects(streamcenterProvider(fetcher).open({provider:'streamcenter',eventId:'401862800',
    linkId:'999f2d14-a516-42cc-847d-d9ce8e83e6dd'},new AbortController().signal),
    error=>error instanceof ProviderDeferredError&&error.retryAfterMs===45000&&error.phase==='resolution');
  assert.deepEqual(requests,[catalog,streams]);
});

test('Dudestream category acquisition reads only public REST posts and never uses publication date as kickoff',async()=>{
  const collector=createFixtureCollector(),source=SOURCES.find(row=>row.id==='dudestream-nba');
  assert.ok(source);
  const categoryUrl=fixture.provenance.category.url;
  const postsUrl='https://dudestream1.com/wp-json/wp/v2/posts?categories=4&per_page=100&page=1&_fields=id,link,title,categories';
  collector.enqueueFixture({url:categoryUrl,body:JSON.stringify(fixture.category)});
  collector.enqueueFixture({url:postsUrl,body:JSON.stringify(fixture.posts)});
  const body=await collector.readHtml(source.url,new AbortController().signal);
  const parsed=collector.parseListings(source,body,at);
  assert.equal(parsed.outcome,'parsed');
  const row=parsed.observations.find(row=>row.url==='https://dudestream1.com/nba3/');
  assert.ok(row);
  assert.equal(row.title,'Charlotte Hornets vs Boston Celtics');
  assert.equal(row.kickoff,null);
  assert.deepEqual(collector.fixtureRequests().map(row=>row.url),[categoryUrl,postsUrl]);
  assert.deepEqual(collector.compatiblePlayers('nba-401918011',row,body),[]);
});

test('Dudestream rejects category conflicts and external post links instead of reading category HTML',async()=>{
  for(const [category,posts] of [[[{id:4,slug:'nfl',name:'NFL'}],fixture.posts],
    [fixture.category,fixture.posts.map(row=>({...row,link:'https://evil.example/game/'}))]]){
    const collector=createFixtureCollector(),source=SOURCES.find(row=>row.id==='dudestream-nba');
    assert.ok(source);
    collector.enqueueFixture({url:fixture.provenance.category.url,body:JSON.stringify(category)});
    collector.enqueueFixture({url:'https://dudestream1.com/wp-json/wp/v2/posts?categories=4&per_page=100&page=1&_fields=id,link,title,categories',body:JSON.stringify(posts)});
    await assert.rejects(collector.readHtml(source.url,new AbortController().signal),/parser-changed/);
    assert.ok(collector.fixtureRequests().every(row=>row.url.includes('/wp-json/')));
  }
});

test('Dudestream rejects an overflowing listing and duplicate posts across page boundaries',async()=>{
  for(const duplicate of [true,false]){
    const collector=createFixtureCollector(),source=SOURCES.find(row=>row.id==='dudestream-nba');
    assert.ok(source);
    collector.enqueueFixture({url:fixture.provenance.category.url,body:JSON.stringify(fixture.category)});
    for(let page=1;page<=3;page++){
      const posts=Array.from({length:100},(_,index)=>({...fixture.posts[0],id:(duplicate?0:page*100)+index+1,
        link:`https://dudestream1.com/game-${(duplicate?0:page*100)+index+1}/`}));
      collector.enqueueFixture({url:`https://dudestream1.com/wp-json/wp/v2/posts?categories=4&per_page=100&page=${page}&_fields=id,link,title,categories`,
        body:JSON.stringify(posts)});
    }
    await assert.rejects(collector.readHtml(source.url,new AbortController().signal),duplicate?/parser-changed/:/listing-page-limit/);
    assert.equal(collector.fixtureRequests().length,duplicate?3:4);
  }
});

test('Dudestream REST 403 cannot reopen the category page in a browser',async()=>{
  let browserCalls=0;
  const source=SOURCES.find(row=>row.id==='dudestream-nba');
  assert.ok(source);
  const server=createServer((_request,response)=>{
    browserCalls++;
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({kind:'complete',url:source.url,body:'<html>stale category</html>'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const priorOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN,priorToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='api-no-browser-test';
  try{
    const collector=createFixtureCollector();
    collector.enqueueFixture({url:fixture.provenance.category.url,status:403,body:'challenge'});
    await assert.rejects(collector.readHtml(source.url,new AbortController().signal),/http-403/);
    assert.equal(browserCalls,0);
  }finally{
    if(priorOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=priorOrigin;
    if(priorToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN=priorToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
