import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {observedPublicPage} from '../lib/playback/providers/public-page.ts';

test('observer completion, incomplete capture, and local capacity reach distinct provider results',async()=>{
  const replies=[
    {status:404,body:{kind:'no-feed',phase:'activation',reason:'offline'}},
    {status:503,body:{kind:'incomplete',phase:'capture',reason:'deadline',retryAfterMs:30000}},
    {status:503,body:null},
    {status:404,body:null},
    {status:503,body:{kind:'incomplete',phase:'capture',reason:'x'.repeat(2048),retryAfterMs:30000}},
  ];
  const server=createServer((_request,response)=>{
    const reply=replies.shift();
    assert.ok(reply);
    response.writeHead(reply.status,{'content-type':'application/json'});
    response.end(reply.body ? JSON.stringify(reply.body) : undefined);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert.ok(address&&typeof address!=='string');
  const previousOrigin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
  const previousToken=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=`http://127.0.0.1:${address.port}`;
  process.env.SUNDAY_ROOM_CONTROL_TOKEN='fixture-token';
  const observe=()=>observedPublicPage(new URL('https://player.example/watch'),new AbortController().signal,'probe');
  try {
    await assert.rejects(observe(),{name:'ProviderNoFeedError',phase:'activation'});
    await assert.rejects(observe(),{name:'ProviderDeferredError',phase:'capture',retryAfterMs:30000});
    await assert.rejects(observe(),{name:'ProviderDeferredError',retryAfterMs:2000});
    assert.equal(await observe(),null);
    await assert.rejects(observe(),{name:'ProviderDeferredError',retryAfterMs:2000});
    assert.equal(replies.length,0);
  }finally{
    if(previousOrigin===undefined)delete process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN;
    else process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN=previousOrigin;
    if(previousToken===undefined)delete process.env.SUNDAY_ROOM_CONTROL_TOKEN;
    else process.env.SUNDAY_ROOM_CONTROL_TOKEN=previousToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
