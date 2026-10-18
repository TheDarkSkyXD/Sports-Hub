import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInventoryEventTimeFormatter } from '../components/source-inventory-view.ts';
import { relativeStartDay } from '../lib/game-timing.ts';

test('inventory uses Today and Tomorrow while later events keep their date and time', () => {
  const format = createInventoryEventTimeFormatter('America/Chicago');
  const now = Date.parse('2026-10-12T17:00:00Z');
  assert.equal(format('2026-10-13T00:00:00Z', now), 'Today, 7:00 PM CDT');
  assert.equal(format('2026-10-14T00:00:00Z', now), 'Tomorrow, 7:00 PM CDT');
  assert.equal(format('2026-10-15T00:00:00Z', now), 'Wed, Oct 14, 7:00 PM CDT');
  assert.equal(format(null, now), 'Start time not confirmed');
});

test('relative dates use the display time zone instead of the host time zone', () => {
  const now = Date.parse('2026-10-13T04:30:00Z');
  const start = Date.parse('2026-10-13T05:30:00Z');
  assert.equal(relativeStartDay({ start, now, timeZone: 'America/New_York' }), 'Today');
  assert.equal(relativeStartDay({ start, now, timeZone: 'America/Chicago' }), 'Tomorrow');
});

test('Tomorrow follows calendar days across daylight saving changes and year rollover', () => {
  const format = createInventoryEventTimeFormatter('America/Chicago');
  assert.equal(format('2026-11-02T06:30:00Z', Date.parse('2026-11-01T05:30:00Z')), 'Tomorrow, 12:30 AM CST');
  assert.equal(format('2026-03-09T05:30:00Z', Date.parse('2026-03-08T06:30:00Z')), 'Tomorrow, 12:30 AM CDT');
  assert.equal(format('2027-01-01T06:30:00Z', Date.parse('2027-01-01T05:30:00Z')), 'Tomorrow, 12:30 AM CST');
});
