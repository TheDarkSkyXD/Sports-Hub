import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSchedule, SCHEDULES, type ScheduleListingCache } from '../lib/football/adapters/schedule.ts';
import { wrestlingEventKey, wrestlingPromotion, wrestlingShowKey } from '../lib/football/domain/wrestling-events.ts';
import { matchObservation } from '../lib/football/domain/matching.ts';
import { combatListingFeedEligible, feedEligible } from '../lib/football/domain/feed-eligibility.ts';
import { workingFeedOwner, WorkingFeedSchema } from '../lib/football/domain/working-feed.ts';
import { BoardSchema, GameSchema, isWrestlingGame, LeagueSchema } from '../lib/football/shared.ts';
import { LEAGUES, validGameId } from '../lib/sunday.ts';

const start=Date.parse('2026-10-12T00:30:00Z');
const now=start-60_000;
const events=['WWE NXT','TNA Bound for Glory','AEW WrestleDream','NJPW King of Pro-Wrestling'].map((name,index)=>({
  id:30225+index,name,tag:'Wrestling',source_tag:'USA',uri_name:`wrestling-show-${30225+index}`,
  starts_at:start/1000,ends_at:start/1000+10800,always_live:0,
  iframe:`https://taifood-blog.asia/embed/wrestling-show-${30225+index}`,substreams:[],
}));
const ppv=JSON.stringify({success:true,streams:[{id:38,category:'Wrestling',streams:events}]});
const onlyPpv=async(url:string)=>{if(!url.includes('ppv.st'))throw new Error('offline');return ppv;};
function partition(id:string){const value=SCHEDULES.find(row=>row.id===id);assert.ok(value);return value;}

test('AEW and other wrestling promotions have event models, labels and six-hour unknown grace',()=>{
  for(const league of ['aew','wrestling'] as const){
    assert.equal(LeagueSchema.safeParse(league).success,true);
    const game=GameSchema.parse({id:`${league}-123`,league,name:league==='aew'?'AEW WrestleDream':'NJPW King of Pro-Wrestling',
      date:new Date(start).toISOString(),wrestling:{eventId:'123'},status:'unknown',lifecycle:'unknown',detail:'Status unavailable'});
    assert.ok(isWrestlingGame(game));
    assert.equal(validGameId(game.id),true);
    assert.equal(feedEligible(game,start+6*3600_000),true);
    assert.equal(combatListingFeedEligible(game,start+6*3600_000),true);
    assert.equal(feedEligible(game,start+6*3600_000+1),false);
    assert.deepEqual(workingFeedOwner(game,[league]),{league,eventId:'123',date:game.date,partitionIds:[league]});
    assert.equal(WorkingFeedSchema.safeParse({version:1,identityHash:'a'.repeat(64),
      candidate:{id:'ppv-choice',gameId:game.id,label:'Published feed',sourceIds:['ppv'],observedAt:now,
        locator:{provider:'event-page',gameId:game.id,eventUrl:'https://ppv.st/live/wrestling-show-30225',
          serverUrl:'https://taifood-blog.asia/embed/wrestling-show-30225'}},
      owner:workingFeedOwner(game,[league]),checkedAt:now,proof:'media'}).success,true);
  }
  assert.equal(LEAGUES.aew.label,'AEW');
  assert.equal(LEAGUES.wrestling.label,'Other wrestling');
  const board=BoardSchema.parse({schemaVersion:2,revision:0,games:[],updatedAt:new Date(now).toISOString(),scheduleState:'ready',
    leagues:{nfl:{scoresAt:null,sourceAt:null,errors:[]},ncaaf:{scoresAt:null,sourceAt:null,errors:[]}},aliases:{}});
  assert.deepEqual(board.leagues.aew,{scoresAt:null,sourceAt:null,errors:[]});
  assert.deepEqual(board.leagues.wrestling,{scoresAt:null,sourceAt:null,errors:[]});
});

test('promotion recognition is explicit and generic identity keeps the full normalized title and date',()=>{
  assert.equal(wrestlingPromotion('AEW Grand Slam: Collision'),'aew');
  assert.equal(wrestlingPromotion('All Elite Wrestling WrestleDream'),'aew');
  assert.equal(wrestlingPromotion('Collision'),null);
  assert.equal(wrestlingShowKey('aew','AEW Grand Slam: Collision'),'grand slam collision');
  assert.equal(wrestlingShowKey('aew','All Elite Wrestling Grand Slam Collision'),'grand slam collision');
  const key=wrestlingEventKey('wrestling','NJPW King of Pro-Wrestling Live Stream',start);
  assert.equal(key,'wrestling|njpw king of pro wrestling|2026-10-11');
  assert.equal(key,wrestlingEventKey('wrestling','NJPW King of Pro Wrestling',start));
  assert.notEqual(key,wrestlingEventKey('wrestling','NJPW King of Pro Wrestling',start+86400_000));
  assert.notEqual(key,wrestlingEventKey('wrestling','ROH King of Pro Wrestling',start));
});

test('all four wrestling partitions read PPV once through a shared cache and match their own event',async()=>{
  const cache:ScheduleListingCache={};
  const calls:string[]=[];
  const reader=async(url:string)=>{calls.push(url);return onlyPpv(url);};
  const results=await Promise.all(['wwe','tna','aew','wrestling'].map(league=>readSchedule(partition(league),now,
    new AbortController().signal,undefined,undefined,undefined,cache,reader)));
  assert.equal(calls.filter(url=>url.includes('ppv.st')).length,1);
  for(const [index,result] of results.entries()){
    assert.equal(result.games.length,1);
    const game=result.games[0];
    assert.equal(game.name,events[index].name);
    assert.ok(isWrestlingGame(game));
    const observation={id:`ppv-${index}`,sourceId:'ppv',url:`https://ppv.st/live/${events[index].uri_name}`,
      title:game.name,league:game.league,teams:null,kickoff:start,rawTime:String(start/1000),observedAt:now,parserVersion:3 as const};
    assert.deepEqual(matchObservation(observation,result.games,now),{kind:'matched',gameId:game.id});
  }
  await assert.rejects(readSchedule(partition('boxing'),now,new AbortController().signal,undefined,
    undefined,undefined,undefined,onlyPpv),/source-schedule-unavailable/);
});

test('canceling one wrestling partition preserves the shared read for another partition',async()=>{
  const cache:ScheduleListingCache={};
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const reader=async(url:string,signal:AbortSignal)=>{await gate;assert.equal(signal.aborted,false);return onlyPpv(url);};
  const canceled=new AbortController();
  const a=readSchedule(partition('aew'),now,canceled.signal,undefined,undefined,undefined,cache,reader);
  const b=readSchedule(partition('wrestling'),now,new AbortController().signal,undefined,undefined,undefined,cache,reader);
  canceled.abort();
  await assert.rejects(a,{name:'AbortError'});
  release();
  assert.equal((await b).games[0].league,'wrestling');
});
