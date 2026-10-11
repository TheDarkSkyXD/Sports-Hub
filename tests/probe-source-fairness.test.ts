import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { CandidateProbeResult, FootballDependencies } from '../lib/football/domain/ports.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-10T23:00:00Z');
const proof = { kind: 'advancing-video', version: 1, startupMs: 3000, observedMs: 3000,
  mediaAdvanceMs: 3000, presentedFrames: 4 } satisfies Extract<CandidateProbeResult, { kind: 'playable' }>['proof'];
const game: Game = { id: '100', league: 'nfl', name: 'Away at Home', date: new Date(at).toISOString(),
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  home: { name: 'Home', short: 'Home', abbreviation: 'HOM', color: '112233', score: null },
  away: { name: 'Away', short: 'Away', abbreviation: 'AWY', color: '332211', score: null } };

function fixture(probe: FootballDependencies['probeCandidate'], aliases = false, options: { catalogCount?: number; ppvListed?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-source-fairness-'));
  let clock = at;
  let ppvListed = options.ppvListed ?? true;
  const sourceIds = aliases ? ['catalog', 'ppv', 'alias'] : ['catalog', 'ppv'];
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: sourceIds.map(id => ({ id, url: `https://fixture.example/${id}`, family: 'fixture' })),
    readSchedule: async () => ({ games: [game], league: 'nfl', at: clock }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: source => ({ outcome: source.id === 'ppv' && !ppvListed ? 'empty' : 'parsed', observations: source.id === 'ppv' && !ppvListed ? [] : [{ id: `listing-${source.id}`, sourceId: source.id,
      url: `https://fixture.example/${source.id}/event`, title: game.name, teams: ['Away', 'Home'], league: 'nfl',
      kickoff: at, rawTime: game.date ?? '', observedAt: clock, parserVersion: 1 } satisfies Observation] }),
    enrichObservation: value => value,
    compatiblePlayers: (_gameId, observation) => (observation.sourceId === 'catalog' ? Array.from({ length: options.catalogCount ?? 4 }, (_, index) => index + 1) :
      observation.sourceId === 'alias' ? [1, 5] : [9]).map(playerId => ({
      id: `${observation.sourceId === 'ppv' ? 'z' : observation.sourceId === 'alias' ? 'b' : 'a'}-${observation.sourceId}-${playerId}`,
      label: `Server ${playerId}`, locator: { provider: 'gooz', playerId: String(playerId) },
    })),
    probeCandidate: probe,
  });
  return { coordinator, publishPpv(elapsed: number) { clock = at + elapsed; ppvListed = true; },
    async stop() { await coordinator.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Expected the source frontier to advance');
}

function hold() {
  let release: (result: CandidateProbeResult) => void = () => {};
  const promise = new Promise<CandidateProbeResult>(resolve => { release = resolve; });
  return { promise, release };
}

test('a PPV first check finishes before redundant catalog siblings occupy the game frontier', async () => {
  const blocked = hold();
  const calls: string[] = [];
  const run = fixture(async locator => {
    assert.equal(locator.provider, 'gooz');
    if (locator.provider !== 'gooz') throw new Error('Unexpected provider');
    calls.push(locator.playerId);
    return locator.playerId === '1' || locator.playerId === '9' ? { kind: 'playable', proof } : blocked.promise;
  });
  try {
    await run.coordinator.refresh(true);
    await until(() => calls.length >= 3);
    assert.deepEqual(calls.slice(0, 2), ['1', '9']);
    const reply = await run.coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    assert.equal(reply.snapshot.games[0].candidates.find(candidate => candidate.sourceIds.includes('ppv'))?.availability.kind, 'playable');
  } finally { blocked.release({ kind: 'unavailable', reason: 'invalid-media' }); await run.stop(); }
});

for (const aliases of [false, true]) test(`a demanded game admits distinct source checks together${aliases ? ' without duplicate alias probes' : ''}`, async () => {
  const blocked = hold();
  const calls: string[] = [];
  const run = fixture(async locator => {
    assert.equal(locator.provider, 'gooz');
    if (locator.provider !== 'gooz') throw new Error('Unexpected provider');
    calls.push(locator.playerId);
    return blocked.promise;
  }, aliases);
  try {
    await run.coordinator.refresh(true);
    await until(() => calls.length === 2);
    assert.deepEqual([...calls].sort(), ['1', '9']);
    const reply = await run.coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected sources');
    const ppv = reply.snapshot.games[0].candidates.find(candidate => candidate.sourceIds.includes('ppv'));
    assert.equal(ppv?.availability.kind, 'checking');
  } finally { blocked.release({ kind: 'unavailable', reason: 'invalid-media' }); await run.stop(); }
});

for (const queued of [false, true]) test(`a new PPV source gets the lower-priority turn after three same-game working-feed rechecks${queued ? ' and retains its observer wait' : ''}`, async () => {
  const calls: string[] = [];
  const pending = new Map<string, ReturnType<typeof hold>>();
  let rechecking = false;
  const run = fixture(async (locator, _signal, onProgress) => {
    assert.equal(locator.provider, 'gooz');
    if (locator.provider !== 'gooz') throw new Error('Unexpected provider');
    calls.push(locator.playerId);
    onProgress({ kind: queued && locator.playerId === '9' ? 'queued' : 'active' });
    if (!rechecking || locator.playerId === '9' && !queued) return { kind: 'playable', proof };
    const blocked = hold();
    pending.set(locator.playerId, blocked);
    return blocked.promise;
  }, false, { catalogCount: 6, ppvListed: false });
  try {
    await run.coordinator.refresh(true);
    await until(() => calls.length === 6);
    calls.length = 0;
    rechecking = true;
    run.publishPpv(300_000);
    await run.coordinator.refresh(true);
    await until(() => calls.length === 2);
    assert.deepEqual(calls, ['1', '2']);
    pending.get('1')?.release({ kind: 'playable', proof });
    await until(() => calls.length === 3);
    assert.equal(calls[2], '3');
    pending.get('2')?.release({ kind: 'playable', proof });
    await until(() => calls.length >= 4);
    assert.equal(calls[3], '9');
    if (queued) {
      await run.coordinator.refresh(true);
      const reply = await run.coordinator.command({ kind: 'sources' });
      assert.equal(reply.kind, 'sources');
      if (reply.kind !== 'sources') throw new Error('Expected sources');
      assert.equal(reply.snapshot.games[0].candidates.find(candidate => candidate.sourceIds.includes('ppv'))?.availability.kind, 'checking');
      assert.equal(calls.filter(id => id === '9').length, 1);
      pending.get('9')?.release({ kind: 'playable', proof });
    }
    await until(async () => {
      const reply = await run.coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && reply.snapshot.games[0].candidates.some(candidate =>
        candidate.sourceIds.includes('ppv') && candidate.availability.kind === 'playable');
    });
  } finally {
    for (const blocked of pending.values()) blocked.release({ kind: 'unavailable', reason: 'invalid-media' });
    await run.stop();
  }
});
