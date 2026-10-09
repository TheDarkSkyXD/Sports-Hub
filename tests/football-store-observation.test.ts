import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FootballStore } from '../lib/football/adapters/store.ts';
import type { Observation } from '../lib/football/shared.ts';

test('detail ownership uses the current keyed observation, including outside the bulk read window',()=>{
  const dir=mkdtempSync(join(tmpdir(),'football-observation-key-'));
  const path=join(dir,'state.sqlite');
  const store=new FootballStore(path);
  const now=Date.parse('2026-10-08T22:00:00Z');
  const base:Observation={id:'old',sourceId:'sportsurge',url:'https://example.com/old',title:'Old listing',
    league:'nfl',teams:['Chicago Bears','Green Bay Packers'],kickoff:null,rawTime:'',observedAt:now-10_001,
    parserVersion:1};
  try {
    store.observe(base,{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
    const db=new DatabaseSync(path);
    db.exec('BEGIN IMMEDIATE');
    try {
      const insert=db.prepare('INSERT INTO observations VALUES (?,?,?,?)');
      for(let index=0;index<10_000;index++){
        const observation={...base,id:`new-${index}`,url:`https://example.com/${index}`,observedAt:now-index};
        insert.run(observation.id,JSON.stringify(observation),'{}',observation.observedAt);
      }
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    finally { db.close(); }
    assert.equal(store.observations().some(row=>row.id==='old'),false);
    assert.deepEqual(store.observation('old'),base);
    store.sweep(now);
    assert.equal(store.observation('old'),null);
    const replacement={...base,title:'New listing',observedAt:now+1};
    store.observe(replacement,{kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
    assert.deepEqual(store.observation('old'),replacement);
  } finally {
    store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
