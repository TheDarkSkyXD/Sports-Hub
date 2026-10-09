import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CandidateAvailabilitySchema} from '../lib/football/shared.ts';

test('Available accepts only versioned advancing-video evidence',()=>{
  const base={kind:'playable',checkedAt:1};
  assert.equal(CandidateAvailabilitySchema.safeParse({...base,proof:'media'}).success,false);
  assert.equal(CandidateAvailabilitySchema.safeParse({...base,proof:'decoded'}).success,false);
  assert.equal(CandidateAvailabilitySchema.safeParse({...base,proof:{kind:'advancing-video',version:1,
    startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}).success,true);
});
