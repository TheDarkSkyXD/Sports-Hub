import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureCollector, SOURCES } from '../lib/football/adapters/sources.ts';
import { createSourceEventMatcher, matchObservation } from '../lib/football/domain/matching.ts';
import { sourceInventory } from '../lib/football/domain/source-inventory.ts';
import { GameSchema, type Observation } from '../lib/football/shared.ts';

const at = Date.parse('2025-10-04T20:00:00Z');
const mainCard = Date.parse('2025-10-05T02:00:00Z');
const game = GameSchema.parse({ id: 'ufc-320', league: 'ufc', name: 'UFC 320: Ankalaev vs. Pereira 2',
  date: new Date(mainCard).toISOString(), combat: { eventId: '320' }, status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled' });
const observation = (title: string, kickoff: number | null = mainCard): Observation => ({
  id: 'streamed:ufc-320', sourceId: 'streamed', url: 'https://streamed.st/watch/ufc-320',
  title, league: 'ufc', teams: null, kickoff, rawTime: '', observedAt: at, parserVersion: 1,
});
const source = (id: string) => {
  const row = SOURCES.find(value => value.id === id);
  assert.ok(row);
  return row;
};

test('UFC prelim and main-card titles attach to their card while preserving published identities', () => {
  for (const title of ['UFC 320 Prelims', 'UFC 320 - Early Prelims', 'UFC 320: Preliminary Card',
    'UFC 320: Ankalaev vs. Pereira 2 (Prelims)', 'UFC 320: Ankalaev vs. Pereira 2 (Early Prelims)',
    'UFC 320: Ankalaev vs. Pereira 2 (Main Card)', 'UFC 320 Prelims vs Live Broadcast']) {
    const row = observation(title);
    assert.deepEqual(createSourceEventMatcher([game])(row, { undated: 'none', externalGameId: null }, at).match,
      { kind: 'matched', gameId: game.id }, title);
    assert.equal(row.title, title);
  }
});

test('explicit UFC stages allow the four-hour card span without loosening other matching guards', () => {
  const title = 'UFC 320: Ankalaev vs. Pereira 2 (Early Prelims)';
  assert.deepEqual(matchObservation(observation(title, mainCard - 4 * 60 * 60_000), [game], at),
    { kind: 'matched', gameId: game.id });
  for (const row of [observation(title, mainCard - 4 * 60 * 60_000 - 1), observation(title, mainCard + 24 * 60 * 60_000),
    observation('UFC 320', mainCard - 4 * 60 * 60_000), observation('UFC 321 Prelims'),
    observation('UFC 320: Other vs. Pereira 2 (Prelims)'), observation('UFC 320 Highlights'),
    observation('UFC 320 Prelims Highlights'), observation(title, null)]) {
    assert.equal(matchObservation(row, [game], at).kind, 'unmatched', row.title);
  }
  const second = GameSchema.parse({ ...game, id: 'ufc-321', combat: { eventId: '321' } });
  assert.deepEqual(matchObservation(observation('UFC 320 Prelims'), [game, second], at),
    { kind: 'unmatched', reason: 'ambiguous-matchup', possibleGameIds: [game.id, second.id] });
});

test('native UFC stage listings produce one inventory event with separate listing links', () => {
  const collector = createFixtureCollector();
  const events = [
    { id: 'ufc-320-early-prelims', title: 'UFC 320: Ankalaev vs. Pereira 2 (Early Prelims)', date: mainCard - 4 * 60 * 60_000 },
    { id: 'ufc-320-prelims', title: 'UFC 320: Ankalaev vs. Pereira 2 (Prelims)', date: mainCard - 2 * 60 * 60_000 },
    { id: 'ufc-320-main-card', title: 'UFC 320: Ankalaev vs. Pereira 2 (Main Card)', date: mainCard },
  ].map(row => ({ ...row, category: 'fight', teams: null, sources: [] }));
  const listing = collector.parseListings(source('streamed'), JSON.stringify(events), at);
  assert.deepEqual(listing.observations.map(row => row.league), ['ufc', 'ufc', 'ufc']);
  const snapshot = sourceInventory({ at, revision: 1, lastDiscoveryAt: at, browserCollectorsAvailable: true,
    sources: [source('streamed')], observations: listing.observations, games: [game], candidates: new Map(),
    attempts: { streamed: { at, outcome: 'parsed' } },
    sportsurgeCatalog: { current: null, lastComplete: null, previous: null },
    streameastCatalog: { current: null, lastComplete: null, previous: null } });
  assert.equal(snapshot.games.length, 1);
  assert.deepEqual(snapshot.games[0].sourceLinks.map(row => row.title).sort(), events.map(row => row.title).sort());
});

test('resolved UFC feeds identify early prelims and prelims in their labels', async () => {
  const collector = createFixtureCollector();
  for (const segment of ['Early Prelims', 'Prelims', 'Main Card']) {
    const event = { id: `ufc-320-${segment.toLowerCase().replaceAll(' ', '-')}`, title: `UFC 320 (${segment})`,
      category: 'fight', date: mainCard, teams: null, sources: [{ source: 'golf', id: '2181' }] };
    const row = collector.parseListings(source('streamed'), JSON.stringify([event]), at).observations[0];
    const feeds = await collector.resolvePlayers(game.id, row, JSON.stringify(event), new AbortController().signal,
      async () => JSON.stringify([{ id: '2181', source: 'golf', streamNo: 1, embedUrl: 'https://embed.st/embed/golf/2181/1' }]));
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].label, `Streamed · golf 1 · ${segment}`);
  }
});
