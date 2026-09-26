import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';
import { parsePlayers, validSourcePage } from '../lib/sunday.ts';
const require=createRequire(import.meta.url);
const {allowedPlayer,validGameId,safeBounds}=require('../desktop/security.cjs');
const {localServerPort}=require('../desktop/port.cjs');

test('desktop server chooses another loopback port when the preferred port is occupied',async()=>{
 const occupied=net.createServer();
 await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
 try {
  const address=occupied.address();
  assert.ok(address&&typeof address!=='string');
  const fallback=await localServerPort(address.port);
  assert.notEqual(fallback,address.port);
  const check=net.createServer();
  await new Promise<void>(resolve=>check.listen(fallback,'127.0.0.1',resolve));
  await new Promise<void>(resolve=>check.close(()=>resolve()));
 } finally {await new Promise<void>(resolve=>occupied.close(()=>resolve()));}
});

test('player resolver prioritizes the current iframe and deduplicates fallback servers',()=>{
 const html='<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe><div onclick="changeStream(456)">Server 1</div><div onclick="changeStream(123)">Server 2</div>';
 assert.deepEqual(parsePlayers(html).map(p=>p.id),['123','456']);
 assert.equal(parsePlayers('<iframe src="https://attacker.test/new-stream-embed/123"></iframe>').length,0);
});
test('untrusted source URLs cannot turn resolution into an arbitrary fetch proxy',()=>{
 assert.ok(validSourcePage('https://isportsurge.ws/watch/nfl/team-a-team-b/123'));
 assert.ok(validSourcePage('https://isportsurge.ws/watch/cfb/brown-harvard/123'));
 for(const value of ['http://isportsurge.ws/watch/nfl/a/1','https://isportsurge.ws.attacker.test/watch/nfl/a/1','https://isportsurge.ws/watch/nfl/a/1?url=http://localhost','https://isportsurge.ws@attacker.test/watch/nfl/a/1'])assert.equal(validSourcePage(value),false);
 for(const value of ['https://isportsurge.ws/watch/cfb/a/1?next=x','https://isportsurge.ws/watch/cfb/a/1#player','https://isportsurge.ws/watch/cfb/a/not-an-id','https://isportsurge.ws/watch/cfb/a/1/extra'])assert.equal(validSourcePage(value),false);
});
test('desktop player navigation is restricted to the exact supported player origin and path',()=>{
 assert.ok(allowedPlayer('https://gooz.aapmains.net/new-stream-embed/123'));
 for(const value of ['file:///C:/secret','javascript:alert(1)','https://gooz.aapmains.net.attacker.test/new-stream-embed/123','https://gooz.aapmains.net/new-stream-embed/123?redirect=x','http://127.0.0.1/admin'])assert.equal(allowedPlayer(value),false);
 assert.ok(validGameId('401872933'));assert.equal(validGameId('../../admin'),false);
 assert.ok(validGameId('ncaaf-397359440'));assert.ok(validGameId('ncaaf-source-397359440'));
 for(const value of ['ncaaf-redzone','ncaaf-source-abc','ncaaf-397359440/../../admin'])assert.equal(validGameId(value),false);
});
test('native player bounds are finite, clipped to the window, and hidden above the viewport',()=>{
 assert.deepEqual(safeBounds({x:10,y:10,width:2000,height:2000},[800,600]),{x:10,y:10,width:790,height:590});
 assert.equal(safeBounds({x:0,y:-10,width:100,height:100},[800,600]),null);
 assert.equal(safeBounds({x:0,y:0,width:NaN,height:100},[800,600]),null);
});
