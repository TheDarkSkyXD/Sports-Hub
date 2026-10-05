import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compatiblePlayers,missingPlayerReason} from '../lib/football/adapters/sources.ts';
import type {Observation} from '../lib/football/shared.ts';

const observation:Observation={id:'tvapp:100',sourceId:'tvapp',url:'https://tvapp1.pk/watch/100',
  title:'Away vs Home',league:'ncaaf',teams:['Away','Home'],kickoff:Date.parse('2026-10-03T19:30:00Z'),
  rawTime:'',observedAt:Date.parse('2026-10-03T19:00:00Z'),parserVersion:2};

test('waiting needs a visible source message and blocks placeholder player admission',()=>{
  const page=`<link rel="canonical" href="${observation.url}"><meta property="og:url" content="${observation.url}">
    <meta property="og:title" content="Away vs Home - Live Stream Free in HD | TheTVApp">
    <meta name="description" content="Watch Away vs Home live stream free in HD on TheTVApp.">
    <main><div id="player-frame"></div><p>This stream will be available shortly.</p></main>`;
  assert.equal(missingPlayerReason(observation,page),'not-yet-published');
  assert.deepEqual(compatiblePlayers('ncaaf-100',observation,page),[]);
  const published=page.replace('<p>This stream will be available shortly.</p>','');
  assert.equal(missingPlayerReason(observation,published),'no-compatible-media');
  assert.equal(compatiblePlayers('ncaaf-100',observation,published).length,1);
});

test('source page messages distinguish no channel from unsupported or unknown media',()=>{
  assert.equal(missingPlayerReason({...observation,sourceId:'methstreams'},'<main>No channel available</main>'),'no-published-player');
  assert.equal(missingPlayerReason(observation,'<main>Upcoming game</main>'),'no-compatible-media');
  assert.equal(missingPlayerReason(observation,'<script>const message="This stream will be available shortly";</script><main>Watch</main>'),'no-compatible-media');
  assert.equal(missingPlayerReason({...observation,sourceId:'other'},'<main>This stream will be available shortly</main>'),'no-compatible-media');
});

test('Sportsurge empty embed placeholders mean no published feed without admitting a player',()=>{
  const sportsurge={...observation,sourceId:'sportsurge',url:'https://isportsurge.ws/event/away-home'};
  const placeholder='<iframe id="cx-iframe" src="https://gooz.aapmains.net/new-stream-embed/"></iframe>';
  const page=`${placeholder}<script>window.changeStream = function(streamId) {
    document.getElementById('cx-iframe').src = 'https://gooz.aapmains.net/new-stream-embed/' + streamId;
  };</script>`;
  assert.equal(missingPlayerReason(sportsurge,page),'no-published-player');
  assert.deepEqual(compatiblePlayers('ncaaf-100',sportsurge,page),[]);
  assert.equal(missingPlayerReason(observation,page),'no-compatible-media');

  const unsupported='<iframe src="https://unknown.example/published-player/123"></iframe>';
  for(const published of [unsupported,placeholder+unsupported,
    `${placeholder}<button onclick="changeStream(123)">Server 1</button>`,
    `${placeholder}<video src="https://unknown.example/live.m3u8"></video>`]) {
    assert.equal(missingPlayerReason(sportsurge,published),'no-compatible-media');
  }
  assert.deepEqual(compatiblePlayers('ncaaf-100',sportsurge,unsupported),[]);
});
