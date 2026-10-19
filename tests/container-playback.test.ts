import assert from 'node:assert/strict';
import test from 'node:test';
import {containerFailure} from '../components/container-playback.ts';

test('container network errors preserve local capacity and transient upstream retry semantics',()=>{
  assert.deepEqual(containerFailure({network:true,status:429,unsupported:false}),{kind:'deferred',reason:'capacity',phase:'replay',retryAfterMs:2000});
  for(const status of [undefined,-1,0,408,500,503])assert.deepEqual(containerFailure({network:true,status,unsupported:false}),
    {kind:'deferred',reason:'upstream',phase:'replay',retryAfterMs:30000});
  assert.deepEqual(containerFailure({network:true,status:403,unsupported:false}),{kind:'unavailable',reason:'blocked',phase:'replay'});
  assert.deepEqual(containerFailure({network:false,unsupported:true}),{kind:'unavailable',reason:'unsupported',phase:'decode'});
  assert.deepEqual(containerFailure({network:false,unsupported:false}),{kind:'unavailable',reason:'invalid-media',phase:'decode'});
});
