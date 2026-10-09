import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdvancingVideoSampler } from '../lib/playback/advancing-video.ts';

test('one rendered frame followed by a frozen clock never proves playback', () => {
  const sampler=createAdvancingVideoSampler();
  assert.equal(sampler.sample({wallMs:0,mediaMs:1000,currentMs:1000,frames:1,width:320,height:180,playing:true}),null);
  assert.equal(sampler.sample({wallMs:3100,mediaMs:1000,currentMs:1000,frames:1,width:320,height:180,playing:true}),null);
});

test('a seek jump does not prove playback, but later advancing frames do', () => {
  const sampler=createAdvancingVideoSampler();
  assert.equal(sampler.sample({wallMs:0,mediaMs:0,currentMs:0,frames:1,width:320,height:180,playing:true}),null);
  assert.equal(sampler.sample({wallMs:500,mediaMs:30000,currentMs:30000,frames:2,width:320,height:180,playing:true}),null);
  assert.equal(sampler.sample({wallMs:1500,mediaMs:31000,currentMs:31000,frames:3,width:320,height:180,playing:true}),null);
  assert.deepEqual(sampler.sample({wallMs:3550,mediaMs:33100,currentMs:33100,frames:4,width:320,height:180,playing:true}),
    {kind:'advancing-video',version:1,startupMs:3550,observedMs:3050,mediaAdvanceMs:3100,presentedFrames:3});
});

test('startup includes delayed source capture and remains stable on renewal',()=>{
  const sampler=createAdvancingVideoSampler(0);
  const sample=(wallMs:number,frames:number)=>sampler.sample({wallMs,mediaMs:wallMs-19000,
    currentMs:wallMs-19000,frames,width:320,height:180,playing:true});
  assert.equal(sample(19000,1),null);
  assert.equal(sample(20000,26),null);
  assert.equal(sample(21050,52)?.startupMs,21050);
  assert.equal(sample(22000,75),null);
  assert.equal(sample(23000,100),null);
  assert.equal(sample(24100,125)?.startupMs,21050);
});
