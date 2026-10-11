import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureCollector, parseListings, SOURCES } from '../lib/football/adapters/sources.ts';
import { createSourceEventMatcher, matchObservation } from '../lib/football/domain/matching.ts';
import type { Game, League, Observation } from '../lib/football/shared.ts';

const at=Date.parse('2026-10-08T21:10:00Z');
const kickoff=at+60*60_000;
const sourceIds=['streamed','livesportpro','sportsbite','sportsfeed24'] as const;
type SourceId=typeof sourceIds[number];
type Event={category:string;title:string;teams?:readonly [string,string]};
const team=(name:string)=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
function source(id:SourceId) {
  const found=SOURCES.find(row=>row.id===id);
  assert.ok(found);
  return found;
}
function body(id:SourceId,events:readonly Event[]):string {
  if(id==='sportsfeed24')return JSON.stringify(events.map((event,index)=>({
    categoryName:event.category,subCategories:[{subCategoryName:event.category,games:[{
      teamA:event.teams?.[0]??event.title,teamB:event.teams?.[1]??'Live',
      matchDate:new Date(kickoff).toUTCString(),sourceLink:`https://links.totalsportek1.is/event/${10000+index}/`,
    }]}],
  })));
  const rows=events.map((event,index)=>({
    id:`event-${index}`,event_key:`fg-event-${index}`,title:event.title,category:event.category,date:kickoff,
    start:new Date(kickoff).toISOString(),kickoffMs:kickoff,sources:[],streams:[],
    teams:event.teams?{home:{name:event.teams[0]},away:{name:event.teams[1]}}:null,
  }));
  return JSON.stringify(id==='sportsbite'?{scraped_at:new Date(at).toISOString(),days:[{date:'2026-10-08',events:rows}]}:rows);
}
function game(league:'nfl'|'ncaaf'|'nba'|'wnba'):Game {
  return {id:`${league}-same-teams`,league,name:'Home vs Away',date:new Date(kickoff).toISOString(),
    home:team('Home'),away:team('Away'),status:'pre',lifecycle:'scheduled',detail:'',redzone:false};
}

test('broad catalogs exclude unsupported sports before they can match covered games',()=>{
  for(const id of sourceIds) {
    const result=parseListings(source(id),body(id,[
      {category:'NBA',title:'Home vs Away',teams:['Home','Away']},
      ...['soccer','Golf','cricket','tennis','rugby','Premier League'].map(category=>({category,title:`${category} teams`,teams:['Home','Away'] as const})),
    ]),at);
    assert.equal(result.outcome,'parsed',id);
    assert.deepEqual(result.observations.map(row=>row.league),['nba'],id);
    const decision=createSourceEventMatcher([game('nba')])(result.observations[0],{undated:'none',externalGameId:null},at);
    assert.deepEqual(decision.match,{kind:'matched',gameId:'nba-same-teams'},id);
  }
});

test('explicit category leagues keep matching within the published competition',()=>{
  const cases:readonly (readonly [string,League])[]=[
    ['NFL','nfl'],['College Football','ncaaf'],['NBA','nba'],['WNBA','wnba'],['NHL','nhl'],['MLB','mlb'],
  ];
  for(const id of sourceIds)for(const [category,league] of cases) {
    const result=parseListings(source(id),body(id,[{category,title:'Home vs Away',teams:['Home','Away']}]),at);
    assert.equal(result.outcome,'parsed',`${id} ${category}`);
    assert.deepEqual(result.observations.map(row=>row.league),[league],`${id} ${category}`);
    if(league==='nfl'||league==='ncaaf'||league==='nba'||league==='wnba') {
      const decision=createSourceEventMatcher([game('nfl'),game('ncaaf'),game('nba'),game('wnba')])(
        result.observations[0],{undated:'none',externalGameId:null},at);
      assert.deepEqual(decision.match,{kind:'matched',gameId:`${league}-same-teams`},`${id} ${category}`);
    }
  }
});

test('generic basketball and football categories retain schedule disambiguation',()=>{
  for(const id of sourceIds)for(const [category,leagues] of [
    ['american-football',['nfl','ncaaf']],['basketball',['nba','wnba']],
  ] as const) {
    const result=parseListings(source(id),body(id,[{category,title:'Home vs Away',teams:['Home','Away']}]),at);
    assert.deepEqual(result.observations.map(row=>row.league),[null],`${id} ${category}`);
    for(const league of leagues) {
      const decision=createSourceEventMatcher([game(league)])(result.observations[0],{undated:'none',externalGameId:null},at);
      assert.deepEqual(decision.match,{kind:'matched',gameId:`${league}-same-teams`},`${id} ${league}`);
    }
    const ambiguous=createSourceEventMatcher(leagues.map(game))(result.observations[0],{undated:'none',externalGameId:null},at);
    assert.equal(ambiguous.kind,'possible',`${id} ${category}`);
    assert.equal(ambiguous.match.kind==='unmatched'&&ambiguous.match.reason,'ambiguous-matchup');
  }
});

test('SportsFeed24 category evidence survives generic Main Events groups',()=>{
  const payload=JSON.parse(body('sportsfeed24',[
    {category:'NBA',title:'Home vs Away',teams:['Home','Away']},
    {category:'Golf',title:'Other vs Away',teams:['Other','Away']},
  ]));
  for(const category of payload)category.subCategories[0].subCategoryName='Main Events';
  const result=parseListings(source('sportsfeed24'),JSON.stringify(payload),at);
  assert.deepEqual(result.observations.map(row=>({league:row.league,title:row.title})),[{league:'nba',title:'Home vs Away'}]);
});

test('SportsFeed24 combat placeholder titles match without changing listing identity',()=>{
  for(const [league,name,title] of [
    ['ufc','UFC 333: Allen vs Duncan','UFC 333 vs Live'],
    ['boxing','Floyd Schofield vs Lucas Bahdi','Floyd Schofield vs Lucas Bahdi vs Live'],
  ] as const) {
    const scheduled:Game={id:`${league}-333`,league,name,date:new Date(kickoff).toISOString(),
      combat:{eventId:'333'},status:'pre',lifecycle:'scheduled',detail:'Scheduled'};
    const observation:Observation={id:'sportsfeed24:10000',sourceId:'sportsfeed24',
      url:'https://sportsfeed24.st/fixture/UFC%20333-vs-Live',title,league,teams:null,kickoff,
      rawTime:new Date(kickoff).toUTCString(),observedAt:at,parserVersion:1};
    assert.deepEqual(matchObservation(observation,[scheduled],at),{kind:'matched',gameId:`${league}-333`});
    assert.equal(observation.title,title);
    assert.equal(matchObservation({...observation,title:title.replace('Live','Other Fighter')},[scheduled],at).kind,'unmatched');
  }
});

test('SportsFeed24 emits dated combat cards without invented teams',()=>{
  const result=parseListings(source('sportsfeed24'),body('sportsfeed24',[
    {category:'UFC',title:'UFC 333'},
    {category:'Boxing',title:'Floyd Schofield vs Lucas Bahdi'},
  ]),at);
  assert.deepEqual(result.observations.map(row=>({title:row.title,league:row.league,teams:row.teams})),[
    {title:'UFC 333 vs Live',league:'ufc',teams:null},
    {title:'Floyd Schofield vs Lucas Bahdi vs Live',league:'boxing',teams:null},
  ]);
});

test('SportsFeed24 collects its published UFC and Boxing categories',async()=>{
  const collector=createFixtureCollector();
  const endpoint=source('sportsfeed24').url;
  for(const categoryName of ['', 'NFL','NBA','NHL','MLB','F1','motogp','UFC','Boxing']) {
    const catalog=categoryName==='UFC'?JSON.parse(body('sportsfeed24',[{category:'UFC',title:'UFC 333'}]))[0]:
      categoryName==='Boxing'?JSON.parse(body('sportsfeed24',[{category:'Boxing',title:'Floyd Schofield vs Lucas Bahdi'}]))[0]:
        {categoryName:categoryName||'Streams today',subCategories:[]};
    if(categoryName==='Boxing')catalog.subCategories[0].games[0].sourceLink='https://links.totalsportek1.is/event/10001/';
    collector.enqueueFixture({url:endpoint,method:'POST',requestBody:categoryName?JSON.stringify({categoryName}):'{}',
      body:JSON.stringify(catalog)});
  }
  const listing=await collector.readHtml(endpoint,new AbortController().signal);
  assert.deepEqual(JSON.parse(listing).categories.map((category:{categoryName:string})=>category.categoryName),
    ['Streams today','NFL','NBA','NHL','MLB','F1','motogp','UFC','Boxing']);
  const parsed=collector.parseListings(source('sportsfeed24'),listing,at);
  assert.deepEqual(parsed.observations.map(row=>row.league),['ufc','boxing']);
});

test('SportsFeed24 dedicated category time wins over conflicting generic times in every order',()=>{
  const event={teamA:'Floyd Schofield',teamB:'Lucas Bahdi',matchDate:'Sun, 11 Oct 2026 07:03:17 GMT',
    sourceLink:'https://links.totalsportek1.is/floyd-schofield-vs-lucas-bahdi/76214/'};
  const today={categoryName:'Streams today',subCategories:[{subCategoryName:'Boxing',games:[event]}]};
  const anotherGeneric={categoryName:'Streams today',subCategories:[{subCategoryName:'Boxing',games:[{
    ...event,matchDate:'Sun, 11 Oct 2026 11:03:17 GMT',
  }]}]};
  const dedicated={categoryName:'Boxing',subCategories:[{subCategoryName:'Boxing',games:[{
    ...event,matchDate:'Mon, 12 Oct 2026 01:00:00 GMT',
    sourceLink:'https://totalsportek1.is/game/floyd-schofield-vs-lucas-bahdi/76214/',
  }]}]};
  for(const categories of [
    [today,anotherGeneric,dedicated],[today,dedicated,anotherGeneric],
    [anotherGeneric,today,dedicated],[anotherGeneric,dedicated,today],
    [dedicated,today,anotherGeneric],[dedicated,anotherGeneric,today],
  ]) {
    const result=parseListings(source('sportsfeed24'),JSON.stringify(categories),Date.parse('2026-10-11T16:00:00Z'));
    assert.equal(result.outcome,'parsed');
    assert.deepEqual(result.observations.map(row=>({id:row.id,title:row.title,league:row.league,kickoff:row.kickoff})),[
      {id:'sportsfeed24:76214',title:'Floyd Schofield vs Lucas Bahdi',league:'boxing',kickoff:Date.parse('2026-10-12T01:00:00Z')},
    ]);
  }
  for(const categories of [[today,anotherGeneric],[anotherGeneric,today]]) {
    const result=parseListings(source('sportsfeed24'),JSON.stringify(categories),Date.parse('2026-10-11T16:00:00Z'));
    assert.deepEqual(result,{outcome:'parser-changed',observations:[]});
  }
  for(const conflicting of [
    {...event,matchDate:'Tue, 13 Oct 2026 01:00:00 GMT'},
    {...event,teamB:'Other Fighter'},
  ]) {
    const otherDedicated={categoryName:'Boxing',subCategories:[{subCategoryName:'Boxing',games:[conflicting]}]};
    const result=parseListings(source('sportsfeed24'),JSON.stringify([dedicated,otherDedicated]),Date.parse('2026-10-11T16:00:00Z'));
    assert.deepEqual(result,{outcome:'parser-changed',observations:[]});
  }
});

