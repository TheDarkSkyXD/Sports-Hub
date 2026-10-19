import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rankingAt,rankingFixture,rankingProof} from './fixtures/ranking-fixture.ts';

test('session ranking reads each retained proof once per sort while retaining every server',async()=>{
 const fixture=rankingFixture({count:64});
 try{
  const opened=await fixture.open();
  assert.equal(opened.session.candidateId,'route-000');
  fixture.resetReads();
  const reply=await fixture.coordinator.command({kind:'session',sessionId:opened.session.id,generation:0,retry:true,failure:false});
  assert.equal(reply.kind,'session');
  if(reply.kind!=='session')throw new Error('Expected session');
  assert.equal(reply.candidates.length,64);
  assert.deepEqual(reply.candidates.slice(0,3).map(candidate=>candidate.id),['route-000','route-001','route-002']);
  assert.equal(reply.candidates.at(-1)?.id,'route-063');
  assert.ok(reply.candidates.every(candidate=>candidate.availability.kind==='playable'));
  assert.ok(fixture.reads()<=64*3,`Ranking 64 retained servers read their schedule ${fixture.reads()} times; expected at most 192`);
 }finally{await fixture.close();}
});

test('mixed and expired decoded observations retain pairwise ranking and explicit server selection',async()=>{
 const fixture=rankingFixture();
 try{
  for(const [id,startupMs,elapsed] of [['route-001',900,0],['route-002',100,1]] as const){
   fixture.setNow(rankingAt+elapsed);
   const opened=await fixture.open(id);
   assert.equal(opened.session.candidateId,id);
   assert.equal((await fixture.coordinator.command({kind:'playback-evidence',sessionId:opened.session.id,
    candidateId:id,generation:0,evidence:{...rankingProof,startupMs}})).kind,'ok');
  }
  const mixed=await fixture.open();
  assert.equal(mixed.session.candidateId,'route-000');
  assert.deepEqual(mixed.candidates.map(candidate=>candidate.id),['route-000','route-002','route-001','route-003']);
  fixture.setNow(rankingAt+10*60_000);
  const expired=await fixture.open();
  assert.equal(expired.session.candidateId,'route-000');
  assert.deepEqual(expired.candidates.map(candidate=>candidate.id),['route-000','route-001','route-002','route-003']);
 }finally{await fixture.close();}
});
