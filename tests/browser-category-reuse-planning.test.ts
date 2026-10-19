import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {FootballCoordinator} from '../lib/football/runtime/coordinator.ts';
import type {SportsurgeCatalog,StreameastCatalog} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z'),minute=60000;
const runIds=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const surgeEvent={id:'nfl:10001',league:'nfl',url:'https://v2.sportsurge.net/watch-10001-nfl-away-home/',
  title:'Away at Home',teams:['Away','Home'],kickoff:at,sourceStatus:'live',advertisedLinkCount:0,
  detail:{kind:'collected',at,providers:[]}} satisfies SportsurgeCatalog['events'][number];
const streamEvent={id:'nfl:10001',league:'nfl',url:'https://v2.streameast.ga/nfl/away-vs-home/',
  title:'Away at Home',teams:['Away','Home'],kickoff:at,espnEventId:null,
  detail:{kind:'collected',at,servers:[]}} satisfies StreameastCatalog['events'][number];

function fixture(source:'sportsurge-v2'|'streameast',tied:boolean,issues=false){
  const store=new FootballStore(':memory:');
  for(const [index,age] of [20,15,10].entries()){
    const checkedAt=at-age*minute,runId=runIds[index],receivedAt=tied?at-minute:checkedAt;
    const state=index===0?{kind:'complete' as const,at:checkedAt}:{kind:'collecting' as const};
    if(source==='sportsurge-v2')store.saveSportsurgeCatalog({receivedAt,catalog:{runId,sequence:1,startedAt:checkedAt,state,
      categories:{nfl:{kind:'collected',at:checkedAt},ncaaf:{kind:'collected',at:checkedAt}},events:[{...surgeEvent,detail:{kind:'collected',at:checkedAt,providers:[]}}],
      rejectedGames:[],catalogIssues:issues&&index===2?[{league:'nfl',title:'Duplicate listing',reason:'duplicate-game-id'}]:[]}},[]);
    else store.saveStreameastCatalog({receivedAt,catalog:{runId,sequence:1,startedAt:checkedAt,state,
      categories:{nfl:{kind:'collected',at:checkedAt},ncaaf:{kind:'collected',at:checkedAt}},events:[{...streamEvent,detail:{kind:'collected',at:checkedAt,servers:[]}}],
      rejectedGames:[]}},[]);
  }
  const coordinator=new FootballCoordinator({store,now:()=>at,id:()=> 'fixture',schedules:[],
    sources:[{id:source,url:source==='sportsurge-v2'?'https://v2.sportsurge.net/':'https://v2.streameast.ga/',
      family:source,kind:'browser-catalog',leagues:['nfl','ncaaf']}],browserCollectorsAvailable:true,
    readSchedule:async()=>{throw new Error('No schedule reads expected');},readSeasonMembership:async()=>{throw new Error('No membership reads expected');},
    readHtml:async()=>{throw new Error('No network reads expected');},parseListings:()=>({outcome:'empty',observations:[]}),
    enrichObservation:value=>value,compatiblePlayers:()=>[],missingPlayerReason:()=> 'no-published-player',retryAfterMs:()=>0,
    probeCandidate:async()=>{throw new Error('No probes expected');}});
  const publish=async(complete=false)=>{
    const base={runId:runIds[3],sequence:complete?1:0,startedAt:at,
      state:complete?{kind:'complete' as const,at}:{kind:'collecting' as const},
      categories:{nfl:complete?{kind:'collected' as const,at}:{kind:'pending' as const},
        ncaaf:complete?{kind:'collected' as const,at}:{kind:'pending' as const}},rejectedGames:[]};
    return source==='sportsurge-v2'?
      coordinator.command({kind:'sportsurge-catalog',catalog:{...base,catalogIssues:[],events:complete?[surgeEvent]:[]}}):
      coordinator.command({kind:'streameast-catalog',catalog:{...base,events:complete?[streamEvent]:[]}});
  };
  return {store,coordinator,publish};
}

for(const source of ['sportsurge-v2','streameast'] as const)for(const tied of [false,true])
test(`${source} starting category reuse reads one history snapshot${tied?' with received-time ties':''}`,async context=>{
  const run=fixture(source,tied);
  try{
    const reusedAt=at-10*minute;
    const event=source==='sportsurge-v2'?surgeEvent:streamEvent;
    assert.deepEqual(await run.publish(),{kind:'catalog-ack',nextSweepAt:at+20*minute,skipDetailEventIds:['nfl:10001'],
      reuseCategories:{kind:source,categories:[{league:'nfl',at:reusedAt},{league:'ncaaf',at:reusedAt}],events:[{...event,detail:{kind:'pending'}}]}});
    const nextSweepAt=at+(tied?10:20)*minute;
    assert.deepEqual(await run.coordinator.command({kind:'collector-polling',source}),{kind:'collector-polling',nextSweepAt});
    const reads=mock.method(run.store,source==='sportsurge-v2'?'sportsurgeCatalog':'streameastCatalog');
    try{
      assert.deepEqual(await run.coordinator.command({kind:'collector-polling',source}),{kind:'collector-polling',nextSweepAt});
      const count=reads.mock.callCount();
      assert.deepEqual(await run.publish(true),{kind:'catalog-ack',nextSweepAt:at+30*minute,skipDetailEventIds:['nfl:10001']});
      assert.deepEqual(await run.coordinator.command({kind:'collector-polling',source}),
        {kind:'collector-polling',nextSweepAt:at+30*minute},'A later checkpoint must replace the previous planning snapshot');
      context.diagnostic(JSON.stringify({source,tied,catalogReads:count}));
      assert.equal(count,2,'Polling needs its current checkpoint and one history snapshot');
    }finally{reads.mock.restore();}
  }finally{await run.coordinator.stop();}
});

test('Sportsurge category issues prevent reuse without retaining a stale planning snapshot',async context=>{
  const run=fixture('sportsurge-v2',false,true);
  try{
    assert.deepEqual(await run.publish(),{kind:'catalog-ack',nextSweepAt:at+1000,skipDetailEventIds:[],
      reuseCategories:{kind:'sportsurge-v2',categories:[{league:'ncaaf',at:at-10*minute}],events:[]}});
    assert.deepEqual(await run.coordinator.command({kind:'collector-polling',source:'sportsurge-v2'}),
      {kind:'collector-polling',nextSweepAt:at+1000});
    const reads=mock.method(run.store,'sportsurgeCatalog');
    try{
      assert.deepEqual(await run.coordinator.command({kind:'collector-polling',source:'sportsurge-v2'}),
        {kind:'collector-polling',nextSweepAt:at+1000});
      const count=reads.mock.callCount();
      assert.deepEqual(await run.publish(true),{kind:'catalog-ack',nextSweepAt:at+30*minute,skipDetailEventIds:['nfl:10001']});
      context.diagnostic(JSON.stringify({source:'sportsurge-v2',issues:true,catalogReads:count}));
      assert.equal(count,2,'Issue handling must use the same captured history');
    }finally{reads.mock.restore();}
  }finally{await run.coordinator.stop();}
});
