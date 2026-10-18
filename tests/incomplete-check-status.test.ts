import assert from 'node:assert/strict';
import {test} from 'node:test';
import {candidateEvidence} from '../components/source-inventory-view.ts';
import type {CandidateSummary} from '../lib/football/shared.ts';

test('an incomplete feed distinguishes its cooldown from a due retry',()=>{
  const candidate:CandidateSummary={id:'feed-1',gameId:'100',label:'Server 1',sourceIds:['fixture'],observedAt:1000,
    availability:{kind:'checking',progress:{kind:'deferred',since:1000,retryAt:31_000,phase:'replay'}}};
  assert.equal(candidateEvidence(candidate,1000),'Check incomplete while reading the stream · Retrying in 30s');
  assert.equal(candidateEvidence(candidate,31_000),'Check incomplete while reading the stream · Retry due');
});
