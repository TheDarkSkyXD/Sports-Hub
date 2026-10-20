import {readFileSync as readBaseline} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const baselineIndex=process.argv.indexOf('--baseline-root');
if(baselineIndex<0||!process.argv[baselineIndex+1])throw new Error('Pass --baseline-root with the original TypeScript repository snapshot.');
const baselineRoot=resolve(process.argv[baselineIndex+1]);
if(readBaseline(join(baselineRoot,'lib/football/domain/matching.ts'),'utf8').includes('createNativeMatcher'))
 throw new Error('Native results cannot replace the frozen TypeScript expectations.');
const baselineModule=relative=>import(pathToFileURL(join(baselineRoot,relative)).href);

import {writeFileSync} from 'node:fs';

const {COLLEGE_TEAM_CATALOG}=await baselineModule('lib/football/domain/college-teams.generated.ts');
const {normalizedName, createObservationMatcher, createSourceEventMatcher, createFinishedGameMatcher, mergeSchedulePartitions, detailCandidateGameIds}=await baselineModule('lib/football/domain/matching.ts');
const {feedCalendarDay,feedDateEligible,feedEligible,feedInventoryEligible,combatListingFeedEligible,feedWindow}=await baselineModule('lib/football/domain/feed-eligibility.ts');
const {detailIdentity,detailIdentityMatches,detailPolling,detailDeadline,discoveryDeadline,sourceFailure,retryDeadline}=await baselineModule('lib/football/domain/source-policy.ts');
const {recordFinal,reconcileSession,failedCandidate,nextCandidate}=await baselineModule('lib/football/domain/lifecycle.ts');
const {workingFeedOwner,workingFeedMatches,cachedFeedEligible}=await baselineModule('lib/football/domain/working-feed.ts');
const {wrestlingShowKey,wrestlingEventKey}=await baselineModule('lib/football/domain/wrestling-events.ts');
const {provisionalLiveChannel,resolvedLiveChannelMatch}=await baselineModule('lib/football/domain/live-channel.ts');
const {browserEventDeadline,browserEvidenceFresh}=await baselineModule('lib/football/domain/browser-polling.ts');
const {providerProbeIdentity}=await baselineModule('lib/playback/provider-registry.ts');
const {persistableLocator}=await baselineModule('lib/playback/persistent-locator.ts');
const {playbackResolution}=await baselineModule('lib/football/domain/playback-resolution.ts');

const now=Date.parse('2026-10-18T18:00:00Z');
const date=new Date(now).toISOString();
const team=(name,id)=>({name,short:name,abbreviation:name,id,color:'112233',score:null});
const base={id:'100',league:'nfl',name:'Away at Home',date,home:team('Home','espn:nfl:1'),away:team('Away','espn:nfl:2'),detail:'Q1',redzone:false,status:'in',lifecycle:'live',partitions:['nfl']};
const observation={id:'source:1',sourceId:'fixture',url:'https://example.test/event',title:'Away at Home',teams:['Away','Home'],league:'nfl',kickoff:now,rawTime:'',observedAt:now,parserVersion:3};
const candidate={id:'gooz-1',gameId:'100',label:'Server 1',sourceIds:['fixture'],observedAt:now,locator:{provider:'gooz',playerId:'1'}};
const cases=[];
const add=(operation,input,expected)=>cases.push({operation,input,expected});
for(const value of ['München and Köln','ＡＢＣ ﬁancée','São José State','École','Washington & Lee','  Foo-Bar  '])add('normalized',{value},normalizedName(value));
const match=(games,row=observation,at=now,mode='current',freshUntil)=>{
 const expected=createObservationMatcher(games,mode,freshUntil===undefined?undefined:()=>freshUntil)(row,at);
 add('match',{games,observation:row,now:at,mode,...(freshUntil===undefined?{}:{freshUntil})},expected);
 add('detail-candidates',{result:expected},detailCandidateGameIds(expected));
};
match([base]);
for(const change of [{teams:null},{teams:['Home','Home']},{teams:['Unknown','Home']},{league:'nba'},{kickoff:null},{kickoff:now+4*3600000},{observedAt:now+60001},{observedAt:now-1800001}])match([base],{...observation,...change});
for(const lifecycle of ['scheduled','live','unknown','final']){
 const game={...base,lifecycle,status:lifecycle==='scheduled'?'pre':lifecycle==='live'?'in':'post',...(lifecycle==='final'?{finalObservedAt:now,graceEndsAt:now+60000}:{})};
 match([game],{...observation,observedAt:now-1800001},now,'inventory-live');
 match([game],{...observation,kickoff:null});
 match([game],{...observation,observedAt:now-1800001},now,'current',now+1);
}
match([base,{...base,id:'101'}]);
for(const league of ['nba','wnba','nhl','mlb'])match([{...base,league}],{...observation,league});
match([{...base,league:'nhl',home:team('Toronto Maple Leafs','espn:nhl:21'),away:team('Montreal Canadiens','espn:nhl:10')}],{...observation,league:'nhl',teams:['Maple Leaf','Canadeins']});
const college=COLLEGE_TEAM_CATALOG.filter(row=>row.aliases.length>1).slice(0,80);
for(let i=0;i+1<college.length;i+=2){
 const [a,b]=college.slice(i,i+2),game={...base,id:`college-${i}`,league:'ncaaf',home:team(a.aliases[0],a.id),away:team(b.aliases[0],b.id)};
 match([game],{...observation,league:'ncaaf',teams:[a.aliases.at(-1),b.aliases.at(-1)]});
 match([game],{...observation,league:'ncaaf',teams:[b.aliases[0],a.aliases[0]],kickoff:null});
}
for(const league of ['f1','nascar-cup','nascar-truck','motogp','motorsport'])for(const session of ['practice','practice-1','practice-2','sprint-qualifying','sprint','qualifying','race']){
 const game={id:`${league}-1`,league,name:'Monaco Grand Prix',date,race:{eventId:'1',sessionId:'2',session,round:'Monaco'},status:'in',lifecycle:'live',detail:'Live',partitions:[league]};
 for(const title of [`Monaco ${session.replace('-',' ')}`,`Monaco FP1`,'Monaco Race','Monaco NASCAR Cup Series Race'])match([game],{...observation,league,teams:null,title});
 match([game],{...observation,league,teams:null,title:`Monaco ${session}`,kickoff:null});
}
for(const [league,name,titles] of [
 ['ufc','UFC 321: Tom Aspinall vs Ciryl Gane',['UFC 321','UFC 321 Prelims','UFC 322','Aspinall vs Gane','Tom Aspinall vs. Ciryl Gane','Gane vs Aspinall']],
 ['ufc',"Dana White's Contender Series Season 10 Week 7",["Dana White's Contender Series","Dana White's Contender Series Week 7","Dana White's Contender Series Week 8"]],
 ['boxing','BKFC 82: Dave Mundell vs Mike Richman',['BKFC 82: Mundell vs Richman','BKFC 81: Mundell vs Richman','Dave Mundell vs Mike Richman','Richman vs Mundell 2']],
]){const game={id:`${league}-1`,league,name,date,combat:{eventId:'1'},status:'in',lifecycle:'live',detail:'Live'};for(const title of titles)for(const offset of [0,90*60000,3*3600000,4*3600000])match([game],{...observation,league,teams:null,title,kickoff:now+offset});}
for(const [league,titles] of [['wwe',['WWE Monday Night Raw','Raw','WWE NXT','NXT No Mercy','WWE Friday Night SmackDown']],['tna',['TNA Impact','Impact Wrestling','TNA Bound For Glory']],['aew',['AEW Dynamite','All Elite Wrestling Collision']],['wrestling',['Independent Wrestling']]])for(const title of titles){
 const game={id:`${league}-1`,league,name:title,date,wrestling:{eventId:'1'},status:'in',lifecycle:'live',detail:'Live'};
 add('wrestling-key',{league,title,now},[wrestlingShowKey(league,title),wrestlingEventKey(league,title,now)]);
 for(const offset of [0,90*60000,91*60000])match([game],{...observation,league,teams:null,title,kickoff:now+offset});
}
for(const undated of ['none','published-listing','live-claim','retained-live-detail'])for(const externalGameId of [null,'100','101'])for(const sourceId of ['fixture','sportsurge','buffstream-nfl']){
 const row={...observation,sourceId,kickoff:null},evidence={undated,externalGameId};
 add('source-match',{games:[base],observation:row,now,evidence},createSourceEventMatcher([base])(row,evidence,now));
}
const final=recordFinal(base,now,5);
const binding={sourceId:'fixture',eventId:'event',url:observation.url,league:'nfl',teams:observation.teams,gameId:'100',observedAt:now};
for(const kickoff of [null,now])for(const expectedGameId of [undefined,'100','101']){
 const row={...observation,kickoff},matcher=createFinishedGameMatcher([final]);
 add('finished-match',{games:[final],observation:row,now,expectedGameId,bindings:[binding],eventId:'event'},[matcher.finishedGameId(row,now,expectedGameId),matcher.finishedBoundEvent(row,'event',[binding])]);
}
for(const changed of [{id:'101'},{date:new Date(now+4*3600000).toISOString()},{home:team('Other','other')},{league:'nba'},{partitions:['other']}])add('merge',{partitions:[[base],[{...base,...changed}],[base]]},mergeSchedulePartitions([[base],[{...base,...changed}],[base]]));
for(const at of [now,Date.parse('2026-03-08T07:59:59Z'),Date.parse('2026-03-08T08:00:00Z'),Date.parse('2026-11-01T06:59:59Z'),Date.parse('2026-11-01T07:00:00Z')]){
 add('calendar',{now:at},[feedCalendarDay(at),feedWindow(at)]);
 for(const offset of [-86400000,0,86400000,2*86400000])add('date-eligible',{kickoff:at+offset,now:at},feedDateEligible(at+offset,at));
}
for(const league of ['nfl','boxing','wwe'])for(const lifecycle of ['scheduled','live','unknown','final'])for(const offset of [-7,-6,0,24,48]){
 const game={...base,league,lifecycle,date:new Date(now+offset*3600000).toISOString(),...(lifecycle==='final'?{finalObservedAt:now,graceEndsAt:now+300000}:{})};
 add('eligible',{game,now},[feedEligible(game,now),feedInventoryEligible(game,now),combatListingFeedEligible(game,now)]);
}
add('identity',{observation},detailIdentity(observation));
for(const identity of [detailIdentity(observation),JSON.stringify(['fixture',observation.url,'nfl',observation.title,observation.teams,now,'18:00',3]),'[]','bad'])add('identity-match',{observation,identity},detailIdentityMatches(identity,observation));
for(const unchangedChecks of [0,2,3])for(const published of [false,true]){
 const polling={signature:'sig',unchangedChecks};
 add('detail-deadline',{at:now,polling,game:base,now,published},detailDeadline({at:now,polling,game:base,now,published}));
}
for(const observations of [[],[observation],[{...observation,kickoff:null}]])add('discovery-deadline',{at:now,observations,games:[base],leagues:['nfl'],now},discoveryDeadline(now,observations,[base],['nfl'],now));
add('polling',{observation,players:[{id:candidate.id,label:candidate.label,locator:candidate.locator}],game:base},detailPolling(undefined,observation,[{id:candidate.id,label:candidate.label,locator:candidate.locator}],base));
for(const message of ['source-page-capacity','http-403','http-404','http-429','Timeout exceeded','fetch failed','unsupported-discovery-address','response-too-large','redirect-limit','other'])add('source-failure',{message},sourceFailure(new Error(message)));
add('retry-deadline',{at:now,retryAfterMs:3600000,minimumDelayMs:300000},retryDeadline(now,3600000,300000));
const owner=workingFeedOwner(base,['nfl','nfl','other']);
add('owner',{game:base,partitions:['nfl','nfl','other']},owner);
const feed={version:2,identityHash:'a'.repeat(64),candidate,owner,checkedAt:now,proof:{kind:'advancing-video',version:1,startupMs:2000,observedMs:2000,mediaAdvanceMs:2000,presentedFrames:3}};
for(const game of [base,{...base,id:'101'},final])add('working-match',{feed,game,now},[workingFeedMatches(feed,game),cachedFeedEligible(feed,game,now)]);
let recovery={attempted:[],cooled:{},cycleStartedAt:now,failures:{}};
for(let count=0;count<5;count++){const input=recovery;recovery=failedCandidate(recovery,candidate.id,now);add('failed-candidate',{recovery:input,id:candidate.id,now},recovery);}
add('next-candidate',{candidates:[candidate],recovery:{attempted:[],cooled:{},cycleStartedAt:now,failures:{}},now},nextCandidate([candidate],{attempted:[],cooled:{},cycleStartedAt:now,failures:{}},now)??null);
for(const at of [now,now+300000]){const session={id:'11111111-1111-4111-8111-111111111111',gameId:'100',candidateId:'gooz-1',generation:0,state:'active',graceEndsAt:null};add('session',{session,game:final,now:at},reconcileSession(session,final,at));}
for(const at of [now,now+1800000,now+1800001])add('browser-fresh',{checkedAt:now,now:at},browserEvidenceFresh(undefined,now,at));
add('browser-deadline',{now},browserEventDeadline(undefined,undefined,now));
const liveObservation={...observation,sourceId:'buffstream-nfl',kickoff:null,rawTime:'2:00 pm ET'};
const liveResult={kind:'unmatched',reason:'unverified-kickoff',possibleGameIds:['100']};
add('live-channel',{observation:liveObservation,result:liveResult,games:[base],now},[provisionalLiveChannel(liveObservation,liveResult,[base],now)?.id??null,resolvedLiveChannelMatch(liveObservation,liveResult,[base],undefined,now)]);
const locators=[
 {provider:'gooz',playerId:'1'}, {provider:'streameast',channelId:'2'},
 {provider:'wikisport',section:'strm',playerId:'3'},
 {provider:'event-page',gameId:'100',eventUrl:'https://methstreams.st/event/away-home',serverUrl:'https://fxtrend.st/stream/away-home'},
 {provider:'event-page',gameId:'100',eventUrl:'https://example.test/event',serverUrl:'https://example.test/server'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://live.embedca.st/live.php?ch=es123'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://example.test/video/playlist.m3u8'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://example.test/watch?token=secret'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://sportsupa.st/event/?id=away-vs-home-123&src=best&sno=1'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://example.test:8443/watch'},
 {provider:'sportsurge-v2',eventId:'nfl:1',providerId:'a',url:'https://127.0.0.1/watch'},
 {provider:'tvapp',gameId:'100',eventUrl:'https://tvapp1.pk/watch/away-home',source:'alpha',sourceId:'123',streamNo:1,kickoff:now,title:'Away at Home',teams:['Away','Home']},
 {provider:'catalog-stream',gameId:'100',source:'streamed',eventUrl:'https://streamed.st/watch/away-home',eventId:'away-home',sourceName:'alpha',sourceId:'123',streamNo:1,kickoff:now,title:'Away at Home',teams:['Away','Home']},
 {provider:'catalog-stream',gameId:'100',source:'livesportpro',eventUrl:'https://api.kultsport.com/api/matches/all#away-home',eventId:'away-home',sourceName:'ppv:s',sourceId:'wwe/2026-10-18',streamNo:101,kickoff:now,title:'WWE Raw',teams:null},
 {provider:'streameast-server',gameId:'100',sourceEventId:'nfl:1',eventUrl:'https://v2.streameast.ga/nfl/away-home/',serverId:'1'},
];
for(const locator of locators)add('locator-policy',{locator},[providerProbeIdentity(locator),persistableLocator(locator),playbackResolution(locator)]);
writeFileSync(new URL('../tests/fixtures/rust-pipeline-domain.json',import.meta.url),JSON.stringify({version:1,cases},null,2)+'\n');
console.log(`Recorded ${cases.length} native domain parity cases.`);
