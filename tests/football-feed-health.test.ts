import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';

const at = Date.parse('2026-10-02T15:00:00Z');

test('a missing FBS feed does not label a freshly loaded FCS feed unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'football-feed-missing-'));
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => at, sources: [],
    readSchedule: async source => {
      if (source.id === 'fbs') throw new Error('upstream-failed');
      return { games: [], at, league: source.league };
    },
  });
  try {
    await coordinator.refresh(true);
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    if (reply.kind === 'board') {
      assert.deepEqual(reply.board.leagues.nfl.errors, []);
      assert.deepEqual(reply.board.leagues.ncaaf.errors, ['FBS schedule is unavailable or stale.']);
    }
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an old FCS feed does not label a freshly refreshed FBS feed stale', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'football-feed-stale-'));
  let now = at;
  let failFcs = false;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => now, sources: [],
    readSchedule: async source => {
      if (source.id === 'fcs' && failFcs) throw new Error('upstream-failed');
      return { games: [], at: now, league: source.league };
    },
  });
  try {
    await coordinator.refresh(true);
    now += 90001;
    failFcs = true;
    await coordinator.refresh(true);
    const reply = await coordinator.command({ kind: 'board' });
    assert.equal(reply.kind, 'board');
    if (reply.kind === 'board') {
      assert.deepEqual(reply.board.leagues.nfl.errors, []);
      assert.deepEqual(reply.board.leagues.ncaaf.errors, ['FCS schedule is unavailable or stale.']);
    }
    failFcs = false;
    await coordinator.refresh(true);
    const recovered = await coordinator.command({ kind: 'board' });
    assert.equal(recovered.kind, 'board');
    if (recovered.kind === 'board') assert.deepEqual(recovered.board.leagues.ncaaf.errors, []);
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each failed schedule reports once and clears after recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'football-feed-recovery-'));
  let fail = true;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => at, sources: [],
    readSchedule: async source => {
      if (fail) throw new Error('upstream-failed');
      return { games: [], at, league: source.league };
    },
  });
  try {
    await coordinator.refresh(true);
    const failed = await coordinator.command({ kind: 'board' });
    assert.equal(failed.kind, 'board');
    if (failed.kind === 'board') {
      assert.deepEqual(failed.board.leagues.nfl.errors, ['NFL schedule is unavailable or stale.']);
      assert.deepEqual(failed.board.leagues.ncaaf.errors, [
        'FBS schedule is unavailable or stale.', 'FCS schedule is unavailable or stale.',
      ]);
    }
    fail = false;
    await coordinator.refresh(true);
    const recovered = await coordinator.command({ kind: 'board' });
    assert.equal(recovered.kind, 'board');
    if (recovered.kind === 'board') {
      assert.deepEqual(recovered.board.leagues.nfl.errors, []);
      assert.deepEqual(recovered.board.leagues.ncaaf.errors, []);
    }
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed refresh reports saved scores as available until they become stale',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'football-feed-fresh-failure-'));
  let now=at;
  let fail=false;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>now,sources:[],
    readSchedule:async source=>{
      if(fail&&source.id==='fbs')throw new Error('upstream-failed');
      return {games:[],at:now,league:source.league};
    },
  });
  try {
    await coordinator.refresh(true);
    now+=30_000;
    fail=true;
    await coordinator.refresh(true);
    const fresh=await coordinator.command({kind:'board'});
    assert.equal(fresh.kind,'board');
    if(fresh.kind==='board'){
      assert.equal(fresh.board.leagues.ncaaf.scoresAt,new Date(at).toISOString());
      assert.deepEqual(fresh.board.leagues.ncaaf.errors,
        ['FBS schedule refresh failed; showing saved scores.']);
    }
    now+=60_001;
    const stale=await coordinator.command({kind:'board'});
    assert.equal(stale.kind,'board');
    if(stale.kind==='board')assert.deepEqual(stale.board.leagues.ncaaf.errors,
      ['FBS schedule is unavailable or stale.']);
    fail=false;
    await coordinator.refresh(true);
    const recovered=await coordinator.command({kind:'board'});
    assert.equal(recovered.kind,'board');
    if(recovered.kind==='board'){
      assert.equal(recovered.board.leagues.ncaaf.scoresAt,new Date(now).toISOString());
      assert.deepEqual(recovered.board.leagues.ncaaf.errors,[]);
    }
  } finally {
    await coordinator.stop();
    rmSync(directory,{recursive:true,force:true});
  }
});
