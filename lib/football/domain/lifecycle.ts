import {z} from 'zod';
import {DEFAULT_FINISHED_GAME_RETENTION_MINUTES,GameSchema,SessionSchema,CandidateSchema,type Candidate,type FinalGame,type Game,type RawFinalGame,type Session} from '../shared.ts';
import {nativeDomain} from './native.ts';

export const GRACE_MS=DEFAULT_FINISHED_GAME_RETENTION_MINUTES*60_000;
export const SESSION_LEASE_MS=90_000;
const FinalSchema=GameSchema.refine(game=>game.lifecycle==='final');
const RecoverySchema=z.object({attempted:z.array(z.string()),cooled:z.record(z.number()),cycleStartedAt:z.number(),failures:z.record(z.number())});
export type Recovery=z.infer<typeof RecoverySchema>;

export function recordFinal(game:RawFinalGame|FinalGame,now:number,retentionMinutes=DEFAULT_FINISHED_GAME_RETENTION_MINUTES):FinalGame {
  const value=nativeDomain('recordFinal',[game,now,retentionMinutes],FinalSchema);
  if(value.lifecycle!=='final')throw new Error('Native final-game response is invalid.');
  return value;
}
export function reconcileSession(session:Session,game:Game|undefined,now:number):Session {
  return nativeDomain('reconcileSession',[session,game,now],SessionSchema);
}
export function compareCandidates(a:Candidate,b:Candidate):number {
  return nativeDomain('compareCandidates',[a,b],z.number());
}
export function nextCandidate(candidates:Candidate[],recovery:Recovery,now:number,exclude?:string,compare=compareCandidates):Candidate|undefined {
  const ordered=compare===compareCandidates?candidates:[...candidates].sort(compare);
  return nativeDomain('nextCandidate',[ordered,recovery,now,exclude,compare!==compareCandidates],CandidateSchema.nullable())??undefined;
}
export function failedCandidate(recovery:Recovery,id:string,now:number):Recovery {
  return nativeDomain('failedCandidate',[recovery,id,now],RecoverySchema);
}