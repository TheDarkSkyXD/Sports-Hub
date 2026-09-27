import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countdown, gameTiming } from '../lib/game-timing.ts';

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
