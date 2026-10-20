import assert from 'node:assert/strict';
import {test} from 'node:test';
import {at,snapshotFixture as fixture} from './fixtures/source-snapshot-fixture.ts';

test('unchanged source requests preserve the saved board and source evidence',async()=>{
  const run=fixture();
  try{
    const before=await run.snapshot();
    assert.deepEqual(before.games.map(game=>game.gameId),Array.from({length:80},(_,index)=>`game-${index}`));
    await run.coordinator.command({kind:'collector-polling',source:'sportsurge-v2'});
    const cached=await run.snapshot();
    assert.deepEqual(cached,before);
  }finally{await run.coordinator.stop();}
});

test('source cache rechecks exact schedule freshness boundaries and newly written partitions',async()=>{
  const run=fixture();
  try{
    run.setClock(at+90_000);
    const fresh=await run.snapshot();
    assert.deepEqual(fresh.games[0].feeds,{kind:'incomplete',reason:'listings'});
    run.setClock(at+90_001);
    const stale=await run.snapshot();
    assert.deepEqual(stale.games[0].feeds,{kind:'incomplete',reason:'schedule'});
    const current=run.store.partition('nfl');assert.ok(current);
    run.store.savePartition('nfl',{...current,at:at+90_001});
    assert.deepEqual((await run.snapshot()).games[0].feeds,{kind:'incomplete',reason:'listings'});
  }finally{await run.coordinator.stop();}
});

test('source cache does not return a snapshot from after the current clock',async()=>{
  const run=fixture();
  try{
    run.setClock(at+10_000);
    assert.equal((await run.snapshot()).at,at+10_000);
    run.setClock(at);
    assert.equal((await run.snapshot()).at,at);
  }finally{await run.coordinator.stop();}
});
