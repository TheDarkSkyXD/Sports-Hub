import {BoardSchema,SourcesSnapshotSchema} from '../lib/football/shared.ts';
import {SOURCES} from '../lib/football/adapters/sources.ts';
import {feedEligible} from '../lib/football/domain/feed-eligibility.ts';

const origin=new URL(process.argv.find(value=>value.startsWith('--origin='))?.slice(9)||'http://127.0.0.1:3000');
if(origin.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
  throw new Error('Use a local app origin without a path or credentials.');
const responses=await Promise.all(['/api/games','/api/sources'].map(path=>
  fetch(new URL(path,origin),{cache:'no-store',signal:AbortSignal.timeout(30_000)})));
if(responses.some(response=>!response.ok))throw new Error(`App API returned ${responses.map(response=>response.status).join('/')}.`);
const board=BoardSchema.parse(await responses[0].json());
const snapshot=SourcesSnapshotSchema.parse(await responses[1].json());
const inventory=new Map(snapshot.sources.map(source=>[source.id,source]));
const summarize=candidates=>candidates.reduce((counts,candidate)=>{
  const state=candidate.availability.kind==='unavailable'?`unavailable:${candidate.availability.reason}`:candidate.availability.kind;
  counts[state]=(counts[state]||0)+1;
  return counts;
},{});
const sources=SOURCES.map(definition=>{
  const source=inventory.get(definition.id);
  if(!source)return {id:definition.id,state:'missing-inventory'};
  const candidates=snapshot.games.flatMap(game=>game.candidates).filter(candidate=>candidate.sourceIds.includes(source.id));
  return {id:source.id,collectionMode:source.collectionMode,pending:source.pending,
    attempt:source.lastAttempt,health:source.collectionHealth,
    listings:source.listingCount,matchedGames:source.matchedGameCount,
    workingChoices:source.workingChoiceCount,checkStates:summarize(candidates),
    unmatchedReasons:source.unmatchedReasons,
    games:source.links.filter(link=>link.gameId).map(link=>({gameId:link.gameId,title:link.title,evidence:link.evidence})),
  };
});
const games=board.games.filter(game=>feedEligible(game,snapshot.at)).map(game=>{
  const row=snapshot.games.find(row=>row.gameId===game.id);
  return {id:game.id,name:game.name,lifecycle:game.lifecycle,kickoff:game.date,
    sourceCount:row?.sourceCount||0,workingChoices:row?.workingChoiceCount||0,
    checkStates:summarize(row?.candidates||[]),
  };
});
process.stdout.write(`${JSON.stringify({capturedAt:new Date(snapshot.at).toISOString(),origin:origin.origin,
  feedCheckIntervalMinutes:board.feedCheckIntervalMinutes,sourceCount:sources.length,
  sources,games,limits:'Playback results describe the latest check. An empty catalog or an offline upstream feed is not proof of an app defect. Shared candidates may belong to several sources.'},null,2)}\n`);
