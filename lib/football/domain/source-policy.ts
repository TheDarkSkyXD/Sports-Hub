import {z} from 'zod';
import {SourceAttemptSchema,type DetailEvidence,type Game,type League,type Observation,type ResolvedPlayer,type SourceAttempt} from '../shared.ts';
import {nativeDomain} from './native.ts';

export const SOURCE_REFRESH_MS=5*60_000;
export const ACTIVE_DISCOVERY_MS=30*60_000;
export const IDLE_DISCOVERY_MS=5*60*60_000;
export const KICKOFF_WAKE_MS=2*60*60_000;
export const COLLECTION_SETTLE_MS=60_000;
const PollingSchema=z.object({signature:z.string(),unchangedChecks:z.number().int().min(0).max(3)});

export function detailIdentity(observation:Observation):string {
  return nativeDomain('detailIdentity',[observation],z.string());
}
export function detailIdentityMatches(identity:string|undefined,observation:Observation):boolean {
  return nativeDomain('detailIdentityMatches',[identity,observation],z.boolean());
}
export function discoveryDeadline(at:number,observations:readonly Observation[],games:readonly Game[],leagues:readonly League[],now=at):number {
  return nativeDomain('discoveryDeadline',[at,observations,games,leagues,now],z.number());
}
export function detailPolling(prior:DetailEvidence|undefined,observation:Observation,players:readonly ResolvedPlayer[],game?:Game):NonNullable<DetailEvidence['polling']> {
  return nativeDomain('detailPolling',[prior,observation,players,game],PollingSchema);
}
export function detailDeadline(input:{at:number;polling:NonNullable<DetailEvidence['polling']>;game:Game|undefined;now?:number;published:boolean}):number {
  return nativeDomain('detailDeadline',[input],z.number());
}
export function retryDeadline(at:number,retryAfterMs=0,minimumDelayMs=SOURCE_REFRESH_MS):number {
  return nativeDomain('retryDeadline',[at,retryAfterMs,minimumDelayMs],z.number());
}
export function sourceFailure(error:unknown):NonNullable<SourceAttempt['failure']> {
  return nativeDomain('sourceFailure',[error instanceof Error?error.message:''],SourceAttemptSchema.shape.failure.unwrap());
}