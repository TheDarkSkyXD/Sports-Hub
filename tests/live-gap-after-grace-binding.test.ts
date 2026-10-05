import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {Game,Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-03T20:00:00Z');
const team=(name:string,id:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:null});
const game:Game={id:'ncaaf-100',league:'ncaaf',name:'Away at Home',date:new Date(at).toISOString(),
  home:team('Home','espn:ncaaf:100'),away:team('Away','espn:ncaaf:101'),
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['fcs']};
const other:Game={...game,id:'ncaaf-200',name:'Elsewhere at Other',
  home:team('Other','espn:ncaaf:200'),away:team('Elsewhere','espn:ncaaf:201')};
const listing:Observation={id:'vipbox-cfb:event',sourceId:'vipbox-cfb',url:'https://vipbox.fm/cfb/event',
  title:'Away vs Home',league:'ncaaf',teams:['Away','Home'],kickoff:at,
  rawTime:new Date(at).toISOString(),observedAt:at,parserVersion:2};
const lookalike:Observation={...listing,id:'vipbox-cfb:other-event',url:'https://vipbox.fm/cfb/other-event',
  kickoff:null,rawTime:''};

async function until(check:()=>boolean):Promise<void>{
  for(let turn=0;turn<200;turn++){if(check())return;await new Promise<void>(resolve=>setImmediate(resolve));}
  assert.fail('listing collection did not finish');
}

test('a dated live binding prevents the first undated republish after final grace from resurrecting its link',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'final-after-grace-binding-'));
  const path=join(dir,'state.sqlite');
  let clock=at;
  let finished=false;
  let undated=false;
  let listingReads=0;
  const coordinator=createFootballCoordinator(path,{
    now:()=>clock,schedules:[{id:'fcs',league:'ncaaf',path:'fixture',group:'81'}],
    sources:[{id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'}],
    readSchedule:async()=>({games:[finished?{...game,status:'post',lifecycle:'final',finalObservedAt:clock,
      graceEndsAt:clock+5*60_000}:game,other],league:'ncaaf',at:clock}),
    readSeasonMembership:async()=>({season:2026,at:clock,teams:{}}),
    readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>{listingReads++;return {outcome:'parsed',observations:undated?
      [{...listing,kickoff:null,rawTime:'',observedAt:clock},{...lookalike,observedAt:clock}]:
      [{...listing,observedAt:clock}]};},
    enrichObservation:value=>value,compatiblePlayers:()=>[],probeCandidate:async()=>({kind:'unavailable',reason:'upstream'}),
  });
  const countObservation=()=>{
    const db=new DatabaseSync(path);
    try{return db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id=?').get(listing.id)?.n;}
    finally{db.close();}
  };
  try{
    await coordinator.command({kind:'set-retention',minutes:5});
    await coordinator.refresh(true);
    await until(()=>listingReads>=1);
    clock+=300_001;
    finished=true;
    await coordinator.refresh(true);
    await until(()=>listingReads>=2);
    clock+=5*60_000+1;
    await coordinator.command({kind:'sources'});
    assert.equal(countObservation(),0,'grace cleanup removes the dated observation');
    undated=true;
    await coordinator.refresh(true);
    await until(()=>listingReads>=3);
    const sources=await coordinator.command({kind:'sources'});
    assert.equal(sources.kind,'sources');
    if(sources.kind==='sources'){
      assert.equal(sources.snapshot.sources[0].links.some(row=>row.url===listing.url),false);
      assert.equal(sources.snapshot.sources[0].links.some(row=>row.url===lookalike.url),false);
      assert.equal(sources.snapshot.games.some(row=>row.candidates.some(candidate=>candidate.sourceIds.includes('vipbox-cfb'))),false);
    }
    assert.equal(countObservation(),0,'the undated republish cannot restore the removed final observation');
    const db=new DatabaseSync(path);
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id=?').get(lookalike.id)?.n,1);}
    finally{db.close();}
  }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
