import assert from 'node:assert/strict';
import {test} from 'node:test';
import {roomSourceInventory,roomSources,sourceInventory} from '../lib/football/domain/source-inventory.ts';
import {SportsurgeCatalogSchema,StreameastCatalogSchema,type Candidate,type CandidateAvailability,type Game,type Observation} from '../lib/football/shared.ts';

const at=Date.parse('2026-10-18T18:00:00Z');
type Input=Parameters<typeof sourceInventory>[0];
const game=(index:number):Game=>({id:String(index),league:'nfl',name:`Away ${index} at Home ${index}`,
  date:new Date(at).toISOString(),status:'in',lifecycle:'live',detail:'Live',redzone:false,
  home:{name:`Home ${index}`,short:`Home ${index}`,abbreviation:`H${index}`,color:'112233'},
  away:{name:`Away ${index}`,short:`Away ${index}`,abbreviation:`A${index}`,color:'332211'}});
const candidate=(index:number,id=`server-${index}`):Candidate=>({id,gameId:String(index),label:id,
  sourceIds:['fixture'],observedAt:at,locator:{provider:'gooz',playerId:String(index)}});
const observation=(index:number):Observation=>({id:`event-${index}`,sourceId:'fixture',
  url:`https://fixture.example/event/${index}`,title:`Away ${index} at Home ${index}`,league:'nfl',
  teams:[`Away ${index}`,`Home ${index}`],kickoff:at,rawTime:'',observedAt:at,parserVersion:3});
function input(games:Game[]=[game(0)]):Input{
  return {at,revision:7,lastDiscoveryAt:at,browserCollectorsAvailable:true,
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['nfl']}],
    observations:[],games,candidates:new Map(),attempts:{},freshGameIds:new Set(games.map(game=>game.id)),
    sportsurgeCatalog:{current:null,lastComplete:null,previous:null},streameastCatalog:{current:null,lastComplete:null,previous:null}};
}

test('the direct room projector preserves literal pending and schedule states',()=>{
  const games=Array.from({length:10},(_,index)=>game(index));
  games[2]={...games[2],lifecycle:'unknown',status:'unknown'};
  const states:CandidateAvailability[]=[{kind:'unknown'},
    {kind:'checking',progress:{kind:'queued',since:at}},
    {kind:'checking',progress:{kind:'active',since:at}},
    {kind:'checking',progress:{kind:'deferred',since:at,retryAt:at+1000}},
    {kind:'unavailable',reason:'upstream',checkedAt:at,retryAt:at+1000},
    {kind:'playable',checkedAt:at,proof:{kind:'advancing-video',version:1,startupMs:3000,observedMs:3000,mediaAdvanceMs:3000,presentedFrames:4}}];
  const value:Input={...input(games),observations:[0,1,2,8].map(observation),
    freshGameIds:new Set(games.filter(game=>game.id!=='1'&&game.id!=='3').map(game=>game.id)),
    candidates:new Map(states.map((_state,index)=>[String(index+3),[candidate(index+3)]])),
    availability:row=>states[Number(row.gameId)-3]};
  const actual=roomSourceInventory(value);
  assert.deepEqual(actual.games.map(game=>({id:game.gameId,pending:game.pending})),[
    {id:'0',pending:true},{id:'1',pending:false},{id:'2',pending:false},{id:'3',pending:true},
    {id:'4',pending:true},{id:'5',pending:true},{id:'6',pending:false},{id:'7',pending:false},
    {id:'8',pending:false},{id:'9',pending:false}]);
  assert.deepEqual(actual.games[8].candidates,[{id:'server-8',gameId:'8',label:'server-8',sourceIds:['fixture'],observedAt:at,availability:states[5]}]);
  assert.deepEqual(actual,roomSources(sourceInventory(value)));
});

test('compact projection skips diagnostic history, source metadata and identity counting',()=>{
  const value:Input={...input(),candidates:new Map([['0',[candidate(0)]]]),
    get collectionHistory(){throw new Error('Diagnostic collection history was read');},
    candidateIdentity:()=>{throw new Error('Diagnostic identity counting ran');},
    sources:[{id:'fixture',url:'https://fixture.example/list',family:'fixture',leagues:['nfl'],
      get name(){throw new Error('Diagnostic source metadata was read');}}]};
  assert.deepEqual(roomSourceInventory(value),{revision:7,collecting:false,games:[{
    gameId:'0',candidates:[{id:'server-0',gameId:'0',label:'server-0',sourceIds:['fixture'],observedAt:at,
      availability:{kind:'unknown'}}],pending:true}]});
});

test('compact and full projections share candidate eligibility, availability and ordering',()=>{
  const calls={eligible:new Map<string,number>(),availability:new Map<string,number>()};
  const value:Input={...input(),candidates:new Map([['0',[candidate(0,'a'),candidate(0,'z'),candidate(0,'excluded')]],['hidden',[candidate(99)]]]),
    candidateEligible:row=>{calls.eligible.set(row.id,(calls.eligible.get(row.id)??0)+1);return row.id!=='excluded';},
    availability:row=>{calls.availability.set(row.id,(calls.availability.get(row.id)??0)+1);return {kind:'checking',progress:{kind:'queued',since:at}};},
    compareCandidates:(left,right)=>right.id.localeCompare(left.id)};
  const compact=roomSourceInventory(value);
  assert.deepEqual(compact.games[0].candidates.map(row=>row.id),['z','a']);
  assert.deepEqual([...calls.eligible],[['a',1],['z',1],['excluded',1]]);
  assert.deepEqual([...calls.availability],[['z',1],['a',1]]);
  assert.deepEqual(compact,roomSources(sourceInventory(value)));
});

for(const state of ['collecting','complete'] as const)test(`compact projection matches catalog history and dated-live fallback for ${state} runs`,()=>{
  const base=input();
  const surgeEvent={id:'nfl:1',league:'nfl',title:'Away 0 at Home 0',teams:['Away 0','Home 0'],
    url:'https://v2.sportsurge.net/watch-1-nfl-away-home/',kickoff:at,sourceStatus:'live',advertisedLinkCount:1,
    detail:{kind:'collected',at:at-1000,providers:[]}};
  const eastEvent={id:'nfl:1',league:'nfl',title:'Away 0 at Home 0',teams:['Away 0','Home 0'],
    url:'https://v2.streameast.ga/nfl/away-vs-home/',kickoff:at,espnEventId:null,
    detail:{kind:'collected',at:at-1000,publication:{premium:0,unknown:0},servers:[]}};
  const catalog={runId:'11111111-1111-4111-8111-111111111111',sequence:0,startedAt:at-1000,
    state:{kind:'complete',at:at-1000},categories:{nfl:{kind:'collected',at:at-1000},ncaaf:{kind:'pending'}},rejectedGames:[]};
  const surge=SportsurgeCatalogSchema.parse({...catalog,events:[surgeEvent],catalogIssues:[]});
  const east=StreameastCatalogSchema.parse({...catalog,events:[eastEvent]});
  const current={...catalog,runId:'22222222-2222-4222-8222-222222222222',startedAt:at,
    state:state==='collecting'?{kind:state}:{kind:state,at},categories:{nfl:{kind:'collected',at},ncaaf:{kind:'pending'}}};
  const value:Input={...base,sources:[...base.sources,
    {id:'sportsurge-v2',url:'https://v2.sportsurge.net/watch-nfl-streams/',family:'sportsurge',kind:'browser-catalog',leagues:['nfl']},
    {id:'streameast',url:'https://v2.streameast.ga/nfl-streams/',family:'streameast',kind:'browser-catalog',leagues:['nfl']}],
    sportsurgeCatalog:{current:{catalog:SportsurgeCatalogSchema.parse({...current,catalogIssues:[],events:state==='collecting'?[{...surgeEvent,kickoff:null,detail:{kind:'pending'}}]:[]}),receivedAt:at},
      previous:{catalog:surge,receivedAt:at-1000},lastComplete:{catalog:surge,receivedAt:at-1000}},
    streameastCatalog:{current:{catalog:StreameastCatalogSchema.parse({...current,events:state==='collecting'?[{...eastEvent,kickoff:null,detail:{kind:'pending'}}]:[]}),receivedAt:at},
      previous:{catalog:east,receivedAt:at-1000},lastComplete:{catalog:east,receivedAt:at-1000}}};
  const compact=roomSourceInventory(value);
  assert.deepEqual(compact,{revision:7,collecting:state==='collecting',games:[{gameId:'0',candidates:[],pending:state==='collecting'}]});
  assert.deepEqual(compact,roomSources(sourceInventory(value)));
});
