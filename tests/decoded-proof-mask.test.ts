import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T18:00:00Z');
const game: Game = {
  id: 'ncaaf-1', league: 'ncaaf', name: 'Away at Home', date: new Date(at).toISOString(),
  home: { name: 'Home', short: 'Home', abbreviation: 'HOM', color: '112233', score: '0' },
  away: { name: 'Away', short: 'Away', abbreviation: 'AWY', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['fcs'],
};
const source = { id: 'fixture', url: 'https://fixture.example/list', family: 'fixture' };
const observation: Observation = {
  id: 'fixture:ncaaf-1', sourceId: source.id, url: 'https://fixture.example/detail',
  title: game.name, league: 'ncaaf', teams: ['Away', 'Home'], kickoff: at,
  rawTime: '', observedAt: at, parserVersion: 2,
};

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('coordinator did not reach the required state');
}

test('new decoded proof stays visible while an older probe remains active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'decoded-proof-mask-'));
  let calls = 0;
  let olderProbeSettled=false;
  let releaseProbe = () => {};
  const pendingProbe = new Promise<void>(resolve => { releaseProbe = resolve; });
  let clock=at;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock,
    sources: [source],
    readSchedule: async partition => ({ games: partition.id === 'fcs' ? [game] : [], league: partition.league, at: clock }),
    readHtml: async () => '<main>fixture</main>',
    parseListings: () => ({ outcome: 'parsed', observations: [observation] }),
    enrichObservation: value => value,
    compatiblePlayers: () => [{ id: 'server-1', label: 'Server 1', locator: { provider: 'gooz', playerId: '1' } }],
    probeCandidate: async () => {
      if (++calls === 1) return { kind: 'playable' as const, proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const };
      if(calls>2)return {kind:'unavailable' as const,reason:'upstream' as const};
      await pendingProbe;
      olderProbeSettled=true;
      return { kind: 'unavailable' as const, reason: 'upstream' as const };
    },
  });
  try {
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && reply.snapshot.games.find(row => row.gameId === game.id)?.workingChoiceCount === 1;
    });
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    const session = opened.playback.session;
    const failed = await coordinator.command({ kind: 'session', sessionId: session.id, generation: 0, failure: true, retry: false });
    assert.equal(failed.kind, 'session');
    assert.deepEqual(await coordinator.command({ kind: 'check-sources', gameIds: [game.id], retry: true }), { kind: 'ok' });
    await until(async () => calls === 2);
    assert.deepEqual(await coordinator.command({ kind: 'playback-evidence', sessionId: session.id,
      candidateId: 'server-1', generation: 1, evidence:{kind:'advancing-video',version:1,startupMs:100,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }), { kind: 'ok' });
    const sources = await coordinator.command({ kind: 'sources' });
    const board = await coordinator.command({ kind: 'board' });
    assert.equal(sources.kind, 'sources');
    assert.equal(board.kind, 'board');
    if (sources.kind === 'sources' && board.kind === 'board') {
      const row = sources.snapshot.games.find(row => row.gameId === game.id);
      assert.equal(row?.workingChoiceCount, 1);
      assert.equal(row?.candidates[0]?.availability.kind, 'playable');
      assert.equal(board.board.games.find(row => row.id === game.id)?.sourceUrl, `/play/${game.id}`);
    }
    releaseProbe();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return olderProbeSettled&&reply.kind==='sources'&&
        reply.snapshot.games.find(row=>row.gameId===game.id)?.candidates[0]?.availability.kind==='playable';
    });
    const decoded=await coordinator.command({kind:'sources'});
    assert.equal(decoded.kind,'sources');
    if(decoded.kind==='sources')assert.deepEqual(decoded.snapshot.games.find(row=>row.gameId===game.id)?.candidates[0]?.availability,
      {kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:100,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4},checkedAt:at});
    clock+=10*60_000+1;
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return calls===3&&reply.kind==='sources'&&
        reply.snapshot.games.find(row=>row.gameId===game.id)?.workingChoiceCount===0;
    });
  } finally {
    releaseProbe();
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
