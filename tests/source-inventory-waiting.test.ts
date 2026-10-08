import assert from 'node:assert/strict';
import {test} from 'node:test';
import {candidateEvidence} from '../components/source-inventory-view.ts';
import type {CandidateSummary} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T20:00:00Z');
const candidate:CandidateSummary={
  id:'server-1',gameId:'game-1',label:'Server 1',sourceIds:['fixture'],observedAt:at,
  availability:{kind:'unavailable',reason:'upstream',checkedAt:at,retryAt:at+300_000},
};

test('waiting time counts down to the real media retry deadline',()=>{
  assert.equal(candidateEvidence(candidate,at),'Source media unavailable · Waiting 5m 0s for next check');
  assert.equal(candidateEvidence(candidate,at+60_000),'Source media unavailable · Waiting 4m 0s for next check');
  assert.equal(candidateEvidence(candidate,at+300_000),'Source media unavailable · Check due · Waiting for a checker slot');
});

test('an already queued check does not show an invented countdown',()=>{
  const queued:CandidateSummary={...candidate,availability:{kind:'checking',progress:{kind:'queued',since:at}}};
  assert.equal(candidateEvidence(queued,at),'Queued for media check · Waiting for a checker slot');
  assert.equal(candidateEvidence(queued,at+300_000),'Queued for media check · Waiting for a checker slot');
});
