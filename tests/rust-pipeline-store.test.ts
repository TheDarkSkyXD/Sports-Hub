import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {z} from 'zod';
import {createNativeStore,createNativeSchedule,pipelineDomain} from '../native/collector/bridge.cjs';

const fixture=z.object({steps:z.array(z.object({operation:z.string(),args:z.array(z.unknown()),expected:z.unknown()}))})
  .parse(JSON.parse(readFileSync(new URL('./fixtures/rust-pipeline-store.json',import.meta.url),'utf8')));

test('Rust repository reproduces current persisted behavior',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rust-store-parity-'));
  const store=createNativeStore(join(directory,'state.sqlite'));
  try {
    for(const step of fixture.steps)assert.deepEqual(JSON.parse(store.call(step.operation,JSON.stringify(step.args))),step.expected,step.operation);
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('Rust repository preserves legacy source catalog columns and rejects a live writer',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rust-store-schema-'));
  const path=join(directory,'state.sqlite');
  const db=new DatabaseSync(path);
  db.exec('CREATE TABLE source_catalogs (id TEXT PRIMARY KEY,current_payload TEXT NOT NULL,complete_payload TEXT) STRICT; PRAGMA user_version=1');
  db.close();
  const store=createNativeStore(path,'owner-1');
  try {
    assert.throws(()=>createNativeStore(path,'owner-2'),/football-writer-already-active/);
    assert.deepEqual(JSON.parse(store.call('sportsurgeCatalog','[]')),{current:null,lastComplete:null,previous:null});
    const inspect=new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('PRAGMA table_info(source_catalogs)').all().some(row=>row.name==='previous_payload'),false);
      assert.equal(inspect.prepare('PRAGMA user_version').get()?.user_version,1);
    } finally {inspect.close();}
  } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('Rust schedule parser keeps ESPN identity and scores',()=>{
  const input={events:[{id:'9',status:{type:{state:'in',shortDetail:'Q2'}},competitions:[{competitors:[
    {id:'a',homeAway:'away',team:{id:'2',displayName:'Away',name:'Away',abbreviation:'AWY',color:'ffffff'}},
    {id:'h',homeAway:'home',score:'7',team:{id:'1',displayName:'Home',name:'Home',abbreviation:'HME',color:'000000'}},
  ],situation:{isRedZone:true,possession:'h'}}]}]};
  const games=z.array(z.object({id:z.string(),home:z.object({id:z.string(),score:z.string()}),redzone:z.boolean(),possession:z.string()}))
    .parse(JSON.parse(pipelineDomain('parseScoreboard',JSON.stringify([input,'nfl']))));
  assert.equal(games[0].id,'9');
  assert.equal(games[0].home.id,'espn:nfl:1');
  assert.equal(games[0].home.score,'7');
  assert.equal(games[0].redzone,true);
  assert.equal(games[0].possession,'HME');
});

test('native schedule acquisition works through raw fixture HTTP without JavaScript fetch',async()=>{
  const schedule=createNativeSchedule(true);
  const now=Date.parse('2026-10-08T22:00:00Z');
  for(let offset=-1;offset<=7;offset++){
    const date=new Date(now+offset*86400000).toISOString().slice(0,10).replaceAll('-','');
    schedule.enqueueFixture(JSON.stringify({url:`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=200&dates=${date}`,body:'{"events":[]}'}));
  }
  const progress:unknown[]=[];
  try {
    const result=JSON.parse(await schedule.read(JSON.stringify({id:'nfl',league:'nfl',path:'nfl',group:null}),now,schedule.begin(),json=>{progress.push(JSON.parse(json));}));
    assert.deepEqual(result.games,[]);
    assert.equal(JSON.parse(schedule.fixtureRequests()).length,9);
    assert.ok(progress.length>=1);
  } finally {schedule.close();}
});

test('native schedule progress errors cancel and settle pending HTTP bodies',async()=>{
  const schedule=createNativeSchedule(true);
  const now=Date.parse('2026-10-08T22:00:00Z');
  for(let offset=-1;offset<=7;offset++){
    const date=new Date(now+offset*86400000).toISOString().slice(0,10).replaceAll('-','');
    schedule.enqueueFixture(JSON.stringify({url:`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?limit=200&dates=${date}`,
      ...(offset===0?{body:'{"events":[]}'}:{pending:true})}));
  }
  try {
    await assert.rejects(schedule.read(JSON.stringify({id:'nfl',league:'nfl',path:'nfl',group:null}),now,schedule.begin(),()=>{
      throw new Error('fixture-progress-failed');
    }),/fixture-progress-failed/);
    assert.ok(JSON.parse(schedule.fixtureCancels()).length>=1);
  } finally {schedule.close();}
});
