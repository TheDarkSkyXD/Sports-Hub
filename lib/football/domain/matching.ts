import {z} from 'zod';
import {createNativeMatcher} from '../../../native/collector/bridge.cjs';
import {GameSchema,type Game,type Match,type Observation,type SourceEventBinding} from '../shared.ts';
import {nativeDomain} from './native.ts';

const MatchSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('matched'),gameId:z.string()}),
  z.object({kind:z.literal('unmatched'),reason:z.string(),possibleGameIds:z.array(z.string())}),
]);
export type SourceEventEvidence={
  undated:'none'|'published-listing'|'live-claim'|'retained-live-detail';
  externalGameId:string|null;
};
const SourceEventDecisionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('matched'),gameId:z.string(),match:MatchSchema.options[0]}),
  z.object({kind:z.literal('possible'),gameIds:z.array(z.string()),reason:z.string(),match:MatchSchema.options[1]}),
  z.object({kind:z.literal('rejected'),reason:z.string(),match:MatchSchema.options[1]}),
]);
export type SourceEventDecision=z.infer<typeof SourceEventDecisionSchema>;

export function normalizedName(value:string):string {
  return nativeDomain('normalizedName',[value],z.string());
}
export function createObservationMatcher(games:readonly Game[],mode:'current'|'inventory-live'='current',freshness?:(observation:Observation)=>number|undefined):(observation:Observation,now:number)=>Match {
  const matcher=createNativeMatcher('observation',JSON.stringify(games),mode);
  return (observation,now)=>MatchSchema.parse(JSON.parse(matcher.call(JSON.stringify({observation,now,freshUntil:freshness?.(observation)}))));
}
export function matchObservation(observation:Observation,games:Game[],now:number):Match {
  return nativeDomain('matchObservation',[observation,games,now],MatchSchema);
}
export function detailCandidateGameIds(result:Match):readonly string[] {
  return nativeDomain('detailCandidateGameIds',[result],z.array(z.string()));
}
export function createSourceEventMatcher(games:readonly Game[],mode:'current'|'inventory-live'='current',freshness?:(observation:Observation)=>number|undefined) {
  const matcher=createNativeMatcher('source',JSON.stringify(games),mode);
  return (observation:Observation,evidence:SourceEventEvidence,now:number):SourceEventDecision=>
    SourceEventDecisionSchema.parse(JSON.parse(matcher.call(JSON.stringify({observation,evidence,now,freshUntil:freshness?.(observation)}))));
}
export function createFinishedGameMatcher(games:readonly Game[]) {
  const matcher=createNativeMatcher('finished',JSON.stringify(games));
  return {
    finishedGameId(observation:Observation,now:number,expectedGameId?:string):string|null {
      return z.string().nullable().parse(JSON.parse(matcher.call(JSON.stringify({operation:'finishedGameId',observation,now,expectedGameId}))));
    },
    finishedBoundEvent(observation:Observation,eventId:string,bindings:readonly SourceEventBinding[]):string|null {
      return z.string().nullable().parse(JSON.parse(matcher.call(JSON.stringify({operation:'finishedBoundEvent',observation,eventId,bindings}))));
    },
  };
}
export function mergeSchedulePartitions(partitions:Game[][]):Game[] {
  return nativeDomain('mergeSchedulePartitions',[partitions],z.array(GameSchema));
}