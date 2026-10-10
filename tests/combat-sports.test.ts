import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseListings,SOURCES} from '../lib/football/adapters/sources.ts';
import {readSchedule,SCHEDULES} from '../lib/football/adapters/schedule.ts';
import {createSourceEventMatcher,matchObservation} from '../lib/football/domain/matching.ts';
import {combatListingFeedEligible} from '../lib/football/domain/feed-eligibility.ts';
import {workingFeedMatches,workingFeedOwner} from '../lib/football/domain/working-feed.ts';
import {CatalogStreamLocatorSchema,GameSchema,MatchupGameSchema,isCombatGame} from '../lib/football/shared.ts';
import {parseScoreboard} from '../lib/sunday.ts';

const at=Date.parse('2026-10-09T18:00:00Z');
const cardDate='2026-10-10T21:00:00Z';
const card=(name:string,id='600061541',date=cardDate)=>({id,name,date,
  status:{type:{name:'STATUS_SCHEDULED',state:'pre',completed:false,shortDetail:'Sat, Oct 10'}},
  competitions:[{id:'contest-1',date,competitors:[{id:'athlete-1'},{id:'athlete-2'}]}]});
const ufc=()=>GameSchema.parse({id:'ufc-600061541',league:'ufc',name:'UFC Fight Night: Allen vs. Duncan',
  date:cardDate,combat:{eventId:'600061541'},status:'pre',lifecycle:'scheduled',detail:'Scheduled'});
const boxing=()=>GameSchema.parse({id:'boxing-234',league:'boxing',name:'Castillo vs Zarate',
  date:'2026-10-10T01:00:00Z',combat:{eventId:'234'},status:'pre',lifecycle:'scheduled',detail:'Scheduled'});
const listing=(category:string,title:string,date:number,id:string,teams:unknown=null)=>JSON.stringify([{id,title,category,date,teams,sources:[]}]);
const source=(id:string)=>{
  const row=SOURCES.find(candidate=>candidate.id===id);
  assert.ok(row);
  return row;
};

test('UFC scoreboard emits one card without invented teams and excludes non-UFC promotions',()=>{
  const games=parseScoreboard({events:[card('UFC Fight Night: Allen vs. Duncan'),
    card("Dana White's Contender Series: Season 10, Week 10",'600060741'),
    card('BKFC Fight Night Bethlehem', '12345')]},'ufc');
  assert.equal(games.length,2);
  assert.equal(games[0].id,'ufc-600061541');
  assert.equal('home' in games[0],false);
  assert.equal('away' in games[0],false);
  assert.equal(MatchupGameSchema.safeParse(games[0]).success,false);
  const undercardEnded=card('UFC Fight Night: Allen vs. Duncan');
  const withoutCardStatus=parseScoreboard({events:[{...undercardEnded,status:undefined,competitions:[{
    ...undercardEnded.competitions[0],status:{type:{name:'STATUS_FINAL',state:'post',completed:true}}
  }]}]},'ufc');
  assert.equal(withoutCardStatus[0].lifecycle,'unknown');
});

test('combat matching requires exact card identity and bounded start time',()=>{
  const game=ufc();
  const observation={id:'streamed:1',sourceId:'streamed',url:'https://streamed.st/watch/ufc-320',
    title:game.name,league:'ufc' as const,teams:null,kickoff:Date.parse(cardDate)+3*60*60_000,
    rawTime:cardDate,observedAt:at,parserVersion:1 as const};
  assert.deepEqual(matchObservation(observation,[game],at),{kind:'matched',gameId:game.id});
  assert.equal(matchObservation({...observation,title:'UFC Fight Night: Other vs. Duncan'},[game],at).kind,'unmatched');
  assert.equal(matchObservation({...observation,kickoff:observation.kickoff+24*60*60_000},[game],at).kind,'unmatched');
  const numbered=GameSchema.parse({...game,id:'ufc-320',name:'UFC 320: Allen vs. Duncan',combat:{eventId:'320'}});
  assert.deepEqual(matchObservation({...observation,title:'UFC 320'},[numbered],at),{kind:'matched',gameId:'ufc-320'});
  assert.equal(matchObservation({...observation,title:'UFC 32: Allen vs. Duncan'},[numbered],at).kind,'unmatched');
  assert.equal(matchObservation({...observation,title:'UFC 3200: Allen vs. Duncan'},[numbered],at).kind,'unmatched');
  assert.equal(matchObservation({...observation,title:'UFC 32'},[numbered],at).kind,'unmatched');
  assert.equal(matchObservation({...observation,title:'UFC 3200'},[numbered],at).kind,'unmatched');
  assert.equal(matchObservation({...observation,title:'UFC 320',kickoff:observation.kickoff+24*60*60_000},[numbered],at).kind,'unmatched');
  const nextWeek=GameSchema.parse({...numbered,id:'ufc-321',name:'UFC 321: Allen vs. Duncan',date:'2026-10-17T21:00:00Z',combat:{eventId:'321'}});
  assert.equal(matchObservation({...observation,title:'UFC 320',kickoff:Date.parse(nextWeek.date)},[numbered,nextWeek],at).kind,'unmatched');
});

test('native catalogs classify combat while keeping published fighter metadata',()=>{
  const fight={home:{name:'Castillo'},away:{name:'Zarate'}};
  const streamed=parseListings(source('streamed'),listing('fight','Castillo vs Zarate',Date.parse('2026-10-10T01:00:00Z'),'live-event_castillo-vs-zarate',fight),at);
  const mirror=parseListings(source('livesportpro'),listing('boxing','Castillo vs Zarate',Date.parse('2026-10-10T01:00:00Z'),'live-event_castillo-vs-zarate',fight),at);
  assert.equal(streamed.observations.length,0);
  assert.equal(mirror.observations[0].league,'boxing');
  assert.deepEqual(mirror.observations[0].teams,['Castillo','Zarate']);
  assert.equal(createSourceEventMatcher([boxing()])(mirror.observations[0],{undated:'none',externalGameId:null},at).kind,'matched');
  const bkfc=parseListings(source('livesportpro'),listing('ufc','BKFC Fight Night Bethlehem',at+60_000,'bkfc-fight-night'),at);
  assert.equal(bkfc.observations[0].league,'boxing');
  const ufcListing=parseListings(source('livesportpro'),listing('ufc','UFC 320: Allen vs. Duncan',at+60_000,'ufc-320'),at);
  assert.equal(ufcListing.observations[0].league,'ufc');
});

test('boxing schedule deduplicates mirrors by card and day',async()=>{
  const event=JSON.parse(listing('boxing','Castillo vs Zarate',Date.parse('2026-10-10T01:00:00Z'),'event-1',
    {home:{name:'Castillo'},away:{name:'Zarate'}}));
  const result=await readSchedule(SCHEDULES.find(row=>row.id==='boxing')!,at,new AbortController().signal,undefined,
    undefined,undefined,undefined,async()=>JSON.stringify(event));
  assert.equal(result.games.length,1);
  assert.equal(result.games[0].name,'Castillo vs Zarate');
  assert.equal(result.games[0].league,'boxing');
  const oneMirror=await readSchedule(SCHEDULES.find(row=>row.id==='boxing')!,at,new AbortController().signal,undefined,
    undefined,undefined,undefined,async url=>{
      if(url.includes('streamed.st'))throw new Error('source offline');
      return JSON.stringify(event);
    });
  assert.equal(oneMirror.games.length,1);
  const shifted=JSON.parse(listing('boxing','Castillo vs Zarate',Date.parse('2026-10-10T05:00:00Z'),'event-2',
    {home:{name:'Castillo'},away:{name:'Zarate'}}));
  await assert.rejects(readSchedule(SCHEDULES.find(row=>row.id==='boxing')!,at,new AbortController().signal,undefined,
    undefined,undefined,undefined,async url=>JSON.stringify(url.includes('streamed.st')?event:shifted)),
  /source-schedule-conflicting-event/);
});

test('combat owner rejects a reused game ID with a different card identity',()=>{
  const game=boxing();
  assert.ok(isCombatGame(game));
  const owner=workingFeedOwner(game,['boxing']);
  const feed={owner,candidate:{gameId:game.id}};
  assert.equal(workingFeedMatches(feed,game),true);
  assert.equal(workingFeedMatches(feed,{...game,combat:{eventId:'other'}}),false);
  assert.equal(workingFeedMatches(feed,{...game,date:'2026-10-17T01:00:00Z'}),false);
  assert.equal(combatListingFeedEligible({...game,lifecycle:'unknown',status:'unknown'},Date.parse(game.date)+60_000),true);
  assert.equal(CatalogStreamLocatorSchema.safeParse({provider:'catalog-stream',gameId:game.id,
    source:'streamed',eventUrl:'https://streamed.st/watch/event-1',eventId:'event-1',sourceName:'alpha',sourceId:'id-1',
    streamNo:1,kickoff:Date.parse(game.date),title:game.name,teams:['Castillo','Zarate']}).success,true);
});
