import { command } from './football/runtime/client';
import type { Playback, Session } from './football/shared';
import { validGameId } from './sunday';
import { revokeGeneration, revokeSession } from './stream-relay';

export type PlaybackResult<T> = { status: 200; value: T } | { status: number; error: string; retryAfter?: number };
const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

export async function resolvePlayback(gameId: unknown, manual = false, requestId: unknown): Promise<PlaybackResult<Playback>> {
  if (!validGameId(gameId)) return { status: 400, error: 'Choose a valid game.' };
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) return { status: 400, error: 'Invalid playback request.' };
  const reply = await command({ kind: 'open', gameId, manual, requestId });
  if (reply.kind === 'error') return { status: reply.status, error: reply.message };
  if (reply.kind !== 'playback') return { status: 502, error: 'Unexpected playback response.' };
  return { status: 200, value: reply.playback };
}

export async function updatePlayback(sessionId: unknown, generation: unknown, candidateId: unknown, failure: unknown, retry: unknown): Promise<PlaybackResult<Session>> {
  if (!validSessionId(sessionId) || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0 || (candidateId !== undefined && typeof candidateId !== 'string') || (failure !== undefined && typeof failure !== 'boolean') || (retry !== undefined && typeof retry !== 'boolean')) {
    return { status: 400, error: 'Invalid playback request.' };
  }
  const reply = await command({ kind: 'session', sessionId, generation, candidateId, failure: failure === true, retry: retry === true });
  if (reply.kind === 'error') return { status: reply.status, error: reply.message, retryAfter: 'retryAfter' in reply && typeof reply.retryAfter === 'number' ? reply.retryAfter : undefined };
  if (reply.kind !== 'session') return { status: 502, error: 'Unexpected playback response.' };
  if (reply.session.generation !== generation) revokeGeneration(sessionId, reply.session.generation);
  if (reply.session.state === 'closed') revokeSession(sessionId);
  return { status: 200, value: reply.session };
}

export async function closePlayback(sessionId: unknown): Promise<PlaybackResult<null>> {
  if (!validSessionId(sessionId)) return { status: 400, error: 'Invalid playback session.' };
  revokeSession(sessionId);
  const reply = await command({ kind: 'close', sessionId });
  if (reply.kind === 'error') return { status: reply.status, error: reply.message };
  if (reply.kind !== 'ok') return { status: 502, error: 'Unexpected playback response.' };
  return { status: 200, value: null };
}
