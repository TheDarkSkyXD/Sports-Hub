import {z} from 'zod';
import {GameSchema,type DetailEvidence,type Game,type Match,type Observation} from '../shared.ts';
import {nativeDomain} from './native.ts';

const MatchSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('matched'),gameId:z.string()}),
  z.object({kind:z.literal('unmatched'),reason:z.string(),possibleGameIds:z.array(z.string())}),
]);
export function provisionalLiveChannel(observation:Observation,result:Match,freshGames:readonly Game[],now:number):Game|null {
  return nativeDomain('provisionalLiveChannel',[observation,result,freshGames,now],GameSchema.nullable());
}
export function resolvedLiveChannelMatch(observation:Observation,result:Match,freshGames:readonly Game[],detail:DetailEvidence|undefined,now:number,options?:{retainedPublication:boolean}):Match {
  return nativeDomain('resolvedLiveChannelMatch',[observation,result,freshGames,detail,now,options],MatchSchema);
}