import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { Game, SeasonMembership } from '../lib/football/shared.ts';

const at = Date.parse('2026-09-26T16:00:00Z');
const schedules = [
  {id:'nfl',league:'nfl',path:'nfl',group:null},
  {id:'fbs',league:'ncaaf',path:'college-football',group:'80'},
  {id:'fcs',league:'ncaaf',path:'college-football',group:'81'},
] as const;
const team = (name:string,id:string) => ({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const nfl:Game = {
  id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),
  home:team('Home','espn:nfl:1'),away:team('Away','espn:nfl:2'),status:'in',lifecycle:'live',
  detail:'Q1',redzone:false,partitions:['nfl'],
};
const college:Game = {
  ...nfl,id:'ncaaf-200',league:'ncaaf',name:'College Away at College Home',season:2026,
  home:team('College Home','espn:ncaaf:3'),away:team('College Away','espn:ncaaf:4'),partitions:['fbs'],
};
function deferred<T>() {
  let resolve!: (value:T) => void;
  let reject!: (error:Error) => void;
  const promise = new Promise<T>((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function settled<T>(promise:Promise<T>):Promise<boolean> {
  return Promise.race([promise.then(() => true),new Promise<false>(resolve => setImmediate(() => resolve(false)))]);
}

test('board publishes an NFL game while college reads and membership remain pending',async () => {
  const dir=mkdtempSync(join(tmpdir(),'football-board-partial-'));
  const pendingCollege=deferred<{games:Game[];at:number;league:'ncaaf'}>();
  const pendingMembership=deferred<SeasonMembership>();
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,schedules,sources:[],
    readSchedule:async source => source.id==='nfl' ? {games:[nfl],at,league:'nfl'} :
      source.id==='fbs' ? pendingCollege.promise : {games:[],at,league:'ncaaf'},
    readSeasonMembership:async()=>pendingMembership.promise,
  });
  try {
    const firstPromise=coordinator.command({kind:'board'});
    assert.equal(await settled(firstPromise),true,'the first board read must return before college settles');
    const first=await firstPromise;
    assert.equal(first.kind,'board');
    if(first.kind==='board')assert.equal(first.board.scheduleState,'loading');
    const partial=await coordinator.command({kind:'board'});
    assert.equal(partial.kind,'board');
    if(partial.kind==='board') {
      assert.deepEqual(partial.board.games.map(game=>game.id),['100']);
      assert.equal(partial.board.scheduleState,'loading');
    }
    pendingCollege.resolve({games:[college],at,league:'ncaaf'});
    for(let i=0;i<5;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    const ready=await coordinator.command({kind:'board'});
    assert.equal(ready.kind,'board');
    if(ready.kind==='board') {
      assert.deepEqual(ready.board.games.map(game=>game.id),['100','ncaaf-200']);
      assert.equal(ready.board.scheduleState,'ready');
    }
  } finally {
    pendingCollege.resolve({games:[],at,league:'ncaaf'});
    pendingMembership.resolve({season:2026,at,teams:{}});
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('explicit refresh waits for all partitions while board reads stay prompt',async () => {
  const dir=mkdtempSync(join(tmpdir(),'football-board-explicit-'));
  const pending=deferred<{games:Game[];at:number;league:'ncaaf'}>();
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,schedules,sources:[],
    readSchedule:async source=>source.id==='nfl'?{games:[nfl],at,league:'nfl'}:source.id==='fbs'?pending.promise:{games:[],at,league:'ncaaf'},
  });
  try {
    const refresh=coordinator.refresh(true);
    assert.equal(await settled(refresh),false);
    const boardPromise=coordinator.command({kind:'board'});
    assert.equal(await settled(boardPromise),true,'board reads must not wait for an explicit refresh');
    const board=await boardPromise;
    assert.equal(board.kind,'board');
    if(board.kind==='board')assert.deepEqual([board.board.games.map(game=>game.id),board.board.scheduleState],[['100'],'loading']);
    pending.resolve({games:[],at,league:'ncaaf'});
    await refresh;
    const complete=await coordinator.command({kind:'board'});
    assert.equal(complete.kind,'board');
    if(complete.kind==='board')assert.equal(complete.board.scheduleState,'ready');
  } finally {
    pending.resolve({games:[],at,league:'ncaaf'});
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('failed and empty initial schedules still finish loading',async () => {
  const dir=mkdtempSync(join(tmpdir(),'football-board-empty-'));
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,schedules,sources:[],
    readSchedule:async source=>{if(source.id==='fbs')throw new Error('upstream-failed');return {games:[],at,league:source.league};},
  });
  try {
    await coordinator.refresh(true);
    const board=await coordinator.command({kind:'board'});
    assert.equal(board.kind,'board');
    if(board.kind==='board') {
      assert.equal(board.board.scheduleState,'ready');
      assert.deepEqual(board.board.games,[]);
      assert.deepEqual(board.board.leagues.ncaaf.errors,['FBS schedule is unavailable or stale.']);
    }
  } finally {
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
