import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortGamesForDisplay } from '../lib/sunday.ts';
import type { Game } from '../lib/sunday.ts';

type DisplayGame = Pick<Game, 'date' | 'status' | 'lifecycle'> & { id: string };

function game(id: string, date: string | undefined, status: DisplayGame['status'], lifecycle: DisplayGame['lifecycle']): DisplayGame {
  return { id, date, status, lifecycle };
}

test('live games lead, local-day games follow kickoff order, and older finals trail', () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const games = [
      game('old-final', '2026-09-30T20:00:00Z', 'post', 'final'),
      game('stale-scheduled', '2026-10-01T18:00:00Z', 'pre', 'scheduled'),
      game('today-late', '2026-10-03T01:00:00Z', 'pre', 'scheduled'),
      game('undated', undefined, 'pre', 'scheduled'),
      game('overnight-live', '2026-10-02T01:00:00Z', 'in', 'live'),
      game('today-final', '2026-10-02T17:00:00Z', 'post', 'final'),
      game('future', '2026-10-03T18:00:00Z', 'pre', 'scheduled'),
      game('today-early', '2026-10-02T16:00:00Z', 'pre', 'scheduled'),
      game('invalid', 'not-a-date', 'pre', 'scheduled'),
      game('today-live', '2026-10-02T15:00:00Z', 'in', 'live'),
      game('recent-final', '2026-10-01T20:00:00Z', 'post', 'final'),
      game('undated-final', undefined, 'post', 'final'),
    ];
    const original = games.map(item => item.id);

    assert.deepEqual(sortGamesForDisplay(games, Date.parse('2026-10-02T18:00:00Z')).map(item => item.id), [
      'overnight-live', 'today-live', 'today-early', 'today-late', 'today-final',
      'stale-scheduled', 'future', 'undated', 'invalid', 'recent-final', 'old-final', 'undated-final',
    ]);
    assert.deepEqual(games.map(item => item.id), original);
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test('local calendar day wins over UTC day at the evening boundary', () => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/Chicago';
  try {
    const games = [
      game('tomorrow-utc', '2026-10-03T15:00:00Z', 'pre', 'scheduled'),
      game('stale', '2026-10-01T15:00:00Z', 'pre', 'scheduled'),
      game('today-local', '2026-10-03T01:00:00Z', 'pre', 'scheduled'),
    ];
    assert.deepEqual(sortGamesForDisplay(games, Date.parse('2026-10-03T02:00:00Z')).map(item => item.id), [
      'today-local', 'stale', 'tomorrow-utc',
    ]);
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test('invalid calendar dates are undated and ties keep input order', () => {
  const games = [
    game('invalid-day', '2026-02-30T12:00:00Z', 'pre', 'scheduled'),
    game('missing', undefined, 'pre', 'scheduled'),
    game('invalid-format', '2026-02-28', 'pre', 'scheduled'),
    game('dated', '2026-03-01T12:00:00Z', 'pre', 'scheduled'),
  ];
  assert.deepEqual(sortGamesForDisplay(games, Date.parse('2026-04-01T00:00:00Z')).map(item => item.id), [
    'dated', 'invalid-day', 'missing', 'invalid-format',
  ]);
});
