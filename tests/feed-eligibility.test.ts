import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedDateEligible, feedEligible } from '../lib/football/domain/feed-eligibility.ts';

test('feed window uses Chicago calendar today and tomorrow rather than UTC or rolling48 hours', () => {
  const now = Date.parse('2026-10-05T04:59:00Z');
  for (const date of ['2026-10-04T05:00:00Z', '2026-10-06T04:59:59Z'])
    assert.equal(feedDateEligible(Date.parse(date), now), true, date);
  for (const date of ['2026-10-04T04:59:59Z', '2026-10-06T05:00:00Z'])
    assert.equal(feedDateEligible(Date.parse(date), now), false, date);
  assert.equal(feedDateEligible(Date.parse('2026-10-06T05:00:00Z'), now + 60_000), true);
});

test('calendar eligibility handles both DST changes, leap day, and year rollover', () => {
  const cases = [
    ['2026-03-08T05:59:00Z', '2026-03-09T04:59:59Z', '2026-03-09T05:00:00Z'],
    ['2026-11-01T04:59:00Z', '2026-11-02T05:59:59Z', '2026-11-02T06:00:00Z'],
    ['2028-02-29T05:59:00Z', '2028-03-01T05:59:59Z', '2028-03-01T06:00:00Z'],
    ['2026-01-01T05:59:00Z', '2026-01-02T05:59:59Z', '2026-01-02T06:00:00Z'],
  ];
  for (const [now, included, excluded] of cases) {
    assert.equal(feedDateEligible(Date.parse(included), Date.parse(now)), true, included);
    assert.equal(feedDateEligible(Date.parse(excluded), Date.parse(now)), false, excluded);
  }
});

test('live games override dates while final, unknown, and undated scheduled games cannot authorize feeds', () => {
  const now = Date.parse('2026-10-04T17:00:00Z');
  assert.equal(feedEligible({ lifecycle: 'live', date: '2026-10-03T17:00:00Z' }, now), true);
  assert.equal(feedEligible({ lifecycle: 'live' }, now), true);
  assert.equal(feedEligible({ lifecycle: 'live', finalObservedAt: now }, now), false);
  for (const lifecycle of ['final', 'unknown', 'scheduled'] as const)
    assert.equal(feedEligible({ lifecycle }, now), false);
  assert.equal(feedEligible({ lifecycle: 'scheduled', date: 'invalid' }, now), false);
  assert.equal(feedDateEligible(1e20, now), false);
  assert.equal(feedDateEligible(now, Infinity), false);
});
