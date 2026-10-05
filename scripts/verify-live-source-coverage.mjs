import {BoardSchema,SourcesSnapshotSchema} from '../lib/football/shared.ts';

const originArg=process.argv.find(value=>value.startsWith('--origin='))?.slice(9)||'http://127.0.0.1:3000';
const origin=new URL(originArg);
if(origin.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
  throw new Error('Use a local app origin without a path or credentials.');
const check=process.argv.includes('--check');
const targetWorkingChoices=4;
const waitMs=Number(process.argv.find(value=>value.startsWith('--wait-ms='))?.slice(10)||0);
if(!Number.isInteger(waitMs)||waitMs<0||waitMs>120_000)throw new Error('wait-ms must be an integer between 0 and 120000.');
async function read() {
  const [boardResponse,sourcesResponse]=await Promise.all(['/api/games','/api/sources'].map(path=>
    fetch(new URL(path,origin),{cache:'no-store',signal:AbortSignal.timeout(30_000)})));
  if(!boardResponse.ok||!sourcesResponse.ok)throw new Error(`App API returned ${boardResponse.status}/${sourcesResponse.status}.`);
  return {board:BoardSchema.parse(await boardResponse.json()),sources:SourcesSnapshotSchema.parse(await sourcesResponse.json())};
}
function subdivision(game) {
  if(game.partitions?.includes('fbs'))return 'fbs';
  if(game.partitions?.includes('fcs'))return 'fcs';
  return game.home.membership?.subdivision||game.away.membership?.subdivision||'unclassified';
}
function rows(snapshot) {
  const byGame=new Map(snapshot.sources.games.map(game=>[game.gameId,game]));
  return snapshot.board.games.filter(game=>game.league==='ncaaf'&&['live','scheduled'].includes(game.lifecycle)).map(game=>{
    const row=byGame.get(game.id),candidates=row?.candidates||[];
    return {id:game.id,name:game.name,subdivision:subdivision(game),state:game.lifecycle,kickoff:game.date||null,
      listedSources:row?.sourceCount||0,freeChoices:row?.freeChoiceCount||0,workingChoices:row?.workingChoiceCount||0,
      sharedPublishedRoutes:row?.sharedRoutes.length||0,
      choices:candidates.map(candidate=>({id:candidate.id,label:candidate.label,sourceIds:candidate.sourceIds,availability:candidate.availability})),
      listingEvidence:(row?.sourceLinks||[]).map(link=>({sourceId:link.sourceId,evidence:link.evidence})),
    };
  });
}
const started=Date.now();
let snapshot=await read();
const initial=rows(snapshot),live=initial.filter(game=>game.state==='live').sort((a,b)=>b.freeChoices-a.freeChoices);
const targets=[...live.filter(game=>game.subdivision==='fbs').slice(0,2),...live.filter(game=>game.subdivision==='fcs').slice(0,2)];
for(const game of live)if(targets.length<4&&!targets.some(target=>target.id===game.id))targets.push(game);
if(check&&targets.length) {
  const response=await fetch(new URL('/api/sources',origin),{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({kind:'check-sources',gameIds:targets.map(game=>game.id),retry:true}),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error(`Source check request returned ${response.status}.`);
}
while(check&&waitMs&&Date.now()-started<waitMs) {
  await new Promise(resolve=>setTimeout(resolve,1500));
  snapshot=await read();
  const latest=rows(snapshot).filter(game=>targets.some(target=>target.id===game.id));
  if(latest.length&&latest.every(game=>game.workingChoices>=targetWorkingChoices))break;
}
const current=rows(snapshot);
const summary=(state,subdivision)=>{
  const games=current.filter(game=>game.state===state&&(!subdivision||game.subdivision===subdivision));
  return {games:games.length,withListings:games.filter(game=>game.listedSources>0).length,
    withFreeChoices:games.filter(game=>game.freeChoices>0).length,withMultipleFreeChoices:games.filter(game=>game.freeChoices>1).length,
    withWorkingChoices:games.filter(game=>game.workingChoices>0).length,withMultipleWorkingChoices:games.filter(game=>game.workingChoices>1).length,
    withAtLeastFourFreeChoices:games.filter(game=>game.freeChoices>=targetWorkingChoices).length,
    withAtLeastFourWorkingChoices:games.filter(game=>game.workingChoices>=targetWorkingChoices).length};
};
process.stdout.write(JSON.stringify({capturedAt:new Date().toISOString(),elapsedMs:Date.now()-started,origin:origin.origin,
  checksRequested:check?targets.map(game=>game.id):[],live:summary('live'),upcoming:summary('scheduled'),
  targetWorkingChoices,
  liveCoverage:current.filter(game=>game.state==='live').map(game=>({id:game.id,name:game.name,
    subdivision:game.subdivision,listedSources:game.listedSources,freeChoices:game.freeChoices,
    workingChoices:game.workingChoices,targetMet:game.workingChoices>=targetWorkingChoices,
    checkStates:game.choices.reduce((states,choice)=>{
      const state=choice.availability.kind==='unavailable'?`unavailable:${choice.availability.reason}`:choice.availability.kind;
      states[state]=(states[state]||0)+1;return states;
    },{})})),
  subdivisions:Object.fromEntries(['fbs','fcs'].map(subdivision=>[subdivision,
    {live:summary('live',subdivision),upcoming:summary('scheduled',subdivision)}])),
  workingExamples:['fbs','fcs'].flatMap(subdivision=>current.filter(game=>game.state==='live'&&
    game.subdivision===subdivision&&game.workingChoices>0).sort((a,b)=>b.workingChoices-a.workingChoices).slice(0,2)),
  targets:current.filter(game=>targets.some(target=>target.id===game.id)),
  sourceAttention:snapshot.sources.sources.filter(source=>source.collectionHealth.kind==='attention').map(source=>
    ({sourceId:source.id,health:source.collectionHealth})),
  limits:'Working choices have current media or decoded evidence. Shared route attribution does not establish independent broadcasters. Upcoming choices are not proof of playable video before kickoff.',
},null,2));
