import assert from 'node:assert/strict';
import {mock,test} from 'node:test';
import {parseScoreboard} from '../lib/sunday.ts';
import {BoardSchema,CandidateLocatorSchema,GameSchema,isMotorsportsLeague,type Observation,type RaceGame} from '../lib/football/shared.ts';
import {SCHEDULES,readSchedule} from '../lib/football/adapters/schedule.ts';
import {SOURCES,compatiblePlayers,parseListings} from '../lib/football/adapters/sources.ts';
import {matchObservation} from '../lib/football/domain/matching.ts';
import {validEventPagePair} from '../lib/playback/providers/event-page-policy.ts';

const now=Date.parse('2026-10-08T12:00:00Z');
const times=['2026-10-09T08:30:00Z','2026-10-09T12:30:00Z','2026-10-10T09:00:00Z',
  '2026-10-10T13:00:00Z','2026-10-11T12:00:00Z'];
const codes=['FP1','SS','SR','Qual','Race'];
const sessionIds=['401839113','401839114','401839115','401839116','401839117'];
const scheduled={name:'STATUS_SCHEDULED',state:'pre',completed:false,shortDetail:'Scheduled'};
const weekend={events:[{id:'600057445',name:'Singapore Airlines Singapore Grand Prix',season:{year:2026},
  circuit:{fullName:'Marina Bay Street Circuit',address:{city:'Singapore'}},
  competitions:codes.map((abbreviation,index)=>({id:sessionIds[index],date:times[index],
    type:{abbreviation},status:{type:scheduled},broadcasts:[{names:['Apple TV']}]}))}]};
const games=parseScoreboard(weekend,'f1');
function race(index:number):RaceGame {
  const game=games[index];
  assert.equal(game.league,'f1');
  return game;
}
function observation(title:string,kickoff:number,league:Observation['league']='f1'):Observation {
  return {id:`ppv:${title}`,sourceId:'ppv',url:'https://ppv.st/live/f1/2026/singapore/fp1',title,
    league,teams:null,kickoff,rawTime:new Date(kickoff).toISOString(),observedAt:now,parserVersion:2};
}

test('ESPN weekend expands each competition and keeps old board v2 matchups readable',()=>{
  assert.deepEqual(games.map(game=>game.id),sessionIds.map(id=>`f1-${id}`));
  assert.deepEqual(games.map(game=>game.league==='f1'?game.race.session:null),
    ['practice-1','sprint-qualifying','sprint','qualifying','race']);
  assert.deepEqual(games.map(game=>game.date),times);
  assert.equal(race(0).race.circuit,'Marina Bay Street Circuit');
  assert.equal(race(0).race.round,'Singapore');
  assert.equal(race(0).broadcast,'Apple TV');
  assert.equal(GameSchema.safeParse({...race(0),home:{name:'Fake'}}).success,false);
  const team={name:'Chicago Bears',short:'Bears',abbreviation:'CHI',color:'112233',score:null};
  const matchup={id:'123',league:'nfl',name:'Bears at Packers',home:team,away:{...team,name:'Green Bay Packers'},
    lifecycle:'scheduled',status:'pre',detail:'Scheduled',redzone:false};
  const board=BoardSchema.parse({schemaVersion:2,revision:1,updatedAt:times[0],scheduleState:'ready',
    aliases:{},games:[matchup],leagues:{nfl:{scoresAt:null,sourceAt:null,errors:[]},ncaaf:{scoresAt:null,sourceAt:null,errors:[]}}});
  assert.equal(board.games[0].id,'123');
  assert.deepEqual(board.leagues.f1,{scoresAt:null,sourceAt:null,errors:[]});
});
test('daily ESPN repeats merge into five sessions without one-event completeness false positives',async()=>{
  const fetchMock=mock.method(globalThis,'fetch',async()=>Response.json(weekend));
  try{
    const partition=SCHEDULES.find(source=>source.id==='f1');
    assert.ok(partition);
    const result=await readSchedule(partition,now,new AbortController().signal);
    assert.deepEqual(result.games.map(game=>game.id),sessionIds.map(id=>`f1-${id}`));
    assert.deepEqual(result.horizonErrors,undefined);
  }finally{fetchMock.mock.restore();}
});

test('F1 match requires the same round, session, sport, and published start',()=>{
  const fp1=Date.parse(times[0]);
  assert.deepEqual(matchObservation(observation('Singapore Grand Prix - Practice',fp1),games,now),
    {kind:'matched',gameId:'f1-401839113'});
  for(const candidate of [
    observation('Singapore Grand Prix - Practice',Date.parse(times[1])),
    observation('Singapore Grand Prix - Sprint',fp1),
    observation('Monaco Grand Prix - Practice',fp1),
    observation('Singapore Grand Prix - Practice',fp1,'nascar-cup'),
    {...observation('Singapore Grand Prix - Practice',fp1),kickoff:null},
    observation('Singapore Grand Prix weekend',fp1),
  ])assert.equal(matchObservation(candidate,games,now).kind,'unmatched');
});

test('NASCAR matches the verified Charlotte hour offset without accepting stale or cross-series links',()=>{
  const cup=parseScoreboard({events:[{id:'202610110021',name:'NASCAR Cup Series at Charlotte',
    competitions:[{id:'202610110021',date:'2026-10-11T19:00:00Z',status:{type:scheduled}}]}]},'nascar-cup');
  const truck=parseScoreboard({events:[{id:'202610094261',name:'NASCAR Truck Series at Charlotte',
    competitions:[{id:'202610094261',date:'2026-10-09T21:00:00Z',status:{type:scheduled}}]}]},'nascar-truck');
  const listing=observation('2026 NASCAR Cup Series Playoff at Charlotte Road Course',Date.parse('2026-10-11T20:00:00Z'),'nascar-cup');
  assert.deepEqual(matchObservation(listing,[...cup,...truck],now),{kind:'matched',gameId:'nascar-cup-202610110021'});
  for(const changed of [
    {...listing,kickoff:Date.parse('2026-10-11T08:45:00Z')},
    {...listing,title:'NASCAR Cup Series at Indianapolis'},
    {...listing,league:'nascar-truck' as const},
  ])assert.equal(matchObservation(changed,[...cup,...truck],now).kind,'unmatched');
});

const ppvSource=SOURCES.find(source=>source.id==='ppv');
assert.ok(ppvSource);
const ppvEvent={id:29979,name:'Singapore Grand Prix - Practice 1',tag:'Formula 1',
  uri_name:'f1/2026/singapore/fp1',starts_at:1791534600,
  iframe:'https://embedindia.st/embed/f1/2026/singapore/fp1',source_tag:'Apple TV',
  substreams:[{id:29980,name:'Singapore Grand Prix - Practice 1',tag:'Formula 1',
    uri_name:'singapore-grand-prix---practice-1-29980',source_tag:'Apple TV (F1TV)',
    iframe:'https://embedindia.st/embed/singapore-grand-prix---practice-1-29980'}]};
test('PPV F1 catalog and verified main and alternate players retain their exact session',()=>{
  const catalog=JSON.stringify({success:true,streams:[{category:'Motorsports',streams:[ppvEvent]}]});
  const listed=parseListings(ppvSource,catalog,now);
  assert.equal(listed.outcome,'parsed');
  assert.equal(listed.observations.length,1);
  assert.equal(listed.observations[0].teams,null);
  assert.deepEqual(matchObservation(listed.observations[0],games,now),{kind:'matched',gameId:'f1-401839113'});
  const players=compatiblePlayers('f1-401839113',listed.observations[0],JSON.stringify(ppvEvent));
  assert.deepEqual(players.map(player=>player.locator.provider==='event-page'?player.locator.serverUrl:''),
    [ppvEvent.iframe,ppvEvent.substreams[0].iframe]);
  for(const changed of [
    'https://embedindia.st/embed/f1/2026/singapore/race',
    'https://embedindia.st/embed/monaco-grand-prix---practice-1-29980',
    'https://embedindia.st/embed/singapore-grand-prix---race-29980',
    'https://embedindia.st/embed/247-sky-sports-f1',
    'https://embedindia.st.evil.test/embed/f1/2026/singapore/fp1',
  ])assert.equal(validEventPagePair(listed.observations[0].url,changed),false);
});

function listing(){return `<section class="lg" id="g-lg-f1-20261009">
  <a class="ev ev-plain" href="/event/m-f1-singapore-gp" title="Singapore Grand Prix - Practice" data-start="1791534600"><img alt="Formula 1"></a>
  </section><section class="lg" id="g-cat-motogp-20261009">
  <a class="ev ev-plain" href="/event/m-motogp-indonesia-gp" title="Indonesian Grand Prix MotoGP - Practice" data-start="1791529200"><img alt="MotoGP"></a>
  </section><section class="lg" id="g-cat-motorsport-20261009">
  <a class="ev ev-plain" href="/event/mount-panorama-free-practice-4" title="Mount Panorama — Free Practice 4" data-start="${Date.parse('2026-10-09T02:15:00Z')/1000}"><img alt="Motorsport"></a>
  </section><section class="lg" id="g-lg-nascar-truck-20261009">
  <a class="ev ev-plain" href="/event/2026-truck-playoff-at-charlotte-road-course" title="2026 Truck Playoff at Charlotte Road Course" data-start="1791583200"><img alt="NASCAR Truck Series"></a>
  </section><section class="lg" id="g-lg-nascar-premier-20261011">
  <a class="ev ev-plain" href="/event/2026-nascar-cup-series-playoff-at-charlotte-road-course" title="2026 NASCAR Cup Series Playoff at Charlotte Road Course" data-start="${Date.parse('2026-10-11T20:00:00Z')/1000}"><img alt="NASCAR Cup Series"></a>
  </section>`;}
test('Methstreams and Crackstreams timed listings classify five race series by their published sections',()=>{
  for(const sourceId of ['methstreams-f1','crackstreams-f1']){
    const source=SOURCES.find(row=>row.id===sourceId);
    assert.ok(source);
    const result=parseListings(source,listing(),now);
    assert.equal(result.outcome,'parsed');
    assert.deepEqual(result.observations.map(row=>row.league),['f1','motogp','motorsport','nascar-truck','nascar-cup']);
    assert.ok(result.observations.every(row=>row.teams===null&&row.kickoff!==null));
    const practice=result.observations[0];
    const detail=`<link rel="canonical" href="${practice.url}"><meta property="og:url" content="${practice.url}">
      <script type="application/ld+json">${JSON.stringify({'@type':'SportsEvent',url:practice.url,name:practice.title,
        startDate:'2026-10-09T08:30:00+00:00',sport:'Formula 1',performer:[{name:practice.title}],offers:{price:'0'}})}</script>
      <a class="sl-row" href="https://fxtrend.st/event/m-f1-singapore-gp" aria-label="Watch Singapore Grand Prix - Practice on Main 1 — opens the player in a new tab"><span class="sl-nm">Main 1</span></a>`;
    assert.equal(compatiblePlayers('f1-401839113',practice,detail).length,1);
    assert.equal(validEventPagePair(practice.url,'https://fxtrend.st/event/m-f1-singapore-gp'),true);
    assert.equal(validEventPagePair(practice.url,'https://fxtrend.st/event/singapore-grand-prix-sprint'),false);
    assert.deepEqual(compatiblePlayers('f1-401839113',practice,detail.replace('sport":"Formula 1','sport":"NASCAR')),[]);
  }
});

test('every race series produces a schema-valid event-page player only for its published sport',()=>{
  const sports={f1:'Formula 1',motogp:'MotoGP',motorsport:'Motorsport',
    'nascar-truck':'NASCAR Truck Series','nascar-cup':'NASCAR Cup Series'} as const;
  for(const sourceId of ['methstreams-f1','crackstreams-f1']){
    const source=SOURCES.find(row=>row.id===sourceId);
    assert.ok(source);
    const observations=parseListings(source,listing(),now).observations;
    for(const observation of observations){
      if(!observation.league||!isMotorsportsLeague(observation.league)||observation.kickoff===null)
        throw new Error('Race listing lacks series or start');
      const sport=sports[observation.league];
      const gameId=`${observation.league}-12345`;
      const serverUrl=`https://fxtrend.st${new URL(observation.url).pathname}`;
      const detail=`<link rel="canonical" href="${observation.url}"><meta property="og:url" content="${observation.url}">
        <script type="application/ld+json">${JSON.stringify({'@type':'SportsEvent',url:observation.url,
          name:observation.title,startDate:new Date(observation.kickoff).toISOString(),sport,
          performer:[{name:observation.title}],offers:{price:'0'}})}</script>
        <a class="sl-row" href="${serverUrl}" aria-label="Watch ${observation.title} on Main 1 — opens the player in a new tab"><span class="sl-nm">Main 1</span></a>`;
      const players=compatiblePlayers(gameId,observation,detail);
      assert.equal(players.length,1,`${sourceId} ${observation.league}`);
      const locator=CandidateLocatorSchema.parse(players[0].locator);
      assert.equal(locator.provider,'event-page');
      if(locator.provider!=='event-page')throw new Error('Unexpected player locator');
      assert.equal(locator.gameId,gameId);
      assert.equal(validEventPagePair(observation.url,serverUrl),true);
      assert.deepEqual(compatiblePlayers(gameId,observation,detail.replace(`"sport":"${sport}"`,'"sport":"Other Series"')),[]);
    }
  }
});

test('source-backed MotoGP and Motorsport schedules deduplicate providers and preserve Practice 4',async()=>{
  const fetched:string[]=[];
  const fetchMock=mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    fetched.push(String(url));
    return new Response(listing(),{status:200});
  });
  try{
    const signal=new AbortController().signal;
    const motogp=SCHEDULES.find(source=>source.id==='motogp');
    const motorsport=SCHEDULES.find(source=>source.id==='motorsport');
    assert.ok(motogp&&motorsport);
    const [moto,other]=await Promise.all([readSchedule(motogp,now,signal),readSchedule(motorsport,now,signal)]);
    assert.deepEqual(fetched.sort(),['https://crackstreams.st/F1','https://methstreams.st/F1']);
    assert.equal(moto.games.length,1);
    assert.equal(moto.games[0].league,'motogp');
    assert.equal(moto.games[0].league==='motogp'?moto.games[0].race.session:null,'practice');
    assert.equal(other.games.length,1);
    assert.equal(other.games[0].league==='motorsport'?other.games[0].race.session:null,'practice-4');
  }finally{fetchMock.mock.restore();}
});

test('failed or cancelled shared catalog reads allow the next refresh to recover',async()=>{
  const motogp=SCHEDULES.find(source=>source.id==='motogp');
  const motorsport=SCHEDULES.find(source=>source.id==='motorsport');
  assert.ok(motogp&&motorsport);
  let fail=true;
  const fetchMock=mock.method(globalThis,'fetch',async()=>{
    if(fail)throw new Error('catalog unavailable');
    return new Response(listing(),{status:200});
  });
  try{
    const failed=new AbortController();
    await assert.rejects(readSchedule(motogp,now+1000,failed.signal),/source-schedule-unavailable/);
    fail=false;
    const cancelled=new AbortController();
    const pending=readSchedule(motorsport,now+2000,cancelled.signal);
    cancelled.abort();
    await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');
    const next=new AbortController();
    const recovered=await readSchedule(motorsport,now+3000,next.signal);
    assert.equal(recovered.games.length,1);
  }finally{fetchMock.mock.restore();}
});

test('paired transient motorsports timeouts recover both shared schedules',async()=>{
  const calls=new Map<string,number>();
  const fetchMock=mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    const key=String(url),attempt=(calls.get(key)||0)+1;
    calls.set(key,attempt);
    if(attempt===1)throw new DOMException('Timed out','TimeoutError');
    return new Response(listing(),{status:200});
  });
  try{
    const motogp=SCHEDULES.find(source=>source.id==='motogp');
    const motorsport=SCHEDULES.find(source=>source.id==='motorsport');
    assert.ok(motogp&&motorsport);
    const signal=new AbortController().signal;
    const [moto,other]=await Promise.all([readSchedule(motogp,now+4000,signal),readSchedule(motorsport,now+4000,signal)]);
    assert.deepEqual([moto.games.map(game=>game.league),other.games.map(game=>game.league)],[['motogp'],['motorsport']]);
    assert.deepEqual([...calls.entries()].sort(),[
      ['https://crackstreams.st/F1',2],['https://methstreams.st/F1',2],
    ]);
  }finally{fetchMock.mock.restore();}
});

test('one timed-out provider retries without fetching a healthy provider again',async()=>{
  const calls=new Map<string,number>();
  const fetchMock=mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    const key=String(url),attempt=(calls.get(key)||0)+1;
    calls.set(key,attempt);
    if(key==='https://methstreams.st/F1'&&attempt===1)throw new DOMException('Timed out','TimeoutError');
    return new Response(listing(),{status:200});
  });
  try{
    const motogp=SCHEDULES.find(source=>source.id==='motogp');
    assert.ok(motogp);
    const result=await readSchedule(motogp,now+5000,new AbortController().signal);
    assert.deepEqual(result.games.map(game=>game.league),['motogp']);
    assert.deepEqual([...calls.entries()].sort(),[
      ['https://crackstreams.st/F1',1],['https://methstreams.st/F1',2],
    ]);
  }finally{fetchMock.mock.restore();}
});

test('repeated motorsports timeouts keep the schedule unavailable',async()=>{
  const calls=new Map<string,number>();
  const fetchMock=mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    const key=String(url);
    calls.set(key,(calls.get(key)||0)+1);
    throw new DOMException('Timed out','TimeoutError');
  });
  try{
    const motorsport=SCHEDULES.find(source=>source.id==='motorsport');
    assert.ok(motorsport);
    await assert.rejects(readSchedule(motorsport,now+6000,new AbortController().signal),/source-schedule-unavailable/);
    assert.deepEqual([...calls.entries()].sort(),[
      ['https://crackstreams.st/F1',2],['https://methstreams.st/F1',2],
    ]);
  }finally{fetchMock.mock.restore();}
});

test('parent cancellation does not retry motorsports timeouts',async()=>{
  const controller=new AbortController(),calls=new Map<string,number>();
  const fetchMock=mock.method(globalThis,'fetch',async(url:RequestInfo|URL)=>{
    const key=String(url);
    calls.set(key,(calls.get(key)||0)+1);
    controller.abort();
    throw new DOMException('Timed out','TimeoutError');
  });
  try{
    const motogp=SCHEDULES.find(source=>source.id==='motogp');
    assert.ok(motogp);
    await assert.rejects(readSchedule(motogp,now+7000,controller.signal),error=>error instanceof Error&&error.name==='AbortError');
    assert.ok(calls.size >= 1);
    assert.ok([...calls.values()].every(count => count === 1));
  }finally{fetchMock.mock.restore();}
});
