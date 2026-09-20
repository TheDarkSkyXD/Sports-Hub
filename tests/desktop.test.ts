import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parsePlayers, validSourcePage } from '../lib/sunday.ts';
const require=createRequire(import.meta.url);
const {allowedPlayer,validGameId,safeBounds}=require('../desktop/security.cjs');

test('player resolver prioritizes the current iframe and deduplicates fallback servers',()=>{
 const html='<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe><div onclick="changeStream(456)">Server 1</div><div onclick="changeStream(123)">Server 2</div>';
 assert.deepEqual(parsePlayers(html).map(p=>p.id),['123','456']);
 assert.equal(parsePlayers('<iframe src="https://attacker.test/new-stream-embed/123"></iframe>').length,0);
});
test('untrusted source URLs cannot turn resolution into an arbitrary fetch proxy',()=>{
 assert.ok(validSourcePage('https://isportsurge.ws/watch/nfl/team-a-team-b/123'));
 for(const value of ['http://isportsurge.ws/watch/nfl/a/1','https://isportsurge.ws.attacker.test/watch/nfl/a/1','https://isportsurge.ws/watch/nfl/a/1?url=http://localhost','https://isportsurge.ws@attacker.test/watch/nfl/a/1'])assert.equal(validSourcePage(value),false);
});
test('desktop player navigation is restricted to the exact supported player origin and path',()=>{
 assert.ok(allowedPlayer('https://gooz.aapmains.net/new-stream-embed/123'));
 for(const value of ['file:///C:/secret','javascript:alert(1)','https://gooz.aapmains.net.attacker.test/new-stream-embed/123','https://gooz.aapmains.net/new-stream-embed/123?redirect=x','http://127.0.0.1/admin'])assert.equal(allowedPlayer(value),false);
 assert.ok(validGameId('401872933'));assert.equal(validGameId('../../admin'),false);
});
test('native player bounds are finite, clipped to the window, and hidden above the viewport',()=>{
 assert.deepEqual(safeBounds({x:10,y:10,width:2000,height:2000},[800,600]),{x:10,y:10,width:790,height:590});
 assert.equal(safeBounds({x:0,y:-10,width:100,height:100},[800,600]),null);
 assert.equal(safeBounds({x:0,y:0,width:NaN,height:100},[800,600]),null);
});
