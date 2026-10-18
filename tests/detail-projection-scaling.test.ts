import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { AdvancingVideo, Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-11T18:00:00Z');
const proof: AdvancingVideo = { kind: 'advancing-video', version: 1, startupMs: 3000,
  observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 4 };

for (const size of [32, 64]) test(`changed detail identities retract every unselected alias with linear locator reads for ${size} listings`, async context => {
  const directory = mkdtempSync(join(tmpdir(), 'detail-projection-'));
  const path = join(directory, 'state.sqlite');
  const team = (name: string) => ({ name, short: name, abbreviation: name, color: '112233', score: '0' });
  const game: Game = { id: 'fixture-game', league: 'nfl', name: 'Away at Home', date: new Date(at).toISOString(),
    home: team('Home'), away: team('Away'), status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'] };
  const observations: Observation[] = Array.from({ length: size }, (_, index) => ({
    id: `listing-${index}`, sourceId: 'fixture', url: `https://fixture.example/event/${index}`,
    title: game.name, league: 'nfl', teams: ['Away', 'Home'], kickoff: at, rawTime: '', observedAt: at, parserVersion: 3,
  }));
  let locatorReads = 0;
  const instrumented = new WeakSet<object>();
  const coordinator = createFootballCoordinator(path, {
    now: () => at, schedules: [{ id: 'nfl', league: 'nfl', path: '/fixture', group: null }],
    sources: [{ id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' }],
    readSchedule: async () => ({ games: [game], league: 'nfl', at }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: 'parsed', observations }),
    enrichObservation: value => value,
    compatiblePlayers: (_gameId, observation) => {
      const index = observation.id.slice('listing-'.length);
      const locator = { provider: 'gooz' as const, playerId: index };
      return [{ id: `player-${index}`, label: `Player ${index}`, locator },
        ...(index === '0' ? [{ id: 'alias-0', label: 'Alias', locator }] : [])];
    },
    probeIdentity: locator => {
      if (locator.provider === 'gooz' && !instrumented.has(locator)) {
        const playerId = locator.playerId;
        Object.defineProperty(locator, 'playerId', { enumerable: true, configurable: true,
          get() { locatorReads++; return playerId; } });
        instrumented.add(locator);
      }
      return JSON.stringify(locator);
    },
    probeCandidate: async () => ({ kind: 'playable', proof }),
  });
  try {
    await coordinator.command({ kind: 'refresh' });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      const reply = await coordinator.command({ kind: 'sources' });
      const candidates = reply.kind === 'sources' ? reply.snapshot.games[0]?.candidates : undefined;
      if (candidates?.length === size + 1 && candidates.every(candidate => candidate.availability.kind === 'playable')) {
        ready = true;
        break;
      }
    }
    assert.ok(ready, 'every published candidate must have playback proof before the identity correction');
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false, initialCandidateId: 'player-0' });
    assert.equal(opened.kind, 'playback');
    const database = new DatabaseSync(path);
    try {
      database.prepare("UPDATE details SET payload=json_set(payload,'$.identity','corrected') WHERE observation_id<>?")
        .run(`listing-${size - 1}`);
    } finally { database.close(); }
    locatorReads = 0;
    await coordinator.command({ kind: 'set-retention', minutes: 1440 });
    const measuredReads = locatorReads;
    const reply = await coordinator.command({ kind: 'sources' });
    assert.equal(reply.kind, 'sources');
    if (reply.kind !== 'sources') throw new Error('Expected source inventory');
    const candidates = reply.snapshot.games.find(row => row.gameId === game.id)?.candidates;
    assert.deepEqual(candidates?.map(candidate => candidate.id).sort(), ['player-0', `player-${size - 1}`].sort());
    assert.ok(candidates?.every(candidate => candidate.availability.kind === 'playable'));
    locatorReads = 0;
    const started = performance.now();
    const cpu = process.cpuUsage();
    const projections = 25;
    for (let index = 0; index < projections; index++)
      await coordinator.command({ kind: 'set-retention', minutes: 1440 });
    const used = process.cpuUsage(cpu);
    context.diagnostic(JSON.stringify({ listings: size, firstProjectionLocatorReads: measuredReads,
      projections, replayLocatorReads: locatorReads, wallMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000 }));
    assert.ok(measuredReads <= size * 20,
      `${size} changed listings read candidate locators ${measuredReads} times, exceeding the linear budget ${size * 20}`);
    assert.ok(locatorReads <= projections * size * 20,
      `Repeated projection exceeded its linear budget with ${locatorReads} locator reads`);
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
