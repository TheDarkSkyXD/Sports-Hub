import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SOURCES} from '../lib/football/adapters/sources.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game} from '../lib/football/shared.ts';

const initial=Date.parse('2026-10-04T18:00:00Z');
const source=SOURCES.find(row=>row.id==='sportsurge');
assert.ok(source);
const game:Game={id:'401872965',league:'nfl',name:'Washington Commanders at Indianapolis Colts',
  date:new Date(initial).toISOString(),lifecycle:'live',status:'in',detail:'Q1',redzone:false,
  partitions:['nfl'],home:{name:'Indianapolis Colts',short:'Colts',abbreviation:'IND',color:'112233',score:'0'},
  away:{name:'Washington Commanders',short:'Commanders',abbreviation:'WSH',color:'332211',score:'0'}};
const detailUrl='https://isportsurge.ws/watch/nfl/washington-indianapolis/57561';
const listing=`<a href="${detailUrl}" datetime="${game.date}"><span class="team-name-event-row"><img alt="Washington Commanders"></span><span class="team-name-event-row"><img alt="Indianapolis Colts"></span></a>`;
const detail='<iframe src="https://gooz.aapmains.net/new-stream-embed/57561"></iframe>'+
  '<button onclick="changeStream(57562)">Backup 1</button><button onclick="changeStream(57563)">Backup 2</button>';

async function until(predicate:()=>Promise<boolean>,message:string) {
  for(let turn=0;turn<300;turn++) {
    if(await predicate())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}

function fixture(allPlayable:boolean) {
  const directory=mkdtempSync(join(tmpdir(),'legacy-sportsurge-retention-'));
  const path=join(directory,'state.sqlite');
  let clock=initial;
  let detailReads=0;
  const probes:string[]=[];
  let networkBarrier:Promise<void>|null=null;
  let unblockNetwork:(()=>void)|null=null;
  const create=()=>createFootballCoordinator(path,{
    now:()=>clock,sources:[source],schedules:[{id:'nfl',league:'nfl',path:'nfl',group:null}],
    readSchedule:async()=>{if(networkBarrier)await networkBarrier;return {games:[game],league:'nfl',at:clock};},
    readHtml:async url=>{if(networkBarrier)await networkBarrier;return url===source.url?listing:(detailReads++,detail);},
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'gooz');
      probes.push(locator.playerId);
      return allPlayable||locator.playerId==='57561'?{kind:'playable' as const,proof:'media' as const}:
        {kind:'unavailable' as const,reason:'invalid-media' as const};
    },
  });
  let coordinator=create();
  const snapshot=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    return reply.snapshot;
  };
  const choices=async()=>(await snapshot()).games.find(row=>row.gameId===game.id)?.candidates
    .filter(row=>row.sourceIds.includes(source.id))||[];
  return {snapshot,choices,probes,get detailReads(){return detailReads;},
    advance:(milliseconds:number)=>{clock+=milliseconds;},
    holdNetwork(){networkBarrier=new Promise<void>(resolve=>{unblockNetwork=resolve;});},
    releaseNetwork(){unblockNetwork?.();networkBarrier=null;unblockNetwork=null;},
    async refresh(){await coordinator.refresh(true);},
    async restart(){await coordinator.stop();coordinator=create();},
    async close(){await coordinator.stop();rmSync(directory,{recursive:true,force:true});},
  };
}

test('legacy Sportsurge rereads a live page with missing playable siblings after its evidence window',async()=>{
  const run=fixture(false);
  try {
    await run.refresh();
    await until(async()=>{const rows=await run.choices();return rows.length===3&&
      rows.every(row=>row.availability.kind==='playable'||row.availability.kind==='unavailable');},'initial three checked players');
    assert.deepEqual((await run.choices()).map(row=>[row.label,row.availability.kind]),
      [['Primary','playable'],['Backup 1','unavailable'],['Backup 2','unavailable']]);
    run.advance(4*60_000);
    await run.refresh();
    for(let turn=0;turn<20;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(run.detailReads,1);
    run.advance(60_000);
    await run.refresh();
    await until(async()=>run.detailReads===2,'detail retried at five minutes');
    run.advance(31*60_000);
    await run.refresh();
    await until(async()=>run.detailReads===3&&(await run.choices()).length===3&&
      (await run.snapshot()).sources.find(row=>row.id===source.id)?.links[0]?.evidence.kind==='collected',
    'fresh detail with all three published players');
    assert.equal((await run.choices()).length,3);
    assert.deepEqual(run.probes.sort(),['57561','57561','57562','57563']);
  } finally {await run.close();}
});

test('legacy Sportsurge restores unavailable published siblings and rechecks working media after restart',async()=>{
  const run=fixture(false);
  try {
    await run.refresh();
    await until(async()=>{const rows=await run.choices();return rows.length===3&&
      rows.every(row=>row.availability.kind==='playable'||row.availability.kind==='unavailable');},
    'three initial media outcomes');
    run.advance(31*60_000);
    await run.restart();
    await run.refresh();
    await until(async()=>run.detailReads===2&&(await run.choices()).length===3,
      'three published players restored after restart');
    assert.equal((await run.snapshot()).sources.find(row=>row.id===source.id)?.links[0]?.evidence.kind,'collected');
    assert.equal(run.probes.filter(id=>id==='57561').length,2);
  } finally {await run.close();}
});

test('legacy Sportsurge keeps complete live proof while rereading detail after restart',async()=>{
  const run=fixture(true);
  try {
    await run.refresh();
    await until(async()=>{const rows=await run.choices();return rows.length===3&&
      rows.every(row=>row.availability.kind==='playable');},'three playable players');
    run.advance(31*60_000);
    run.holdNetwork();
    await run.restart();
    const pendingRefresh=run.refresh();
    const cold=await run.snapshot();
    assert.equal(cold.sources.find(row=>row.id===source.id)?.links[0]?.evidence.kind,'collected');
    assert.equal(cold.sources.find(row=>row.id===source.id)?.lastAttempt?.at,initial);
    assert.equal(cold.games.find(row=>row.gameId===game.id)?.candidates.length,3);
    assert.equal(run.detailReads,1,'cold restore does not need a network detail read');
    run.releaseNetwork();
    await pendingRefresh;
    await until(async()=>{const rows=await run.choices();return rows.length===3&&
      rows.every(row=>row.availability.kind==='playable');},'restored three playable players');
    const afterRestart=await run.snapshot();
    assert.equal(afterRestart.sources.find(row=>row.id===source.id)?.links[0]?.evidence.kind,'collected');
    assert.equal(run.detailReads,2,'eligible live detail is checked again after its interval');
    assert.deepEqual(run.probes.sort(),['57561','57562','57563']);
  } finally {run.releaseNetwork();await run.close();}
});
