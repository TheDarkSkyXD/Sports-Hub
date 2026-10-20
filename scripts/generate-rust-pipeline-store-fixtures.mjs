import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const baselineRoot=process.argv[process.argv.indexOf('--baseline-root')+1];
if(!process.argv.includes('--baseline-root')||!baselineRoot)throw new Error('Pass --baseline-root with the original TypeScript repository snapshot. The native implementation must not generate its own parity expectations.');
const {FootballStore}=await import(pathToFileURL(join(baselineRoot,'lib/football/adapters/store.ts')).href);
const {parseScoreboard}=await import(pathToFileURL(join(baselineRoot,'lib/sunday.ts')).href);

const directory=mkdtempSync(join(tmpdir(),'rust-store-fixtures-'));
const store=new FootballStore(join(directory,'state.sqlite'));
const at=Date.parse('2026-10-08T22:00:00Z');
const team=name=>({name,short:name,abbreviation:name.slice(0,3),color:'123456',score:null});
const game={id:'12345',league:'nfl',name:'Chicago Bears at Green Bay Packers',date:new Date(at).toISOString(),
  home:team('Green Bay Packers'),away:team('Chicago Bears'),detail:'Final',redzone:false,status:'post',lifecycle:'final',
  finalObservedAt:at,graceEndsAt:at+86400000,partitions:['nfl']};
const observation={id:'observation-1',sourceId:'sportsurge',url:'https://example.com/game',title:game.name,
  league:'nfl',teams:['Chicago Bears','Green Bay Packers'],kickoff:at,rawTime:'',observedAt:at,parserVersion:1};
const match={kind:'matched',gameId:game.id};
const identityHash='a'.repeat(64);
const candidate={id:'candidate-1',gameId:game.id,label:'Player 1',sourceIds:['sportsurge'],observedAt:at,
  locator:{provider:'gooz',playerId:'1'}};
const owner={league:'nfl',home:{name:game.home.name},away:{name:game.away.name},partitionIds:['nfl']};
const working={version:1,identityHash,candidate,owner,checkedAt:at,proof:'decoded'};
const steps=[];
function call(operation,...args) {
  const value=store[operation](...args);
  steps.push({operation,args,expected:value??null});
}
try {
  call('finishedGameRetentionMinutes');
  call('savePartition','nfl',{games:[game],at,week:5});
  call('partition','nfl');
  call('savePartition','nfl',{games:[game],at:at+100000,week:5});
  call('finals');
  call('setFinishedGameRetentionMinutes',60);
  call('partition','nfl');
  call('finals');
  call('observe',observation,match);
  call('observation',observation.id);
  call('observations');
  call('saveListingAttempt','sportsurge',{at,outcome:'parsed',count:1,failures:0,nextEligibleAt:at+300000},
    [{observation,result:match}],[]);
  call('sourceAttempts');
  call('collectionHistory',at+1);
  call('saveDetailEvidence',{outcome:'unresolved',observationId:observation.id,generation:'generation-1',at,
    reason:'not-yet-published',failures:0,nextEligibleAt:at+300000});
  call('detailEvidence');
  call('replaceWorkingIdentity',game.id,identityHash,[working]);
  call('workingFeeds');
  call('saveFeedCheck',{version:1,gameId:game.id,gameDate:game.date,identityHash,owner,
    outcome:{kind:'unavailable',checkedAt:at+1,retryAt:at+60000,reason:'invalid-media'}});
  call('workingFeeds');
  call('feedChecks',at+2);
  call('replaceWorkingIdentity',game.id,identityHash,[{...working,checkedAt:at+2}]);
  call('feedChecks',at+3);
  call('workingFeeds');
  call('replaceWorkingIdentity',game.id,identityHash,[]);
  call('workingFeeds');
  for(const source of ['Sportsurge','Streameast']) {
    const catalog={runId:'11111111-1111-4111-8111-111111111111',sequence:1,startedAt:at,state:{kind:'complete',at},
      categories:{nfl:{kind:'collected',at},ncaaf:{kind:'collected',at}},events:[],rejectedGames:[],
      ...(source==='Sportsurge'?{catalogIssues:[]}:{})};
    call(`save${source}Catalog`,{catalog,receivedAt:at},[]);
    call(`${source.toLowerCase()}Catalog`);
    call(`save${source}Catalog`,{catalog:{...catalog,runId:'22222222-2222-4222-8222-222222222222',
      startedAt:at+1,state:{kind:'collecting'},categories:{nfl:{kind:'failed',at:at+1,reason:'blocked'},ncaaf:{kind:'pending'}}},receivedAt:at+1},[]);
    call(`save${source}Catalog`,{catalog:{...catalog,runId:'33333333-3333-4333-8333-333333333333',
      startedAt:at+2,state:{kind:'collecting'},categories:{nfl:{kind:'pending'},ncaaf:{kind:'pending'}}},receivedAt:at+2},[]);
    call(`${source.toLowerCase()}Catalog`);
  }
  call('sourceAttempts');
  call('collectionHistory',at+3);
  call('saveMembership',{season:2026,at,teams:{'123':'fbs','456':'fcs'}});
  call('membership',2026);
  call('membership',2025);
  call('alias','legacy-id','12345');
  call('aliases');
  call('alias','legacy-id','54321');
  call('alias','legacy-id','12345');
  call('aliases');
  call('sportsurgeCatalog');
  call('streameastCatalog');
  call('workingFeeds');
  call('feedChecks',at);
  call('removeFinalEvidence',[game.id],at+3600001);
  call('observations');
  call('sweep',at+8*86400000);
  call('observations');
  call('sourceEventBindings');
  const scoreboards=[];
  const event={id:'9',name:'Away at Home',date:new Date(at).toISOString(),season:{year:2026},
    status:{type:{state:'in',shortDetail:'Q2'}},competitions:[{competitors:[
      {id:'a',homeAway:'away',team:{id:'2',displayName:'Away',name:'Away',abbreviation:'AWY',color:'ffffff'}},
      {id:'h',homeAway:'home',score:'7',team:{id:'1',displayName:'Home',name:'Home',abbreviation:'HME',color:'000000'}},
    ],situation:{isRedZone:true,possession:'h'},broadcasts:[{names:['ESPN','ABC']}],venue:{fullName:'Stadium'}}]};
  for(const league of ['nfl','ncaaf','nba','wnba','nhl','mlb'])for(const status of [
    {state:'in',shortDetail:'Q2'},{state:'pre',name:'STATUS_SCHEDULED',shortDetail:'TBD'},
    {state:'pre',name:'STATUS_SCHEDULED',shortDetail:'10/8 6:00 PM'},{state:'post',name:'STATUS_FINAL',completed:true,shortDetail:'Final'},
    {state:'post',name:'STATUS_FINAL',completed:false,shortDetail:'Final'},
  ]) {const data={events:[{...event,status:{type:status}}],week:{number:5}};scoreboards.push({data,league,expected:parseScoreboard(data,league)});}
  for(const league of ['f1','nascar-cup','nascar-truck']) {
    const data={events:[{id:'88',name:'Grand Prix at Austin',circuit:{fullName:'Circuit of the Americas',address:{city:'Austin'}},season:{year:2026},
      competitions:[{id:'99',date:new Date(at).toISOString(),type:{abbreviation:'Race'},status:{type:{state:'pre',name:'STATUS_SCHEDULED'}},broadcasts:[{names:['ESPN']}]}]}]};
    scoreboards.push({data,league,expected:parseScoreboard(data,league)});
  }
  const ufc={events:[{id:'123',name:'UFC 325',date:new Date(at).toISOString(),status:{type:{state:'pre',name:'STATUS_SCHEDULED'}},competitions:[]},
    {id:'124',name:'Other MMA',date:new Date(at).toISOString(),competitions:[]}]};
  scoreboards.push({data:ufc,league:'ufc',expected:parseScoreboard(ufc,'ufc')});
  writeFileSync(new URL('../tests/fixtures/rust-pipeline-store.json',import.meta.url),JSON.stringify({steps,scoreboards},null,2)+'\n');
} finally {store.close();rmSync(directory,{recursive:true,force:true});}
