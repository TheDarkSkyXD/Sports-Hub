import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import {FootballStore} from '../lib/football/adapters/store.ts';
import type {CandidateProbeResult,FootballDependencies} from '../lib/football/domain/ports.ts';
import type {MatchupGame} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T16:00:00Z');
const game:MatchupGame={id:'10001',league:'nfl',name:'Denver Broncos at San Francisco 49ers',
  date:new Date(at+3600000).toISOString(),lifecycle:'scheduled',status:'pre',detail:'Scheduled',
  redzone:false,partitions:['nfl'],
  home:{name:'San Francisco 49ers',short:'49ers',abbreviation:'SF',color:'112233',score:null},
  away:{name:'Denver Broncos',short:'Broncos',abbreviation:'DEN',color:'332211',score:null}};

async function drain(){for(let turn=0;turn<60;turn++)await new Promise<void>(resolve=>setImmediate(resolve));}

function start(path:string,options:{now?:number;route?:string;home?:string;persistable?:boolean}={}){
  let now=options.now??at;
  const current={...game,date:new Date(now+3600000).toISOString(),
    ...(options.home?{home:{...game.home,name:options.home},name:`Denver Broncos at ${options.home}`}:{})};
  const calls:string[]=[];
  let finish:(result:CandidateProbeResult)=>void=()=>{throw new Error('No check is active');};
  const probe:FootballDependencies['probeCandidate']=(locator,signal,onProgress)=>{
    assert.equal(locator.provider,'gooz');if(locator.provider!=='gooz')throw new Error('Unexpected provider');
    calls.push(locator.playerId);onProgress({kind:'active',since:now});
    return new Promise(resolve=>{
      const aborted=()=>resolve({kind:'deferred',reason:'cancelled',retryAfterMs:2000});
      signal.addEventListener('abort',aborted,{once:true});
      finish=result=>{signal.removeEventListener('abort',aborted);resolve(result);};
    });
  };
  const coordinator=createFootballCoordinator(path,{
    now:()=>now,schedules:[{id:'nfl',league:'nfl',path:'/fixture',group:null}],
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture'}],
    readSchedule:async()=>({games:[current],league:'nfl',at:now}),readHtml:async()=>'<main>fixture</main>',
    parseListings:()=>({outcome:'parsed',observations:[{id:'event',sourceId:'fixture',url:'https://fixture.example/event',
      title:current.name,league:'nfl',teams:[current.away.name,current.home.name],kickoff:Date.parse(current.date??''),
      rawTime:'',observedAt:now,parserVersion:2}]}),enrichObservation:value=>value,
    compatiblePlayers:()=>[1,2,3,4].map(index=>({id:`route-${index}`,label:`Route ${index}`,
      locator:{provider:'gooz',playerId:index===1?options.route??'1':String(index)}})),
    probeCandidate:Object.assign(probe,{concurrency:1}),
    persistableLocator:()=>options.persistable!==false,
  });
  return {coordinator,calls,async refresh(elapsed=0){now=(options.now??at)+elapsed;await coordinator.refresh(true);await drain();},
    async finish(result:CandidateProbeResult){finish(result);await drain();},
    async candidates(){const reply=await coordinator.command({kind:'sources'});assert.equal(reply.kind,'sources');
      if(reply.kind!=='sources')throw new Error('Expected sources');return reply.snapshot.games[0].candidates;}};
}

test('restart retains completed failure and incomplete outcomes while untouched feeds get the next slots',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-restart-')),path=join(directory,'state.sqlite');
  let run=start(path);
  try{
    await run.refresh();assert.deepEqual(run.calls,['1']);
    await run.finish({kind:'unavailable',reason:'blocked',phase:'capture'});
    await run.finish({kind:'deferred',reason:'upstream',phase:'decode',retryAfterMs:30000});
    assert.deepEqual(run.calls,['1','2','3']);
    await run.coordinator.stop();
    run=start(path);await run.refresh();
    assert.deepEqual(run.calls,['3'],'Restart must not repeat already attempted routes ahead of untouched feeds');
    const rows=new Map((await run.candidates()).map(candidate=>[candidate.id,candidate.availability]));
    assert.deepEqual(rows.get('route-1'),{kind:'unavailable',reason:'blocked',phase:'capture',checkedAt:at,retryAt:at+300000});
    assert.deepEqual(rows.get('route-2'),{kind:'checking',progress:{kind:'deferred',since:at,retryAt:at+30000,
      reason:'upstream',phase:'decode',retryAfterMs:30000}});
    await run.refresh(31000);assert.deepEqual(run.calls,['3']);
    await run.finish({kind:'unavailable',reason:'upstream'});assert.deepEqual(run.calls,['3','4']);
    await run.finish({kind:'unavailable',reason:'upstream'});assert.deepEqual(run.calls,['3','4','2']);
    await run.finish({kind:'deferred',reason:'upstream',phase:'decode',retryAfterMs:30000});
    const retried=(await run.candidates()).find(candidate=>candidate.id==='route-2');
    assert.deepEqual(retried?.availability,{kind:'checking',progress:{kind:'deferred',since:at+31000,
      retryAt:at+91000,reason:'upstream',phase:'decode',retryAfterMs:60000}});
  }finally{await run.coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

test('new playable proof clears the old failure even when its player cannot be cached',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-ephemeral-')),path=join(directory,'state.sqlite');
  let run=start(path,{persistable:false});
  try{
    await run.refresh();await run.finish({kind:'unavailable',reason:'blocked'});
    await run.coordinator.command({kind:'check-sources',gameIds:[game.id],retry:true});
    await run.finish({kind:'unavailable',reason:'upstream'});
    assert.equal(run.calls.at(-1),'1');
    await run.finish({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,
      observedMs:2000,mediaAdvanceMs:2000,presentedFrames:60}});
    await run.coordinator.stop();run=start(path,{persistable:false});await run.refresh();
    assert.equal(run.calls[0],'1','An expired failure must not replace newer nonpersistent playback proof');
  }finally{await run.coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

for(const reason of ['capacity','cancelled'] as const)test(`${reason} is not restored as a completed attempt`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-resource-')),path=join(directory,'state.sqlite');
  let run=start(path);
  try{
    await run.refresh();await run.finish({kind:'deferred',reason,retryAfterMs:2000});
    await run.coordinator.stop();run=start(path);await run.refresh();
    assert.deepEqual(run.calls,['1']);
  }finally{await run.coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});

for(const change of [{route:'99'},{home:'Seattle Seahawks'},{now:at+24*3600000}])test(`saved failures cannot cover a changed route, owner, or expired check ${JSON.stringify(change)}`,async()=>{
  const directory=mkdtempSync(join(tmpdir(),'feed-check-identity-')),path=join(directory,'state.sqlite');
  let run=start(path);
  try{
    await run.refresh();await run.finish({kind:'unavailable',reason:'blocked'});
    await run.coordinator.stop();
    if(change.route||change.home){
      const store=new FootballStore(path);
      try{
        const attempt=store.sourceAttempts().fixture;
        if(change.home)store.saveListingAttempt('fixture',{...attempt,nextEligibleAt:0},[]);
        if(change.route)for(const detail of store.detailEvidence())if(detail.outcome==='resolved')store.saveDetailEvidence({...detail,
          players:detail.players.map((player,index)=>index===0?{...player,locator:{provider:'gooz',playerId:change.route}}:player)});
      }finally{store.close();}
    }
    run=start(path,change);await run.refresh();
    if(change.home)assert.deepEqual(await run.candidates(),[],'Old source publications cannot be reused for a different matchup');
    else assert.equal(run.calls.at(-1),change.route??'1');
  }finally{await run.coordinator.stop();rmSync(directory,{recursive:true,force:true});}
});
