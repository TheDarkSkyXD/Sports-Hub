import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameTiming, motorsportsTiming } from '../lib/game-timing.ts';

test('all motorsports leagues count down today and tomorrow for pre and unknown statuses', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const now = Date.parse('2026-10-18T04:00:00-05:00');
    for (const league of ['f1', 'nascar-cup', 'nascar-truck', 'motogp', 'motorsport'] as const) {
      for (const status of ['pre', 'unknown'] as const) {
        assert.deepEqual(motorsportsTiming({ league, status, date: '2026-10-18T05:00:00-05:00' }, now),
          { kind: 'counting', remainingSeconds: 3600 });
        assert.deepEqual(motorsportsTiming({ league, status, date: '2026-10-19T05:00:00-05:00' }, now),
          { kind: 'counting', remainingSeconds: 90000 });
      }
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('motorsports countdown reaches in progress at the scheduled start without changing input or gameTiming', () => {
  const game = Object.freeze({ league: 'motorsport', status: 'unknown', date: '2026-10-18T10:00:00.000Z', lifecycle: 'unknown' } as const);
  const start = Date.parse(game.date);
  assert.deepEqual(motorsportsTiming(game, start - 1), { kind: 'counting', remainingSeconds: 1 });
  assert.deepEqual(motorsportsTiming(game, start), { kind: 'in-progress' });
  assert.deepEqual(motorsportsTiming(game, start + 3600000), { kind: 'in-progress' });
  assert.deepEqual(motorsportsTiming({ ...game, status: 'pre' }, start), { kind: 'in-progress' });
  assert.deepEqual(game, { league: 'motorsport', status: 'unknown', date: '2026-10-18T10:00:00.000Z', lifecycle: 'unknown' });
  assert.deepEqual(gameTiming(game, start), { kind: 'scheduled', start });
  assert.deepEqual(gameTiming({ ...game, status: 'pre' }, start), { kind: 'awaiting', start });
});

test('motorsports fallback follows local midnight, calendar rollover and daylight saving time', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const cases = [
      { now: '2026-10-18T23:59:59-05:00', date: '2026-10-19T00:00:01-05:00', seconds: 2 },
      { now: '2026-10-19T00:00:00-05:00', date: '2026-10-19T00:00:01-05:00', seconds: 1 },
      { now: '2026-01-31T23:55:00-06:00', date: '2026-02-01T00:05:00-06:00', seconds: 600 },
      { now: '2026-12-31T23:55:00-06:00', date: '2027-01-01T00:05:00-06:00', seconds: 600 },
      { now: '2028-02-28T23:55:00-06:00', date: '2028-02-29T00:05:00-06:00', seconds: 600 },
      { now: '2026-03-07T23:30:00-06:00', date: '2026-03-08T23:30:00-05:00', seconds: 82800 },
      { now: '2026-10-31T23:30:00-05:00', date: '2026-11-01T23:30:00-06:00', seconds: 90000 },
    ];
    for (const { now, date, seconds } of cases) {
      assert.deepEqual(motorsportsTiming({ league: 'motogp', status: 'unknown', date }, Date.parse(now)),
        { kind: 'counting', remainingSeconds: seconds }, `${now} to ${date}`);
    }
    const game = { league: 'f1', status: 'unknown', date: '2026-10-18T23:30:00-05:00' } as const;
    assert.deepEqual(motorsportsTiming(game, Date.parse('2026-10-18T23:59:59-05:00')), { kind: 'in-progress' });
    assert.equal(motorsportsTiming(game, Date.parse('2026-10-19T00:00:00-05:00')), null);
    assert.equal(motorsportsTiming({ ...game, date: '2026-10-21T00:00:00Z' }, Date.parse('2026-10-18T23:30:00-05:00')), null);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('fallback requires a clock and valid absolute start time', () => {
  const game = { league: 'nascar-cup', status: 'pre', date: '2026-10-18T10:00:00Z' } as const;
  const now = Date.parse(game.date);
  assert.deepEqual(motorsportsTiming(game, now), { kind: 'in-progress' });
  assert.equal(motorsportsTiming(game, null), null);
  for (const date of [undefined, '', 'in one hour', '2026-10-18T10:00:00', '2026-02-30T10:00:00Z', '2026-99-99T10:00:00Z']) {
    assert.equal(motorsportsTiming({ ...game, date }, now), null, date);
  }
});

test('fallback preserves known live and final statuses and excludes other sports', () => {
  const game = { league: 'nascar-truck', status: 'unknown', date: '2026-10-18T10:00:00Z' } as const;
  const now = Date.parse(game.date);
  assert.deepEqual(motorsportsTiming(game, now), { kind: 'in-progress' });
  for (const status of ['in', 'post'] as const) {
    assert.equal(motorsportsTiming({ ...game, status }, now - 1000), null);
    assert.equal(motorsportsTiming({ ...game, status }, now), null);
    assert.equal(motorsportsTiming({ ...game, status }, now + 1000), null);
  }
  for (const league of ['nfl', 'ncaaf', 'nba', 'wnba', 'nhl', 'mlb', 'ufc', 'boxing', 'wwe', 'tna', undefined] as const) {
    assert.equal(motorsportsTiming({ ...game, league }, now - 1000), null);
    assert.equal(motorsportsTiming({ ...game, league }, now), null);
  }
});
