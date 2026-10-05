import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEDULES } from '../lib/football/adapters/schedule.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';

test('future-day failures stay visible during a retry and clear after successful completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-horizon-'));
  const originalFetch = globalThis.fetch;
  const at = Date.parse('2026-10-04T18:00:00Z');
  let clock = at;
  let retry = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async input => {
    const day = new URL(String(input)).searchParams.get('dates');
    if (!retry && day === '20261005') return new Response('', { status: 503 });
    if (retry && day !== null && day > '20261004') await gate;
    return Response.json({ events: [] });
  };
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock, schedules: [SCHEDULES[0]], sources: [],
  });
  const board = async () => {
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    if (reply.kind !== 'board') throw new Error('Expected board');
    return reply.board;
  };
  try {
    await coordinator.refresh(true);
    assert.match((await board()).leagues.nfl.errors.join(' '), /20261005:http-503/);
    retry = true;
    clock += 300_001;
    const refreshing = coordinator.refresh(true);
    try {
      for (let index = 0; index < 60; index++) {
        if ((await board()).leagues.nfl.scoresAt === new Date(clock).toISOString()) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const pending = await board();
      assert.equal(pending.leagues.nfl.scoresAt, new Date(clock).toISOString());
      assert.match(pending.leagues.nfl.errors.join(' '), /20261005:http-503/);
      assert.doesNotMatch(pending.leagues.nfl.errors.join(' '), /stale-cache/);
    } finally { release(); await refreshing; }
    assert.deepEqual((await board()).leagues.nfl.errors, []);
  } finally {
    release(); await coordinator.stop(); globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
