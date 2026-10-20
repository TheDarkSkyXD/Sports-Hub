import {readFileSync as readBaseline} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const baselineIndex=process.argv.indexOf('--baseline-root');
if(baselineIndex<0||!process.argv[baselineIndex+1])throw new Error('Pass --baseline-root with the original TypeScript repository snapshot.');
const baselineRoot=resolve(process.argv[baselineIndex+1]);
if(readBaseline(join(baselineRoot,'lib/football/domain/matching.ts'),'utf8').includes('createNativeMatcher'))
 throw new Error('Native results cannot replace the frozen TypeScript expectations.');
const baselineModule=relative=>import(pathToFileURL(join(baselineRoot,relative)).href);

import {writeFile} from 'node:fs/promises';

const browser=await baselineModule('lib/football/domain/browser-polling.ts');
const {sportsurgeEventCandidates}=await baselineModule('lib/football/domain/sportsurge-catalog.ts');

const at=Date.parse('2026-10-19T18:00:00Z');
const team=name=>({name,short:name,abbreviation:name,color:'112233',score:'0'});
const game={id:'100',league:'nfl',name:'Away at Home',date:new Date(at).toISOString(),home:team('Home'),away:team('Away'),status:'in',lifecycle:'live',detail:'',redzone:false,partitions:['nfl']};
const surge={id:'nfl:1',url:'https://v2.sportsurge.net/watch-1-nfl-away-vs-home/',league:'nfl',title:game.name,teams:['Away','Home'],kickoff:at,sourceStatus:'live',advertisedLinkCount:1,detail:{kind:'collected',at,providers:[{id:'p1',label:'Player',observedAt:at,destination:{kind:'link',url:'https://sportsupa.st/event/?id=away-vs-home-1&src=best&sno=1'}}]}};
const east={id:'nfl:1',url:'https://v2.streameast.ga/nfl/away-vs-home/',league:'nfl',title:game.name,teams:['Away','Home'],kickoff:at,espnEventId:'100',detail:{kind:'collected',at,servers:[{id:'1',label:'Server 1',url:'https://v2.streameast.ga/nfl/away-vs-home/1',availability:{kind:'free-channel',channelId:'1'}}]}};
const cases=[];
const add=(operation,args)=>cases.push({operation,args:JSON.parse(JSON.stringify(args)),expected:browser[operation](...args)});
for(const event of [surge,east]) {
  add('browserPublicationIdentity',[event]);
  add('browserObservation',[event,at]);
  for(const detail of [event.detail,{kind:'pending'},{kind:'failed',at,reason:'timeout'}]) {
    const row={...event,detail};
    add('browserPollingSignature',[row,browser.browserObservation(row,at),game]);
    add('browserPollingSignature',[row,browser.browserObservation(row,at),undefined]);
  }
  const publication={players:sportsurgeEventCandidates(surge,game.id).map(({id,label,locator})=>({id,label,locator})),event:{gameId:game.id,date:game.date}};
  const success={identity:browser.browserPublicationIdentity(event),at,count:1,publication};
  for(const delta of [-60001,-60000,0,1800000,1860000,1860001,3600000,3600001]) {
    const detail={observationId:`${'sourceStatus' in event?'sportsurge-v2':'streameast'}:${event.url}`,generation:'g',at,nextEligibleAt:at+1800000,outcome:'resolved',players:[],lastSuccess:success};
    add('retainedBrowserPublication',[event,at,detail,game,at+delta]);
    add('retainedBrowserPublication',[event,at,{...detail,lastSuccess:{...success,identity:'different'}},game,at+delta]);
  }
  for(const category of [{kind:'pending'},{kind:'failed',at,reason:'timeout'},{kind:'collected',at}]) for(const delta of [0,1800001]) {
    const catalog={runId:'run',sequence:0,startedAt:at,state:{kind:'collecting'},categories:{nfl:category},events:[event],rejectedGames:[],...('sourceStatus' in event?{catalogIssues:[]}:{})};
    add('browserCategoryDeadline',[catalog,'nfl',[game],at+delta]);
  }
}
await writeFile(new URL('../tests/fixtures/rust-browser.json',import.meta.url),JSON.stringify({cases},null,2)+'\n');
