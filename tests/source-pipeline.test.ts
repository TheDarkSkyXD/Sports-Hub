import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FootballStore } from '../lib/football/adapters/store.ts';
import { recordFinal } from '../lib/football/domain/lifecycle.ts';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import { createProbeResources, probeObserverLease } from '../lib/playback/probe-capacity.ts';
import type { Candidate, Game, Observation } from '../lib/football/shared.ts';
import type { ScheduleResult } from '../lib/football/domain/ports.ts';

const at=Date.parse('2026-10-02T18:00:00Z');
const source={id:'fixture',url:'https://fixture.example/list',family:'fixture'};
const game=(league:Game['league']='nfl',date=at):Game=>({
  id:`${league}-100`,league,name:'Away at Home',date:new Date(date).toISOString(),
  home:{name:'Home',short:'Home',abbreviation:'HOM',color:'112233',score:'0'},
  away:{name:'Away',short:'Away',abbreviation:'AWY',color:'332211',score:'0'},
  status:'in',lifecycle:'live',detail:'Q1',redzone:false,partitions:[league==='nfl'?'nfl':'fcs'],
});
const observation=(league:Game['league']='nfl'):Observation=>({
  id:`${league}-listing`,sourceId:source.id,url:'https://fixture.example/detail',title:'Away vs Home',
  league,teams:['Away','Home'],kickoff:at,rawTime:'',observedAt:at,parserVersion:1,
});
const players=(gameId:string):Candidate[]=>[1,2].map(id=>({
  id:`gooz-${id}`,gameId,label:`Server ${id}`,sourceIds:[source.id],observedAt:at,
  locator:{provider:'gooz',playerId:String(id)},
}));
async function until(check:()=>Promise<boolean>):Promise<void>{
  for(let i=0;i<100;i++){
    if(await check())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail('expected pipeline state did not appear');
}

test('a late schedule partition resolves a saved listing without refetching its source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-late-'));
  const college=game('ncaaf');
  let release!:(result:ScheduleResult)=>void;
  const delayed=new Promise<ScheduleResult>(resolve=>{release=resolve;});
  let listings=0,details=0;
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>partition.id==='fcs'?delayed:{games:partition.id==='nfl'?[game()]:[],league:partition.league,at},
    readHtml:async url=>{if(url===source.url)listings++;else details++;return '<div>fixture</div>';},
    parseListings:()=>({outcome:'parsed',observations:[observation('ncaaf')]}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId)=>players(gameId),
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  const refreshing=coordinator.refresh(true);
  try{
    await until(async()=>listings===1);
    const before=await coordinator.command({kind:'sources'});
    assert.equal(before.kind,'sources');
    if(before.kind==='sources')assert.equal(before.snapshot.games.find(row=>row.gameId===college.id)?.candidates.length,undefined);
    release({games:[college],league:'ncaaf',at});
    await refreshing;
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===college.id)?.candidates.length===2;
    });
    assert.equal(listings,1);
    assert.equal(details,1);
  } finally {
    release({games:[college],league:'ncaaf',at});
    await refreshing;
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('published event pages persist as separate alternatives but count only probed media',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-event-pages-'));
  const path=join(dir,'state.sqlite');
  const eventSource={id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'};
  const eventUrl='https://vipbox.fm/onair/ncaaf/away-vs-home';
  const listed:Observation={...observation('ncaaf'),sourceId:eventSource.id,url:eventUrl};
  let current=game('ncaaf');
  const options={
    now:()=>at,sources:[eventSource],
    readSchedule:async(partition:{id:string;league:Game['league']})=>({games:partition.id==='fcs'?[current]:[],league:partition.league,at}),
    readHtml:async()=>'<main>published servers</main>',
    parseListings:()=>({outcome:'parsed' as const,observations:[listed]}),
    enrichObservation:(value:Observation)=>value,
    compatiblePlayers:(gameId:string)=>[1,2,3,4].map(number=>({id:`event-page-${number}`,label:`Server ${number}`,
      locator:{provider:'event-page' as const,gameId,eventUrl,serverUrl:`https://vipbox.fm/live/ncaaf/away-vs-home-${number}`}})),
    probeCandidate:async(locator:Candidate['locator'])=>locator.provider==='event-page' && locator.serverUrl.endsWith('-1')
      ? {kind:'playable' as const,proof:'media' as const}
      : {kind:'unavailable' as const,reason:'upstream' as const},
  };
  let coordinator=createFootballCoordinator(path,options);
  let unblock=()=>{};
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      const row=reply.kind==='sources'&&reply.snapshot.games.find(item=>item.gameId===current.id);
      return !!row&&row.candidates.length===4&&row.candidates.every(candidate=>
        candidate.availability.kind==='playable'||candidate.availability.kind==='unavailable');
    });
    let reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      const row=reply.snapshot.games.find(item=>item.gameId===current.id);
      assert.equal(row?.candidates.length,4);
      assert.equal(row?.uniqueFeedCount,1);
      assert.equal(new Set(row?.candidates.map(candidate=>candidate.id)).size,4);
    }
    await coordinator.stop();
    coordinator=createFootballCoordinator(path,options);
    await coordinator.refresh(true);
    await until(async()=>{
      const next=await coordinator.command({kind:'sources'});
      return next.kind==='sources'&&next.snapshot.games.find(item=>item.gameId===current.id)?.candidates.length===4;
    });
    const db=new DatabaseSync(path);
    try {
      const stored=db.prepare('SELECT payload FROM details WHERE observation_id=?').get(listed.id);
      assert.equal(typeof stored?.payload,'string');
      if(typeof stored?.payload==='string')assert.equal(JSON.parse(stored.payload).players.length,4);
    } finally {db.close();}
    current=game('ncaaf',at+6*3600000);
    await coordinator.refresh(true);
    reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.deepEqual(reply.snapshot.games.find(item=>item.gameId===current.id)?.candidates.map(candidate=>({
      id:candidate.id,availability:candidate.availability})),[
      {id:'event-page-1',availability:{kind:'playable',checkedAt:at,proof:'media'}},
    ]);
    await coordinator.stop();
    const staleDb=new DatabaseSync(path);
    try {staleDb.prepare("UPDATE details SET payload=json_set(payload,'$.generation','stale','$.identity','stale') WHERE observation_id=?").run(listed.id);}
    finally {staleDb.close();}
    current=game('ncaaf');
    let detailStarted=false;
    const pending=new Promise<void>(resolve=>{unblock=resolve;});
    coordinator=createFootballCoordinator(path,{...options,readHtml:async url=>{
      if(url!==eventSource.url){detailStarted=true;await pending;}
      return '<main>published servers</main>';
    }});
    await coordinator.refresh(true);
    await until(async()=>detailStarted);
    reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.deepEqual(reply.snapshot.games.find(item=>item.gameId===current.id)?.candidates.map(candidate=>({
      id:candidate.id,availability:candidate.availability})),[
      {id:'event-page-1',availability:{kind:'playable',checkedAt:at,proof:'media'}},
    ]);
    unblock();
    await until(async()=>{
      const next=await coordinator.command({kind:'sources'});
      return next.kind==='sources'&&next.snapshot.games.find(item=>item.gameId===current.id)?.candidates.length===4;
    });
  } finally {unblock();await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a detail player bound to another game cannot project into a matched event',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-event-binding-'));
  const eventSource={id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'};
  const eventUrl='https://vipbox.fm/onair/ncaaf/away-vs-home';
  const listed:Observation={...observation('ncaaf'),sourceId:eventSource.id,url:eventUrl};
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[eventSource],
    readSchedule:async partition=>({games:partition.id==='fcs'?[game('ncaaf')]:[],league:partition.league,at}),
    readHtml:async()=>'<main>published server</main>',
    parseListings:()=>({outcome:'parsed',observations:[listed]}),
    enrichObservation:value=>value,
    compatiblePlayers:()=>[{id:'wrong-game',label:'Wrong game',locator:{provider:'event-page',
      gameId:'ncaaf-999',eventUrl,serverUrl:'https://vipbox.fm/live/ncaaf/away-vs-home-1'}}],
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const db=new DatabaseSync(join(dir,'state.sqlite'));
      try{return db.prepare('SELECT COUNT(*) AS count FROM details').get()?.count===1;}
      finally{db.close();}
    });
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.games.find(row=>row.gameId===game('ncaaf').id)?.candidates.length||0,0);
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a retained live VIP event gains current candidates only after its page publishes bound servers',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-live-rollover-'));
  const path=join(dir,'state.sqlite');
  const clock=at+12*3600_000;
  const eventSource={id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'};
  const eventUrl='https://vipbox.fm/onair/ncaaf/away-vs-home';
  const listed:Observation={...observation('ncaaf'),id:'retained-vip',sourceId:eventSource.id,url:eventUrl,observedAt:at};
  let page='<main>published servers</main>';
  let detailReads=0;
  const coordinator=createFootballCoordinator(path,{
    now:()=>clock,sources:[eventSource],
    readSchedule:async partition=>({games:partition.id==='fcs'?[game('ncaaf')]:[],league:partition.league,at:clock}),
    readHtml:async url=>{if(url===eventUrl){detailReads++;return page;}return '<main>no current listing</main>';},
    parseListings:()=>({outcome:'parsed',observations:[listed]}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId,value,html)=>html.includes('published')?[...[1,2].map(number=>({
      id:`event-page-${number}`,label:`Server ${number}`,locator:{provider:'event-page' as const,gameId,
        eventUrl:value.url,serverUrl:`https://vipbox.fm/live/ncaaf/away-vs-home-${number}`},
    })),{id:'gooz-7',label:'Free backup',locator:{provider:'gooz' as const,playerId:'7'}}]:[],
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId==='ncaaf-100')?.candidates.length===3;
    });
    assert.equal(detailReads,1);
    const db=new DatabaseSync(path);
    try {
      const stored=db.prepare('SELECT payload FROM observations WHERE id=?').get(listed.id);
      assert.equal(typeof stored?.payload,'string');
      if(typeof stored?.payload==='string')assert.equal(JSON.parse(stored.payload).observedAt,clock);
      const detail=db.prepare('SELECT payload FROM details WHERE observation_id=?').get(listed.id);
      assert.equal(typeof detail?.payload,'string');
      if(typeof detail?.payload==='string')assert.deepEqual(JSON.parse(detail.payload).players.map((value:{id:string})=>value.id),
        ['event-page-1','event-page-2','gooz-7']);
    } finally {db.close();}
    page='<main>no servers</main>';
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('live rollover rejects missing routes, changed game state, and a replaced listing',async()=>{
  const cases=['missing-route','wrong-event','wrong-url','corrected-kickoff','final','stale-schedule','replaced-listing'] as const;
  for(const scenario of cases){
    const dir=mkdtempSync(join(tmpdir(),`pipeline-rollover-${scenario}-`));
    const path=join(dir,'state.sqlite');
    let clock=at+12*3600_000;
    let current=game('ncaaf');
    const eventSource={id:'vipbox-cfb',url:'https://vipbox.fm/ncaaf-schedule',family:'vipbox'};
    const eventUrl='https://vipbox.fm/onair/ncaaf/away-vs-home';
    let listed:Observation={...observation('ncaaf'),id:'retained-vip',sourceId:eventSource.id,url:eventUrl,observedAt:at};
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;});
    let detailStarted=false,detailSettled=false;
    const coordinator=createFootballCoordinator(path,{
      now:()=>clock,sources:[eventSource],
      readSchedule:async partition=>({games:partition.id==='fcs'?[current]:[],league:partition.league,at:clock}),
      readHtml:async url=>{if(url===eventUrl){detailStarted=true;await pending;detailSettled=true;}return '<main>event</main>';},
      parseListings:()=>({outcome:'parsed',observations:[listed]}),
      enrichObservation:value=>value,
      compatiblePlayers:(gameId,value)=>scenario==='missing-route'?[]:[{id:'published-server',label:'Server 1',
        locator:{provider:'event-page' as const,gameId:scenario==='wrong-event'?'ncaaf-999':gameId,
          eventUrl:scenario==='wrong-url'?'https://vipbox.fm/onair/ncaaf/other-event':value.url,
          serverUrl:'https://vipbox.fm/live/ncaaf/away-vs-home-1'}}],
      probeCandidate:async()=>({kind:'playable',proof:'media'}),
    });
    try {
      await coordinator.refresh(true);
      await until(async()=>detailStarted);
      if(scenario==='corrected-kickoff'||scenario==='final'){
        current=scenario==='corrected-kickoff'?game('ncaaf',at+3600_000):
          {...current,status:'post',lifecycle:'final',finalObservedAt:clock};
        await coordinator.refresh(true);
      }
      if(scenario==='stale-schedule')clock+=91_000;
      if(scenario==='replaced-listing'){
        clock+=300_000;
        listed={...listed,observedAt:clock,teams:['Other','Home']};
        await coordinator.refresh(true);
        await until(async()=>{
          const db=new DatabaseSync(path);
          try {
            const stored=db.prepare('SELECT payload FROM observations WHERE id=?').get(listed.id);
            return typeof stored?.payload==='string'&&JSON.parse(stored.payload).observedAt===clock;
          } finally {db.close();}
        });
      }
      const before=await coordinator.command({kind:'sources'});
      assert.equal(before.kind,'sources');
      release();
      await until(async()=>detailSettled);
      const keepsDetail=!['final','stale-schedule','replaced-listing'].includes(scenario);
      if(keepsDetail)await until(async()=>{
        const db=new DatabaseSync(path);
        try{return db.prepare('SELECT COUNT(*) AS count FROM details').get()?.count===1;}
        finally{db.close();}
      });
      else await new Promise<void>(resolve=>setImmediate(resolve));
      const reply=await coordinator.command({kind:'sources'});
      assert.equal(reply.kind,'sources');
      if(reply.kind==='sources')assert.equal(reply.snapshot.games.find(row=>row.gameId==='ncaaf-100')?.candidates.length||0,0,scenario);
      const db=new DatabaseSync(path);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM details').get()?.count,
          keepsDetail?1:0,scenario);
        const stored=db.prepare('SELECT payload FROM observations WHERE id=?').get(listed.id);
        assert.equal(typeof stored?.payload,'string');
        if(typeof stored?.payload==='string')assert.equal(JSON.parse(stored.payload).observedAt,scenario==='replaced-listing'?clock:at,scenario);
      } finally {db.close();}
    } finally {release();await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
  }
});

test('published PPV players enter the bounded detail queue alongside rotating sources',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-ppv-priority-'));
  const path=join(dir,'state.sqlite');
  const generic={id:'fixture',url:'https://fixture.example/list',family:'fixture'};
  const ppv={id:'ppv',url:'https://ppv.st/api/events',family:'ppv',kind:'catalog' as const};
  const matches=Array.from({length:115},(_,index):Game=>{
    const base=game('ncaaf',at+3600_000);
    return {...base,id:`ncaaf-${index+1000}`,name:`Away ${index} at Home ${index}`,
      home:{...base.home,name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`},
      away:{...base.away,name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`},
      status:'pre',lifecycle:'scheduled'};
  });
  const listings=matches.map((match,index):Observation=>({
    ...observation('ncaaf'),id:index<100?`generic-${index}`:`ppv-${index-100}`,
    sourceId:index<100?generic.id:ppv.id,
    url:index<100?`https://fixture.example/detail/${index}`:`https://ppv.st/live/cfb/2026-10-03/game-${index}`,
    title:match.name,teams:[match.away.name,match.home.name],kickoff:at+3600_000,parserVersion:2,
  }));
  const store=new FootballStore(path);
  try {
    for(const source of [generic,ppv])store.saveListingAttempt(source.id,
      {at,outcome:'parsed',count:listings.filter(value=>value.sourceId===source.id).length,nextEligibleAt:at+120_000,parserVersion:2},
      listings.filter(value=>value.sourceId===source.id).map(value=>({observation:value,
        result:{kind:'unmatched' as const,reason:'unknown-teams',possibleGameIds:[]}})));
  } finally {store.close();}
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  let genericReads=0;
  const coordinator=createFootballCoordinator(path,{
    now:()=>at,sources:[generic,ppv],
    readSchedule:async partition=>({games:partition.id==='fcs'?matches:[],league:partition.league,at}),
    readHtml:async url=>{if(url.startsWith('https://fixture.example/detail/')){genericReads++;await pending;}return '<main>published player</main>';},
    parseListings:()=>({outcome:'empty',observations:[]}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId,value)=>[{id:`gooz-${value.id}`,label:'Server 1',
      locator:{provider:'gooz',playerId:gameId.slice('ncaaf-'.length)}}],
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const db=new DatabaseSync(path);
      try{return db.prepare("SELECT COUNT(*) AS count FROM details WHERE observation_id LIKE 'ppv-%'").get()?.count===15;}
      finally{db.close();}
    });
    assert.ok(genericReads>0);
    release();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.filter(row=>row.candidates.some(candidate=>
        candidate.sourceIds.includes('ppv'))).length===15;
    });
  } finally {release();await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a corrected kickoff with the same game ID rematches saved listings and retracts stale candidates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-rematch-'));
  let current=game('nfl',at+6*3600000),listings=0;
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?[current]:[],league:partition.league,at}),
    readHtml:async url=>{if(url===source.url)listings++;return '<div>fixture</div>';},
    parseListings:()=>({outcome:'parsed',observations:[observation()]}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>players(gameId),
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try{
    await coordinator.refresh(true);
    await until(async()=>listings===1);
    current=game();
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===current.id)?.candidates.length===2;
    });
    assert.equal(listings,1);
    current=game('nfl',at+6*3600000);
    await coordinator.refresh(true);
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.games.find(row=>row.gameId===current.id)?.candidates.length||0,0);
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a detail response cannot restore a candidate after its schedule match changes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-detail-schedule-'));
  const path=join(dir,'state.sqlite');
  let current=game();
  let detailStarted=false,detailSettled=false;
  let release!:()=>void;
  const detailPending=new Promise<void>(resolve=>{release=resolve;});
  const coordinator=createFootballCoordinator(path,{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?[current]:[],league:partition.league,at}),
    readHtml:async url=>{
      if(url===source.url)return '<div>fixture</div>';
      detailStarted=true;
      await detailPending;
      detailSettled=true;
      return '<div>fixture</div>';
    },
    parseListings:()=>({outcome:'parsed',observations:[observation()]}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>players(gameId),
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try{
    await coordinator.refresh(true);
    await until(async()=>detailStarted);
    current=game('nfl',at+6*3600000);
    await coordinator.refresh(true);
    release();
    await until(async()=>detailSettled);
    await new Promise<void>(resolve=>setImmediate(resolve));
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.games.find(row=>row.gameId===current.id)?.candidates.length||0,0);
    const db=new DatabaseSync(path);
    try{
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM details').get()?.count,0);
      const row=db.prepare('SELECT result FROM observations WHERE id=?').get(observation().id);
      assert.equal(typeof row?.result,'string');
      if(typeof row?.result==='string')assert.deepEqual(JSON.parse(row.result),
        {kind:'unmatched',reason:'conflicting-date',possibleGameIds:[current.id]});
    } finally {db.close();}
  } finally {release();await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('transport Retry-After survives restart and a missing player preserves the listing match',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-retry-'));
  const path=join(dir,'state.sqlite');
  let clock=at,calls=0,fail=true;
  const options={
    now:()=>clock,sources:[source],
    readSchedule:async(partition:{id:string;league:Game['league']})=>({games:partition.id==='nfl'?[game()]:[],league:partition.league,at:clock}),
    readHtml:async(url:string)=>{if(url===source.url){calls++;if(fail)throw new Error('http-429');}return '<div>no player</div>';},
    parseListings:()=>({outcome:'parsed' as const,observations:[observation()]}),
    enrichObservation:(value:Observation)=>value,
    compatiblePlayers:()=>[],
    retryAfterMs:()=>540_000,
  };
  let coordinator=createFootballCoordinator(path,options);
  try{
    await coordinator.refresh(true);
    await until(async()=>calls===1);
    await coordinator.stop();
    coordinator=createFootballCoordinator(path,options);
    await coordinator.refresh(true);
    assert.equal(calls,1);
    fail=false;
    for(const elapsed of [300_000,539_999]){
      clock=at+elapsed;
      await coordinator.refresh(true);
      assert.equal(calls,1,'the persisted longer Retry-After must survive restart');
    }
    clock=at+540_000;
    await coordinator.refresh(true);
    await until(async()=>calls===2);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.sources.find(row=>row.id===source.id)?.matchedGameCount===1;
    });
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      const row=reply.snapshot.sources.find(item=>item.id===source.id);
      assert.equal(row?.lastAttempt?.outcome,'parsed');
      assert.equal(row?.matchedGameCount,1);
      assert.equal(row?.compatibleFeedCount,0);
      assert.equal(row?.links.length,1);
    }
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('fatal playback cools a shared locator and only current decoded evidence restores it',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-feedback-'));
  let firstProbes=0;
  let rejectLate:((reason?:unknown)=>void)|undefined;
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?[game()]:[],league:partition.league,at}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations:[observation()]}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>players(gameId),
    probeCandidate:async locator=>{
      if(locator.provider==='gooz'&&locator.playerId==='1'&&++firstProbes>1)
        return await new Promise<{kind:'playable';proof:'media'}>((_,reject)=>{rejectLate=reject;});
      return {kind:'playable',proof:'media'};
    },
  });
  try{
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===game().id)?.candidates.length===2&&
        reply.snapshot.games.find(row=>row.gameId===game().id)?.candidates.every(candidate=>candidate.availability.kind==='playable')===true;
    });
    const first=await coordinator.command({kind:'open',gameId:game().id,manual:false});
    assert.equal(first.kind,'playback');
    if(first.kind!=='playback')return;
    assert.equal(first.playback.session.candidateId,'gooz-1');
    const session=first.playback.session;
    const fatal=await coordinator.command({kind:'session',sessionId:session.id,generation:0,failure:true,retry:false});
    assert.equal(fatal.kind,'session');
    const second=await coordinator.command({kind:'open',gameId:game().id,manual:false});
    assert.equal(second.kind,'playback');
    if(second.kind==='playback'){
      assert.equal(second.playback.session.candidateId,'gooz-2');
      assert.deepEqual(await coordinator.command({kind:'playback-evidence',sessionId:second.playback.session.id,
        candidateId:'gooz-2',generation:0,evidence:{kind:'decoded',startupMs:500}}),{kind:'ok'});
    }
    assert.equal((await coordinator.command({kind:'playback-evidence',sessionId:session.id,candidateId:'gooz-1',generation:0,evidence:{kind:'decoded',startupMs:1000}})).kind,'error');
    const cooled=await coordinator.command({kind:'sources'});
    if(cooled.kind==='sources'){
      const rows=cooled.snapshot.games.find(row=>row.gameId===game().id)?.candidates;
      assert.equal(rows?.find(candidate=>candidate.id==='gooz-1')?.availability.kind,'unavailable');
      assert.deepEqual(rows?.map(candidate=>candidate.id),['gooz-2','gooz-1']);
    }
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[game().id],retry:true}),{kind:'ok'});
    await until(async()=>rejectLate!==undefined);
    assert.deepEqual(await coordinator.command({kind:'playback-evidence',sessionId:session.id,candidateId:'gooz-1',generation:1,evidence:{kind:'decoded',startupMs:1000}}),{kind:'ok'});
    rejectLate?.(new Error('late probe failure'));
    await until(async()=>{
      const recovered=await coordinator.command({kind:'sources'});
      return recovered.kind==='sources'&&recovered.snapshot.games.find(row=>row.gameId===game().id)?.candidates.find(candidate=>candidate.id==='gooz-1')?.availability.kind==='playable';
    });
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('a selected HTML player remains authorized during final-game grace',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-final-grace-'));
  let clock=at;
  let current:Game=game();
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>clock,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?[current]:[],league:partition.league,at:clock}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations:[observation()]}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>players(gameId),
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
  });
  try{
    await coordinator.command({kind:'set-retention',minutes:5});
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===game().id)?.candidates.some(candidate=>candidate.availability.kind==='playable')===true;
    });
    const opened=await coordinator.command({kind:'open',gameId:game().id,manual:false});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    const session=opened.playback.session;
    current=recordFinal({...game(),status:'post',lifecycle:'final'},clock);
    await coordinator.refresh(true);
    const finalBoard=await coordinator.command({kind:'board'});
    assert.equal(finalBoard.kind,'board');
    if(finalBoard.kind==='board'){
      assert.equal(finalBoard.board.games.find(row=>row.id===game().id)?.lifecycle,'final');
      assert.deepEqual(finalBoard.board.leagues.nfl.errors,[]);
    }
    const authorized=await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,generation:session.generation});
    assert.equal(authorized.kind,'authorized');
    assert.equal((await coordinator.command({kind:'open',gameId:game().id,manual:false})).kind,'playback');
    clock=at+300_001;
    assert.equal((await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,generation:session.generation})).kind,'error');
  } finally {await coordinator.stop();rmSync(dir,{recursive:true,force:true});}
});

test('accepted browser categories record one durable attempt and replay adds none',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-catalog-attempts-'));
  const path=join(dir,'state.sqlite');
  const coordinator=createFootballCoordinator(path,{now:()=>at,sources:[
    {id:'sportsurge-v2',url:'https://isportsurge.ws',family:'sportsurge-v2',kind:'browser-catalog'},
    {id:'streameast',url:'https://streameast.example',family:'streameast',kind:'browser-catalog'},
  ]});
  const sportsurge={
    runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
    state:{kind:'collecting' as const},
    categories:{ncaaf:{kind:'collected' as const,at},nfl:{kind:'pending' as const}},
    events:[],rejectedGames:[],catalogIssues:[],
  };
  const streameast={
    runId:'22222222-2222-4222-8222-222222222222',sequence:0,startedAt:at,
    state:{kind:'collecting' as const},
    categories:{ncaaf:{kind:'pending' as const},nfl:{kind:'failed' as const,at,reason:'timeout' as const}},
    events:[],rejectedGames:[],
  };
  try{
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:sportsurge}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'sportsurge-catalog',catalog:sportsurge}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'streameast-catalog',catalog:streameast}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    assert.deepEqual(await coordinator.command({kind:'streameast-catalog',catalog:streameast}),{kind:'catalog-ack',sourceRefreshMs:300_000,skipDetailEventIds:[]});
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources'){
      assert.equal(reply.snapshot.sources.find(row=>row.id==='sportsurge-v2')?.lastAttempt?.outcome,'parsed');
      assert.equal(reply.snapshot.sources.find(row=>row.id==='streameast')?.lastAttempt?.outcome,'failed');
    }
  } finally {await coordinator.stop();}
  const db=new DatabaseSync(path);
  try{
    const attempts=db.prepare('SELECT source_id,league,outcome FROM catalog_attempts ORDER BY source_id,league').all().map(row=>({...row}));
    assert.deepEqual(attempts,[
      {source_id:'sportsurge-v2',league:'ncaaf',outcome:'parsed'},
      {source_id:'streameast',league:'nfl',outcome:'failed'},
    ]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM diagnostics WHERE source_id LIKE '%:%'").get()?.n,2);
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test('new live first feeds advance within four observer permits',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-fairness-'));
  const matches=Array.from({length:8},(_,index):Game=>({
    ...game(),id:`game-${index}`,name:`Away ${index} at Home ${index}`,
    home:{...game().home,name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`},
    away:{...game().away,name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`},
  }));
  const listings=matches.map((match,index):Observation=>({
    ...observation(),id:`listing-${index}`,url:`https://fixture.example/detail/${index}`,title:match.name,
    teams:[match.away.name,match.home.name],
  }));
  const calls:string[]=[];
  const pending:(()=>void)[]=[];
  let active=0,peak=0;
  const resources=createProbeResources({httpLimit:8,observerLimit:4,activeBudgetMs:65_000});
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='nfl'?matches:[],league:partition.league,at}),
    readHtml:async()=>'<div>fixture</div>',
    parseListings:()=>({outcome:'parsed',observations:listings}),
    enrichObservation:value=>value,
    compatiblePlayers:(gameId,value)=>Array.from({length:6},(_,index):Candidate=>({
      id:`${gameId}-${index}`,gameId,label:`Server ${index}`,sourceIds:[source.id],observedAt:at,
      locator:{provider:'gooz',playerId:String(Number(value.id.slice('listing-'.length))*6+index+1)},
    })),
    probeCandidate:(locator,signal,onProgress)=>resources.run(signal,onProgress,async activeSignal=>{
      const release=await probeObserverLease(activeSignal);
      try{
      assert.equal(locator.provider,'gooz');
      calls.push(locator.playerId);
      active++;peak=Math.max(peak,active);
      await new Promise<void>(resolve=>{
        pending.push(resolve);
        activeSignal.addEventListener('abort',resolve,{once:true});
      });
      active--;
      return {kind:'playable',proof:'media'};
      }finally{release();}
    }),
  });
  try{
    await coordinator.refresh(true);
    await until(async()=>calls.length===4);
    assert.deepEqual(calls,['1','7','13','19']);
    for(let expected=5;expected<=8;expected++){
      pending.shift()?.();
      await until(async()=>calls.length===expected);
    }
    assert.deepEqual(calls.slice(4,8),['25','31','37','43']);
    assert.equal(peak,4);
  } finally {
    for(const release of pending)release();
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('manual live retries progress alongside a held background route',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pipeline-probe-retry-'));
  const live=game('ncaaf');
  const scheduled:Game={...game('ncaaf',at+3600_000),id:'ncaaf-101',name:'Other at Elsewhere',
    home:{...live.home,name:'Elsewhere',short:'Elsewhere',abbreviation:'ELS'},
    away:{...live.away,name:'Other',short:'Other',abbreviation:'OTH'},status:'pre',lifecycle:'scheduled'};
  const listings=[live,scheduled].map((match:Game)=>({
    ...observation('ncaaf'),id:`listing-${match.id}`,url:`https://fixture.example/detail/${match.id}`,
    title:match.name,teams:[match.away.name,match.home.name],kickoff:Date.parse(match.date || ''),parserVersion:2 as const,
  }));
  let targetChecks=0,backgroundChecks=0;
  const pending:(()=>void)[]=[];
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources:[source],
    readSchedule:async partition=>({games:partition.id==='fcs'?[live,scheduled]:[],league:partition.league,at}),
    readHtml:async()=>'<main>published</main>',
    parseListings:()=>({outcome:'parsed',observations:listings}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>Array.from({length:gameId===live.id?17:300},(_,index)=>{
      const number=gameId===live.id?index+1:index+1000;
      return {id:`gooz-${number}`,label:`Server ${number}`,locator:{provider:'gooz' as const,playerId:String(number)}};
    }),
    probeCandidate:async locator=>{
      assert.equal(locator.provider,'gooz');
      const number=Number(locator.playerId);
      if(number<1000){targetChecks++;return {kind:'unavailable' as const,reason:'upstream' as const};}
      backgroundChecks++;
      if(targetChecks<17)return {kind:'unavailable' as const,reason:'upstream' as const};
      return await new Promise<{kind:'unavailable';reason:'upstream'}>(resolve=>pending.push(()=>resolve({kind:'unavailable',reason:'upstream'})));
    },
  });
  const availability=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    return reply.kind==='sources'?reply.snapshot.games.find(row=>row.gameId===live.id)?.candidates.map(candidate=>candidate.availability.kind):[];
  };
  try {
    await coordinator.refresh(true);
    await until(async()=>targetChecks===17&&pending.length===1);
    assert.deepEqual(new Set(await availability()),new Set(['unavailable']));
    await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false});
    assert.equal(targetChecks,17);
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:true}),{kind:'ok'});
    const backgroundBefore=backgroundChecks;
    await until(async()=>{
      for(const release of pending.splice(0))release();
      return targetChecks===34&&backgroundChecks>backgroundBefore;
    });
    await until(async()=>{
      const states=await availability();
      return states?.length===17&&states.every(state=>state==='unavailable');
    });
  } finally {
    for(const release of pending)release();
    await coordinator.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
