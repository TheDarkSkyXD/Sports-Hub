import assert from 'node:assert/strict';
import {test} from 'node:test';
import {detailPlanningFixture,planningSettled} from './fixtures/detail-planning-fixture.ts';

test('full detail slots defer repeated planning and admit the latest live listing next',async()=>{
 const fixture=detailPlanningFixture();
 try{
  await fixture.start();
  assert.deepEqual(fixture.reads,[
   'https://host0.example/detail/100','https://host1.example/detail/101',
   'https://host2.example/detail/102','https://host3.example/detail/123',
   'https://host3.example/detail/103','https://host0.example/detail/104',
   'https://host1.example/detail/105','https://host2.example/detail/130',
  ]);
  const before=fixture.scans();
  for(let wake=0;wake<6;wake++){
   await fixture.coordinator.refresh(false);
   await planningSettled();
  }
  const saturatedScans=fixture.scans()-before;
  await fixture.insertLive();
  assert.equal(fixture.reads.length,8);
  fixture.releaseSlot();
  await planningSettled();
  assert.equal(fixture.reads[8],'https://host0.example/detail/199');
  await fixture.finish();
  const reply=await fixture.coordinator.command({kind:'sources'});
  assert.equal(reply.kind,'sources');
  if(reply.kind!=='sources')throw new Error('Expected source inventory');
  assert.deepEqual(reply.snapshot.games.map(row=>[row.gameId,row.candidates.map(candidate=>candidate.id).sort()]).sort(),
   [...Array.from({length:64},(_,index)=>String(100+index)),'199'].map(id=>[id,[`route-${id}-a`,`route-${id}-b`]]).sort());
  assert.equal(fixture.reads.length,65);
  assert.equal(new Set(fixture.reads).size,65);
  assert.equal(fixture.peak(),8);
  assert.deepEqual([...fixture.hostPeaks.values()],[2,2,2,2]);
  assert.equal(saturatedScans,0,'Six collector wakes with no free detail slot must not rescan observations');
 }finally{await fixture.close();}
});
