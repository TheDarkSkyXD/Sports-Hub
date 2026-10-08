import { browserCategory, sourceCoverage } from '../lib/football/source-registry.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFootballCoordinator } from '../lib/football/runtime/composition.ts';
import type { FootballDependencies, ListingSource } from '../lib/football/domain/ports.ts';
import type { Game, Observation, SportsurgeCatalog, StreameastCatalog } from '../lib/football/shared.ts';

const at=Date.parse('2026-10-03T18:00:00Z');
const source=(id:string):ListingSource=>({id,url:`https://${id}.example/list`,family:id});
const game=(index:number,minutes:number,lifecycle:Game['lifecycle']='scheduled'):Game=>({
  id:String(100+index),league:'nfl',name:`Away ${index} at Home ${index}`,date:new Date(at+minutes*60_000).toISOString(),
  home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233',score:null},
  away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211',score:null},
  status:lifecycle==='live'?'in':'pre',lifecycle,detail:lifecycle==='live'?'Q1':'Scheduled',redzone:false,partitions:['nfl'],
});
function observation(match:Game,listing:ListingSource,host=listing.id):Observation {
  return {id:`${listing.id}:${match.id}`,sourceId:listing.id,url:`https://${host}.example/detail/${match.id}`,
    title:match.name,league:'nfl',teams:[match.away.name,match.home.name],kickoff:Date.parse(match.date||''),
    rawTime:'',observedAt:at,parserVersion:2};
}
function gate() {
  let release=()=>{};
  const promise=new Promise<void>(resolve=>{release=resolve;});
  return {promise,release};
}
async function until(read:()=>Promise<boolean>|boolean,message:string):Promise<void> {
  for(let attempt=0;attempt<300;attempt++) {
    if(await read())return;
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  assert.fail(message);
}
function fixture(games:Game[],sources:ListingSource[],overrides:Partial<Omit<FootballDependencies,'store'>>) {
  const dir=mkdtempSync(join(tmpdir(),'source-startup-'));
  const coordinator=createFootballCoordinator(join(dir,'state.sqlite'),{
    now:()=>at,sources,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    readSchedule:async()=>({games,league:'nfl',at}),
    readSeasonMembership:async()=>({season:2026,at,teams:{}}),
    readHtml:async()=>'<main>fixture</main>',
    parseListings:listing=>({outcome:'parsed',observations:games.map(match=>observation(match,listing))}),
    enrichObservation:value=>value,
    compatiblePlayers:gameId=>[{id:`gooz-${gameId}`,label:'Free',locator:{provider:'gooz',playerId:gameId}}],
    probeCandidate:async()=>({kind:'playable',proof:'media'}),
    ...overrides,
  });
  return {coordinator,path:join(dir,'state.sqlite'),close:async()=>{await coordinator.stop();rmSync(dir,{recursive:true,force:true});}};
}

test('a fast listing publishes a working live choice while another listing is pending',async()=>{
  const slow=gate(),live=game(0,0,'live');
  const {coordinator,close}=fixture([live],[source('fast'),source('slow')],{
    readHtml:async url=>{if(url==='https://slow.example/list')await slow.promise;return '<main>fixture</main>';},
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.some(row=>row.gameId===live.id&&
        row.candidates.some(candidate=>candidate.availability.kind==='playable'));
    },'the fast live source should become playable before the slow listing is released');
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.sources.find(row=>row.id==='slow')?.lastAttempt,null);
  } finally {slow.release();await close();}
});

test('a distant direct probe cannot repeatedly abort nearer browser probes',async()=>{
  const matches=Array.from({length:9},(_,index)=>game(index,index===8?180:30));
  let starts=0,aborts=0,direct=0;
  const {coordinator,close}=fixture(matches,[source('fixture')],{
    compatiblePlayers:(gameId,listing)=>[{id:`server-${gameId}`,label:'Free',locator:gameId===matches[8].id?
      {provider:'gooz',playerId:gameId}:{provider:'event-page',gameId,eventUrl:listing.url,
        serverUrl:`https://fixture.example/server/${gameId}`}}],
    probeCandidate:async(locator,signal)=>{
      starts++;
      if(locator.provider==='gooz')direct++;
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborts++;resolve();},{once:true}));
      return {kind:'playable',proof:'media'};
    },
  });
  try {
    await coordinator.refresh(true);
    await until(()=>starts===4,'the first browser probes should start');
    await coordinator.refresh(true);
    for(let turn=0;turn<100;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(aborts,0,`nearer pending probes must remain running: ${starts} starts, ${direct} direct probes`);
    assert.equal(starts,4);
  } finally {await close();}
});

test('a busy browser observer defers the browser queue while direct checks still progress',async()=>{
  const live=game(0,0,'live'),lateDirect=gate();
  let browsers=0,direct=0,recovered=0,clock=at,busy=true;
  const {coordinator,close}=fixture([live],[source('fixture'),source('direct')],{
    now:()=>clock,
    readHtml:async url=>{if(url==='https://direct.example/list')await lateDirect.promise;return '<main>fixture</main>';},
    compatiblePlayers:(gameId,listing)=>listing.sourceId==='direct'?
      [{id:'direct',label:'Direct',locator:{provider:'gooz',playerId:gameId}}]:
      Array.from({length:300},(_,index)=>({id:`browser-${index}`,label:'Free',locator:{provider:'event-page',
        gameId,eventUrl:listing.url,serverUrl:`https://fixture.example/server/${index}`}})),
    probeCandidate:async locator=>{
      if(locator.provider==='gooz'){direct++;return {kind:'playable',proof:'media'};}
      browsers++;
      if(!busy){recovered++;return {kind:'playable',proof:'media'};}
      return {kind:'deferred',retryAfterMs:2000};
    },
  });
  try {
    await coordinator.refresh(true);
    await until(()=>browsers>0,'browser checks should start');
    lateDirect.release();
    await until(()=>direct>0,'a late direct check should enter the paused, saturated browser queue');
    for(let turn=0;turn<30;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(direct,1);
    assert.ok(browsers<=4,`a busy observer should defer the queue, not receive ${browsers} calls`);
    busy=false;
    clock+=2000;
    await new Promise<void>(resolve=>setTimeout(resolve,2100));
    await until(()=>recovered>0,'the existing deferred timers should resume browser checks after capacity returns');
  } finally {lateDirect.release();await close();}
});

test('published StreamEast server pages share the browser probe backoff',async()=>{
  const live=game(0,0,'live');
  let starts=0;
  const {coordinator,close}=fixture([live],[source('streameast')],{
    compatiblePlayers:(gameId,listing)=>Array.from({length:6},(_,index)=>({
      id:`streameast-server-${index+1}`,label:`Server ${index+1}`,
      locator:{provider:'streameast-server',gameId,sourceEventId:'nfl:46236',
        eventUrl:listing.url,serverId:String(index+1)} as const,
    })),
    probeCandidate:async()=>{starts++;return {kind:'deferred',retryAfterMs:2000};},
  });
  try {
    await coordinator.refresh(true);
    await until(()=>starts>=4,'the first four browser checks should start');
    for(let turn=0;turn<30;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(starts,4,'remaining server pages must wait for the browser backoff');
  } finally {await close();}
});

test('a game-bound StreamEast server choice cannot be attached to another game',async()=>{
  const live=game(0,0,'live');
  let probes=0;
  const {coordinator,close}=fixture([live],[source('streameast')],{
    compatiblePlayers:(_gameId,listing)=>[{id:'other-game-server',label:'Server 2',
      locator:{provider:'streameast-server',gameId:'99999',sourceEventId:'nfl:46236',
        eventUrl:listing.url,serverId:'2'}}],
    probeCandidate:async()=>{probes++;return {kind:'playable',proof:'media'};},
  });
  try {
    await coordinator.refresh(true);
    for(let turn=0;turn<30;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.games.flatMap(row=>row.candidates).length,0);
    assert.equal(probes,0);
  } finally {await close();}
});

test('a scheduled StreamEast server choice cannot be attached to another game',async()=>{
  const scheduled=game(0,30,'scheduled');
  let probes=0,reads=0;
  const {coordinator,path,close}=fixture([scheduled],[source('streameast')],{
    compatiblePlayers:(_gameId,listing)=>{reads++;return [{id:'other-game-server',label:'Server 2',
      locator:{provider:'streameast-server',gameId:'99999',sourceEventId:'nfl:46236',
        eventUrl:listing.url,serverId:'2'}}];},
    probeCandidate:async()=>{probes++;return {kind:'playable',proof:'media'};},
  });
  try {
    await coordinator.refresh(true);
    await until(()=>reads>0,'the scheduled game detail should be read');
    const db=new DatabaseSync(path,{readOnly:true});
    const details=db.prepare('SELECT payload FROM details').all().map(row=>JSON.parse(String(row.payload)));
    db.close();
    assert.equal(details.length,1);
    assert.equal(details[0].players?.length||0,0);
    assert.equal(probes,0);
  } finally {await close();}
});

test('six minutes of fresh scores retain working choices and saved proof survives a score outage',async()=>{
  const live=game(0,0,'live');
  let clock=at,scheduleFails=false,probes=0;
  const {coordinator,close}=fixture([live],[source('fixture')],{
    now:()=>clock,
    readSchedule:async()=>{
      if(scheduleFails)throw new Error('fixture schedule network failure');
      return {games:[live],league:'nfl',at:clock};
    },
    probeCandidate:async()=>{probes++;return {kind:'playable',proof:'media'};},
  });
  const working=async()=>{
    const reply=await coordinator.command({kind:'sources'});
    return reply.kind==='sources'&&reply.snapshot.games[0]?.candidates[0]?.availability.kind==='playable';
  };
  try {
    coordinator.start();
    for(let seconds=0;seconds<=360;seconds+=30) {
      clock=at+seconds*1000;
      await coordinator.refresh(true);
      await until(working,`fresh scores should retain the working choice after ${seconds} seconds`);
      const reply=await coordinator.command({kind:'board'});
      assert.equal(reply.kind,'board');
      if(reply.kind==='board')assert.deepEqual(reply.board.leagues.nfl.errors,[]);
    }
    assert.equal(probes,1,'fresh playable evidence should not be repeatedly probed');
    scheduleFails=true;
    clock+=30_000;
    await coordinator.refresh(true);
    assert.equal(await working(),true);
    const failed=await coordinator.command({kind:'board'});
    assert.equal(failed.kind,'board');
    if(failed.kind==='board') {
      assert.equal(failed.board.games.length,1);
      assert.deepEqual(failed.board.leagues.nfl.errors,['NFL schedule refresh failed; showing saved scores.']);
    }
    assert.equal((await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false})).kind,'error');
    assert.equal(probes,1);
    scheduleFails=false;
    await coordinator.refresh(true);
    await until(working,'a successful score refresh should restore the fresh working choice');
    clock+=90_001;
    assert.equal(await working(),true,'verified proof remains visible while score freshness expires');
    assert.equal((await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false})).kind,'error');
    assert.equal(probes,1);
  } finally {await close();}
});

test('repeated checks do not churn a full paused queue with more demand than capacity',async()=>{
  const live=game(0,0,'live'),near=game(1,30);
  let probes=0;
  const {coordinator,close}=fixture([live,near],[source('fixture')],{
    compatiblePlayers:(gameId,listing)=>Array.from({length:gameId===live.id?300:100},(_,index)=>({
      id:`browser-${gameId}-${index}`,label:'Free',locator:{provider:'event-page',gameId,eventUrl:listing.url,
        serverUrl:`https://fixture.example/server/${gameId}/${index}`}})),
    probeCandidate:async()=>{probes++;return {kind:'deferred',retryAfterMs:60_000};},
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.reduce((count,row)=>count+row.candidates.length,0)===400&&probes>0;
    },'both games should publish their choices');
    await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false});
    for(let turn=0;turn<10;turn++)await new Promise<void>(resolve=>setImmediate(resolve));
    const before=await coordinator.command({kind:'sources'});
    for(let request=0;request<20;request++)await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false});
    const after=await coordinator.command({kind:'sources'});
    assert.equal(before.kind,'sources');assert.equal(after.kind,'sources');
    if(before.kind==='sources'&&after.kind==='sources')assert.equal(after.snapshot.revision,before.snapshot.revision);
    assert.ok(probes<=4);
  } finally {await close();}
});

test('an unchanged refreshed listing retains fresh choices while its detail refresh is pending',async()=>{
  const pending=gate(),live=game(0,0,'live'),listing=source('fixture');
  let clock=at,reads=0;
  const {coordinator,close}=fixture([live],[listing],{
    now:()=>clock,
    parseListings:()=>({outcome:'parsed',observations:[{...observation(live,listing),observedAt:clock}]}),
    readHtml:async url=>{if(!url.endsWith('/list')&&++reads>1)await pending.promise;return '<main>fixture</main>';},
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games[0]?.candidates.length===1;
    },'the first detail should publish one choice');
    clock+=301_000;
    await coordinator.refresh(true);
    await until(()=>reads===2,'the next detail refresh should start');
    await coordinator.refresh(true);
    const refreshing=await coordinator.command({kind:'sources'});
    assert.equal(refreshing.kind,'sources');
    if(refreshing.kind==='sources')assert.deepEqual(refreshing.snapshot.games[0]?.candidates.map(candidate=>({
      id:candidate.id,observedAt:candidate.observedAt})),[{id:'gooz-100',observedAt:at}]);
    clock=at+30*60_000+1;
    await coordinator.refresh(true);
    const expired=await coordinator.command({kind:'sources'});
    assert.equal(expired.kind,'sources');
    if(expired.kind==='sources')assert.equal(expired.snapshot.games[0]?.candidates.length,0);
  } finally {pending.release();await close();}
});

test('unverified cached choices do not survive changed semantic listing metadata',async()=>{
  const live=game(0,0,'live'),listing=source('fixture');
  const changes:Partial<Observation>[]=[
    {title:'Updated listing title'},
    {rawTime:'Updated published time'},
    {league:'ncaaf'},
    {teams:['Other','Home 0']},
    {kickoff:at+6*3600_000},
    {sourceId:'other'},
    {url:'https://fixture.example/detail/changed'},
    {parserVersion:1},
  ];
  for(const change of changes) {
    const pending=gate();
    let clock=at,reads=0,listed=observation(live,listing);
    const {coordinator,close}=fixture([live],[listing],{
      now:()=>clock,
      parseListings:()=>({outcome:'parsed',observations:[listed]}),
      readHtml:async url=>{if(!url.endsWith('/list')&&++reads>1)await pending.promise;return '<main>fixture</main>';},
      probeCandidate:async()=>({kind:'deferred',retryAfterMs:60_000}),
    });
    try {
      await coordinator.refresh(true);
      await until(async()=>{
        const reply=await coordinator.command({kind:'sources'});
        return reply.kind==='sources'&&reply.snapshot.games[0]?.candidates.length===1;
      },'the initial semantic observation should publish a choice');
      clock+=301_000;listed={...listed,...change};
      await coordinator.refresh(true);
      await until(async()=>{
        const reply=await coordinator.command({kind:'sources'});
        return reply.kind==='sources'&&reply.snapshot.sources[0]?.lastAttempt?.at===clock;
      },'the changed listing should be stored');
      await new Promise<void>(resolve=>setImmediate(resolve));
      const reply=await coordinator.command({kind:'sources'});
      assert.equal(reply.kind,'sources');
      if(reply.kind==='sources')assert.equal(reply.snapshot.games.reduce((count,row)=>count+row.candidates.length,0),0,JSON.stringify(change));
    } finally {pending.release();await close();}
  }
});

test('an in-flight same-identity detail cannot replace a newer observation generation',async()=>{
  const second=gate(),third=gate(),live=game(0,0,'live'),listing=source('fixture');
  let clock=at,reads=0;
  const {coordinator,close}=fixture([live],[listing],{
    now:()=>clock,
    parseListings:()=>({outcome:'parsed',observations:[{...observation(live,listing),observedAt:clock}]}),
    readHtml:async url=>{
      if(!url.endsWith('/list')){reads++;if(reads===2)await second.promise;else if(reads>=3)await third.promise;}
      return '<main>fixture</main>';
    },
    compatiblePlayers:(_gameId,listed)=>{
      const id=listed.observedAt===at?'100':'200';
      return [{id:`gooz-${id}`,label:'Free',locator:{provider:'gooz',playerId:id}}];
    },
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games[0]?.candidates[0]?.id==='gooz-100';
    },'the original detail should publish');
    clock+=301_000;
    await coordinator.refresh(true);
    await until(()=>reads===2,'the second detail should begin');
    clock+=301_000;
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.sources[0]?.lastAttempt?.at===clock;
    },'the newer observation should be stored');
    second.release();
    await until(()=>reads===3,'the discarded detail should allow the current generation to be checked');
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.deepEqual(reply.snapshot.games[0]?.candidates.map(candidate=>({
      id:candidate.id,observedAt:candidate.observedAt})),[{id:'gooz-100',observedAt:at}]);
  } finally {second.release();third.release();await close();}
});

test('retaining a dated live listing does not report an empty collector result',async()=>{
  const live=game(0,0,'live'),listing=source('fixture');
  let clock=at;
  const {coordinator,close}=fixture([live],[listing],{
    now:()=>clock,
    parseListings:()=>({outcome:'parsed',observations:[{...observation(live,listing),observedAt:clock,kickoff:clock===at?at:null}]}),
  });
  try {
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.sources[0]?.lastAttempt?.count===1;
    },'the first listing should establish a positive collector count');
    clock+=301_000;
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.sources[0]?.lastAttempt?.at===clock;
    },'the later undated listing should be counted');
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources') {
      assert.equal(reply.snapshot.sources[0]?.lastAttempt?.count,1);
      assert.equal(reply.snapshot.sources[0]?.listingCount,1);
      assert.equal(reply.snapshot.sources[0]?.collectionHealth.kind,'healthy');
    }
  } finally {await close();}
});

test('a completed detail publishes its choice and source counts while another detail is pending',async()=>{
  const slow=gate(),live=game(0,0,'live'),distant=game(1,720);
  const {coordinator,close}=fixture([live,distant],[source('fixture')],{
    readHtml:async url=>{if(url.endsWith('/detail/101'))await slow.promise;return '<main>fixture</main>';},
  });
  try {
    await coordinator.command({kind:'sources'});
    await coordinator.refresh(true);
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.some(row=>row.gameId===live.id&&
        row.candidates.some(candidate=>candidate.availability.kind==='playable'));
    },'the completed detail should be visible before the slow detail is released');
    const reply=await coordinator.command({kind:'sources'});
    assert.equal(reply.kind,'sources');
    if(reply.kind==='sources')assert.equal(reply.snapshot.sources[0].listingCount,2);
  } finally {slow.release();await close();}
});

test('a late live listing takes the next free detail slot without waiting for the distant batch',async()=>{
  const listing=gate(),live=game(99,0,'live');
  const background=Array.from({length:30},(_,index)=>game(index,720+index));
  const reads:string[]=[],pending=new Map<string,ReturnType<typeof gate>>();
  let active=0,peak=0;
  const byHost=new Map<string,number>(),hostPeaks=new Map<string,number>();
  const publicUrls=Array.from({length:4},(_,index)=>`https://host${index}.example/list`);
  const {coordinator,close}=fixture([...background,live],[{...source('background'),publicUrls},{...source('urgent'),publicUrls}],{
    parseListings:row=>({outcome:'parsed',observations:row.id==='urgent'?[observation(live,row,'host0')]:
      background.map((match,index)=>observation(match,row,`host${index%4}`))}),
    readHtml:async url=>{
      if(url==='https://urgent.example/list'){await listing.promise;return '<main>fixture</main>';}
      if(url.endsWith('/list'))return '<main>fixture</main>';
      const host=new URL(url).hostname;
      reads.push(url);active++;peak=Math.max(peak,active);
      byHost.set(host,(byHost.get(host)||0)+1);hostPeaks.set(host,Math.max(hostPeaks.get(host)||0,byHost.get(host)||0));
      try {
        if(!url.endsWith('/199')){const wait=gate();pending.set(url,wait);await wait.promise;}
        return '<main>fixture</main>';
      } finally {active--;byHost.set(host,(byHost.get(host)||1)-1);}
    },
  });
  try {
    await coordinator.refresh(true);
    await until(()=>reads.length===8,'eight distant detail requests should begin');
    listing.release();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.sources.find(row=>row.id==='urgent')?.listingCount===1;
    },'the late listing should be visible while details remain pending');
    const release=[...pending].find(([url])=>new URL(url).hostname==='host0.example');
    assert.ok(release);
    release[1].release();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.some(row=>row.gameId===live.id&&row.candidates.length===1);
    },'the late live choice should not wait for the distant batch');
    assert.equal(reads[8],'https://host0.example/detail/199');
    assert.equal(peak,8);
    assert.deepEqual([...hostPeaks.values()],[2,2,2,2]);
  } finally {
    listing.release();
    const stopping=coordinator.stop();
    for(const wait of pending.values())wait.release();
    await stopping;await close();
  }
});

test('near-kickoff details start before distant scheduled games in kickoff order',async()=>{
  const pending=gate(),reads:string[]=[];
  const games=[game(0,720),game(1,40),game(2,10),game(3,20)];
  const {coordinator,close}=fixture(games,[source('fixture')],{
    readHtml:async url=>{if(!url.endsWith('/list')){reads.push(url);await pending.promise;}return '<main>fixture</main>';},
  });
  try {
    await coordinator.refresh(true);
    await until(()=>reads.length===2,'two detail requests should start for one host');
    assert.deepEqual(reads,['https://fixture.example/detail/102','https://fixture.example/detail/103']);
  } finally {pending.release();await close();}
});

test('a late near-kickoff choice enters a full distant probe queue and receives the next background turn',async()=>{
  const listing=gate(),live=game(0,0,'live'),distant=game(1,720),near=game(2,10);
  const calls:string[]=[],pending:(()=>void)[]=[];
  const {coordinator,close}=fixture([live,distant,near],[source('initial'),source('late')],{
    parseListings:row=>({outcome:'parsed',observations:(row.id==='late'?[near]:[live,distant]).map(match=>observation(match,row))}),
    readHtml:async url=>{if(url==='https://late.example/list')await listing.promise;return '<main>fixture</main>';},
    compatiblePlayers:gameId=>Array.from({length:gameId===live.id?12:gameId===distant.id?270:1},(_,index)=>{
      const id=String((gameId===live.id?1000:gameId===distant.id?2000:3000)+index);
      return {id:`gooz-${id}`,label:'Free',locator:{provider:'gooz' as const,playerId:id}};
    }),
    probeCandidate:async(locator,signal)=>{
      assert.equal(locator.provider,'gooz');
      if(locator.provider!=='gooz')throw new Error('unexpected provider');
      calls.push(locator.playerId);
      await new Promise<void>(resolve=>{pending.push(resolve);signal.addEventListener('abort',()=>resolve(),{once:true});});
      return {kind:'playable',proof:'media'};
    },
  });
  try {
    await coordinator.refresh(true);
    await until(()=>calls.length===4,'four media checks should start');
    assert.deepEqual(calls,['1000','1001','1002','2000']);
    assert.deepEqual(await coordinator.command({kind:'check-sources',gameIds:[live.id],retry:false}),{kind:'ok'});
    const full=await coordinator.command({kind:'sources'});
    assert.equal(full.kind,'sources');
    if(full.kind==='sources')assert.equal(full.snapshot.games.flatMap(row=>row.candidates)
      .filter(candidate=>candidate.availability.kind==='checking').length,282);
    listing.release();
    await until(async()=>{
      const reply=await coordinator.command({kind:'sources'});
      return reply.kind==='sources'&&reply.snapshot.games.find(row=>row.gameId===near.id)?.candidates[0]?.availability.kind==='checking';
    },'the near-kickoff choice should enter the full probe queue');
    for(let count=5;count<=8;count++){
      pending.shift()?.();
      await until(()=>calls.length===count,'each released media slot should admit another choice');
    }
    assert.deepEqual(calls.slice(4),['1003','1004','1005','3000']);
  } finally {listing.release();await close();}
});

const require=createRequire(import.meta.url);
const {runSportsurgeSweep}=require('../desktop/sportsurge-sweep.cjs');
const surgeCategoryCount=sourceCoverage('sportsurge-v2').length;
const eastCategoryCount=sourceCoverage('streameast').length;
const {runStreameastSweep}=require('../desktop/streameast-sweep.cjs');

test('Sportsurge browser sweep checks urgent games first and preserves serial checkpoints and background progress',async()=>{
  const minutes=[720,30,0,10,20,40];
  const category=`<main id="match-list-container">${minutes.map((minute,index)=>
    `<a class="match-row" href="watch-${100+index}-cfb-away-home-${index}/"><span class="match-row-team-name">Away ${index}</span><span class="match-row-team-name">Home ${index}</span><time class="match-time" data-timestamp="${(at+minute*60_000)/1000}"></time>${index===2?'<span class="live-badge">Live</span>':''}1 Stream</a>`).join('')}</main>`;
  const empty='<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>';
  const completed:string[]=[],sequences:number[]=[];
  let active=0,peak=0;
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,page:string)=>{
      active++;peak=Math.max(peak,active);
      try {
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(page==='category')return url.includes('cfb')?category:empty;
        return '<div class="stream-list">No streams available</div>';
      } finally {active--;}
    },
    send:async(catalog:SportsurgeCatalog)=>{
      sequences.push(catalog.sequence);
      for(const event of catalog.events)if(event.detail.kind==='collected'&&!completed.includes(event.id))completed.push(event.id);
    },signal:new AbortController().signal,now:()=>at,
  });
  assert.equal(result.state.kind,'complete');
  assert.deepEqual(completed,['ncaaf:102','ncaaf:103','ncaaf:104','ncaaf:100','ncaaf:101','ncaaf:105']);
  assert.deepEqual(sequences,Array.from({length:14+surgeCategoryCount},(_,index)=>index));
  assert.equal(peak,1);
});

test('StreamEast browser sweep prioritizes current and near games with serial free-server checks',async()=>{
  const minutes=[720,30,-20,10,20,40];
  const category=minutes.map((minute,index)=>`<article class="m-card" data-match-id="${100+index}" data-team-names="Away ${index}|Home ${index}" data-time="${(at+minute*60_000)/1000}"><a class="m-card__link" href="https://v2.streameast.ga/cfb/away-${index}-vs-home-${index}-${(at+minute*60_000)/1000}/"></a></article>`).join('');
  const empty='<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">No NFL games available</h2></div>';
  const completed:string[]=[],sequences:number[]=[];
  let active=0,peak=0;
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:string)=>{
      active++;peak=Math.max(peak,active);
      try {
        await new Promise<void>(resolve=>setImmediate(resolve));
        if(page==='category')return url.includes('/cfb-streams/')?category:empty.replace('No NFL games available',browserCategory('streameast',league)?.emptyTitles?.[0]||'');
        if(page==='server')return '<iframe src="https://streame.center/stream-east/ch33.php"></iframe>';
        return `<div class="stream-alt-list"><a class="stream-alt-item" href="${url}1"><span class="stream-alt-name">Free</span><span class="stream-alt-free-badge">Free</span></a></div>`;
      } finally {active--;}
    },
    send:async(catalog:StreameastCatalog)=>{
      sequences.push(catalog.sequence);
      for(const event of catalog.events)if(event.detail.kind==='collected'&&!completed.includes(event.id))completed.push(event.id);
    },signal:new AbortController().signal,now:()=>at,
  });
  assert.equal(result.state.kind,'complete');
  assert.deepEqual(completed,['ncaaf:102','ncaaf:103','ncaaf:104','ncaaf:100','ncaaf:101','ncaaf:105']);
  assert.deepEqual(sequences,Array.from({length:20+eastCategoryCount},(_,index)=>index));
  assert.equal(result.events.every(event=>event.detail.kind==='collected'&&event.detail.servers[0]?.availability.kind==='free-channel'),true);
  assert.equal(peak,1);
});

test('StreamEast stops on a free-server rate limit without replacing prior complete detail evidence',async()=>{
  const category=[100,101,102].map(id=>`<article class="m-card" data-match-id="${id}" data-team-names="Away ${id}|Home ${id}" data-time="${at/1000}"><a class="m-card__link" href="https://v2.streameast.ga/cfb/away-${id}-vs-home-${id}-${at/1000}/"></a></article>`).join('');
  const calls:string[]=[],sequences:number[]=[];
  const result:StreameastCatalog=await runStreameastSweep({
    read:async(url:string,page:string,league:string)=>{
      calls.push(page);
      if(page==='category')return url.includes('/cfb-streams/')?category:
        `<div id="m-schedule-empty" class="m-empty"><h2 class="m-empty__title">${browserCategory('streameast',league)?.emptyTitles?.[0]}</h2></div>`;
      if(page==='server')throw new Error('rate-limited');
      return `<div class="stream-alt-list">${[1,2].map(id=>`<a class="stream-alt-item ${id===1?'active':''}" href="${url}${id}"><span class="stream-alt-name">Free ${id}</span><span class="stream-alt-free-badge">Free</span></a>`).join('')}</div><iframe src="https://streame.center/stream-east/ch33.php"></iframe>`;
    },send:async(catalog:StreameastCatalog)=>{sequences.push(catalog.sequence);},
    signal:new AbortController().signal,now:()=>at,
  });
  assert.deepEqual(result.state,{kind:'partial',at,reason:'rate-limited'});
  assert.deepEqual(calls,[...Array.from({length:eastCategoryCount},()=> 'category'),'detail','server']);
  assert.deepEqual(sequences,Array.from({length:4+eastCategoryCount},(_,index)=>index));
  assert.deepEqual(result.events[0].detail,{kind:'failed',at,reason:'rate-limited'});
  assert.deepEqual(result.events.slice(1).map(event=>event.detail.kind),['pending','pending']);
});

test('Sportsurge stops at a rate-limited detail without overwriting earlier checkpoints',async()=>{
  const category=`<main id="match-list-container">${[100,101,102].map(id=>
    `<a class="match-row" href="watch-${id}-cfb-away-home-${id}/"><span class="match-row-team-name">Away ${id}</span><span class="match-row-team-name">Home ${id}</span><time class="match-time" data-timestamp="${at/1000}"></time>1 Stream</a>`).join('')}</main>`;
  let details=0;
  const result:SportsurgeCatalog=await runSportsurgeSweep({
    read:async(url:string,page:string)=>{
      if(page==='category')return url.includes('cfb')?category:'<main id="match-list-container"><div class="watch-empty-state">No live or upcoming games</div></main>';
      if(++details===2)throw new Error('rate-limited');
      return '<div class="stream-list">No streams available</div>';
    },send:async()=>{},signal:new AbortController().signal,now:()=>at,
  });
  assert.equal(details,2);
  assert.deepEqual(result.state,{kind:'partial',at,reason:'rate-limited'});
  assert.deepEqual(result.events.map(event=>event.detail.kind),['collected','failed','pending']);
});

for(const [name,run] of [['Sportsurge',runSportsurgeSweep],['StreamEast',runStreameastSweep]] as const)
  test(`${name} stops category acquisition on the first rate-limit response`,async()=>{
    let reads=0;
    const result=await run({read:async()=>{reads++;throw new Error('rate-limited');},send:async()=>{},
      signal:new AbortController().signal,now:()=>at});
    assert.equal(reads,1);
    assert.deepEqual(result.state,{kind:'partial',at,reason:'rate-limited'});
    assert.equal(result.categories.nfl.kind,'pending');
  });
