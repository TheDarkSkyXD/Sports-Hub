import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectedFeedStatus, groupedListingEvidence } from '../components/source-feed-status.ts';
import type { CandidateSummary, LinkEvidence } from '../lib/football/shared.ts';

const candidate = (id:string,availability:CandidateSummary['availability']):CandidateSummary =>
  ({id,gameId:'game',label:id,sourceIds:['source'],observedAt:1000,availability});
const evidence={kind:'collected',checkedAt:1000,candidateIds:['one','two']} as const;
const collected={...evidence,candidateIds:[...evidence.candidateIds]};

test('failed published feeds report the completed check and earliest retry',()=>{
  assert.deepEqual(collectedFeedStatus(collected,[
    candidate('one',{kind:'unavailable',checkedAt:2000,retryAt:302000,reason:'playback'}),
    candidate('two',{kind:'unavailable',checkedAt:3000,retryAt:303000,reason:'timeout'}),
    candidate('unrelated',{kind:'unknown'}),
  ]),{kind:'unavailable',checkedAt:3000,retryAt:302000});
});

test('pending checks cannot report no working feeds',()=>{
  assert.deepEqual(collectedFeedStatus(collected,[
    candidate('one',{kind:'unavailable',checkedAt:2000,retryAt:302000,reason:'playback'}),
    candidate('two',{kind:'checking',progress:{kind:'queued',since:2000}}),
  ]),{kind:'checking',count:1});
  assert.deepEqual(collectedFeedStatus(collected,[]),{kind:'checking',count:2});
});

test('a verified feed remains available while another feed fails',()=>{
  assert.deepEqual(collectedFeedStatus(collected,[
    candidate('one',{kind:'playable',checkedAt:2000,proof:{kind:'advancing-video',version:1,
      startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}),
    candidate('two',{kind:'unavailable',checkedAt:3000,retryAt:303000,reason:'timeout'}),
  ]),{kind:'available',count:1});
});

test('two team pages for the same event share one result without losing either feed',()=>{
  const rows:LinkEvidence[]=[
    {kind:'collected',checkedAt:1000,candidateIds:['one']},
    {kind:'collected',checkedAt:2000,candidateIds:['two','one']},
  ];
  assert.deepEqual(groupedListingEvidence(rows),{kind:'collected',checkedAt:2000,candidateIds:['one','two']});
});

test('different collection outcomes retain their separate evidence',()=>{
  assert.equal(groupedListingEvidence([
    collected,{kind:'missing',checkedAt:2000,reason:'no-published-player',retryAt:302000},
  ]),null);
});
