import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

test('the bounded frontier admits one candidate per background game before siblings',async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  const kickoff=at+6*60*60_000;
  const games:Game[]=Array.from({length:95},(_,index)=>({
    id:String(index+1000),league:'nfl',name:`Away ${index} at Home ${index}`,
    date:new Date(kickoff).toISOString(),status:'pre',lifecycle:'scheduled',detail:'Scheduled',redzone:false,
    partitions:['nfl'],home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
  }));
  const observations:Observation[]=games.map((game,index)=>({id:`listing-${index}`,sourceId:'fixture',
    url:`https://fixture.example/event/${index}`,title:game.name,league:'nfl',teams:[game.away.name,game.home.name],
    kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:at,parserVersion:1}));
  const directory=mkdtempSync(join(tmpdir(),'probe-frontier-'));
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>at,schedules:[{id:'nfl',league:'nfl',path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl',at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({observations,outcome:'parsed'}),enrichObservation:value=>value,
    compatiblePlayers:gameId=>Array.from({length:18},(_,index)=>({id:`${gameId}-${index}`,label:`Server ${index}`,
      locator:{provider:'gooz' as const,playerId:`${gameId}${index.toString().padStart(2,'0')}`}})),
    probeCandidate:(_locator,signal)=>new Promise(resolve=>signal.addEventListener('abort',()=>
      resolve({kind:'deferred',retryAfterMs:300_000}),{once:true})),
  });
  try{
    await coordinator.refresh(true);
    let snapshot:Awaited<ReturnType<typeof coordinator.command>>|undefined;
    for(let index=0;index<300;index++){
      snapshot=await coordinator.command({kind:'sources'});
      if(snapshot.kind==='sources'&&snapshot.snapshot.games.length===95&&
        snapshot.snapshot.games.every(game=>game.candidates.length===18))break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.equal(snapshot?.kind,'sources');
    if(snapshot?.kind!=='sources')return;
    assert.equal(snapshot.snapshot.games.length,95);
    for(const game of snapshot.snapshot.games){
      assert.equal(game.candidates.length,18,JSON.stringify({id:game.gameId,links:game.sourceLinks,
        source:snapshot.snapshot.sources[0].listingCount}));
      assert.equal(game.candidates.filter(candidate=>candidate.availability.kind==='checking').length,1);
    }
    assert.equal(snapshot.snapshot.games.reduce((count,game)=>count+
      game.candidates.filter(candidate=>candidate.availability.kind==='unknown').length,0),95*17);
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
