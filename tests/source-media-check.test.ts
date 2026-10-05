import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult } from '../lib/football/domain/ports.ts';
import type { CandidateLocator, Game, Observation } from '../lib/football/shared.ts';
import { validEventPagePair } from '../lib/playback/providers/event-page-policy.ts';

const at = Date.parse('2026-10-04T17:00:00Z');
const crackPage = 'https://crackstreams.st/event/m-indianapolis-colts-vs-washington-commanders-1004';
const methPage = 'https://methstreams.st/event/m-indianapolis-colts-vs-washington-commanders-1004';
const sharedServer = 'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/core/1';
const otherServers = [
  'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/core/2',
  'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/vector/1',
  'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/vertex/1',
];
const fifthServer = 'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/foxtrot/1';
const invalidPage = 'https://ppv.st/live/nfl/2026-10-04/ind-wsh';

const game: Game = {
  id: '401872965', league: 'nfl', name: 'Indianapolis Colts at Washington Commanders',
  date: new Date(at).toISOString(),
  home: { name: 'Washington Commanders', short: 'Commanders', abbreviation: 'WSH', color: '112233', score: '0' },
  away: { name: 'Indianapolis Colts', short: 'Colts', abbreviation: 'IND', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
};

function observation(id: string, sourceId: string, match: Game, url: string): Observation {
  return {
    id, sourceId, url, title: match.name, league: 'nfl',
    teams: [match.away.name, match.home.name], kickoff: at, rawTime: '', observedAt: at, parserVersion: 1,
  };
}

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for coordinator probes or source snapshot');
}

function fixture(options: { extraServers: boolean; secondGame: boolean; fifthServer?: boolean; malformedAlias?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'source-media-check-'));
  const otherGame: Game = {
    ...game, id: '401872966', name: 'Miami Dolphins at Minnesota Vikings',
    home: { ...game.home, name: 'Minnesota Vikings', short: 'Vikings', abbreviation: 'MIN' },
    away: { ...game.away, name: 'Miami Dolphins', short: 'Dolphins', abbreviation: 'MIA' },
  };
  const listings = [
    observation('crack-event', 'crack', game, crackPage),
    observation('meth-event', 'meth', game, methPage),
    ...(options.malformedAlias ? [observation('invalid-event', 'invalid', game, invalidPage)] : []),
    ...(options.secondGame ? [observation('reused-event', 'reused', otherGame, crackPage)] : []),
  ];
  const sources = listings.map(listing => ({ id: listing.sourceId, url: `https://fixture.example/${listing.sourceId}`, family: 'fixture' }));
  const calls: CandidateLocator[] = [];
  const pending: Array<{ locator: CandidateLocator; signal: AbortSignal; resolve: (result: CandidateProbeResult) => void }> = [];
  let clock = at;
  let released = false;
  let crackVisible = true;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, sources,
    readSchedule: async partition => ({ games: partition.id === 'nfl' ? [game, ...(options.secondGame ? [otherGame] : [])] : [],
      league: partition.league, at: clock }),
    readHtml: async () => '<main>Published servers</main>',
    parseListings: source => ({ outcome: 'parsed', observations: listings.filter(listing => listing.sourceId === source.id) }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, listing) => {
      if (listing.sourceId === 'crack' && !crackVisible) return [];
      const servers = listing.sourceId === 'crack' && options.extraServers
        ? [sharedServer, ...otherServers, ...(options.fifthServer ? [fifthServer] : [])] : [sharedServer];
      return servers.map((serverUrl, index) => ({
        id: `${listing.sourceId}-${index}`, label: `${listing.sourceId} server ${index + 1}`,
        locator: { provider: 'event-page' as const, gameId, eventUrl: listing.url, serverUrl },
      }));
    },
    probeCandidate: (locator, signal) => {
      assert.equal(locator.provider, 'event-page');
      calls.push(locator);
      if (released) return Promise.resolve({ kind: 'playable', proof: 'media' });
      return new Promise<CandidateProbeResult>(resolve => {
        pending.push({ locator, signal, resolve });
        signal.addEventListener('abort', () => resolve({ kind: 'deferred', retryAfterMs: 60_000 }), { once: true });
      });
    },
  });
  const candidates = async (gameId = game.id) => {
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    return reply.kind === 'sources' ? reply.snapshot.games.find(row => row.gameId === gameId)?.candidates ?? [] : [];
  };
  const releaseAll = () => {
    released = true;
    for (const job of pending) job.resolve({ kind: 'playable', proof: 'media' });
  };
  const stop = async () => {
    releaseAll();
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  };
  return { coordinator, calls, pending, candidates, releaseAll, stop, otherGame,
    setClock: (value: number) => { clock = value; }, setCrackVisible: (value: boolean) => { crackVisible = value; } };
}

test('same-game event-page aliases consume one probe slot and leave capacity for distinct servers', async () => {
  assert.equal(validEventPagePair(crackPage, sharedServer), true);
  assert.equal(validEventPagePair(methPage, sharedServer), true);
  for (const server of otherServers) assert.equal(validEventPagePair(crackPage, server), true);
  const run = fixture({ extraServers: true, secondGame: false });
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 5 && run.calls.length >= 4);
    assert.equal(new Set(run.calls.slice(0, 4).map(locator => locator.provider === 'event-page' ? locator.serverUrl : '')).size, 4);
    run.releaseAll();
    await until(async () => (await run.candidates()).every(candidate => candidate.availability.kind === 'playable'));
    assert.equal(run.calls.length, 4);
    assert.deepEqual(new Set(run.calls.map(locator => locator.provider === 'event-page' ? locator.serverUrl : '')),
      new Set([sharedServer, ...otherServers]));
  } finally {
    await run.stop();
  }
});

test('a completed media check gives both same-game event-page aliases the same health', async () => {
  const run = fixture({ extraServers: false, secondGame: false });
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 2 && run.pending.length >= 1);
    run.pending[0].resolve({ kind: 'playable', proof: 'media' });
    await until(async () => (await run.candidates()).some(candidate => candidate.availability.kind === 'playable'));
    assert.deepEqual((await run.candidates()).map(candidate => candidate.availability.kind), ['playable', 'playable']);
    assert.equal(run.calls.length, 1);
  } finally {
    await run.stop();
  }
});

test('the same physical server is checked separately for different games', async () => {
  const run = fixture({ extraServers: false, secondGame: true });
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 2 && (await run.candidates(run.otherGame.id)).length === 1 && run.pending.length >= 2);
    const firstGame = run.pending.find(job => job.locator.provider === 'event-page' && job.locator.gameId === game.id);
    const secondGame = run.pending.find(job => job.locator.provider === 'event-page' && job.locator.gameId === run.otherGame.id);
    assert.ok(firstGame);
    assert.ok(secondGame);
    firstGame.resolve({ kind: 'playable', proof: 'media' });
    secondGame.resolve({ kind: 'unavailable', reason: 'upstream' });
    await until(async () => (await run.candidates(run.otherGame.id))[0]?.availability.kind === 'unavailable');
    assert.equal((await run.candidates()).some(candidate => candidate.availability.kind === 'playable'), true);
    assert.equal((await run.candidates(run.otherGame.id))[0]?.availability.kind, 'unavailable');
  } finally {
    await run.stop();
  }
});

test('source health reports queued, active, and deferred media-check progress with transition times', async () => {
  assert.equal(validEventPagePair(crackPage, fifthServer), true);
  const run = fixture({ extraServers: true, fifthServer: true, secondGame: false });
  const availability = async (id: string) => (await run.candidates()).find(candidate => candidate.id === id)?.availability;
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 6 && run.pending.length === 4);
    const servers = [sharedServer, ...otherServers, fifthServer];
    const activeServers = new Set(run.pending.map(job => job.locator.provider === 'event-page' ? job.locator.serverUrl : ''));
    assert.equal(activeServers.size, 4);
    const queuedIndex = servers.findIndex(server => !activeServers.has(server));
    assert.notEqual(queuedIndex, -1);
    for (const [index, server] of servers.entries()) assert.deepEqual(await availability(`crack-${index}`), {
      kind: 'checking', progress: { kind: activeServers.has(server) ? 'active' : 'queued', since: at },
    });
    assert.deepEqual(await availability('meth-0'), await availability('crack-0'));

    run.setClock(at + 1000);
    run.pending[0].resolve({ kind: 'playable', proof: 'media' });
    await until(async () => run.pending.length === 5);
    assert.equal(run.pending[4].locator.provider === 'event-page' ? run.pending[4].locator.serverUrl : '', servers[queuedIndex]);
    assert.deepEqual(await availability(`crack-${queuedIndex}`), { kind: 'checking', progress: { kind: 'active', since: at + 1000 } });

    run.setClock(at + 2000);
    const deferredServer = run.pending[1].locator.provider === 'event-page' ? run.pending[1].locator.serverUrl : '';
    const deferredId = `crack-${servers.indexOf(deferredServer)}`;
    run.pending[1].resolve({ kind: 'deferred', retryAfterMs: 2000 });
    await until(async () => {
      const value = await availability(deferredId);
      return value?.kind === 'checking' && value.progress.kind === 'deferred';
    });
    assert.deepEqual(await availability(deferredId), {
      kind: 'checking', progress: { kind: 'deferred', since: at + 2000, retryAt: at + 4000 },
    });
  } finally {
    await run.stop();
  }
});

test('an invalid event-page alias cannot inherit proof from a valid alias with the same server URL', async () => {
  assert.equal(validEventPagePair(invalidPage, sharedServer), false);
  const run = fixture({ extraServers: false, secondGame: false, malformedAlias: true });
  const availability = async (id: string) => (await run.candidates()).find(candidate => candidate.id === id)?.availability.kind;
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 3 && run.pending.length >= 2);
    const valid = run.pending.find(job => job.locator.provider === 'event-page' && job.locator.eventUrl === crackPage);
    assert.ok(valid);
    valid.resolve({ kind: 'playable', proof: 'media' });
    await until(async () => (await availability('crack-0')) === 'playable');
    assert.equal(await availability('meth-0'), 'playable');
    assert.equal(await availability('invalid-0'), 'checking');
  } finally {
    await run.stop();
  }
});

test('removing the chosen event page retains its in-flight media check through another valid alias', async () => {
  const run = fixture({ extraServers: false, secondGame: false });
  try {
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 2 &&
      run.pending.some(job => job.locator.provider === 'event-page' && job.locator.eventUrl === crackPage));
    const shared = run.pending.find(job => job.locator.provider === 'event-page' && job.locator.eventUrl === crackPage);
    assert.ok(shared);
    run.setClock(at + 300_001);
    run.setCrackVisible(false);
    await run.coordinator.refresh(true);
    await until(async () => (await run.candidates()).length === 1);
    assert.equal((await run.candidates())[0].id, 'meth-0');
    assert.equal(shared.signal.aborted, false);
    shared.resolve({ kind: 'playable', proof: 'media' });
    await until(async () => (await run.candidates())[0]?.availability.kind === 'playable');
    assert.equal(run.calls.length, 1);
  } finally {
    await run.stop();
  }
});

test('opening an unverified game requests its queued media check before older background work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'source-open-priority-'));
  const background: Game = { ...game, id: '401872965', status: 'pre', lifecycle: 'scheduled',
    date: new Date(at + 2 * 60 * 60_000).toISOString(), detail: 'Scheduled' };
  const requested: Game = { ...game, id: '401872975', status: 'pre', lifecycle: 'scheduled',
    date: new Date(at + 3 * 60 * 60_000).toISOString(), detail: 'Scheduled',
    name: 'Denver Broncos at San Francisco 49ers',
    home: { ...game.home, name: 'San Francisco 49ers', short: '49ers', abbreviation: 'SF' },
    away: { ...game.away, name: 'Denver Broncos', short: 'Broncos', abbreviation: 'DEN' },
  };
  const requestedPage = 'https://ppv.st/live/nfl/2026-10-04/den-sf';
  const requestedServer = 'https://embedindia.st/embed/nfl/2026-10-04/den-sf';
  assert.equal(validEventPagePair(requestedPage, requestedServer), true);
  const listings = [
    { ...observation('background-event', 'background', background, crackPage), kickoff: Date.parse(background.date ?? '') },
    { ...observation('requested-event', 'requested', requested, requestedPage), kickoff: Date.parse(requested.date ?? '') },
  ];
  const backgroundServers = [sharedServer, ...otherServers, fifthServer,
    'https://fxtrend.st/event/m-indianapolis-colts-vs-washington-commanders-1004/foxtrot/2'];
  const pending: Array<{ locator: CandidateLocator; resolve: (result: CandidateProbeResult) => void }> = [];
  let clock = at;
  let requestedVisible = false;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock,
    sources: listings.map(listing => ({ id: listing.sourceId, url: `https://fixture.example/${listing.sourceId}`, family: 'fixture' })),
    readSchedule: async partition => ({ games: partition.id === 'nfl' ? [background, requested] : [], league: partition.league, at: clock }),
    readHtml: async () => '<main>Published servers</main>',
    parseListings: source => ({ outcome: 'parsed', observations: listings.filter(listing =>
      listing.sourceId === source.id && (listing.sourceId !== 'requested' || requestedVisible)) }),
    enrichObservation: value => value,
    compatiblePlayers: (gameId, listing) => (gameId === requested.id ? [requestedServer] : backgroundServers)
      .map((serverUrl, index) => ({ id: `${listing.sourceId}-${index}`, label: `Server ${index + 1}`,
        locator: { provider: 'event-page' as const, gameId, eventUrl: listing.url, serverUrl } })),
    probeCandidate: (locator, signal) => new Promise<CandidateProbeResult>(resolve => {
      pending.push({ locator, resolve });
      signal.addEventListener('abort', () => resolve({ kind: 'deferred', retryAfterMs: 60_000 }), { once: true });
    }),
  });
  try {
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && reply.snapshot.games.find(row => row.gameId === background.id)?.candidates.length === 6 &&
        pending.length === 4;
    });
    assert.equal(pending.every(job => job.locator.provider === 'event-page' && job.locator.gameId === background.id), true);
    requestedVisible = true;
    clock = at + 300_001;
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && reply.snapshot.games.find(row => row.gameId === requested.id)?.candidates.length === 1;
    });
    assert.equal(pending.length, 4);
    const opened = await coordinator.command({ kind: 'open', gameId: requested.id, manual: false });
    assert.equal(opened.kind, 'error');
    if (opened.kind === 'error') assert.equal(opened.status, 404);
    pending[0].resolve({ kind: 'playable', proof: 'media' });
    await until(() => pending.length === 5);
    assert.equal(pending[4].locator.provider === 'event-page' ? pending[4].locator.gameId : '', requested.id);
  } finally {
    for (const job of pending) job.resolve({ kind: 'playable', proof: 'media' });
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
