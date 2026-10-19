import assert from 'node:assert/strict';
import {test} from 'node:test';
import {roomSources} from '../lib/football/domain/source-inventory.ts';
import {rankingAt,rankingFixture,rankingProof} from './fixtures/ranking-fixture.ts';
import {at,snapshotFixture} from './fixtures/source-snapshot-fixture.ts';

test('room-source commands avoid diagnostic history and share full-snapshot output',async()=>{
  const run=snapshotFixture();
  try{
    const history=run.store.collectionHistory.bind(run.store);
    run.store.collectionHistory=()=>{throw new Error('Room polling must not read diagnostic history');};
    const room=await run.coordinator.command({kind:'room-sources'});
    assert.equal(room.kind,'room-sources');if(room.kind!=='room-sources')throw new Error('Expected room summary');
    assert.equal(room.snapshot.collecting,false);
    assert.deepEqual(room.snapshot.games[0],{gameId:'game-0',candidates:[],pending:false});
    run.setClock(at+1);
    const cached=await run.coordinator.command({kind:'room-sources'});
    assert.equal(cached.kind,'room-sources');if(cached.kind!=='room-sources')throw new Error('Expected room summary');
    assert.equal(cached.snapshot,room.snapshot);
    run.store.collectionHistory=history;
    const full=await run.snapshot();
    assert.deepEqual(roomSources(full),room.snapshot);
    run.store.collectionHistory=()=>{throw new Error('A valid full snapshot must satisfy room polling');};
    run.setClock(at+2);
    const fromFull=await run.coordinator.command({kind:'room-sources'});
    assert.equal(fromFull.kind,'room-sources');if(fromFull.kind!=='room-sources')throw new Error('Expected room summary');
    assert.deepEqual(fromFull.snapshot,roomSources(full));
  }finally{await run.coordinator.stop();}
});

test('room-source cache rechecks schedule freshness between polls',async()=>{
  const run=snapshotFixture();
  try{
    run.setClock(at+90_000);
    const fresh=await run.coordinator.command({kind:'room-sources'});
    run.setClock(at+90_001);
    const stale=await run.coordinator.command({kind:'room-sources'});
    assert.equal(fresh.kind,'room-sources');assert.equal(stale.kind,'room-sources');
    if(fresh.kind!=='room-sources'||stale.kind!=='room-sources')throw new Error('Expected room summaries');
    assert.notEqual(stale.snapshot,fresh.snapshot,'Schedule expiry must invalidate the shared cache');
    assert.deepEqual(stale.snapshot,roomSources(await run.snapshot()));
  }finally{await run.coordinator.stop();}
});
test('promoting a room cache recomputes decoded ordering at the full request time',async()=>{
  const run=rankingFixture();
  try{
    for(const [id,startupMs,elapsed] of [['route-001',900,0],['route-002',100,1]] as const){
      run.setNow(rankingAt+elapsed);
      const opened=await run.open(id);
      assert.equal((await run.coordinator.command({kind:'playback-evidence',sessionId:opened.session.id,
        candidateId:id,generation:0,evidence:{...rankingProof,startupMs}})).kind,'ok');
    }
    run.setNow(rankingAt+599_999);
    const before=await run.coordinator.command({kind:'room-sources'});
    assert.equal(before.kind,'room-sources');if(before.kind!=='room-sources')throw new Error('Expected room summary');
    assert.deepEqual(before.snapshot.games[0].candidates.map(row=>row.id),['route-000','route-002','route-001','route-003']);
    run.setNow(rankingAt+600_000);
    const full=await run.coordinator.command({kind:'sources'});
    assert.equal(full.kind,'sources');if(full.kind!=='sources')throw new Error('Expected full inventory');
    assert.deepEqual(full.snapshot.games[0].candidates.map(row=>row.id),['route-000','route-001','route-002','route-003']);
    const after=await run.coordinator.command({kind:'room-sources'});
    assert.equal(after.kind,'room-sources');if(after.kind!=='room-sources')throw new Error('Expected room summary');
    assert.deepEqual(after.snapshot,roomSources(full.snapshot));
  }finally{await run.close();}
});