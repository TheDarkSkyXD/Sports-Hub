import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdown, gameTiming, relativeStartDay } from '../lib/game-timing.ts';

const start = '2026-09-27T00:00:00Z';
const before = Date.parse(start) - 1000;

test('pre-game timing decrements through zero and waits for the feed', () => {
  assert.deepEqual(gameTiming({ date: start, status: 'pre' }, before), { kind: 'counting', start: Date.parse(start), remainingSeconds: 1 });
  assert.deepEqual(gameTiming({ date: start, status: 'pre' }, before + 1000), { kind: 'awaiting', start: Date.parse(start) });
  assert.deepEqual(gameTiming({ date: start, status: 'pre' }, before + 2000), { kind: 'awaiting', start: Date.parse(start) });
  assert.deepEqual(gameTiming({ date: start, status: 'in' }, before + 2000), { kind: 'scheduled', start: Date.parse(start) });
});

test('only valid absolute dates count down', () => {
  assert.deepEqual(gameTiming({ status: 'pre' }, before), { kind: 'unavailable' });
  assert.deepEqual(gameTiming({ date: '1 hour from now', status: 'pre' }, before), { kind: 'unavailable' });
  assert.deepEqual(gameTiming({ date: '2026-02-30T17:00Z', status: 'pre' }, before), { kind: 'unavailable' });
  assert.deepEqual(gameTiming({ date: '2026-09-27T00:00:00Z', status: 'post' }, before), { kind: 'scheduled', start: Date.parse(start) });
  assert.deepEqual(gameTiming({ date: start, status: 'unknown' }, before), { kind: 'scheduled', start: Date.parse(start) });
  assert.deepEqual(gameTiming({ date: '2026-09-27T17:00Z', status: 'pre' }, Date.parse('2026-09-27T16:59:59Z')), { kind: 'counting', start: Date.parse('2026-09-27T17:00Z'), remainingSeconds: 1 });
});

test('countdown carries hours, minutes, and seconds across days', () => {
  assert.equal(countdown(90061), '1d 01:01:01');
  assert.equal(countdown(3661), '01:01:01');
  assert.equal(countdown(1), '00:00:01');
});

test('relative start days follow local midnight, calendar rollover, and daylight saving time', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const cases = [
      { now: '2026-10-01T18:00:00-05:00', start: '2026-10-01T22:00:00-05:00', label: 'Today' },
      { now: '2026-10-01T23:59:59-05:00', start: '2026-10-02T00:30:00-05:00', label: 'Tomorrow' },
      { now: '2026-10-02T00:00:00-05:00', start: '2026-10-02T00:30:00-05:00', label: 'Today' },
      { now: '2026-01-31T23:55:00-06:00', start: '2026-02-01T00:05:00-06:00', label: 'Tomorrow' },
      { now: '2026-12-31T23:55:00-06:00', start: '2027-01-01T00:05:00-06:00', label: 'Tomorrow' },
      { now: '2028-02-28T23:55:00-06:00', start: '2028-02-29T12:00:00-06:00', label: 'Tomorrow' },
      { now: '2026-03-07T23:30:00-06:00', start: '2026-03-08T23:30:00-05:00', label: 'Tomorrow' },
      { now: '2026-10-31T23:30:00-05:00', start: '2026-11-01T23:30:00-06:00', label: 'Tomorrow' },
      { now: '2026-10-01T23:30:00-05:00', start: '2026-10-03T00:05:00-05:00', label: null },
      { now: '2026-10-02T00:00:00-05:00', start: '2026-10-01T23:30:00-05:00', label: null },
    ];
    for (const { now, start, label } of cases) {
      assert.equal(relativeStartDay({ start: Date.parse(start), now: Date.parse(now) }), label, now + ' to ' + start);
    }
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});
