import assert from 'node:assert/strict';
import test from 'node:test';
import { parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import type { RaceGame } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-11T17:15:00Z');
const event = {
  id: 'charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200',
  title: 'Charlotte Motor Speedway — The Chase - Race: Bank of America 400',
  category: 'motor-sports',
  date: 1791745200000,
  teams: null,
  sources: [{ source: 'hotel', id: 'charlotte-motor-speedway-the-chase-race-bank-of-america-400-nascar-cup-series-1791745200' }],
};
const race: RaceGame = {
  id: 'nascar-cup-202610110021',
  league: 'nascar-cup',
  name: 'NASCAR Cup Series at Charlotte',
  date: '2026-10-11T19:00Z',
  race: { eventId: '202610110021', sessionId: '202610110021', session: 'race', round: 'Charlotte' },
  season: 2026,
  detail: 'Scheduled',
  status: 'pre',
  lifecycle: 'scheduled',
};

test('Streamed catalogs match the Cup race when its series is published in the event ID', () => {
  for (const sourceId of ['streamed', 'livesportpro']) {
    const source = SOURCES.find(row => row.id === sourceId);
    assert.ok(source);
    const body = JSON.stringify([{ ...event, league: 'f1' }]);
    const listing = parseListings(source, body, at);
    assert.equal(listing.outcome, 'parsed');
    assert.equal(listing.observations.length, 1);
    const observation = listing.observations[0];
    assert.equal(observation.league, 'nascar-cup');
    assert.equal(observation.kickoff, 1791745200000);
    assert.equal(observation.title, 'Charlotte Motor Speedway — The Chase - Race: Bank of America 400');
    assert.deepEqual(matchObservation(observation, [race], at), { kind: 'matched', gameId: 'nascar-cup-202610110021' });
  }
});

test('a Truck series event cannot attach to the Cup race at the same venue and time', () => {
  const source = SOURCES.find(row => row.id === 'streamed');
  assert.ok(source);
  const truckId = event.id.replace('nascar-cup-series', 'nascar-truck-series');
  const listing = parseListings(source, JSON.stringify([{ ...event, id: truckId, sources: [{ source: 'hotel', id: truckId }] }]), at);
  assert.equal(listing.outcome, 'parsed');
  assert.equal(listing.observations.length, 1);
  assert.equal(listing.observations[0].league, 'nascar-truck');
  assert.deepEqual(matchObservation(listing.observations[0], [race], at), {
    kind: 'unmatched', reason: 'unknown-race', possibleGameIds: [],
  });
});

test('conflicting, missing, or out-of-category NASCAR series evidence cannot classify a Cup race', () => {
  const source = SOURCES.find(row => row.id === 'streamed');
  assert.ok(source);
  for (const row of [
    { ...event, title: 'NASCAR Truck Series at Charlotte' },
    { ...event, id: 'nascar-charlotte-motor-speedway-1791745200', title: 'NASCAR Charlotte Motor Speedway' },
    { ...event, category: 'basketball' },
    { ...event, id: event.id.replace('nascar-cup-series', 'nascar-cup-seriesextra') },
    { ...event, id: 'cup-series-charlotte-1791745200', title: 'Charlotte NASCAR' },
  ]) {
    assert.deepEqual(parseListings(source, JSON.stringify([row]), at), { outcome: 'empty', observations: [] });
  }
});

test('an explicit NASCAR ID cannot override a conflicting sport or series in the title', () => {
  const source = SOURCES.find(row => row.id === 'streamed');
  assert.ok(source);
  for (const title of [
    'NASCAR Xfinity Series at Charlotte',
    'MotoGP Charlotte Grand Prix',
    'Formula 1 Charlotte Grand Prix',
  ]) {
    assert.deepEqual(parseListings(source, JSON.stringify([{ ...event, title }]), at), {
      outcome: 'empty', observations: [],
    });
  }
});

test('an explicit NASCAR title cannot override a conflicting sport or series in the event ID', () => {
  const source = SOURCES.find(row => row.id === 'streamed');
  assert.ok(source);
  for (const id of [
    'charlotte-nascar-xfinity-series-1791745200',
    'charlotte-motogp-grand-prix-1791745200',
    'charlotte-formula-1-grand-prix-1791745200',
  ]) {
    assert.deepEqual(parseListings(source, JSON.stringify([{ ...event, id, title: 'NASCAR Cup Series at Charlotte' }]), at), {
      outcome: 'empty', observations: [],
    });
  }
});
