import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock,test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {recordFinal} from '../lib/football/domain/lifecycle.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {ScheduleResult} from '../lib/football/domain/ports.ts';
import type {Game,MatchupGame} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T19:00:00Z');
const game:MatchupGame={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),
  home:{id:'home',name:'Home',short:'Home',abbreviation:'H',color:'112233',score:'0'},
  away:{id:'away',name:'Away',short:'Away',abbreviation:'A',color:'332211',score:'0'},
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['nfl']};
const schedules=[{id:'nfl',league:'nfl',path:'nfl',group:null}] as const;
const drain=async()=>{for(let index=0;index<5;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
async function board(coordinator:ReturnType<typeof createFootballCoordinator>){
  const reply=await coordinator.command({kind:'board'});
  assert.equal(reply.kind,'board');
  if(reply.kind!=='board')throw new Error('Expected board');
  return reply.board;
}

test('unchanged normalized schedules advance freshness without rewriting saved observation matches',async()=>{
  for(const final of [false,true]){
    const directory=mkdtempSync(join(tmpdir(),'schedule-projection-')),path=join(directory,'state.sqlite');
    let now=at;
    const games=():Game[]=>[final?recordFinal({...game,status:'post',lifecycle:'final'},now):game];
    const seed=new FootballStore(path);
    seed.savePartition('nfl',{games:games(),at});
    seed.observe({id:'saved',sourceId:'fixture',url:'https://fixture.example/game',title:game.name,
      teams:['Away','Home'],league:'nfl',kickoff:at,rawTime:'',observedAt:at,parserVersion:1},
    {kind:'matched',gameId:'100'});
    seed.close();
    const coordinator=createFootballCoordinator(path,{now:()=>now,schedules,sources:[],
      readHtml:async()=>'',compatiblePlayers:()=>[],
      readSchedule:async(_source,_now,_signal,onCurrent)=>{
        const result:ScheduleResult={games:games(),league:'nfl',at:now};onCurrent?.(result);return result;
      }});
    let writes:ReturnType<typeof mock.method<typeof FootballStore.prototype,'observe'>>|undefined;
    try{
      await coordinator.refresh(true);await drain();
      const before=await board(coordinator);
      writes=mock.method(FootballStore.prototype,'observe');
      for(let index=0;index<4;index++){now+=1000;await coordinator.refresh(true);}
      const after=await board(coordinator);
      assert.deepEqual(after.games.map(row=>[row.id,row.lifecycle]),[['100',final?'final':'live']]);
      assert.equal(after.leagues.nfl.scoresAt,new Date(now).toISOString());
      assert.ok(after.revision>before.revision);
      if(final){
        assert.equal(after.games[0].finalObservedAt,at);
        assert.equal(after.games[0].graceEndsAt,at+24*3600_000);
      }
      assert.equal(writes.mock.callCount(),0,'unchanged accepted schedules must not rematch stored observations');
    }finally{writes?.mock.restore();await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
  }
});

test('changed current scores and later future games are published before and after the horizon completes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'schedule-projection-current-'));
  let finish:(result:ScheduleResult)=>void=()=>{};
  const horizon=new Promise<ScheduleResult>(resolve=>{finish=resolve;});
  const current:Game={...game,home:{...game.home,score:'7'}};
  const future:Game={...game,id:'101',status:'pre',lifecycle:'scheduled',date:new Date(at+86400_000).toISOString()};
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{now:()=>at,schedules,sources:[],
    readSchedule:async(_source,_now,_signal,onCurrent)=>{
      onCurrent?.({games:[current],at,league:'nfl'});return horizon;
    }});
  try{
    const refreshing=coordinator.refresh(true);
    const early=await board(coordinator);
    assert.deepEqual(early.games.map(row=>row.id),['100']);
    assert.equal('home' in early.games[0]?early.games[0].home.score:undefined,'7');
    finish({games:[current,future],at,league:'nfl'});await refreshing;
    assert.deepEqual((await board(coordinator)).games.map(row=>row.id),['100','101']);
  }finally{finish({games:[current,future],at,league:'nfl'});await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
