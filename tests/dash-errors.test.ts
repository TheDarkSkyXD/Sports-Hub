import assert from 'node:assert/strict';
import test from 'node:test';
import {dashFailure} from '../components/dash-playback.ts';

test('DASH preserves HTTP capacity and bounded structured relay outcomes',()=>{
  assert.deepEqual(dashFailure({category:1,data:['fixture',429]}),{kind:'deferred',reason:'capacity',phase:'replay',retryAfterMs:2000});
  assert.deepEqual(dashFailure({category:1,data:['fixture',503]}),{kind:'deferred',reason:'upstream',phase:'replay',retryAfterMs:30000});
  const data=new TextEncoder().encode(JSON.stringify({outcome:{kind:'deferred',reason:'capacity',phase:'capture',retryAfterMs:9000}}));
  assert.deepEqual(dashFailure({category:1,data:['fixture',503,data.buffer]}),
    {kind:'deferred',reason:'capacity',phase:'capture',retryAfterMs:9000});
  assert.deepEqual(dashFailure({category:1,data:['fixture',503,new Uint8Array(8193)]}),
    {kind:'deferred',reason:'upstream',phase:'replay',retryAfterMs:30000});
  const short=new TextEncoder().encode(JSON.stringify({outcome:{kind:'deferred',reason:'capacity',retryAfterMs:1}}));
  assert.deepEqual(dashFailure({category:1,data:['fixture',503,short]}),{kind:'deferred',reason:'upstream',phase:'replay',retryAfterMs:30000});
});
test('DASH distinguishes blocked transport, manifest/media errors and unsupported DRM',()=>{
  assert.deepEqual(dashFailure({category:1,data:['fixture',403]}),{kind:'unavailable',reason:'blocked',phase:'replay'});
  for(const category of [3,4])assert.deepEqual(dashFailure({category,data:[]}),{kind:'unavailable',reason:'invalid-media',phase:'replay'});
  assert.deepEqual(dashFailure({category:6,data:[]}),{kind:'unavailable',reason:'unsupported',phase:'replay'});
});
