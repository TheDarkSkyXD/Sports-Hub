import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FootballStore} from '../lib/football/adapters/store.ts';
import {workingFeedOwner,type WorkingFeed} from '../lib/football/domain/working-feed.ts';
import {createFootballCoordinator} from '../lib/football/runtime/composition.ts';
import type {CandidateLocator,Game,SportsurgeCatalog} from '../lib/football/shared.ts';
import type {CandidateProbeResult} from '../lib/football/domain/ports.ts';

const at=Date.parse('2026-10-08T00:15:00Z');
const team=(id:string,name:string)=>({id,name,short:name,abbreviation:name.slice(0,3),color:'112233',score:'0'});
const game:Game={id:'ncaaf-401871051',league:'ncaaf',name:'Jacksonville State at Kennesaw State',
  date:'2026-10-07T23:00:00Z',away:team('espn:ncaaf:55','Jacksonville State Gamecocks'),
  home:team('espn:ncaaf:338','Kennesaw State Owls'),status:'in',lifecycle:'live',detail:'Q2',redzone:false,partitions:['fbs']};
const eventUrl='https://v2.sportsurge.net/watch-66184-cfb-jacksonville-state-kennesaw-state/';
const providerUrl='https://provider.example/watch/current-game';
const eventId='ncaaf:66184';
const providerId='stream-1-0';
const candidateId=(url:string,id:string)=>'sportsurge-v2:'+createHash('sha256').update(eventUrl).update('\0').update(id).update('\0').update(url).digest('hex').slice(0,24);
const legacyLocator=(url=providerUrl,id=providerId):CandidateLocator=>({provider:'sportsurge-v2',eventId,providerId:id,url});
const catalog:SportsurgeCatalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at,
  state:{kind:'complete',at},categories:{ncaaf:{kind:'collected',at},nfl:{kind:'collected',at}},
  events:[{id:eventId,url:eventUrl,league:'ncaaf',title:'Jacksonville State Gamecocks vs Kennesaw State Owls',
    teams:[game.away.name,game.home.name],sourceStatus:'live',kickoff:null,advertisedLinkCount:1,
    detail:{kind:'collected',at,providers:[{id:providerId,label:'Tophdstreams',observedAt:at,
      destination:{kind:'link',url:providerUrl}}]}}],rejectedGames:[],catalogIssues:[]};
const drain=async()=>{for(let i=0;i<70;i++)await new Promise<void>(resolve=>setImmediate(resolve));};

function fixture(options:{catalog?:boolean;otherRoute?:boolean;oldCheckedAt?:number}={}){
  const directory=mkdtempSync(join(tmpdir(),'sportsurge-cache-migration-'));
  const path=join(directory,'state.sqlite');
  const store=new FootballStore(path);
  store.savePartition('fbs',{games:[game],league:'ncaaf',at});
  const feeds:WorkingFeed[]=[];
  for(const [url,id] of [[providerUrl,providerId],...(options.otherRoute?
    [['https://provider.example/watch/other-game','stream-2-0']]:[])] as [string,string][]) {
    const locator=legacyLocator(url,id);
    const candidate={id:candidateId(url,id),gameId:game.id,label:id,sourceIds:['sportsurge-v2'],observedAt:at,locator};
    const identityHash=createHash('sha256').update(JSON.stringify([game.id,JSON.stringify(locator)])).digest('hex');
    const feed:WorkingFeed={version:2,identityHash,candidate,owner:workingFeedOwner(game,['fbs']),
      checkedAt:options.oldCheckedAt??at,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
    store.replaceWorkingIdentity(game.id,identityHash,[feed]);
    feeds.push(feed);
  }
  if(options.catalog)store.saveSportsurgeCatalog({catalog,receivedAt:at},[]);
  store.close();
  const probes:Array<{locator:CandidateLocator;signal:AbortSignal}>=[];
  let probe:(locator:CandidateLocator,signal:AbortSignal)=>Promise<CandidateProbeResult>=async locator=>
    locator.provider==='sportsurge-v2'&&locator.expectedMatchup?{kind:'unavailable',reason:'invalid-media'}:{kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}};
  const start=()=>createFootballCoordinator(path,{now:()=>at,browserCollectorsAvailable:true,
    schedules:[{id:'fbs',league:'ncaaf',path:'college-football',group:80}],
    sources:[{id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-cfb-streams/',family:'sportsurge',kind:'browser-catalog'}],
    readSchedule:async()=>({games:[game],league:'ncaaf',at}),readSeasonMembership:async()=>{throw new Error('unused');},
    readHtml:async()=>{throw new Error('unused');},parseListings:()=>({observations:[],outcome:'empty'}),
    probeCandidate:(locator,signal)=>{probes.push({locator,signal});return probe(locator,signal);}});
  const readRows=()=>{const saved=new FootballStore(path);try{return saved.workingFeeds();}finally{saved.close();}};
  return {start,probes,feeds,readRows,setProbe:(next:typeof probe)=>{probe=next;},
    cleanup:()=>rmSync(directory,{recursive:true,force:true})};
}

async function candidates(coordinator:ReturnType<ReturnType<typeof fixture>['start']>){
  const reply=await coordinator.command({kind:'sources'});
  assert.equal(reply.kind,'sources');
  return reply.kind==='sources'?reply.snapshot.games.find(row=>row.gameId===game.id):undefined;
}

test('restart retires a metadata-less cached route when the same current route has verified matchup metadata',async()=>{
  for(const otherRoute of [false,true]){
    const run=fixture({catalog:true,otherRoute});
    const coordinator=run.start();
    try {
      await coordinator.refresh(true);await drain();
      await coordinator.refresh(true);await drain();
      const row=await candidates(coordinator);
      assert.equal(row?.workingChoiceCount,otherRoute?1:0,'only the different cached destination stays working');
      assert.deepEqual(row?.candidates.filter(candidate=>candidate.availability.kind==='playable').map(candidate=>candidate.id),
        otherRoute?[run.feeds[1].candidate.id]:[]);
      assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false})).kind,
        otherRoute?'playback':'error');
      assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false,
        initialCandidateId:run.feeds[0].candidate.id})).kind,'error');
    }finally{await coordinator.stop();try{
      assert.deepEqual(run.readRows().map(feed=>feed.candidate.id),otherRoute?[run.feeds[1].candidate.id]:[]);
    }finally{run.cleanup();}}
  }
});

test('a newly verified catalog retires an active old route and prevents stale authorization',async()=>{
  const run=fixture();const coordinator=run.start();
  try {
    const opened=await coordinator.command({kind:'open',gameId:game.id,manual:false});
    assert.equal(opened.kind,'playback');
    if(opened.kind!=='playback')return;
    const session=opened.playback.session;
    assert.equal((await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,
      generation:session.generation})).kind,'authorized');
    assert.equal((await coordinator.command({kind:'sportsurge-catalog',catalog})).kind,'catalog-ack');
    await drain();
    assert.equal((await coordinator.command({kind:'authorize',sessionId:session.id,candidateId:session.candidateId,
      generation:session.generation})).kind,'error');
    assert.equal((await candidates(coordinator))?.workingChoiceCount,0);
    assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false})).kind,'error');
  }finally{await coordinator.stop();run.cleanup();}
});

test('a late old-route media recheck cannot restore proof after verified matchup metadata replaces it',async()=>{
  const run=fixture({oldCheckedAt:at-301_000});
  let resolveOld!:(result:CandidateProbeResult)=>void;
  run.setProbe(async locator=>locator.provider==='sportsurge-v2'&&locator.expectedMatchup?
    {kind:'unavailable',reason:'invalid-media'}:new Promise<CandidateProbeResult>(resolve=>{resolveOld=resolve;}));
  const coordinator=run.start();
  try {
    await coordinator.command({kind:'check-sources',gameIds:[game.id],retry:false});await drain();
    const old=run.probes.find(row=>row.locator.provider==='sportsurge-v2'&&!row.locator.expectedMatchup);
    assert.ok(old);
    assert.equal((await coordinator.command({kind:'sportsurge-catalog',catalog})).kind,'catalog-ack');
    assert.equal(old.signal.aborted,true);
    resolveOld({kind:'playable',proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}});await drain();
    await coordinator.refresh(true);await drain();
    assert.equal((await candidates(coordinator))?.workingChoiceCount,0);
    assert.equal((await coordinator.command({kind:'open',gameId:game.id,manual:false})).kind,'error');
  }finally{resolveOld?.({kind:'deferred',retryAfterMs:1000});await coordinator.stop();run.cleanup();}
});
