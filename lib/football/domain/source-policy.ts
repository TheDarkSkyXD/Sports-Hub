import type { DetailEvidence, Game, League, Observation, ResolvedPlayer, SourceAttempt } from '../shared.ts';
import { combatListingFeedEligible, feedDateEligible, feedEligible } from './feed-eligibility.ts';

export function detailIdentity(observation:Observation):string {
  return JSON.stringify([observation.sourceId,observation.url,observation.league,observation.title,
    observation.teams,observation.kickoff,observation.kickoff===null?observation.rawTime:'',observation.parserVersion]);
}

export function detailIdentityMatches(identity:string|undefined,observation:Observation):boolean {
  const expected=detailIdentity(observation);
  if(identity===expected)return true;
  if(!identity||identity.length>16_384)return false;
  try {
    const value:unknown=JSON.parse(identity);
    if(!Array.isArray(value))return false;
    const fields:unknown[]=value;
    if(fields.length!==8||typeof fields[6]!=='string')return false;
    if(typeof fields[5]==='number')fields[6]='';
    return JSON.stringify(fields)===expected;
  } catch {return false;}
}

export const SOURCE_REFRESH_MS=5*60_000;
export const ACTIVE_DISCOVERY_MS=30*60_000;
export const IDLE_DISCOVERY_MS=5*60*60_000;
export const KICKOFF_WAKE_MS=2*60*60_000;
export const COLLECTION_SETTLE_MS=60_000;

export function discoveryDeadline(at:number,observations:readonly Observation[],games:readonly Game[],leagues:readonly League[],now=at):number {
  const active=observations.some(row=>(row.league===null||leagues.includes(row.league))&&
    (row.kickoff===null||feedDateEligible(row.kickoff,now)));
  let deadline=at+(active?ACTIVE_DISCOVERY_MS:IDLE_DISCOVERY_MS);
  for(const game of games) {
    if(!leagues.includes(game.league)||!feedEligible(game,now))continue;
    const kickoff=game.date?Date.parse(game.date):NaN;
    if(game.lifecycle==='live'||Number.isFinite(kickoff)&&kickoff-now<=KICKOFF_WAKE_MS)
      deadline=Math.min(deadline,at+ACTIVE_DISCOVERY_MS);
    else if(Number.isFinite(kickoff))deadline=Math.min(deadline,kickoff-KICKOFF_WAKE_MS);
  }
  return deadline;
}

export function detailPolling(prior:DetailEvidence|undefined,observation:Observation,players:readonly ResolvedPlayer[],game?:Game):NonNullable<DetailEvidence['polling']> {
  const signature=JSON.stringify([detailIdentity(observation),game?.id,game?.date,players.map(player=>JSON.stringify(player.locator)).sort()]);
  return {signature,unchangedChecks:prior?.polling?.signature===signature?Math.min(3,prior.polling.unchangedChecks+1):0};
}

export function detailDeadline({at,polling,game,now=at,published}:{
  at:number;polling:NonNullable<DetailEvidence['polling']>;game:Game|undefined;now?:number;published:boolean;
}):number {
  let deadline=at+(polling.unchangedChecks>=3?IDLE_DISCOVERY_MS:ACTIVE_DISCOVERY_MS);
  if(published&&game&&(feedEligible(game,now)||combatListingFeedEligible(game,now)))
    return Math.min(deadline,at+ACTIVE_DISCOVERY_MS);
  if(game&&feedEligible(game,now)) {
    const kickoff=game.date?Date.parse(game.date):NaN;
    if(game.lifecycle==='live'||Number.isFinite(kickoff)&&kickoff-now<=KICKOFF_WAKE_MS)deadline=Math.min(deadline,at+ACTIVE_DISCOVERY_MS);
    else if(Number.isFinite(kickoff))deadline=Math.min(deadline,kickoff-KICKOFF_WAKE_MS);
  }
  return deadline;
}

export function retryDeadline(at:number,retryAfterMs=0,minimumDelayMs=SOURCE_REFRESH_MS):number {
  return at+Math.max(minimumDelayMs,retryAfterMs);
}

export function sourceFailure(error:unknown):NonNullable<SourceAttempt['failure']> {
  const message=error instanceof Error?error.message:'';
  if(message==='source-page-capacity')return 'collector-busy';
  if(message==='blocked'||message==='http-403'||message==='source-page-challenge')return 'blocked';
  if(/\b404\b/.test(message))return 'not-found';
  if(message==='rate-limited'||/\b429\b/.test(message))return 'rate-limited';
  if(/timeout|timed out/i.test(message))return 'timed-out';
  if(/fetch failed|network/i.test(message)||message==='source-page-closed'||message==='source-page-window-closed')return 'network-unavailable';
  if(message==='unsupported-discovery-address'||message==='source-page-unsupported-address')return 'unsupported-address';
  if(message==='response-too-large'||message==='source-page-response-too-large')return 'response-too-large';
  if(/^(?:empty-response|redirect-without-location|redirect-limit|source-page-(?:page-changed|changed|invalid-response))$/.test(message))return 'invalid-response';
  return 'upstream-error';
}
