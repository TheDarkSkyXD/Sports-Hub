import { browserCategory } from '../lib/football/source-registry.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { CommandSchema, type Game, type SportsurgeCatalog, type StreameastCatalog } from '../lib/football/shared.ts';

const require = createRequire(import.meta.url);
const { runSportsurgeSweep } = require('../desktop/sportsurge-sweep.cjs');
const { runStreameastSweep } = require('../desktop/streameast-sweep.cjs');
const at = Date.parse('2026-10-04T17:00:00Z');
const game = (index: number): Game => ({ id: String(10000 + index), league: 'nfl',
  name: `Away ${index} at Home ${index}`, date: new Date(at + (index === 3 ? 3600000 : 0)).toISOString(),
  status: index === 3 ? 'pre' : 'in', lifecycle: index === 3 ? 'scheduled' : 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { name: `Home ${index}`, short: `Home ${index}`, abbreviation: 'HOM', color: '112233', score: '0' },
  away: { name: `Away ${index}`, short: `Away ${index}`, abbreviation: 'AWY', color: '112233', score: '0' } });
async function drain() { for (let i = 0; i < 50; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

for (const sourceId of ['sportsurge-v2', 'streameast']) test(`${sourceId} reuses proven live details through real sweeps while collecting new games`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-retained-details-'));
  let clock = at, listed = [1, 2], finished = false;
  const reads: string[] = [];
  const surge = sourceId === 'sportsurge-v2';
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, browserCollectorsAvailable: true,
    sources: [{ id: sourceId, url: surge ? 'https://v2.sportsurge.net/watch-nfl-streams/' : 'https://v2.streameast.ga/nfl-streams/', family: sourceId, kind: 'browser-catalog' }],
    readSchedule: async source => ({ games: source.id === 'nfl' ? [1, 2, 3].map(index => finished && index === 1 ? { ...game(index), status: 'post', lifecycle: 'final' as const, finalObservedAt: clock, graceEndsAt: clock + 300000 } : game(index)) : [], league: source.league, at: clock }),
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  const sweep = async (): Promise<SportsurgeCatalog | StreameastCatalog> => {
    await coordinator.refresh(true); await drain();
    return (surge ? runSportsurgeSweep : runStreameastSweep)({ now: () => clock, signal: new AbortController().signal,
      send: async (catalog: unknown) => {
        const command = CommandSchema.parse({ kind: surge ? 'sportsurge-catalog' : 'streameast-catalog', catalog: structuredClone(catalog) });
        const ack = await coordinator.command(command);
        assert.equal(ack.kind, 'catalog-ack', JSON.stringify(ack));
        assert.deepEqual(await coordinator.command(command), ack, 'wire replay must stay idempotent');
        return ack;
      },
      read: async (url: string, page: string, league: string) => {
        reads.push(page);
        if (page === 'category') {
          if (!url.includes('nfl')) return surge ? '<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>' : `<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">${browserCategory('streameast',league)?.emptyTitles?.[0]}</h2></div>`;
          return surge ? `<main id="match-list-container">${listed.map(index => `<a class="match-row" href="watch-${10000 + index}-nfl-away-home-${index}/"><span class="match-row-team-name">Away ${index}</span><span class="match-row-team-name">Home ${index}</span><time class="match-time" data-timestamp="${Date.parse(game(index).date || '') / 1000}"></time>${index !== 3 ? '<span class="live-badge">Live</span>' : ''}2 Streams</a>`).join('')}</main>` : listed.map(index => `<article class="m-card" data-match-id="${10000 + index}" data-team-names="Away ${index}|Home ${index}" data-time="${Date.parse(game(index).date || '') / 1000}"><a class="m-card__link" href="https://v2.streameast.ga/nfl/away-${index}-vs-home-${index}-${at / 1000}/"></a></article>`).join('');
        }
        const index = Number(/home-(\d)/.exec(url)?.[1]);
        if (surge) return `<div class="stream-list">${[1, 2].map(server => `<div class="stream-item" data-href="https://fixture.example/player/${index}/${server}"><span class="stream-row-site-name">Server ${server}</span><span class="stream-vote" id="stream-${index}${server}"></span></div>`).join('')}</div>`;
        if (page === 'server') return `<iframe src="https://streame.center/stream-east/ch${index}${url.slice(-1)}.php"></iframe>`;
        return `<div class="stream-alt-list">${[1, 2].map(server => `<a class="stream-alt-item" href="${url}${server}"><span class="stream-alt-name">Free ${server}</span><span class="stream-alt-free-badge">Free</span></a>`).join('')}</div>`;
      },
    });
  };
  try {
    const first = await sweep(); await drain();
    assert.equal(first.state.kind, 'complete');
    assert.equal(reads.filter(page => page === 'detail').length, 2);
    const before = await coordinator.command({ kind: 'sources' });
    assert.equal(before.kind, 'sources');
    if (before.kind === 'sources') assert.deepEqual(before.snapshot.games.map(row => [row.gameId, row.workingChoiceCount]),
      [['10001', 2], ['10002', 2], ['10003', 0]]);
    clock += 60000; listed = [1, 2, 3]; reads.length = 0;
    const second = await sweep(); await drain();
    assert.equal(second.state.kind, 'complete');
    assert.equal(reads.filter(page => page === 'detail').length, 1, 'only the new upcoming game needs a detail read');
    assert.equal(reads.filter(page => page === 'server').length, surge ? 0 : 2);
    assert.deepEqual(second.events.slice(0, 2).map(event => event.detail.kind === 'collected' ? event.detail.at : null), [at, at]);
    const snapshot = await coordinator.command({ kind: 'sources' });
    assert.equal(snapshot.kind, 'sources');
    if (snapshot.kind === 'sources') {
      assert.deepEqual(snapshot.snapshot.games.map(row => row.workingChoiceCount), [2, 2, 2]);
      assert.ok(snapshot.snapshot.games.slice(0, 2).every(row => row.candidates.every(candidate => candidate.observedAt === at)));
    }
    for (const mutation of ['timestamp', 'identity', 'provenance']) {
      const forged = structuredClone(second);
      forged.runId = randomUUID(); forged.sequence = 0; forged.startedAt = clock + 1;
      forged.categories = { ncaaf: { kind: 'collected', at: clock + 1 }, nfl: { kind: 'collected', at: clock + 1 } };
      forged.state = { kind: 'collecting' };
      const event = forged.events[0];
      if (event.detail.kind !== 'collected') throw new Error('Expected collected detail');
      if (mutation === 'timestamp') event.detail.at--;
      if (mutation === 'identity') event.title += ' changed';
      if (mutation === 'provenance') event.detail.retainedFromRunId = randomUUID();
      const reply = await coordinator.command(CommandSchema.parse({ kind: surge ? 'sportsurge-catalog' : 'streameast-catalog', catalog: forged }));
      assert.equal(reply.kind, 'error', mutation);
      if (reply.kind === 'error') assert.equal(reply.status, 400);
    }
    for (let run = 0; run < 4; run++) { clock += 300000; reads.length = 0; await sweep(); assert.equal(reads.filter(page => page === 'detail').length, 3); }
    clock += 10 * 60000;
    await coordinator.refresh(true); await drain();
    for (const gameId of ['10001', '10002']) {
      const failedCandidates = new Set<string>();
      for (let route = 0; route < 2; route++) {
        const opened = await coordinator.command({ kind: 'open', gameId, manual: false });
        assert.equal(opened.kind, 'playback');
        if (opened.kind !== 'playback') throw new Error('Expected playback session');
        assert.equal(failedCandidates.has(opened.playback.session.candidateId), false);
        failedCandidates.add(opened.playback.session.candidateId);
        await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id,
          generation: 0, failure: true, retry: false });
      }
      assert.equal(failedCandidates.size, 2);
    }
    clock += 300000; reads.length = 0;
    await sweep();
    assert.equal(reads.filter(page => page === 'detail').length, 3, 'negative media proof releases live detail reuse');
    finished = true; clock += 300000;
    const final = await sweep();
    assert.equal(final.events.some(event => event.id === 'nfl:10001'), false, 'finished event removal remains distinct from reuse');
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});

for (const sourceId of ['sportsurge-v2', 'streameast']) test(`${sourceId} discovers a newly published live feed after one check interval`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-detail-refresh-'));
  const surge = sourceId === 'sportsurge-v2';
  let clock = at;
  let published = 1;
  const reads: string[] = [];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, browserCollectorsAvailable: true,
    sources: [{ id: sourceId, url: surge ? 'https://v2.sportsurge.net/watch-nfl-streams/' : 'https://v2.streameast.ga/nfl-streams/', family: sourceId, kind: 'browser-catalog' }],
    readSchedule: async source => ({ games: source.id === 'nfl' ? [game(1)] : [], league: source.league, at: clock }),
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  const sweep = async () => {
    await coordinator.refresh(true); await drain();
    return (surge ? runSportsurgeSweep : runStreameastSweep)({ now: () => clock, signal: new AbortController().signal,
      send: async (catalog: unknown) => {
        const command = CommandSchema.parse({ kind: surge ? 'sportsurge-catalog' : 'streameast-catalog', catalog: structuredClone(catalog) });
        const ack = await coordinator.command(command);
        assert.equal(ack.kind, 'catalog-ack', JSON.stringify(ack));
        return ack;
      },
      read: async (url: string, page: string, league: string) => {
        reads.push(page);
        if (page === 'category') {
          if (!url.includes('nfl')) return surge ? '<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>' : `<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">${browserCategory('streameast',league)?.emptyTitles?.[0]}</h2></div>`;
          return surge ? `<main id="match-list-container"><a class="match-row" href="watch-10001-nfl-away-home-1/"><span class="match-row-team-name">Away 1</span><span class="match-row-team-name">Home 1</span> <time class="match-time" data-timestamp="${at / 1000}"></time><span class="live-badge">Live</span> 2 Streams</a></main>` :
            `<article class="m-card" data-match-id="10001" data-team-names="Away 1|Home 1" data-time="${at / 1000}"><a class="m-card__link" href="https://v2.streameast.ga/nfl/away-1-vs-home-1-${at / 1000}/"></a></article>`;
        }
        if (surge) return `<div class="stream-list">${Array.from({ length: published }, (_, server) => `<div class="stream-item" data-href="https://fixture.example/player/1/${server + 1}"><span class="stream-row-site-name">Server ${server + 1}</span><span class="stream-vote" id="stream-1${server + 1}"></span></div>`).join('')}</div>`;
        if (page === 'server') return `<iframe src="https://streame.center/stream-east/ch1${url.slice(-1)}.php"></iframe>`;
        return `<div class="stream-alt-list">${Array.from({ length: published }, (_, server) => `<a class="stream-alt-item" href="${url}${server + 1}"><span class="stream-alt-name">Free ${server + 1}</span><span class="stream-alt-free-badge">Free</span></a>`).join('')}</div>`;
      },
    });
  };
  try {
    await sweep(); await drain();
    const first = await coordinator.command({ kind: 'sources' });
    assert.equal(first.kind, 'sources');
    if (first.kind !== 'sources') throw new Error('Expected source snapshot');
    assert.equal(first.snapshot.games[0].workingChoiceCount, 1);
    const firstCandidateId = first.snapshot.games[0].candidates[0].id;
    const firstAvailability = first.snapshot.games[0].candidates[0].availability;
    assert.deepEqual(firstAvailability, { kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}, checkedAt: at });
    assert.equal((await coordinator.command({ kind: 'set-feed-check-interval', minutes: 1 })).kind, 'board');
    clock += 60000;
    published = 2;
    reads.length = 0;
    await sweep(); await drain();
    const second = await coordinator.command({ kind: 'sources' });
    assert.equal(second.kind, 'sources');
    if (second.kind === 'sources') {
      assert.equal(second.snapshot.games[0].workingChoiceCount, 2);
      assert.deepEqual(second.snapshot.games[0].candidates.find(candidate => candidate.id === firstCandidateId)?.availability,
        { kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}, checkedAt: at });
      assert.deepEqual(second.snapshot.games[0].candidates.find(candidate => candidate.id !== firstCandidateId)?.availability,
        { kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}, checkedAt: at + 60_000 });
    }
    assert.equal(reads.filter(page => page === 'detail').length, 1);
  } finally { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); }
});
