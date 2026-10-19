import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {mock,test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {SourceAttemptSchema} from '../lib/football/shared.ts';

test('latest source attempts retain malformed-row fallback and timestamp precedence without validating older history',()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-attempt-history-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path);
  const db=new DatabaseSync(path);
  const insert=db.prepare('INSERT INTO catalog_attempts VALUES (?,?,?,?,?)');
  const attempt=(at:number,count:number)=>({at,outcome:'parsed',count});
  try {
    db.exec('BEGIN');
    for(let at=1;at<=256;at++)insert.run('history','nfl',at,'parsed',JSON.stringify(attempt(at,at)));
    insert.run('history','nba',257,'failed','{');
    insert.run('history','nhl',258,'failed',JSON.stringify({at:258,outcome:'invalid'}));
    insert.run('tied','nfl',300,'parsed',JSON.stringify(attempt(300,1)));
    insert.run('tied','nba',300,'parsed',JSON.stringify(attempt(300,2)));
    db.prepare('INSERT INTO sources VALUES (?,?)').run('saved',JSON.stringify({...attempt(400,3),nextEligibleAt:500}));
    insert.run('saved','nfl',400,'parsed',JSON.stringify(attempt(400,4)));
    insert.run('saved','nba',399,'parsed',JSON.stringify(attempt(399,5)));
    insert.run('timestamp','nfl',500,'parsed',JSON.stringify(attempt(501,6)));
    insert.run('timestamp','nba',499,'parsed',JSON.stringify(attempt(502,7)));
    db.exec('COMMIT');
    const parses=mock.method(SourceAttemptSchema,'safeParse');
    try {
      assert.deepEqual(store.sourceAttempts(),{
        saved:{at:400,outcome:'parsed',count:3,nextEligibleAt:500},
        timestamp:{at:502,outcome:'parsed',count:7},
        tied:{at:300,outcome:'parsed',count:1},
        history:{at:256,outcome:'parsed',count:256},
      });
      assert.ok(parses.mock.callCount()<=6,
        `Reading four latest source attempts validated ${parses.mock.callCount()} retained attempts`);
    } finally {parses.mock.restore();}
  } finally {db.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('retained catalog history does not cross the JSON boundary after its latest valid attempts',()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-attempt-transfer-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path),db=new DatabaseSync(path);
  try {
    const insert=db.prepare('INSERT INTO catalog_attempts VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for(let index=0;index<5000;index++)insert.run(index%2?'second':'first','nfl',1000+index,'parsed',
      JSON.stringify({at:1000+index,outcome:'parsed',count:index}));
    db.exec('COMMIT');
    const parses=mock.method(JSON,'parse');
    try {
      const attempts=store.sourceAttempts(),reads=parses.mock.callCount();
      assert.deepEqual(attempts,{first:{at:5998,outcome:'parsed',count:4998},second:{at:5999,outcome:'parsed',count:4999}});
      assert.ok(reads<=2,`Reading two latest attempts decoded ${reads} retained payloads`);
    } finally {parses.mock.restore();}
  } finally {db.close();store.close();rmSync(directory,{recursive:true,force:true});}
});

test('catalog ordering keeps JSON last-key semantics, timestamp ties and legacy source normalization',()=>{
  const directory=mkdtempSync(join(tmpdir(),'source-attempt-order-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path),db=new DatabaseSync(path);
  try {
    const insert=db.prepare('INSERT INTO catalog_attempts VALUES (?,?,?,?,?)');
    insert.run('duplicate','nfl',100,'parsed','{"at":100,"at":5,"outcome":"parsed","count":1}');
    insert.run('duplicate','nba',10,'parsed','{"at":10,"outcome":"parsed","count":2}');
    insert.run('escaped','nfl',1,'parsed','{"a\\u0074":20,"outcome":"parsed","count":3}');
    insert.run('escaped','nba',2,'parsed','{"at":15,"outcome":"parsed","count":4}');
    insert.run('invalid-last','nfl',80,'parsed','{"at":80,"at":"bad","outcome":"parsed"}');
    insert.run('invalid-last','nba',7,'parsed','{"at":7,"outcome":"empty"}');
    insert.run('payload-tie','nfl',5,'parsed','{"at":42,"outcome":"parsed","count":5}');
    insert.run('payload-tie','nba',6,'parsed','{"at":42,"outcome":"parsed","count":6}');
    db.prepare('INSERT INTO sources VALUES (?,?)').run('legacy','{"at":20,"outcome":"empty","count":8}');
    db.prepare('INSERT INTO sources VALUES (?,?)').run('legacy-failure','{"at":30,"outcome":"failed","error":"http-403"}');
    insert.run('legacy','nfl',20,'parsed','{"at":20,"outcome":"parsed","count":9}');
    assert.deepEqual(store.sourceAttempts(),{
      legacy:{at:20,outcome:'empty',failures:0,nextEligibleAt:0},
      'legacy-failure':{at:30,outcome:'failed',failure:'blocked',failures:0,nextEligibleAt:0},
      duplicate:{at:10,outcome:'parsed',count:2},escaped:{at:20,outcome:'parsed',count:3},
      'invalid-last':{at:7,outcome:'empty'},'payload-tie':{at:42,outcome:'parsed',count:6},
    });
  } finally {db.close();store.close();rmSync(directory,{recursive:true,force:true});}
});
