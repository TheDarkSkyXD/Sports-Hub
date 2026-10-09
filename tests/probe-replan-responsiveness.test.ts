import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {createProbeResources,probeHttpResponse} from '../lib/playback/probe-capacity.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

test('a large restored inventory keeps public commands and timers responsive while media waits',async()=>{
  const at=Date.parse('2026-10-08T17:00:00Z');
  const games:Game[]=Array.from({length:80},(_,index)=>({
    id:String(1000+index),league:'nfl',name:`Away ${index} at Home ${index}`,
    date:new Date(at+6*60*60_000).toISOString(),status:'pre',lifecycle:'scheduled',
    detail:'Scheduled',redzone:false,partitions:['nfl'],
    home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
    away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
  }));
  const observations:Observation[]=games.map(game=>({
    id:`event-${game.id}`,sourceId:'fixture',url:`https://fixture.example/event/${game.id}`,
    title:game.name,league:'nfl',teams:[game.away.name,game.home.name],
    kickoff:Date.parse(game.date!),rawTime:game.date!,observedAt:at,parserVersion:1,
  }));
  const directory=mkdtempSync(join(tmpdir(),'probe-replan-burst-'));
  const path=join(directory,'state.sqlite');
  const base={now:()=>at,schedules:[{id:'nfl',league:'nfl' as const,path:'',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games,league:'nfl' as const,at}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed' as const,observations}),enrichObservation:(value:Observation)=>value,
    compatiblePlayers:(gameId:string)=>Array.from({length:15},(_,index)=>({
      id:`server-${gameId}-${index}`,label:`Server ${index}`,
      locator:{provider:'gooz' as const,playerId:String(Number(gameId)*100+index)},
    })),
  };
  const seed=createFootballCoordinator(path,{...base,probeCandidate:async()=>new Promise(()=>{})});
  let coordinator:ReturnType<typeof createFootballCoordinator>|undefined;
  let releaseWork=()=>{};
  const held=new Promise<void>(resolve=>{releaseWork=resolve;});
  try{
    await seed.refresh(true);
    let published=false;
    for(let turn=0;turn<300;turn++){
      const reply=await seed.command({kind:'sources'});
      if(reply.kind==='sources'&&reply.snapshot.games.reduce((count,row)=>count+row.candidates.length,0)===1200){published=true;break;}
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
    assert.equal(published,true);
    await seed.stop();
    const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
    let active=0,peak=0;
    const started=performance.now();
    const heartbeat=new Promise<number>(resolve=>setTimeout(()=>resolve(performance.now()-started),0));
    coordinator=createFootballCoordinator(path,{...base,
      probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async activeSignal=>{
        const response=await probeHttpResponse(activeSignal,async()=>{
          active++;peak=Math.max(peak,active);
          try{await held;return new Response('ok');}finally{active--;}
        });
        await response.text();
        return {kind:'playable',proof:'media'};
      }),
    });
    const [board,sources,elapsed]=await Promise.all([
      coordinator.command({kind:'board'}),coordinator.command({kind:'sources'}),heartbeat,
    ]);
    const commandElapsed=performance.now()-started;
    assert.equal(board.kind,'board');
    assert.equal(sources.kind,'sources');
    if(sources.kind==='sources')assert.equal(sources.snapshot.games.reduce((count,row)=>count+row.candidates.length,0),1200);
    assert.ok(elapsed<3000,`a media burst delayed the event loop for ${Math.round(elapsed)} ms`);
    assert.ok(commandElapsed<3000,`public commands waited ${Math.round(commandElapsed)} ms behind media checks`);
    for(let turn=0;active<8&&turn<100;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(peak,8);
  }finally{
    releaseWork();
    await coordinator?.stop();
    await seed.stop();
    rmSync(directory,{recursive:true,force:true});
  }
});
