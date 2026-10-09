import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, compatiblePlayers, parseListings } from '../lib/football/adapters/sources.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-02T18:00:00Z');
const kickoff = new Date(at).toISOString();
const game: Game = {
  id: '100', league: 'nfl', name: 'Away at Home', date: kickoff,
  home: { id: 'espn:nfl:1', name: 'Home', short: 'Home', abbreviation: 'HOM', color: '112233', score: '0' },
  away: { id: 'espn:nfl:2', name: 'Away', short: 'Away', abbreviation: 'AWY', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
};

test('Gooz iframe sources accept quoted attributes and exclude lookalikes', () => {
  const observation: Observation = {id:'gooz-coverage',sourceId:'sportsurge',url:'https://isportsurge.ws/watch/nfl/away-home/100',
    title:'Away vs Home',league:'nfl',teams:['Away','Home'],kickoff:null,rawTime:'',observedAt:at,parserVersion:1};
  const html = `<iframe data-src="https://gooz.aapmains.net/new-stream-embed/99"
    SRC = 'https://gooz.aapmains.net/new-stream-embed/101'></iframe>
    <iframe src="https://gooz.aapmains.net/new-stream-embed/202"></iframe>
    <iframe src='https://gooz.aapmains.net.attacker.test/new-stream-embed/303'></iframe>
    <button onclick="changeStream(404)"></button>`;
  assert.deepEqual(compatiblePlayers('100',observation,html).map(player => [player.id, player.label]), [
    ['gooz-101', 'Primary'], ['gooz-202', 'Backup 1'], ['gooz-404', 'Backup 2'],
  ]);
  assert.deepEqual(compatiblePlayers('100',observation,`<iframe data-src='https://gooz.aapmains.net/new-stream-embed/505'></iframe>
    <button onclick="changeStream(606)"></button>`), []);
});

test('two dated live listings with compatible media retain both playable source candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-coverage-'));
  const sportsurge = SOURCES.find(source => source.id === 'sportsurge');
  const crackstreams = SOURCES.find(source => source.id === 'crackstreams-st');
  assert.ok(sportsurge);
  assert.ok(crackstreams);
  const firstUrl = 'https://isportsurge.ws/watch/nfl/away-home/100';
  const secondUrl = 'https://crackstreams.st/event/m-away-vs-home-1002';
  const serverUrl = 'https://fxtrend.st/event/m-away-vs-home-1002/main/1';
  const html = new Map([
    [sportsurge.url, `<a href="${firstUrl}" datetime="${kickoff}">Away vs Home</a>`],
    [crackstreams.url, `<article datetime="${kickoff}"><a href="${secondUrl}">Away vs Home</a></article>`],
    [firstUrl, '<iframe src="https://gooz.aapmains.net/new-stream-embed/101"></iframe>'],
    [secondUrl, `<link rel="canonical" href="${secondUrl}"><meta property="og:url" content="${secondUrl}">
      <script type="application/ld+json">${JSON.stringify({'@type':'SportsEvent',url:secondUrl,
        name:'Away vs Home',startDate:kickoff,homeTeam:{name:'Home'},awayTeam:{name:'Away'},offers:{price:'0'}})}</script>
      <a class="sl-row" href="${serverUrl}" aria-label="Watch Away vs Home on Main 1 — opens the player in a new tab"><span class="sl-nm">Main 1</span></a>`],
  ]);
  assert.equal(parseListings(sportsurge, html.get(sportsurge.url) || '', at).observations.length, 1);
  assert.equal(parseListings(crackstreams, html.get(crackstreams.url) || '', at).observations.length, 1);
  const visitedDetails = new Set<string>();
  const coordinator = createFootballCoordinator(join(dir, 'state.sqlite'), {
    now: () => at,
    sources: [sportsurge, crackstreams],
    readSchedule: async (partition, time) => ({ games: partition.id === 'nfl' ? [game] : [], at: time, league: partition.league }),
    readHtml: async url => {
      const body = html.get(url);
      if (body === undefined) throw new Error(`Unexpected fixture URL: ${url}`);
      if (url === firstUrl || url === secondUrl) visitedDetails.add(url);
      return body;
    },
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  try {
    await coordinator.refresh(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (visitedDetails.size === 2) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(visitedDetails.size, 2);
    let response = await coordinator.command({ kind: 'sources' });
    for (let attempt = 0; attempt < 100; attempt++) {
      const choices = response.kind === 'sources'
        ? response.snapshot.games.find(row => row.gameId === game.id)?.candidates : undefined;
      if (choices?.some(candidate => candidate.id === 'gooz-101' && candidate.availability.kind === 'playable') &&
        choices.some(candidate => candidate.id.startsWith('event-page:') && candidate.availability.kind === 'playable')) break;
      await new Promise<void>(resolve => setImmediate(resolve));
      response = await coordinator.command({ kind: 'sources' });
    }
    assert.equal(response.kind, 'sources');
    if (response.kind !== 'sources') return;
    const snapshot = response.snapshot;
    assert.deepEqual(snapshot.sources.map(source => [source.id, source.listingCount, source.matchedGameCount]), [
      ['sportsurge', 1, 1], ['crackstreams-st', 1, 1],
    ]);
    const row = snapshot.games.find(item => item.gameId === game.id);
    assert.ok(row);
    assert.equal(row.sourceCount, 2);
    assert.equal(row.candidates.length, 2);
    assert.ok(row.candidates.some(candidate => candidate.id === 'gooz-101'));
    assert.ok(row.candidates.some(candidate => candidate.id.startsWith('event-page:') &&
      candidate.sourceIds.includes('crackstreams-st') &&
      candidate.availability.kind === 'playable'));
    assert.equal(row.uniqueFeedCount, 2);
  } finally {
    await coordinator.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
