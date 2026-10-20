import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureSchedule, SCHEDULES } from '../lib/football/adapters/schedule.ts';
import {enqueueListings} from './schedule-fixture.ts';
import { parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { GameSchema, isWrestlingGame, ObservationSchema } from '../lib/football/shared.ts';

const start = 1791750600000;
const end = 1791765000000;
const tna = { id: 30225, name: 'TNA Bound for Glory', tag: 'Wrestling',
  uri_name: 'tna-bound-for-glory-30225', starts_at: start / 1000, ends_at: end / 1000 };
const source = SOURCES.find(row => row.id === 'ppv');
assert.ok(source);
function catalog(events: unknown[]) { return JSON.stringify({ success: true, streams: [{ category: 'Wrestling', streams: events }] }); }
function partition(league: string) { const value = SCHEDULES.find(row => row.id === league); assert.ok(value); return value; }
function reader(events: unknown[]) { return async (url: string) => { if (!url.includes('api.ppv.st')) throw new Error('offline'); return catalog(events); }; }

test('the native PPV boundary retains the published TNA broadcast end and ignores invalid optional ends', () => {
  const result = parseListings(source, catalog([tna]), start);
  assert.equal(result.outcome, 'parsed');
  assert.equal(ObservationSchema.parse(result.observations[0]).endsAt, end);
  for (const ends_at of [undefined, null, 0, -1, start / 1000, start / 1000 - 1, 'later', {}, 1e20, 4102444800]) {
    const result = parseListings(source, catalog([{ ...tna, ends_at }]), start);
    assert.equal(result.outcome, 'parsed', String(ends_at));
    assert.equal(result.observations.length, 1, String(ends_at));
    assert.equal(result.observations[0].kickoff, start);
    assert.equal(result.observations[0].endsAt, undefined, String(ends_at));
  }
});

test('every wrestling promotion follows its published window boundaries', async () => {
  const names = ['WWE NXT', 'TNA Bound for Glory', 'AEW WrestleDream', 'NJPW King of Pro-Wrestling'];
  for (const [index, league] of ['wwe', 'tna', 'aew', 'wrestling'].entries()) {
    const event = { ...tna, id: 30225 + index, name: names[index], uri_name: `wrestling-show-${30225 + index}` };
    for (const [now, status, lifecycle, detail] of [
      [start - 1, 'pre', 'scheduled', 'Scheduled'], [start, 'in', 'live', 'In progress'],
      [end - 1, 'in', 'live', 'In progress'], [end, 'unknown', 'unknown', 'Status unavailable'],
    ] as const) {
      const fixture=createFixtureSchedule();await enqueueListings(fixture,reader([event]));
      const { games } = await fixture.readSchedule(partition(league), now, new AbortController().signal);
      assert.equal(games.length, 1);
      const game = games[0];
      assert.ok(isWrestlingGame(game));
      assert.equal(game.wrestling.endsAt, end);
      assert.deepEqual([game.status, game.lifecycle, game.detail], [status, lifecycle, detail], `${league} at ${now}`);
    }
  }
});

test('cached wrestling observations recalculate status at both published boundaries', async () => {
  const fixture=createFixtureSchedule();await enqueueListings(fixture,reader([tna]));
  for (const [now, status] of [[start - 1, 'pre'], [start, 'in'], [end - 1, 'in'], [end, 'unknown']] as const) {
    const result = await fixture.readSchedule(partition('tna'), now, new AbortController().signal);
    assert.equal(result.games[0].status, status);
  }
  assert.equal(fixture.fixtureRequests().length,3);
});

test('a duplicate start-only source preserves the PPV window and its authoritative start', async () => {
  const duplicate = { id: 'tna-bound-for-glory', title: tna.name, category: 'wrestling',
    date: start + 60_000, sources: [], teams: null };
  const fixture=createFixtureSchedule();await enqueueListings(fixture,async url=>url.includes('api.ppv.st')?catalog([tna]):JSON.stringify([duplicate]));
  const result = await fixture.readSchedule(partition('tna'), start + 30_000, new AbortController().signal);
  assert.equal(result.games.length, 1);
  const game = result.games[0];
  assert.ok(isWrestlingGame(game));
  assert.equal(game.date, '2026-10-11T20:30:00.000Z');
  assert.equal(game.wrestling.endsAt, end);
  assert.equal(game.status, 'in');
});

test('missing end evidence keeps started wrestling unknown', async () => {
  const withoutEnd = { ...tna, ends_at: undefined };
  const fixture=createFixtureSchedule();await enqueueListings(fixture,reader([withoutEnd]));
  const result = await fixture.readSchedule(partition('tna'), start, new AbortController().signal);
  assert.equal(result.games[0].status, 'unknown');
});

test('wrestling schemas preserve published ends and accept saved events without them', () => {
  const legacy = { id: 'tna-123', league: 'tna', name: tna.name, date: new Date(start).toISOString(),
    wrestling: { eventId: '123' }, status: 'pre', lifecycle: 'scheduled', detail: 'Scheduled' };
  assert.equal(GameSchema.safeParse(legacy).success, true);
  const game = GameSchema.parse({ ...legacy, wrestling: { eventId: '123', endsAt: end } });
  assert.ok(isWrestlingGame(game));
  assert.equal(game.wrestling.endsAt, end);
});
