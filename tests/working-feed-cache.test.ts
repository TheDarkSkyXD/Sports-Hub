import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateLocator, Game } from '../lib/football/shared.ts';
import { WorkingFeedSchema, type WorkingFeed } from '../lib/football/domain/working-feed.ts';
import { persistableLocator } from '../lib/playback/persistent-locator.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const game: Game = { id: '10001', league: 'nfl', name: 'Denver Broncos at San Francisco 49ers',
  date: new Date(at).toISOString(), lifecycle: 'live', status: 'in', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { id: 'sf', name: 'San Francisco 49ers', short: '49ers', abbreviation: 'SF', color: '112233', score: '0' },
  away: { id: 'den', name: 'Denver Broncos', short: 'Broncos', abbreviation: 'DEN', color: '332211', score: '0' } };
async function drain() { for (let index = 0; index < 60; index++) await new Promise<void>(resolve => setImmediate(resolve)); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'working-feed-cache-')), path = join(directory, 'state.sqlite');
  let clock = at, current: Game[] = [game], visible = true, failSchedule = false, listingVersion = 1;
  let probe: (locator: CandidateLocator) => Promise<CandidateProbeResult> = async () => ({ kind: 'playable', proof: 'media' });
  let sourceIds = ['fixture'], locators: CandidateLocator[] = [{ provider: 'gooz', playerId: '100' }], partitionIds = ['nfl'];
  const partitionResults = new Map<string, Game[] | Promise<Game[]>>();
  const probes: CandidateLocator[] = [];
  let detailReads = 0;
  const eventUrl = (sourceId: string, gameId: string) => {
    const locator = locators[sourceIds.indexOf(sourceId)];
    return locator?.provider === 'event-page' ? locator.eventUrl : `https://fixture.example/event/${gameId}/${listingVersion}`;
  };
  const start = () => createFootballCoordinator(path, {
    now: () => clock, schedules: partitionIds.map(id => ({ id, league: 'nfl', path: '/fixture', group: null })),
    sources: sourceIds.map(id => ({ id, url: `https://fixture.example/list/${id}`, family: 'fixture',
      publicUrls: locators.flatMap(locator => locator.provider === 'event-page' ? [locator.eventUrl] : []) })),
    readSchedule: async source => { if (failSchedule) throw new Error('schedule offline'); return { games: await (partitionResults.get(source.id) ?? current), league: 'nfl', at: clock }; },
    readHtml: async () => { detailReads++; return '<main>published</main>'; },
    parseListings: source => ({ outcome: visible ? 'parsed' : 'empty', observations: visible ? current.map(row => ({
      id: `${source.id}:${row.id}`, sourceId: source.id, url: eventUrl(source.id, row.id),
      title: row.name, league: row.league, teams: [row.away.name, row.home.name], kickoff: Date.parse(row.date!),
      rawTime: '', observedAt: clock, parserVersion: 2,
    })) : [] }),
    enrichObservation: value => value,
    compatiblePlayers: (_gameId, observation) => locators.flatMap((locator, index) => locator.provider === 'event-page' && locator.eventUrl !== observation.url ? [] :
      [{ id: `${observation.sourceId}-${index}`, label: `Free ${index}`, locator }]),
    probeCandidate: async locator => { probes.push(locator); return probe(locator); },
  });
  return { path, probes, start, detailReads: () => detailReads,
    setClock: (value: number) => { clock = value; }, hide: () => { visible = false; },
    setGames: (value: Game[]) => { current = value; }, setSources: (value: string[]) => { sourceIds = value; },
    setLocators: (value: CandidateLocator[]) => { locators = value; }, setScheduleFailure: (value: boolean) => { failSchedule = value; },
    setPartitions: (value: string[]) => { partitionIds = value; }, partitionResults,
    setListingVersion: (value: number) => { listingVersion = value; },
    setProbe: (value: (locator: CandidateLocator) => Promise<CandidateProbeResult>) => { probe = value; },
    readRows() { const db = new DatabaseSync(path); try { return db.prepare('SELECT payload FROM working_feeds').all().map(row => WorkingFeedSchema.parse(JSON.parse(String(row.payload)))); } finally { db.close(); } },
    sql(value: string) { const db = new DatabaseSync(path); try { db.exec(value); } finally { db.close(); } },
    writeRows(feeds: WorkingFeed[]) { const db = new DatabaseSync(path); try {
      for (const feed of feeds) db.prepare('INSERT OR REPLACE INTO working_feeds VALUES (?,?,?,?)')
        .run(feed.candidate.gameId, feed.candidate.id, feed.identityHash, JSON.stringify(feed));
    } finally { db.close(); } },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}
async function snapshot(coordinator: ReturnType<typeof createFootballCoordinator>) {
  const reply = await coordinator.command({ kind: 'sources' });
  assert.equal(reply.kind, 'sources');
  if (reply.kind !== 'sources') throw new Error('Expected sources');
  return reply.snapshot;
}

test('working choices survive stop and recreate without another probe or a new checked time', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    const before = (await snapshot(coordinator)).games[0].candidates;
    assert.equal(run.probes.length, 1);
    await coordinator.stop();
    coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.deepEqual((await snapshot(coordinator)).games[0].candidates, before);
    assert.equal(run.probes.length, 1);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('public Sportsurge query pages retain media proof across coordinator restart without probing again', async () => {
  const run = fixture();
  run.setLocators([
    { provider: 'sportsurge-v2', eventId: 'nfl:10001', providerId: 'sportsupa',
      url: 'https://sportsupa.st/event/?id=san-francisco-49ers-vs-denver-broncos-2475434&src=best&sno=1' },
    { provider: 'sportsurge-v2', eventId: 'nfl:10001', providerId: 'embedca',
      url: 'https://live.embedca.st/live.php?ch=es211' },
  ]);
  let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    const before = (await snapshot(coordinator)).games[0].candidates;
    assert.equal(before.length, 2);
    assert.deepEqual(before.map(row => row.availability), [
      { kind: 'playable', proof: 'media', checkedAt: at },
      { kind: 'playable', proof: 'media', checkedAt: at },
    ]);
    assert.equal(run.probes.length, 2);
    await coordinator.stop(); run.hide(); run.setClock(at + 60_000);
    coordinator = run.start();
    assert.deepEqual((await snapshot(coordinator)).games[0].candidates, before);
    await coordinator.refresh(true); await drain();
    assert.deepEqual((await snapshot(coordinator)).games[0].candidates, before);
    assert.equal(run.probes.length, 2);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('old live and scheduled working choices are visible before schedule refresh', async () => {
  for (const scheduled of [false, true]) {
    const run = fixture();
    if (scheduled) run.setGames([{ ...game, lifecycle: 'scheduled', status: 'pre', date: '2026-10-05T17:00:00Z' }]);
    let coordinator = run.start();
    try {
      await coordinator.refresh(true); await drain();
      const before = (await snapshot(coordinator)).games[0].candidates[0];
      await coordinator.stop(); run.hide(); run.setClock(at + 31 * 60_000);
      coordinator = run.start();
      assert.deepEqual((await snapshot(coordinator)).games[0].candidates[0], before);
      assert.equal(run.probes.length, 1);
      await coordinator.refresh(true); await drain();
      assert.deepEqual((await snapshot(coordinator)).games[0].candidates[0], before);
      assert.equal(run.probes.length, 1);
    } finally { await coordinator.stop(); run.cleanup(); }
  }
});

test('a held schedule refresh leaves saved working feeds open without network or media reads', async () => {
  for (const scheduled of [false, true]) {
    const run = fixture();
    if (scheduled) run.setGames([{ ...game, lifecycle: 'scheduled', status: 'pre', date: '2026-10-05T17:00:00Z' }]);
    let coordinator = run.start();
    let release: ((games: Game[]) => void) | undefined;
    let pending: Promise<void> | undefined;
    try {
      await coordinator.refresh(true); await drain();
      const candidate = (await snapshot(coordinator)).games[0].candidates[0];
      const reads = run.detailReads();
      await coordinator.stop(); run.hide(); run.setClock(at + (scheduled ? 25 * 60 : 31) * 60_000);
      run.partitionResults.set('nfl', new Promise<Game[]>(resolve => { release = resolve; }));
      coordinator = run.start(); pending = coordinator.refresh(true); await drain();
      const sources = await snapshot(coordinator);
      assert.deepEqual(sources.games[0].candidates[0], candidate);
      const board = await coordinator.command({ kind: 'board' });
      assert.equal(board.kind, 'board');
      if (board.kind === 'board') assert.equal(board.board.games.find(row => row.id === game.id)?.sourceUrl, `/play/${game.id}`);
      const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
      assert.equal(opened.kind, 'playback');
      if (opened.kind === 'playback') {
        assert.deepEqual(opened.playback.candidates.map(row => row.id), [candidate.id]);
        const session = opened.playback.session;
        assert.equal((await coordinator.command({ kind: 'authorize', sessionId: session.id,
          candidateId: session.candidateId, generation: session.generation })).kind, 'authorized');
      }
      assert.equal((await coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: false })).kind, 'error');
      assert.equal(run.probes.length, 1);
      assert.equal(run.detailReads(), reads);
    } finally {
      release?.([]); await pending;
      await coordinator.stop(); run.cleanup();
    }
  }
});

test('stale saved proof excludes unverified sibling routes and yesterday live games', async () => {
  const run = fixture(); run.setLocators([{ provider: 'gooz', playerId: '100' }, { provider: 'gooz', playerId: '200' }]);
  run.setProbe(async locator => locator.provider === 'gooz' && locator.playerId === '100' ?
    { kind: 'playable', proof: 'media' } : { kind: 'unavailable', reason: 'timeout' });
  let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates.length, 2);
    run.setClock(at + 85_000);
    assert.equal((await snapshot(coordinator)).games[0].candidates.length, 2);
    run.setClock(at + 91_000);
    const stale = await snapshot(coordinator);
    assert.equal(stale.games[0].candidates.length, 1);
    assert.equal(stale.games[0].candidates[0].availability.kind, 'playable');
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind === 'playback') {
      assert.equal(opened.playback.candidates.length, 1);
      const sessionReply = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id,
        generation: opened.playback.session.generation, failure: false, retry: false });
      assert.equal(sessionReply.kind, 'session');
      if (sessionReply.kind === 'session') assert.equal(sessionReply.candidates.length, 1);
    }
    await coordinator.stop(); run.setClock(at + 25 * 60 * 60_000); coordinator = run.start();
    assert.equal((await snapshot(coordinator)).games.length, 0);
    const board = await coordinator.command({ kind: 'board' });
    assert.equal(board.kind, 'board');
    if (board.kind === 'board') assert.equal(board.board.games.find(row => row.id === game.id), undefined);
    assert.equal((await coordinator.command({ kind: 'open', gameId: game.id, manual: false })).kind, 'error');
    assert.equal(run.probes.length, 2);
    run.hide(); await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
    assert.equal(run.probes.length, 2);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('normalized aliases persist together, trim removed sources, and invalidate together on playback failure', async () => {
  const run = fixture(); run.setSources(['first']);
  let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    assert.equal(run.probes.length, 1);
    assert.equal(run.readRows().length, 1);
    await coordinator.stop(); run.setSources(['first', 'second']); coordinator = run.start();
    await coordinator.refresh(true); await drain();
    assert.equal(run.probes.length, 1);
    assert.equal(run.readRows().length, 2);
    await coordinator.stop(); run.setSources(['second']); coordinator = run.start();
    await coordinator.refresh(true); await drain();
    assert.equal(run.readRows().length, 1);
    assert.deepEqual(run.readRows()[0].candidate.sourceIds, ['second']);
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id, generation: 0, failure: true, retry: false });
    assert.equal(run.readRows().length, 0);
    await coordinator.stop(); coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.equal(run.probes.length, 2);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('schema-valid aliases with another team owner are discarded independently', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain(); await coordinator.stop();
    const feed = run.readRows()[0];
    run.writeRows([{ ...feed, candidate: { ...feed.candidate, id: 'wrong-owner' },
      owner: { ...feed.owner, home: { id: 'other', name: 'Other Team' } } }]);
    coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.deepEqual((await snapshot(coordinator)).games[0].candidates.map(row => row.id), [feed.candidate.id]);
    assert.equal(run.readRows().length, 1);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('changed teams discard cached proof while date-only rescheduling preserves it outside and back inside the window', async () => {
  for (const changeTeams of [false, true]) {
    const run = fixture(); let coordinator = run.start();
    try {
      await coordinator.refresh(true); await drain(); await coordinator.stop(); run.hide(); run.setClock(at + 31 * 60_000);
      const changed: Game = changeTeams ? { ...game, home: { ...game.home, id: 'other', name: 'Other Team' } } :
        { ...game, lifecycle: 'scheduled', status: 'pre', date: '2026-10-08T17:00:00Z' };
      run.setGames([changed]); coordinator = run.start(); await coordinator.refresh(true); await drain();
      assert.equal((await snapshot(coordinator)).games.flatMap(row => row.candidates).length, 0);
      assert.equal(run.readRows().length, changeTeams ? 0 : 1);
      if (!changeTeams) {
        run.setGames([{ ...changed, date: '2026-10-05T17:00:00Z' }]); await coordinator.refresh(true); await drain();
        assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
        assert.equal(run.probes.length, 1);
      }
    } finally { await coordinator.stop(); run.cleanup(); }
  }
});

test('absence cleanup waits for every league partition and final cleanup needs no remaining observation', async () => {
  for (const final of [false, true]) {
    const run = fixture(); run.setPartitions(['nfl', 'other']); run.setGames([{ ...game, partitions: ['nfl', 'other'] }]); let coordinator = run.start();
    try {
      await coordinator.refresh(true); await drain(); await coordinator.stop(); run.hide(); run.setClock(at + 31 * 60_000);
      run.sql('DELETE FROM observations; DELETE FROM details;');
      if (final) run.setGames([{ ...game, lifecycle: 'final', status: 'post', finalObservedAt: at + 31 * 60_000, graceEndsAt: at + 36 * 60_000 }]);
      else {
        run.setGames([]); run.partitionResults.set('nfl', []);
        let release!: (games: Game[]) => void;
        run.partitionResults.set('other', new Promise<Game[]>(resolve => { release = resolve; }));
        coordinator = run.start(); const refresh = coordinator.refresh(true); await drain();
        try {
          assert.equal(run.readRows().length, 1);
          assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
        } finally { release([]); } await refresh; await drain();
        assert.equal(run.readRows().length, 0);
        continue;
      }
      coordinator = run.start(); await coordinator.refresh(true); await drain();
      await coordinator.command({ kind: 'set-retention', minutes: 5 });
      run.setClock(at + 40 * 60_000); await coordinator.refresh(true); await drain();
      assert.equal(run.readRows().length, 0, JSON.stringify(await coordinator.command({ kind: 'board' })));
    } finally { await coordinator.stop(); run.cleanup(); }
  }
});

test('corrupt and unsupported cache rows are removed without blocking restart', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain(); await coordinator.stop();
    run.sql(`INSERT INTO working_feeds VALUES ('bad','bad','bad','not-json');
      INSERT INTO working_feeds SELECT 'old','old',identity_hash,json_set(payload,'$.version',999) FROM working_feeds WHERE game_id='${game.id}';`);
    coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.equal(run.readRows().length, 1);
    assert.equal(run.probes.length, 1);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('a failed durable positive write leaves real media playable and reports the storage failure', async () => {
  const run = fixture(); const coordinator = run.start();
  try {
    run.sql("CREATE TRIGGER deny_cache BEFORE INSERT ON working_feeds BEGIN SELECT RAISE(FAIL,'cache-unavailable'); END;");
    await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    if (reply.kind === 'board') assert.ok(reply.board.leagues.nfl.errors.some(error => error.includes('could not be saved')));
    assert.equal(run.readRows().length, 0);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('persistable locators are original public pages or opaque IDs, never signed or direct media URLs', () => {
  const page = (url: string): CandidateLocator => ({ provider: 'sportsurge-v2', eventId: 'nfl:10001', providerId: 'public-page', url });
  assert.equal(persistableLocator(page('https://provider.example/watch/game-123')), true);
  for (const url of ['https://provider.example/live.m3u8', 'https://provider.example/hls/123',
    'https://provider.example/watch?token=secret', 'https://user:password@provider.example/watch',
    'https://provider.example/watch#secret', 'http://provider.example/watch']) assert.equal(persistableLocator(page(url)), false);
  assert.equal(persistableLocator({ provider: 'event-page', gameId: game.id,
    eventUrl: 'https://tvapp1.pk/watch/12', serverUrl: 'https://tvapp1.pk/watch/12' }), true);
});

test('an aged scheduled working route and its changed-locator alias both survive restart', async () => {
  const run = fixture(); run.setGames([{ ...game, lifecycle: 'scheduled', status: 'pre', date: '2026-10-05T17:00:00Z' }]);
  let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain();
    run.setClock(at + 301_000); run.setListingVersion(2); run.setLocators([{ provider: 'gooz', playerId: '200' }]);
    await coordinator.refresh(true); await drain();
    const before = (await snapshot(coordinator)).games[0].candidates;
    assert.equal(before.length, 2);
    assert.ok(before.every(row => row.availability.kind === 'playable'));
    assert.equal(run.readRows().length, 2);
    await coordinator.stop(); run.hide(); run.setClock(at + 40 * 60_000);
    coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.deepEqual((await snapshot(coordinator)).games[0].candidates, before);
    assert.equal(run.probes.length, 2);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('only recognized public Sportsurge event and channel queries can be persisted', () => {
  const page = (url: string): CandidateLocator => ({ provider: 'sportsurge-v2', eventId: 'nfl:10001', providerId: 'public-page', url });
  const event = 'https://sportsupa.st/event/?id=carolina-panthers-vs-detroit-lions-2475436&src=best&sno=1';
  const channel = 'https://live.embedca.st/live.php?ch=es213';
  for (const url of [event, channel,
    'https://sportsupa.st/event/?sno=2&src=best&id=san-francisco-49ers-vs-denver-broncos-2475434']) {
    assert.equal(persistableLocator(page(url)), true, url);
  }
  for (const url of [
    `${event}&token=secret`, `${event}&signature=secret`, `${channel}&expires=1791159196`,
    `${event}&id=other-vs-game-1`, `${event}&src=best`, `${event}&sno=1`, `${channel}&ch=es214`,
    event.replace('sportsupa.st', 'provider.example'), event.replace('/event/', '/watch/'),
    channel.replace('live.embedca.st', 'embedca.st'), channel.replace('/live.php', '/player.php'),
    event.replace('src=best', 'src=other'), event.replace('sno=1', 'sno=0'), event.replace('sno=1', 'sno=secret'),
    event.replace('sno=1', 'sno=12345'), event.replace('carolina-panthers-vs-detroit-lions-2475436', 'secret'),
    event.replace('carolina-panthers-vs-detroit-lions-2475436', 'carolina-panthers-vs-detroit-lions'),
    event.replace('&src=best', ''), event.replace('&sno=1', ''),
    channel.replace('es213', 'secret'), channel.replace('es213', 'es1234567'), channel.replace('es213', 'es%32%31%33'),
    channel.replace('https:', 'http:'), channel.replace('live.embedca.st', 'user:secret@live.embedca.st'),
    channel.replace('live.embedca.st', 'live.embedca.st:8443'), `${channel}#secret`,
  ]) assert.equal(persistableLocator(page(url)), false, url);
});

test('decoded playback persists and a late canceled probe cannot overwrite it across restart', async () => {
  const run = fixture(); let coordinator = run.start();
  let release: (value: CandidateProbeResult) => void = () => {};
  try {
    await coordinator.refresh(true); await drain();
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback'); if (opened.kind !== 'playback') return;
    const session = opened.playback.session;
    await coordinator.command({ kind: 'session', sessionId: session.id, generation: 0, failure: true, retry: false });
    run.setProbe(() => new Promise(resolve => { release = resolve; }));
    await coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true }); await drain();
    assert.equal(run.probes.length, 2);
    const decoded = await coordinator.command({ kind: 'playback-evidence', sessionId: session.id, candidateId: session.candidateId,
      generation: 1, evidence: { kind: 'decoded', startupMs: 100 } });
    assert.equal(decoded.kind, 'ok');
    release({ kind: 'unavailable', reason: 'timeout' }); await drain();
    assert.equal(run.readRows()[0].proof, 'decoded');
    await coordinator.stop(); coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
    assert.equal(run.readRows()[0].proof, 'decoded');
    assert.equal(run.probes.length, 2);
  } finally { release({ kind: 'unavailable', reason: 'timeout' }); await coordinator.stop(); run.cleanup(); }
});

test('a failed startup schedule keeps stale working choices visible with durable evidence', async () => {
  const run = fixture(); let coordinator = run.start();
  try {
    await coordinator.refresh(true); await drain(); await coordinator.stop();
    run.hide(); run.setClock(at + 31 * 60_000); run.setScheduleFailure(true);
    coordinator = run.start(); await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
    assert.equal(run.readRows().length, 1);
    run.setScheduleFailure(false); await coordinator.refresh(true); await drain();
    assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
    assert.equal(run.probes.length, 1);
  } finally { await coordinator.stop(); run.cleanup(); }
});

test('removed browser collectors cannot restore or rediscover cached catalog choices after restart', async () => {
  for (const sourceId of ['sportsurge-v2', 'streameast']) {
    const run = fixture(); run.setSources([sourceId]); run.hide(); let coordinator = run.start();
    try {
      await coordinator.refresh(true); await drain();
      const common = { runId: '11111111-1111-4111-8111-111111111111', sequence: 0, startedAt: at,
        state: { kind: 'complete' as const, at }, categories: { nfl: { kind: 'collected' as const, at }, ncaaf: { kind: 'collected' as const, at } }, rejectedGames: [] };
      const event = { id: 'nfl:10001', league: 'nfl' as const, title: game.name,
        teams: [game.away.name, game.home.name] as [string, string], kickoff: at };
      const reply = sourceId === 'sportsurge-v2' ? await coordinator.command({ kind: 'sportsurge-catalog', catalog: {
        ...common, catalogIssues: [], events: [{ ...event, url: 'https://v2.sportsurge.net/watch-10001-nfl-denver-san-francisco/',
          sourceStatus: 'live', advertisedLinkCount: 1, detail: { kind: 'collected', at, providers: [
            { id: 'provider-1', label: 'Public page', observedAt: at, destination: { kind: 'link', url: 'https://provider.example/watch/game-10001' } },
          ] } }],
      } }) : await coordinator.command({ kind: 'streameast-catalog', catalog: {
        ...common, events: [{ ...event, url: 'https://v2.streameast.ga/nfl/denver-san-francisco/', espnEventId: game.id,
          detail: { kind: 'collected', at, servers: [{ id: '1', label: 'Free 1',
            url: 'https://v2.streameast.ga/nfl/denver-san-francisco/1', availability: { kind: 'free-channel', channelId: '33' } }] } }],
      } });
      assert.equal(reply.kind, 'catalog-ack');
      await coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: false }); await drain();
      assert.equal((await snapshot(coordinator)).games[0].candidates[0].availability.kind, 'playable');
      assert.equal(run.readRows().length, 1);
      await coordinator.stop(); run.setSources([]); coordinator = run.start(); await coordinator.refresh(true); await drain();
      assert.equal((await snapshot(coordinator)).games.flatMap(row => row.candidates).length, 0);
      assert.equal(run.readRows().length, 0);
      assert.equal(run.probes.length, 1);
    } finally { await coordinator.stop(); run.cleanup(); }
  }
});
