import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult} from '../lib/football/domain/ports.ts';
import type {Game} from '../lib/football/shared.ts';

test('physical checker counts distinguish six published aliases and preserve the completed retry outcome',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'checker-outcomes-'));
  let now=Date.parse('2026-10-04T17:00:00Z');
  const at=now,team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
  const game:Game={id:'123',league:'nfl',name:'Tennessee Titans at Baltimore Ravens',date:new Date(now).toISOString(),
    home:team('Baltimore Ravens'),away:team('Tennessee Titans'),status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl']};
  const pending=Promise.withResolvers<CandidateProbeResult>();let calls=0;
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>now,
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async source=>({games:source.id==='nfl'?[game]:[],league:source.league,at:now}),
    readHtml:async()=>'<div>fixture</div>',parseListings:()=>({outcome:'parsed',observations:[{id:'listing',sourceId:'fixture',
      url:'https://fixture.example/detail',title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,rawTime:'',observedAt:now,parserVersion:2}]}),
    enrichObservation:value=>value,
    compatiblePlayers:()=>Array.from({length:6},(_,index)=>({id:'alias-'+index,label:'Server '+index,locator:{provider:'gooz' as const,playerId:String(index+1)}})),
    probeIdentity:()=> 'same-player',probeCandidate:Object.assign(async()=>{calls++;return pending.promise;},{concurrency:4}),
  });
  const drain=async()=>{for(let turn=0;turn<40;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    await coordinator.refresh();await drain();
    const active=await coordinator.command({kind:'sources'});assert.equal(active.kind,'sources');if(active.kind!=='sources')return;
    assert.equal(calls,1);assert.equal(active.snapshot.games[0].candidates.filter(row=>row.availability.kind==='checking'&&row.availability.progress.kind==='active').length,6);
    assert.equal(active.snapshot.checks?.active,1);assert.equal(active.snapshot.checks?.limit,4);
    now+=5000;pending.resolve({kind:'deferred',reason:'upstream',phase:'capture',retryAfterMs:45000});await drain();
    const ended=await coordinator.command({kind:'sources'});assert.equal(ended.kind,'sources');if(ended.kind!=='sources')return;
    assert.equal(ended.snapshot.checks?.active,0);assert.equal(ended.snapshot.checks?.completed,1);
    const availability=ended.snapshot.games[0].candidates[0].availability;
    assert.deepEqual(availability,{kind:'checking',progress:{kind:'deferred',since:now,retryAt:now+45000,
      reason:'upstream',phase:'capture',retryAfterMs:45000}});
    assert.equal(ended.snapshot.checks?.recent[0].activeMs,5000);
    assert.equal(ended.snapshot.checks?.recent[0].reason,'upstream');
  }finally{pending.resolve({kind:'deferred',retryAfterMs:30000});await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
