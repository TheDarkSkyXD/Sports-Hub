import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {MatchupGame} from '../lib/football/shared.ts';

test('a burst of failed feed checks publishes every unavailable feed',async()=>{
  const at=Date.parse('2026-10-14T17:00:00Z');
  const games:MatchupGame[]=Array.from({length:2},(_,index)=>({
    id:String(100+index),league:'nfl',name:`Away ${index} at Home ${index}`,date:new Date(at).toISOString(),
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:'0'},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:'0'},
    status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl'],
  }));
  const pending=new Map<string,(result:CandidateProbeResult)=>void>();
  const probe:FootballDependencies['probeCandidate']=Object.assign((_locator,signal,_onProgress,target)=>
    new Promise<CandidateProbeResult>(resolve=>{
      const finish=(result:CandidateProbeResult)=>{
        signal.removeEventListener('abort',abort);pending.delete(target.sessionId);resolve(result);
      };
      const abort=()=>finish({kind:'deferred',retryAfterMs:2000});
      signal.addEventListener('abort',abort,{once:true});pending.set(target.sessionId,finish);
    }),{concurrency:20});
  const directory=mkdtempSync(join(tmpdir(),'probe-failure-publication-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:games.map(game=>({
      id:`event-${game.id}`,sourceId:'fixture',url:`https://fixture.example/event/${game.id}`,
      title:game.name,league:'nfl',teams:[game.away.name,game.home.name],kickoff:at,
      rawTime:'',observedAt:at,parserVersion:3,
    }))}),enrichObservation:observation=>observation,
    compatiblePlayers:gameId=>Array.from({length:10},(_,index)=>({
      id:`feed-${gameId}-${index}`,label:`Feed ${index}`,locator:{provider:'gooz',playerId:`${gameId}${index}`},
    })),probeCandidate:probe,
  });
  const drain=async()=>{for(let turn=0;turn<20;turn++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    await coordinator.refresh(true);await drain();
    assert.equal(pending.size,20,'the synthetic burst starts twenty checks across both games');
    for(const finish of [...pending.values()])finish({kind:'unavailable',reason:'invalid-media'});
    await drain();
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind!=='sources')throw new Error('Expected source inventory');
    assert.deepEqual(reply.snapshot.games.map(game=>({id:game.gameId,feeds:game.candidates.map(candidate=>candidate.availability.kind)})),[
      {id:'100',feeds:Array(10).fill('unavailable')},
      {id:'101',feeds:Array(10).fill('unavailable')},
    ]);
  }finally{
    await coordinator.stop();rmSync(directory,{recursive:true,force:true});
  }
});
