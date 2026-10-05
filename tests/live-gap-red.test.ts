import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { compatiblePlayers, enrichObservation } from '../lib/football/adapters/sources.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import type { Game, Observation } from '../lib/football/shared.ts';

const kickoff = Date.parse('2026-10-03T20:00:00Z');
const home = {id:'espn:ncaaf:99991',name:'Bay Lanterns',short:'Bay Lanterns',abbreviation:'BAY',color:'112233',score:null};
const away = {id:'espn:ncaaf:99992',name:'Cedar Otters',short:'Cedar Otters',abbreviation:'CED',color:'332211',score:null};
const live:Game = {id:'ncaaf-99991',league:'ncaaf',name:'Cedar Otters at Bay Lanterns',
  date:new Date(kickoff).toISOString(),home,away,status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:['fcs']};
const final:Game = {...live,status:'post',lifecycle:'final',detail:'Final',finalObservedAt:kickoff,
  graceEndsAt:kickoff+5*60_000};
const observation:Observation = {id:'vipbox-cfb:game',sourceId:'vipbox-cfb',
  url:'https://vipbox.fm/cfb/game',title:'Cedar Otters vs Bay Lanterns',teams:['Cedar Otters','Bay Lanterns'],
  league:'ncaaf',kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:kickoff,parserVersion:2};

async function until(check:()=>boolean|Promise<boolean>,message:string):Promise<void> {
  for(let turn=0;turn<300;turn++) {
    if(await check())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}

test('an undated listing with unknown teams reports the matchup uncertainty',()=>{
  const unknownTeams:[string,string]=['Unlisted Ravens','Unlisted Foxes'];
  const unknown={...observation,teams:unknownTeams,kickoff:null};
  assert.deepEqual(matchObservation(unknown,[live],kickoff),
    {kind:'unmatched',reason:'unknown-teams',possibleGameIds:[]});
});

test('an undated listing for one finished game reports that it finished',()=>{
  assert.deepEqual(matchObservation({...observation,kickoff:null},[final],kickoff),
    {kind:'unmatched',reason:'finished-game',possibleGameIds:[final.id]});
});

test('a late generic player survives a live listing that loses its kickoff',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'live-gap-late-'));
  const path=join(dir,'state.sqlite');
  let now=kickoff,undated=false,published=false;
  const publishedPage='<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>';
  assert.deepEqual(compatiblePlayers(live.id,observation,publishedPage).map(player=>player.id),['gooz-123']);
  const coordinator=createFootballCoordinator(path,{
    now:()=>now,schedules:[{id:'fcs',league:'ncaaf',path:'fixture',group:'81'}],
    sources:[{id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'}],
    readSchedule:async()=>({games:[live],league:'ncaaf',at:now}),
    readSeasonMembership:async()=>({season:2026,at:now,teams:{}}),
    readHtml:async url=>url===observation.url && published?publishedPage:'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:[{...observation,kickoff:undated?null:kickoff,
      rawTime:undated?'':observation.rawTime,observedAt:now}]}),
    enrichObservation,
    compatiblePlayers,
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  const detailAt=()=>{
    const db=new DatabaseSync(path);
    try {const row=db.prepare('SELECT at FROM details WHERE observation_id=?').get(observation.id);
      return typeof row?.at==='number'?row.at:0;}
    finally {db.close();}
  };
  try {
    await coordinator.refresh(true);
    await until(()=>detailAt()===kickoff,'the initial empty detail should be persisted');
    now+=31*60_000;
    undated=true;
    published=true;
    await coordinator.refresh(true);
    await until(()=>detailAt()===now,'the late detail should be fetched again');
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources' && !!reply.snapshot.games.find(row=>row.gameId===live.id)?.candidates
        .some(candidate=>candidate.id==='gooz-123');
    },'the newly published free player should appear');
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('lost-time lineage rejects stale listings, changed identity, and a conflicting detail date',async()=>{
  for(const scenario of ['stale','changed-teams','changed-url','conflicting-date'] as const){
    const dir=mkdtempSync(join(tmpdir(),`live-gap-${scenario}-`));
    const path=join(dir,'state.sqlite');
    let now=kickoff;
    let changed=false;
    const coordinator=createFootballCoordinator(path,{
      now:()=>now,schedules:[{id:'fcs',league:'ncaaf',path:'fixture',group:'81'}],
      sources:[{id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'}],
      readSchedule:async()=>({games:[live],league:'ncaaf',at:now}),
      readSeasonMembership:async()=>({season:2026,at:now,teams:{}}),
      readHtml:async url=>url==='https://vipbox.fm/ncaaf-schedule'?'<main>fixture</main>':
        changed?`<time datetime="${new Date(kickoff+24*3600_000).toISOString()}"></time><iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>`:'<main>fixture</main>',
      parseListings:()=>({outcome:'parsed',observations:[changed?{...observation,kickoff:null,rawTime:'',
        observedAt:scenario==='stale'?kickoff:now,
        teams:scenario==='changed-teams'?['Other Otters','Bay Lanterns'] as [string,string]:observation.teams,
        url:scenario==='changed-url'?'https://vipbox.fm/cfb/other':observation.url}:{...observation,observedAt:now}]}),
      enrichObservation,
      compatiblePlayers,
      probeCandidate:async()=>({kind:'playable',proof:'media'}),
    });
    try{
      await coordinator.refresh(true);
      await until(()=>{
        const db=new DatabaseSync(path);
        try{return db.prepare('SELECT at FROM details WHERE observation_id=?').get(observation.id)?.at===kickoff;}
        finally{db.close();}
      },'initial detail should settle');
      changed=true;
      now+=31*60_000;
      await coordinator.refresh(true);
      await until(async()=>{
        const reply=await coordinator.command({kind:'sources'});
        return reply.kind==='sources'&&reply.snapshot.lastDiscoveryAt===now;
      },'the changed listing should be processed');
      await coordinator.stop();
      const db=new DatabaseSync(path);
      try{
        const detail=db.prepare('SELECT payload FROM details WHERE observation_id=?').get(observation.id);
        assert.notEqual(typeof detail?.payload==='string'?JSON.parse(detail.payload).outcome:null,'resolved',scenario);
      }finally{db.close();}
    }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
  }
});

test('finished game source observations leave storage when viewer grace ends',()=>{
  const dir=mkdtempSync(join(tmpdir(),'live-gap-finished-'));
  const path=join(dir,'state.sqlite');
  const store=new FootballStore(path);
  try {
    store.setFinishedGameRetentionMinutes(5);
    store.savePartition('fcs',{games:[live],at:kickoff});
    store.observe(observation,{kind:'matched',gameId:live.id});
    store.savePartition('fcs',{games:[final],at:kickoff});
    store.sweep(kickoff+5*60_000+1);
    assert.equal(store.observations().some(row=>row.id===observation.id),false);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a known finished listing cannot lose its cleanup identity on an undated refresh',async()=>{
  for(const scenario of ['same-event','first-undated-after-grace','conflicting-date','changed-url','changed-teams','ambiguous-rematch'] as const){
    const dir=mkdtempSync(join(tmpdir(),`live-gap-final-undated-${scenario}-`));
    const path=join(dir,'state.sqlite');
    let now=kickoff,finished=false,lateRefresh=false,listingReads=0;
    const boundFinal=scenario==='same-event'||scenario==='first-undated-after-grace';
    const other:Game={...live,id:'ncaaf-99993',name:'Other at Elsewhere',
      home:{...home,id:'espn:ncaaf:99993',name:'Elsewhere',short:'Elsewhere',abbreviation:'ELS'},
      away:{...away,id:'espn:ncaaf:99994',name:'Other',short:'Other',abbreviation:'OTH'}};
    const refreshed:Observation={...observation,kickoff:scenario==='conflicting-date'?kickoff+7*24*3600_000:null,
      url:scenario==='changed-url'?'https://vipbox.fm/cfb/different-event':observation.url,
      teams:scenario==='changed-teams'?['Other','Elsewhere']:observation.teams};
    const coordinator=createFootballCoordinator(path,{
      now:()=>now,schedules:[{id:'fcs',league:'ncaaf',path:'fixture',group:'81'}],
      sources:[{id:observation.sourceId,url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'}],
      readSchedule:async()=>({games:[finished?{...final,finalObservedAt:now,graceEndsAt:now+5*60_000}:live,other,
        ...(finished&&scenario==='ambiguous-rematch'?[{...live,id:'ncaaf-99995',status:'pre' as const,lifecycle:'scheduled' as const,
          date:new Date(kickoff+7*24*3600_000).toISOString()}]:[])],league:'ncaaf',at:now}),
      readSeasonMembership:async()=>({season:2026,at:now,teams:{}}),
      readHtml:async()=>'<main>fixture</main>',
      parseListings:()=>{listingReads++;return {outcome:'parsed',observations:[{
        ...(finished&&(scenario!=='first-undated-after-grace'||lateRefresh)?refreshed:observation),observedAt:now}]};},
      enrichObservation:value=>value,compatiblePlayers:()=>[],
      probeCandidate:async()=>({kind:'unavailable',reason:'upstream'}),
    });
    try{
      await coordinator.command({kind:'set-retention',minutes:5});
      await coordinator.refresh(true);
      await until(()=>listingReads===1,'the dated listing should be stored');
      finished=true;
      now+=300_001;
      await coordinator.refresh(true);
      await until(()=>listingReads===2,'the shared listing should refresh while another game is live');
      if(scenario==='first-undated-after-grace'){
        now+=5*60_000+1;
        await coordinator.command({kind:'sources'});
        lateRefresh=true;
        now+=300_001;
        await coordinator.refresh(true);
        await until(()=>listingReads===3,'the first undated listing should arrive after physical cleanup');
      }
      const reply=await coordinator.command({kind:'sources'});
      assert.equal(reply.kind,'sources');
      if(reply.kind==='sources')assert.equal(reply.snapshot.sources[0].links.some(row=>row.url===refreshed.url),
        scenario==='changed-teams',scenario);
      now+=5*60_000+1;
      await coordinator.command({kind:'sources'});
      const afterGrace=new DatabaseSync(path);
      try{assert.equal(afterGrace.prepare('SELECT COUNT(*) AS n FROM observations WHERE id=?').get(observation.id)?.n,
        boundFinal?0:1,`${scenario} before another listing can reinsert the row`);}
      finally{afterGrace.close();}
      const beforeRepeat=listingReads;
      now+=300_001;
      await coordinator.refresh(true);
      await until(()=>listingReads===beforeRepeat+1,'another listing refresh should not recreate a finished source');
      const db=new DatabaseSync(path);
      try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations WHERE id=?').get(observation.id)?.n,
        boundFinal?0:1,scenario);}
      finally{db.close();}
    }finally{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
  }
});

test('a held detail response cannot recreate a feed after the matched game becomes final',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'live-gap-held-final-'));
  const path=join(dir,'state.sqlite');
  let now=kickoff;
  let scheduled:Game=live;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  let detailStarted=false;
  const coordinator=createFootballCoordinator(path,{
    now:()=>now,schedules:[{id:'fcs',league:'ncaaf',path:'fixture',group:'81'}],
    sources:[{id:observation.sourceId,url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'}],
    readSchedule:async()=>({games:[scheduled],league:'ncaaf',at:now}),
    readSeasonMembership:async()=>({season:2026,at:now,teams:{}}),
    readHtml:async url=>{if(url===observation.url){detailStarted=true;await held;return '<iframe src="https://gooz.aapmains.net/new-stream-embed/123"></iframe>';}
      return '<main>fixture</main>';},
    parseListings:()=>({outcome:'parsed',observations:[{...observation,observedAt:now}]}),
    enrichObservation,
    compatiblePlayers,
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try{
    await coordinator.command({kind:'set-retention',minutes:5});
    await coordinator.refresh(true);
    await until(()=>detailStarted,'the detail read should start while the game is live');
    now+=60_000;
    scheduled={...final,finalObservedAt:now,graceEndsAt:now+5*60_000};
    await coordinator.refresh(true);
    release();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.every(row=>row.gameId!==live.id||row.candidates.length===0);
    },'the final game should have no newly admitted candidate');
    now+=5*60_000+1;
    await coordinator.command({kind:'sources'});
    await coordinator.stop();
    const after=new DatabaseSync(path);
    try{
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM details WHERE observation_id=?').get(observation.id)?.n,0);
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM observations WHERE id=?').get(observation.id)?.n,0);
    }
    finally{after.close();}
  }finally{release();await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});
