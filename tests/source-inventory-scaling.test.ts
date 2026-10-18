import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import type { AdvancingVideo, Candidate, CandidateAvailability, Game, Observation } from '../lib/football/shared.ts';
import type { ListingSource } from '../lib/football/domain/ports.ts';

test('saved listings retain their matches without rebuilding game aliases for every listing', () => {
  const at = Date.parse('2026-10-08T18:00:00Z');
  let aliasReads = 0;
  const team = (name: string, id: string) => ({
    id, name, short: name, abbreviation: name, color: '112233',
    get aliases() { aliasReads++; return [name]; },
  });
  const games: Game[] = Array.from({ length: 40 }, (_, index) => ({
    id: String(index), league: 'nfl', name: `Away ${index} at Home ${index}`,
    date: new Date(at).toISOString(),
    home: team(`Home ${index}`, `espn:nfl:home-${index}`),
    away: team(`Away ${index}`, `espn:nfl:away-${index}`),
    status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['nfl'],
  }));
  const observations: Observation[] = Array.from({ length: 400 }, (_, index) => ({
    id: `listing-${index}`, sourceId: 'fixture', url: `https://fixture.example/watch/${index}`,
    title: 'Away 0 at Home 0', league: 'nfl', teams: ['Away 0', 'Home 0'],
    kickoff: at, rawTime: new Date(at).toISOString(), observedAt: at, parserVersion: 1,
  }));
  const snapshot = sourceInventory({
    at, revision: 1, lastDiscoveryAt: at,
    sources: [{ id: 'fixture', url: 'https://fixture.example/', family: 'fixture' }],
    observations, games, candidates: new Map(), attempts: {},
    availability: () => ({ kind: 'unknown' }),
    sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
    streameastCatalog: { current: null, lastComplete: null, previous: null },
  });
  assert.equal(snapshot.sources[0].listingCount, 400);
  assert.equal(snapshot.sources[0].matchedGameCount, 1);
  assert.equal(snapshot.sources[0].links[0].gameId, '0');
  assert.ok(aliasReads <= games.length * 8,
    `Source polling reread game aliases ${aliasReads} times for ${games.length} games`);
});

test('one inventory evaluates shared candidate states once and the next snapshot observes changed eligibility and proof', () => {
  const at = Date.parse('2026-10-11T18:00:00Z');
  const sources: ListingSource[] = Array.from({ length: 6 }, (_, index) => ({
    id: `source-${index}`, url: `https://fixture.example/source/${index}`, family: 'fixture', leagues: ['nfl', 'nba'],
  }));
  const team = (name: string) => ({ name, short: name, abbreviation: name, color: '112233', score: '0' });
  const games: Game[] = ['nfl', 'nba'].map((league, index) => ({
    id: String(index), league: league === 'nfl' ? 'nfl' : 'nba', name: `Away ${index} at Home ${index}`,
    home: team(`Home ${index}`), away: team(`Away ${index}`), date: new Date(at).toISOString(),
    status: 'in', lifecycle: 'live', detail: 'Live', redzone: false,
  }));
  const proof: AdvancingVideo = { kind: 'advancing-video', version: 1, startupMs: 3000,
    observedMs: 3000, mediaAdvanceMs: 3000, presentedFrames: 4 };
  const candidates = new Map(games.map(game => [game.id, ['playing', 'checking', 'failed', 'excluded'].map((state, index): Candidate => ({
    id: `${game.id}-${state}`, gameId: game.id, label: state, observedAt: at,
    sourceIds: sources.map(source => source.id), locator: { provider: 'gooz', playerId: `${game.id}${index}` },
  }))]));
  candidates.set('hidden', [{ id: 'hidden', gameId: 'hidden', label: 'Hidden', observedAt: at,
    sourceIds: sources.map(source => source.id), locator: { provider: 'gooz', playerId: '999' } }]);
  const observations: Observation[] = sources.flatMap(source => games.map((game, index) => ({
    id: `${source.id}-${game.id}`, sourceId: source.id, url: `${source.url}/${game.id}`, title: game.name,
    league: game.league, teams: [`Away ${index}`, `Home ${index}`], kickoff: at, rawTime: '', observedAt: at, parserVersion: 3,
  })));
  const eligibilityCalls = new Map<string, number>();
  const availabilityCalls = new Map<string, number>();
  let corrected = false;
  const snapshot = () => sourceInventory({
    at: corrected ? at + 1000 : at, revision: corrected ? 2 : 1, lastDiscoveryAt: at,
    browserCollectorsAvailable: true, sources, games, observations, candidates, attempts: {},
    candidateEligible: candidate => {
      eligibilityCalls.set(candidate.id, (eligibilityCalls.get(candidate.id) || 0) + 1);
      return corrected || !candidate.id.endsWith('-excluded');
    },
    availability: candidate => {
      availabilityCalls.set(candidate.id, (availabilityCalls.get(candidate.id) || 0) + 1);
      if (candidate.id.endsWith('-checking') || corrected && candidate.id.endsWith('-playing'))
        return { kind: 'checking', progress: { kind: 'queued', since: at + 1000 } };
      if (candidate.id.endsWith('-failed')) return { kind: 'unavailable', reason: 'upstream', checkedAt: at, retryAt: at + 300000 };
      return { kind: 'playable', checkedAt: corrected ? at + 1000 : at,
        proof: corrected ? { ...proof, startupMs: 4000 } : proof };
    },
    sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
    streameastCatalog: { current: null, lastComplete: null, previous: null },
  });
  const first = snapshot();
  const initialFeeds = { kind: 'feeds', discovered: 3, mediaVerified: 1, decoded: 1, checking: 1 };
  for (const source of first.sources) {
    assert.equal(source.freeChoiceCount, 6);
    assert.equal(source.workingChoiceCount, 2);
    assert.equal(source.compatibleFeedCount, 2);
    assert.deepEqual(source.scopes.map(scope => scope.feeds), [initialFeeds, initialFeeds]);
  }
  for (const game of first.games) {
    assert.equal(game.uniqueFeedCount, 1);
    assert.deepEqual(game.feeds, initialFeeds);
    assert.deepEqual(game.candidates.find(candidate => candidate.id.endsWith('-playing'))?.availability,
      { kind: 'playable', checkedAt: at, proof });
    assert.ok(!game.candidates.some(candidate => candidate.id.endsWith('-excluded')));
  }
  assert.equal(eligibilityCalls.get('hidden'), undefined);
  assert.equal(availabilityCalls.get('hidden'), undefined);
  assert.equal(eligibilityCalls.size, 8);
  assert.equal(availabilityCalls.size, 6);
  for (const [id, count] of eligibilityCalls) assert.equal(count, 1, `${id} eligibility evaluations`);
  for (const [id, count] of availabilityCalls) assert.equal(count, 1, `${id} availability evaluations`);
  corrected = true;
  eligibilityCalls.clear();
  availabilityCalls.clear();
  const second = snapshot();
  const correctedFeeds = { kind: 'feeds', discovered: 4, mediaVerified: 1, decoded: 1, checking: 2 };
  for (const source of second.sources) {
    assert.equal(source.freeChoiceCount, 8);
    assert.equal(source.workingChoiceCount, 2);
    assert.deepEqual(source.scopes.map(scope => scope.feeds), [correctedFeeds, correctedFeeds]);
  }
  for (const game of second.games) {
    assert.equal(game.uniqueFeedCount, 1);
    assert.deepEqual(game.feeds, correctedFeeds);
    assert.deepEqual(game.candidates.find(candidate => candidate.id.endsWith('-playing'))?.availability,
      { kind: 'checking', progress: { kind: 'queued', since: at + 1000 } });
    const expectedProof: CandidateAvailability = { kind: 'playable', checkedAt: at + 1000, proof: { ...proof, startupMs: 4000 } };
    assert.deepEqual(game.candidates.find(candidate => candidate.id.endsWith('-excluded'))?.availability, expectedProof);
  }
  assert.equal(eligibilityCalls.size, 8);
  assert.equal(availabilityCalls.size, 8);
  for (const count of eligibilityCalls.values()) assert.equal(count, 1);
  for (const count of availabilityCalls.values()) assert.equal(count, 1);
});
