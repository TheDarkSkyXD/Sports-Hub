import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const at = Date.parse('2026-10-03T18:00:00Z');
const game: Game = {
  id: 'ncaaf-100', league: 'ncaaf', name: 'Away at Home', date: new Date(at).toISOString(),
  home: { name: 'Home', short: 'Home', abbreviation: 'HOM', color: '112233', score: '0' },
  away: { name: 'Away', short: 'Away', abbreviation: 'AWY', color: '332211', score: '0' },
  status: 'in', lifecycle: 'live', detail: 'Q1', redzone: false, partitions: ['fcs'],
};
const sources = ['primary', 'backup'].map(id => ({ id, url: `https://${id}.example/list`, family: id }));
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 300; index++) {
    if (await check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('coordinator did not reach the required state');
}

test('working live choices survive session closure without redundant detail refreshes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'selected-candidate-eviction-'));
  let clock = at;
  let primaryDetailReads = 0;
  const coordinator = createFootballCoordinator(join(directory, 'state.sqlite'), {
    now: () => clock,
    sources,
    readSchedule: async partition => ({ games: partition.id === 'fcs' ? [game] : [], league: partition.league, at: clock }),
    readHtml: async url => {
      if (url === 'https://primary.example/detail/ncaaf-100' && ++primaryDetailReads > 1)
        throw new Error('upstream detail failed');
      return '<main>fixture</main>';
    },
    parseListings: source => ({ outcome: 'parsed', observations: [{
      id: `${source.id}:${game.id}`, sourceId: source.id, url: `https://${source.id}.example/detail/${game.id}`,
      title: game.name, league: 'ncaaf', teams: ['Away', 'Home'], kickoff: at,
      rawTime: '', observedAt: clock, parserVersion: 2,
    } satisfies Observation] }),
    enrichObservation: value => value,
    compatiblePlayers: (_gameId, listing) => listing.sourceId === 'primary' ?
      [{ id: 'a-primary', label: 'Primary', locator: { provider: 'gooz', playerId: '1' } }] :
      Array.from({ length: 13 }, (_, index) => ({ id: `b-${index + 1}`, label: `Backup ${index + 1}`,
        locator: { provider: 'gooz' as const, playerId: String(index + 2) } })),
    probeCandidate: async () => ({ kind: 'playable', proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} }),
  });
  try {
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && reply.snapshot.games.find(row => row.gameId === game.id)?.workingChoiceCount === 14;
    });
    const opened = await coordinator.command({ kind: 'open', gameId: game.id, manual: false });
    assert.equal(opened.kind, 'playback');
    if (opened.kind !== 'playback') return;
    assert.equal(opened.playback.session.candidateId, 'a-primary');
    clock += 60_000;
    const heartbeat = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id,
      generation: 0, failure: false, retry: false });
    assert.equal(heartbeat.kind, 'session');
    clock += 60_001;
    await coordinator.refresh(true);
    await until(async () => {
      const reply = await coordinator.command({ kind: 'sources' });
      return reply.kind === 'sources' && primaryDetailReads === 1 &&
        reply.snapshot.games.find(row => row.gameId === game.id)?.workingChoiceCount === 14;
    });
    const refreshed = await coordinator.command({ kind: 'session', sessionId: opened.playback.session.id,
      generation: 0, failure: false, retry: false });
    assert.equal(refreshed.kind, 'session');
    if (refreshed.kind === 'session') {
      const selected = refreshed.candidates.find(candidate => candidate.id === refreshed.session.candidateId);
      assert.ok(selected, 'an active session must include its selected candidate in the reply');
      assert.equal(selected.observedAt,at);
      assert.equal(selected.availability.kind,'playable');
    }
    assert.deepEqual(await coordinator.command({kind:'close',sessionId:opened.playback.session.id}),{kind:'ok'});
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===game.id)?.workingChoiceCount===14;
    });
  } finally {
    await coordinator.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
