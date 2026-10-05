import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { CommandSchema } from '../lib/football/shared.ts';

for(const sourceId of ['sportsurge-v2','streameast'])test(`${sourceId} stores five-minute category eligibility without stretching repeated failures`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'catalog-category-cadence-'));
  let clock=Date.parse('2026-10-04T17:00:00Z');
  const coordinator=createFootballCoordinator(join(directory,'state.sqlite'),{
    now:()=>clock,sources:[{id:sourceId,url:'https://fixture.example/list',family:sourceId,kind:'browser-catalog'}],
  });
  try{
    for(let attempt=1;attempt<=4;attempt++){
      clock+=300000;
      const category=attempt<4?{kind:'failed',at:clock,reason:'timeout'}:{kind:'collected',at:clock};
      const catalog={runId:randomUUID(),sequence:0,startedAt:clock,state:{kind:'collecting'},
        categories:{ncaaf:{kind:'pending'},nfl:category},events:[],rejectedGames:[],
        ...(sourceId==='sportsurge-v2'?{catalogIssues:[]}:{}),
      };
      const reply=await coordinator.command(CommandSchema.parse({kind:sourceId==='sportsurge-v2'?'sportsurge-catalog':'streameast-catalog',catalog}));
      assert.equal(reply.kind,'catalog-ack');
      const snapshot=await coordinator.command({kind:'sources'});
      assert.equal(snapshot.kind,'sources');
      if(snapshot.kind==='sources'){
        const stored=snapshot.snapshot.sources[0].lastAttempt;
        assert.equal(stored?.nextEligibleAt,clock+300000);
        assert.equal(stored?.failures,attempt<4?attempt:0);
        assert.equal(stored?.outcome,attempt<4?'failed':'parsed');
      }
    }
  }finally{await coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
