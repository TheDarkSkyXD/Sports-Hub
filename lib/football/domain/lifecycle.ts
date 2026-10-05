import { DEFAULT_FINISHED_GAME_RETENTION_MINUTES, type Candidate, type FinalGame, type Game, type RawFinalGame, type Session } from '../shared.ts';

export const GRACE_MS = DEFAULT_FINISHED_GAME_RETENTION_MINUTES * 60_000;
export const SESSION_LEASE_MS = 90_000;
export function recordFinal(game: RawFinalGame | FinalGame, now: number, retentionMinutes = DEFAULT_FINISHED_GAME_RETENTION_MINUTES): FinalGame {
  return {...game,sourceUrl:undefined,sourceUrls:[],finalObservedAt:now,graceEndsAt:now + retentionMinutes * 60_000};
}
export function reconcileSession(session: Session, game: Game | undefined, now: number): Session {
  if (session.state === 'closed') return session;
  const deadline = game?.graceEndsAt ?? (session.state === 'draining' ? session.graceEndsAt : undefined);
  if (deadline !== undefined) {
    return now >= deadline ? {...session,state:'closed',graceEndsAt:deadline} : {...session,state:'draining',graceEndsAt:deadline};
  }
  return session;
}
export type Recovery = { attempted: string[]; cooled: Record<string, number>; cycleStartedAt: number; failures: Record<string, number> };
export function compareCandidates(a:Candidate,b:Candidate):number {
  return a.id.localeCompare(b.id);
}
export function nextCandidate(candidates: Candidate[], recovery: Recovery, now: number, exclude?: string, compare=compareCandidates): Candidate | undefined {
  if (recovery.attempted.length >= 3) return undefined;
  return [...candidates].filter(candidate => candidate.id !== exclude && !recovery.attempted.includes(candidate.id) && (recovery.cooled[candidate.id] || 0) <= now)
    .sort((a,b) => (recovery.failures[a.id] || 0) - (recovery.failures[b.id] || 0) || compare(a,b))[0];
}
export function failedCandidate(recovery: Recovery, id: string, now: number): Recovery {
  const count = (recovery.failures[id] || 0) + 1;
  return {...recovery,attempted:[...new Set([...recovery.attempted,id])],failures:{...recovery.failures,[id]:count},cooled:{...recovery.cooled,[id]:now + Math.min(600_000,60_000 * 2 ** (count - 1))}};
}
