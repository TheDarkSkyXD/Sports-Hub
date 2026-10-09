import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-04T17:00:00Z');
const game:Game={id:'401872975',league:'nfl',name:'Denver Broncos at San Francisco 49ers',date:new Date(at).toISOString(),
  home:{name:'San Francisco 49ers',short:'49ers',abbreviation:'SF',color:'112233',score:'0'},
  away:{name:'Denver Broncos',short:'Broncos',abbreviation:'DEN',color:'332211',score:'0'},
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl']};
async function drain(){for(let index=0;index<100;index++)await new Promise<void>(resolve=>setImmediate(resolve));}
async function until(read:()=>Promise<boolean>|boolean,message:string){
  for(let attempt=0;attempt<300;attempt++){
    if(await read())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}
function fixture(family='fixture'){
  const directory=mkdtempSync(join(tmpdir(),'live-retention-identity-'));
  let clock=at,version:'old'|'new'|'none'='old',failListing=false;
  const detailReads:string[]=[],resolved:string[]=[],probes:string[]=[];
  const observation=(phase:'old'|'new'):Observation=>({id:`fixture:${phase}`,sourceId:'fixture',
    url:`https://fixture.example/detail/${phase}`,title:game.name,league:'nfl',teams:[game.away.name,game.home.name],
    kickoff:at,rawTime:new Date(at).toISOString(),observedAt:clock,parserVersion:2});
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[{id:'fixture',url:'https://fixture.example/list',family}],
    schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    readSchedule:async()=>({games:[game],league:'nfl',at:clock}),
    readSeasonMembership:async()=>({season:2026,at:clock,teams:{}}),
    readHtml:async url=>{
      if(url.endsWith('/list')&&failListing)throw new Error('source unavailable');
      if(!url.endsWith('/list'))detailReads.push(url);
      return '<main>fixture</main>';
    },
    parseListings:()=>({outcome:version==='none'?'empty':'parsed',observations:version==='none'?[]:[observation(version)]}),
    enrichObservation:value=>value,
    compatiblePlayers:(_gameId,listing)=>{
      resolved.push(listing.url);
      return [{id:'same-player',label:'Free',locator:{provider:'gooz' as const,
        playerId:listing.url.endsWith('/old')?'111':'222'}}];
    },
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'gooz');
      probes.push(locator.playerId);
      return {kind:'playable' as const,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4} as const};
    },
  });
  const snapshot=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind!=='sources')throw new Error('Expected sources reply');
    return reply.snapshot;
  };
  return {coordinator,detailReads,resolved,probes,snapshot,
    setClock:(value:number)=>{clock=value;},setVersion:(value:'old'|'new'|'none')=>{version=value;},
    failListing:()=>{failListing=true;},
    async refresh(){await coordinator.refresh(true);await drain();},
    async close(){await coordinator.stop();rmSync(directory,{recursive:true,force:true});},
  };
}

test('a new observation admits a changed locator while retaining the proven same-ID player',async()=>{
  const run=fixture();
  try{
    await run.refresh();
    await until(()=>run.probes.includes('111'),'old route should receive media proof');
    assert.equal((await run.snapshot()).games[0].workingChoiceCount,1);
    run.setClock(at+301000);
    run.setVersion('new');
    await run.refresh();
    await until(()=>run.detailReads.some(url=>url.endsWith('/new')),'new listing detail should be visited');
    assert.equal(run.resolved.some(url=>url.endsWith('/new')),true,'new listing must publish a valid player');
    await until(()=>run.probes.includes('222'),'new same-ID locator should enter the media check');
    assert.equal((await run.snapshot()).games[0].workingChoiceCount,2);
  }finally{await run.close();}
});

test('a failed source refresh leaves a proven live feed available',async()=>{
  const run=fixture();
  try{
    await run.refresh();
    await until(()=>run.probes.includes('111'),'old route should receive media proof');
    run.setClock(at+301000);
    run.failListing();
    await run.refresh();
    const snapshot=await run.snapshot();
    assert.equal(snapshot.games[0].workingChoiceCount,1);
    assert.equal(snapshot.sources.find(source=>source.id==='fixture')?.lastAttempt?.outcome,'failed');
  }finally{await run.close();}
});

test('unchanged positive proof survives a scheduled detail retry and media recheck',async()=>{
  const run=fixture('vipbox');
  try{
    await run.refresh();
    await until(()=>run.probes.includes('111'),'old route should receive media proof');
    const initialReads=run.detailReads.length;
    run.setVersion('none');
    run.setClock(at+31*60000);
    await run.refresh();
    assert.equal((await run.snapshot()).games[0].workingChoiceCount,1,'proven live route should remain working');
    assert.equal(run.probes.filter(value=>value==='111').length,2,'unchanged route is rechecked at its interval');
    assert.equal(run.detailReads.length,initialReads+1,'live detail is checked again after its interval');
  }finally{await run.close();}
});

test('a same-ID replacement preserves an active viewer and reuses the new proven detail',async()=>{
  const run=fixture();
  try{
    await run.refresh();
    const opened=await run.coordinator.command({kind:'open',gameId:game.id,manual:false});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    const sessionId=opened.playback.session.id;
    run.setClock(at+60_000);
    await run.coordinator.command({kind:'session',sessionId,generation:0,failure:false,retry:false});
    for(const time of [120000,180000,240000]){run.setClock(at+time);await run.coordinator.command({kind:'session',sessionId,generation:0,failure:false,retry:false});}
    run.setClock(at+301000);run.setVersion('new');await run.refresh();
    const authorization=await run.coordinator.command({kind:'authorize',sessionId,generation:0,candidateId:'same-player'});
    assert.equal(authorization.kind,'authorized');
    if(authorization.kind==='authorized')assert.deepEqual(authorization.candidate.locator,{provider:'gooz',playerId:'111'});
    const snapshot=await run.snapshot();
    const newer=snapshot.games[0].candidates.find(candidate=>candidate.id!=='same-player');
    assert.ok(newer);
    assert.equal(newer.availability.kind,'playable');
    const link=snapshot.games[0].sourceLinks.find(link=>link.url.endsWith('/new'));
    assert.equal(link?.evidence.kind,'collected');
    if(link?.evidence.kind==='collected')assert.ok(link.evidence.candidateIds.includes(newer.id));
    await run.coordinator.command({kind:'session',sessionId,generation:0,failure:true,retry:false});
    const reads=run.detailReads.filter(url=>url.endsWith('/new')).length;
    run.setClock(at+602000);await run.refresh();
    assert.equal(run.detailReads.filter(url=>url.endsWith('/new')).length,reads+1,
      'the new live detail is checked again after its interval');
    const after=await run.snapshot();
    assert.equal(after.games[0].candidates.length,2,JSON.stringify(after.games[0].candidates));
    assert.ok(after.games[0].candidates.some(candidate=>candidate.id===newer.id));
    assert.equal(after.games[0].candidates.find(candidate=>candidate.id===newer.id)?.availability.kind,'playable');
  }finally{await run.close();}
});
