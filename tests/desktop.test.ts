import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parsePlayers, validSourcePage } from '../lib/sunday.ts';
const require=createRequire(import.meta.url);
const {allowedPlayer,validGameId,safeBounds,playerBounds}=require('../desktop/security.cjs');
const {createPlaybackHealth,samplePlaybackHealth,playbackIsStable}=require('../desktop/playback-health.cjs');

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

test('players keep a 16:9 picture inside wide, tall, and clipped tile surfaces',()=>{
 for(const rect of [{x:10,y:10,width:800,height:200},{x:20,y:20,width:300,height:800},{x:10,y:500,width:640,height:360}]){
  const b=playerBounds(rect,[1000,700]);
  assert.ok(b&&b.width>0&&b.height>0);
  assert.ok(Math.abs(b.width/b.height-16/9)<0.02);
  assert.ok(b.x>=rect.x&&b.y>=rect.y&&b.x+b.width<=1000&&b.y+b.height<=700);
 }
});

test('native player placement respects renderer zoom and rejects invalid geometry',()=>{
 assert.deepEqual(playerBounds({x:10,y:20,width:320,height:180},[1000,700],1.5),{x:15,y:30,width:480,height:270});
 assert.equal(playerBounds({x:0,y:0,width:300,height:200},[1000,700],NaN),null);
 assert.equal(playerBounds({x:0,y:0,width:Infinity,height:200},[1000,700]),null);
 assert.equal(playerBounds({x:0,y:-1,width:300,height:200},[1000,700]),null);
});

test('desktop health keeps monitoring after startup and recovers a frozen media clock',()=>{
 const health=createPlaybackHealth(0);
 const media={ready:4,time:10,paused:false,error:false,ended:false};
 assert.equal(samplePlaybackHealth(health,null,{now:1000}),'starting');
 assert.equal(samplePlaybackHealth(health,media,{now:2000}),'playing');
 assert.equal(samplePlaybackHealth(health,media,{now:5000}),'playing');
 assert.equal(samplePlaybackHealth(health,media,{now:6000}),'buffering');
 assert.equal(samplePlaybackHealth(health,media,{now:27000}),'retry');
 assert.equal(samplePlaybackHealth(health,{...media,time:11},{now:28000}),'playing');
});

test('pausing or hiding a desktop stream does not consume its recovery timeout',()=>{
 const health=createPlaybackHealth(0);
 const media={ready:4,time:5,paused:false};
 assert.equal(samplePlaybackHealth(health,media,{now:1000}),'playing');
 assert.equal(samplePlaybackHealth(health,{...media,paused:true},{now:120000,playing:false}),'idle');
 assert.equal(samplePlaybackHealth(health,media,{now:121000}),'playing');
 assert.equal(samplePlaybackHealth(health,media,{now:240000,visible:false}),'idle');
 assert.equal(samplePlaybackHealth(health,media,{now:241000}),'playing');
 assert.equal(samplePlaybackHealth(health,{...media,time:6},{now:242000}),'playing');
});

test('desktop health retries failed startup, media errors, and ended live feeds',()=>{
 assert.equal(samplePlaybackHealth(createPlaybackHealth(0),null,{now:25000}),'retry');
 assert.equal(samplePlaybackHealth(createPlaybackHealth(0),{ready:4,time:5,paused:false,error:true},{now:1000}),'retry');
 assert.equal(samplePlaybackHealth(createPlaybackHealth(0),{ready:4,time:5,paused:false,ended:true},{now:1000}),'retry');
});

test('recovery allowance replenishes only after sustained advancing playback',()=>{
 const health=createPlaybackHealth(0);
 const media={ready:4,time:10,paused:false};
 samplePlaybackHealth(health,media,{now:1000});
 assert.equal(playbackIsStable(health,1000),false);
 samplePlaybackHealth(health,media,{now:5000});
 assert.equal(playbackIsStable(health,30000),false);
 for(let now=30000;now<=44000;now+=2000)samplePlaybackHealth(health,{...media,time:now},{now});
 assert.equal(playbackIsStable(health,44000),false);
 samplePlaybackHealth(health,{...media,time:46000},{now:46000});
 assert.equal(playbackIsStable(health,46000),true);
 samplePlaybackHealth(health,null,{now:47000,visible:false});
 assert.equal(playbackIsStable(health,90000),false);
});
