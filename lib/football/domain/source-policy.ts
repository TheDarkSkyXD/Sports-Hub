import type { Observation, SourceAttempt } from '../shared.ts';

export function detailIdentity(observation:Observation):string {
  return JSON.stringify([observation.sourceId,observation.url,observation.league,observation.title,
    observation.teams,observation.kickoff,observation.rawTime,observation.parserVersion]);
}

export const SOURCE_REFRESH_MS=5*60_000;

export function retryDeadline(at:number,retryAfterMs=0,sourceRefreshMs=SOURCE_REFRESH_MS):number {
  return at+Math.max(sourceRefreshMs,retryAfterMs);
}

export function rebaseRetryDeadline(at:number,currentDeadline:number,previousRefreshMs:number,nextRefreshMs:number,rateLimited=false):number {
  if(currentDeadline===Number.MAX_SAFE_INTEGER)return currentDeadline;
  const minimumCooldown=rateLimited?SOURCE_REFRESH_MS:0;
  const previousDeadline=at+Math.max(previousRefreshMs,minimumCooldown);
  const nextDeadline=at+Math.max(nextRefreshMs,minimumCooldown);
  return rateLimited||currentDeadline>previousDeadline?Math.max(nextDeadline,currentDeadline):nextDeadline;
}

export function sourceFailure(error:unknown):NonNullable<SourceAttempt['failure']> {
  const message=error instanceof Error?error.message:'';
  if(message==='blocked')return 'blocked';
  if(/\b404\b/.test(message))return 'not-found';
  if(message==='rate-limited'||/\b429\b/.test(message))return 'rate-limited';
  if(/timeout|timed out/i.test(message))return 'timed-out';
  if(/fetch failed|network/i.test(message))return 'network-unavailable';
  if(message==='unsupported-discovery-address')return 'unsupported-address';
  if(/^(?:empty-response|response-too-large|redirect-without-location|redirect-limit)$/.test(message))return 'invalid-response';
  return 'upstream-error';
}
