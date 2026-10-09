import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {SOURCES,missingPlayerReason} from '../lib/football/adapters/sources.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const initial=Date.parse('2026-10-04T18:00:00Z');
const source=SOURCES.find(row=>row.id==='livetv');
assert.ok(source);
const game:Game={id:'401872965',league:'nfl',name:'Washington Commanders at Indianapolis Colts',
  date:new Date(initial).toISOString(),lifecycle:'live',status:'in',detail:'Q1',redzone:false,
  partitions:['nfl'],home:{name:'Indianapolis Colts',short:'Colts',abbreviation:'IND',color:'112233',score:'0'},
  away:{name:'Washington Commanders',short:'Commanders',abbreviation:'WSH',color:'332211',score:'0'}};
const alias='https://livetv.sx/enx/eventinfo/478510070__/';
const canonical='https://livetv.sx/enx/eventinfo/478510070_washington_indianapolis/';
const listing='<table><tr><td><img alt="USA. NFL"><a href="/enx/eventinfo/478510070__/">Washington Commanders &ndash; Indianapolis Colts</a></td></tr></table>';
const detail=`<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}">
  <script type="application/ld+json">${JSON.stringify({'@type':'BroadcastEvent',url:canonical,
    name:'Washington Commanders - Indianapolis Colts',startDate:game.date,
    broadcastOfEvent:{'@type':'SportsEvent',name:'Washington Commanders - Indianapolis Colts',
      competitor:[{name:'Washington Commanders'},{name:'Indianapolis Colts'}]}})}</script>
  ${['3081333','3082009'].map(channel=>`<a href="https://livetv.sx/webplayer.php?t=ifr&c=${channel}&lang=en&eid=478510070&lid=${channel}&ci=142&si=27">Watch</a>`).join('')}`;

async function until(predicate:()=>Promise<boolean>,message:string) {
  for(let turn=0;turn<300;turn++) {
    if(await predicate())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}

for(const allPlayable of [false,true])test(`LiveTV restores two published feeds after evidence expiry with ${allPlayable?'complete':'partial'} working cache`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'livetv-retention-'));
  let clock=initial;
  let detailReads=0;
  const probes:string[]=[];
  let barrier:Promise<void>|null=null;
  let release:(()=>void)|undefined;
  const create=()=>createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[source],schedules:[{id:'nfl',league:'nfl',path:'nfl',group:null}],
    readSchedule:async()=>{if(barrier)await barrier;return {games:[game],league:'nfl',at:clock};},
    readHtml:async url=>{if(barrier)await barrier;return url===source.url?listing:(detailReads++,detail);},
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'event-page');
      const channel=new URL(locator.serverUrl).searchParams.get('c');
      assert.ok(channel);
      probes.push(channel);
      return allPlayable||channel==='3081333'?{kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}:
        {kind:'unavailable',reason:'invalid-media'};
    },
  });
  let coordinator=create();
  const snapshot=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    return reply.snapshot;
  };
  const choices=async()=>(await snapshot()).games.find(row=>row.gameId===game.id)?.candidates||[];
  try {
    await coordinator.refresh(true);
    await until(async()=>{const rows=await choices();return rows.length===2&&rows.every(row=>
      row.availability.kind==='playable'||row.availability.kind==='unavailable');},'two initial checked feeds');
    clock+=4*60_000;
    await coordinator.refresh(true);
    assert.equal(detailReads,1);
    clock+=60_000;
    await coordinator.refresh(true);
    if(!allPlayable)await until(async()=>detailReads===2,'partial listing retried at five minutes');
    assert.equal(detailReads,2,'published detail is checked again after five minutes');
    clock+=31*60_000;
    await coordinator.stop();
    barrier=new Promise<void>(resolve=>{release=resolve;});
    coordinator=create();
    const refresh=coordinator.refresh(true);
    if(allPlayable) {
      const cold=await snapshot();
      assert.equal(cold.sources[0].links[0]?.evidence.kind,'collected');
      assert.equal(cold.games.find(row=>row.gameId===game.id)?.candidates.length,2);
    }
    release?.();barrier=null;
    await refresh;
    await until(async()=>(await choices()).length===2&&
      (await snapshot()).sources[0].links[0]?.evidence.kind==='collected','both published feeds restored');
    assert.equal(detailReads,3,'published detail is checked again after evidence expiry');
    assert.equal(probes.filter(channel=>channel==='3081333').length,3);
    assert.equal(probes.filter(channel=>channel==='3082009').length,allPlayable?3:2);
  } finally {release?.();await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('LiveTV publication message reports waiting without inventing player links',()=>{
  const observation:Observation={id:'livetv:478510070',sourceId:'livetv',url:alias,
    title:'Washington Commanders vs Indianapolis Colts',league:'nfl',teams:['Washington Commanders','Indianapolis Colts'],
    kickoff:initial,rawTime:'',observedAt:initial,parserVersion:2};
  const message="Live streams will be available approximately 30 minutes before the broadcast's start.";
  assert.equal(missingPlayerReason(observation,`<main>${message}</main>`),'not-yet-published');
  assert.equal(missingPlayerReason(observation,`<script>${message}</script><main>Watch</main>`),'no-compatible-media');
  assert.equal(missingPlayerReason(observation,`${detail}<main>${message}</main>`),'no-compatible-media');
});
