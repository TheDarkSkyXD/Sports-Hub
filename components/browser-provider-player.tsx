'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { PlaybackSchema, type Playback, type Session } from '@/lib/football/shared';
import type { Feed } from '@/lib/sunday';
import { GamePlayer } from './game-player';
import { ServerControls, type DiscoveredServer } from './server-controls';

type Props = {
  gameId: string;
  discoveredServers?: DiscoveredServer[];
  manualFeed?: Feed;
  graceEndsAt?: number;
  focused: boolean;
  audible: boolean;
  volume: number;
  playing: boolean;
  delay: number;
  onPlayingChange: (playing: boolean) => void;
  onAudibleChange: (audible: boolean) => void;
  onVolumeChange: (volume: number) => void;
};

async function readError(response: Response): Promise<{ message: string; retryAfter?: number; code?: 'drain-exhausted' }> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return {
        message: body.error,
        retryAfter: 'retryAfter' in body && typeof body.retryAfter === 'number' ? body.retryAfter : undefined,
        code: 'code' in body && body.code === 'drain-exhausted' ? body.code : undefined,
      };
    }
  }
  catch {}
  return { message: `Playback request failed (${response.status}).` };
}

class PlaybackRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number, readonly code?: 'drain-exhausted') { super(message); }
}

function isTransientRequestError(error: unknown): boolean {
  return !(error instanceof PlaybackRequestError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

type SessionChange = { failure?: boolean; candidateId?: string; retry?: boolean };
type ReconcileIntent = { changes: SessionChange; priorId: string; kind: 'rejected' | 'uncertain' };
function changePriority(change: SessionChange): number {
  return change.candidateId ? 3 : change.retry ? 2 : change.failure ? 1 : 0;
}

async function updateSession(session: Session, changes: SessionChange = {}): Promise<Playback> {
  const response = await fetch('/api/playback', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'session', sessionId: session.id, generation: session.generation, ...changes }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) { const failure = await readError(response); throw new PlaybackRequestError(failure.message, response.status, failure.retryAfter, failure.code); }
  const parsed = PlaybackSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('The player returned an invalid playback.');
  return parsed.data;
}

export function BrowserProviderPlayer({ gameId, discoveredServers = [], manualFeed, graceEndsAt, focused, audible, volume, playing, delay, onPlayingChange, onAudibleChange, onVolumeChange }: Props) {
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [message, setMessage] = useState('Finding your game…');
  const [endedReason, setEndedReason] = useState<'final' | 'media' | null>(null);
  const ended = endedReason !== null;
  const [retry, setRetry] = useState(0);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const ownedSession = useRef<Session | null>(null);
  const inFlight = useRef(false);
  const pendingChange = useRef<SessionChange | null>(null);
  const reconcileIntent = useRef<ReconcileIntent | null>(null);
  const changeRef = useRef<(changes: SessionChange) => Promise<void>>(async () => {});
  const intent = useRef<{ key: string; requestId: string } | null>(null);
  const ownedKey = useRef<string | null>(null);
  const graceRef = useRef(graceEndsAt);
  const fixedDeadline = useRef<number | null>(graceEndsAt ?? null);
  const openFailures = useRef(0);
  const transportFailures = useRef(0);
  const commandSerial = useRef(0);
  const openTimer = useRef<number | null>(null);
  const commandTimer = useRef<number | null>(null);
  useEffect(() => { graceRef.current = graceEndsAt; if (graceEndsAt !== undefined) fixedDeadline.current = graceEndsAt; }, [graceEndsAt]);
  const endingDeadline = useCallback(() => fixedDeadline.current ?? graceRef.current ?? ownedSession.current?.graceEndsAt ?? null, []);

  const reopen = useCallback((reason = 'Reconnecting to your game…') => {
    const deadline = endingDeadline();
    if (deadline !== null && (deadline <= Date.now() || !ownedSession.current)) {
      setEndedReason(deadline <= Date.now() ? 'final' : 'media');
      return;
    }
    const pending = pendingChange.current;
    if (pending && (pending.candidateId || pending.retry) && (!reconcileIntent.current || changePriority(pending) >= changePriority(reconcileIntent.current.changes))) {
      reconcileIntent.current = { changes: pending, priorId: sessionRef.current?.id || '', kind: 'rejected' };
    }
    sessionRef.current = null;
    pendingChange.current = null;
    commandSerial.current++;
    if (commandTimer.current !== null) { window.clearTimeout(commandTimer.current); commandTimer.current = null; }
    setPlayback(null);
    setRetryAfter(null);
    setMessage(reason);
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(openFailures.current++, delays.length - 1)];
    openTimer.current = window.setTimeout(() => { openTimer.current = null; setRetry(value => value + 1); }, delay);
  }, [endingDeadline]);

  useEffect(() => {
    const key = `${gameId}:${!!manualFeed}`;
    ownedKey.current = key;
    fixedDeadline.current = graceRef.current ?? null;
    openFailures.current = 0;
    transportFailures.current = 0;
    return () => {
      ownedKey.current = null;
      reconcileIntent.current = null;
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (commandTimer.current !== null) window.clearTimeout(commandTimer.current);
      const session = ownedSession.current;
      sessionRef.current = null;
      ownedSession.current = null;
      if (session?.gameId === gameId) void fetch(`/api/playback?session=${encodeURIComponent(session.id)}`, { method: 'DELETE', keepalive: true });
    };
  }, [gameId, manualFeed]);

  useEffect(() => {
    let active = true;
    const key = `${gameId}:${!!manualFeed}`;
    if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
    const requestId = intent.current.requestId;
    inFlight.current = false;
    pendingChange.current = null;
    const body = JSON.stringify({ kind: 'open', gameId, manual: !!manualFeed, requestId });
    const open = window.setTimeout(() => {
      const deadline = endingDeadline();
      if (deadline !== null && (deadline <= Date.now() || !ownedSession.current)) { setEndedReason(deadline <= Date.now() ? 'final' : 'media'); return; }
      setEndedReason(null);
      if (!openFailures.current) setMessage('Finding your game…');
      setPlayback(null);
      setRetryAfter(null);
      void fetch('/api/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) }).then(async response => {
      if (!response.ok) { const failure = await readError(response); throw new PlaybackRequestError(failure.message,response.status); }
      const parsed = PlaybackSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('The player returned an invalid playback.');
      if (!manualFeed && !parsed.data.candidates.length) {
        void fetch(`/api/playback?session=${encodeURIComponent(parsed.data.session.id)}`, { method: 'DELETE', keepalive: true });
        throw new Error('No player is listed for this game.');
      }
      if (!active) {
        if (ownedKey.current !== key) void fetch(`/api/playback?session=${encodeURIComponent(parsed.data.session.id)}`, { method: 'DELETE', keepalive: true });
        return;
      }
      const deadline = endingDeadline();
      if (deadline !== null && deadline <= Date.now()) {
        void fetch(`/api/playback?session=${encodeURIComponent(parsed.data.session.id)}`, { method: 'DELETE', keepalive: true });
        setEndedReason('final');
        return;
      }
      openFailures.current = 0;
      transportFailures.current = 0;
      if (ownedSession.current && ownedSession.current.id !== parsed.data.session.id) void fetch(`/api/playback?session=${encodeURIComponent(ownedSession.current.id)}`, { method: 'DELETE', keepalive: true });
      sessionRef.current = parsed.data.session;
      ownedSession.current = parsed.data.session;
      if (parsed.data.session.graceEndsAt !== null) fixedDeadline.current = parsed.data.session.graceEndsAt;
      setMessage('');
      setPlayback(parsed.data);
      const replay = reconcileIntent.current;
      reconcileIntent.current = null;
      if (replay?.changes.candidateId && parsed.data.candidates.some(candidate => candidate.id === replay.changes.candidateId) && replay.changes.candidateId !== parsed.data.session.candidateId) {
        void changeRef.current({ candidateId: replay.changes.candidateId });
      } else if (replay?.priorId === parsed.data.session.id && replay.kind === 'rejected') {
        if (replay.changes.retry) void changeRef.current({ retry: true });
      }
    }).catch(error => {
      if (!active) return;
      const deadline = endingDeadline();
      if (deadline !== null && (deadline <= Date.now() || !ownedSession.current || error instanceof PlaybackRequestError && (error.status === 409 || error.status === 410))) {
        setEndedReason(deadline <= Date.now() ? 'final' : 'media');
        return;
      }
      reopen(error instanceof PlaybackRequestError && error.status === 404 ? error.message : undefined);
    }); }, 0);
    return () => {
      active = false;
      window.clearTimeout(open);
    };
  }, [gameId, manualFeed, retry, reopen, endingDeadline]);

  useEffect(() => {
    if (!playback || ended) return;
    const timer = window.setInterval(() => { if (sessionRef.current && !inFlight.current) void changeRef.current({}); }, 30000);
    return () => window.clearInterval(timer);
  }, [playback, ended]);

  useEffect(() => {
    const deadline = graceEndsAt ?? playback?.session.graceEndsAt ?? fixedDeadline.current ?? ownedSession.current?.graceEndsAt;
    if (deadline === undefined || deadline === null) return;
    const timer = window.setTimeout(() => setEndedReason('final'), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [graceEndsAt, playback]);

  useEffect(() => {
    if (!ended) return;
    const session = ownedSession.current;
    if (!session) return;
    sessionRef.current = null;
    ownedSession.current = null;
    void fetch(`/api/playback?session=${encodeURIComponent(session.id)}`, { method: 'DELETE', keepalive: true });
  }, [ended]);

  const change = useCallback(async (changes: SessionChange) => {
    const session = sessionRef.current;
    if (!session) {
      if (changes.candidateId || changes.retry) {
        if (!reconcileIntent.current || changePriority(changes) >= changePriority(reconcileIntent.current.changes)) reconcileIntent.current = { changes, priorId: '', kind: 'rejected' };
        if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; }
        setRetry(value => value + 1);
      }
      return;
    }
    if (inFlight.current) {
      if (!pendingChange.current || changePriority(changes) >= changePriority(pendingChange.current)) pendingChange.current = changes;
      return;
    }
    if (commandTimer.current !== null) { window.clearTimeout(commandTimer.current); commandTimer.current = null; }
    inFlight.current = true;
    const serial = ++commandSerial.current;
    try {
      const next = await updateSession(session, changes);
      if (sessionRef.current?.id !== session.id || next.session.generation < sessionRef.current.generation) return;
      transportFailures.current = 0;
      sessionRef.current = next.session;
      ownedSession.current = next.session;
      if (next.session.graceEndsAt !== null) fixedDeadline.current = next.session.graceEndsAt;
      if (next.session.state === 'closed') setEndedReason('final');
      else {
        setMessage(''); setRetryAfter(null); setPlayback(next);
      }
    } catch (error) {
      if (sessionRef.current?.id === session.id) {
        if (error instanceof PlaybackRequestError && (error.status === 410 || error.status === 409)) {
          const deadline = endingDeadline();
          if (error.status === 410 && deadline !== null) setEndedReason(deadline <= Date.now() ? 'final' : 'media');
          else {
            if (changes.candidateId || changes.retry) reconcileIntent.current = { changes, priorId: session.id, kind: 'rejected' };
            reopen();
          }
        }
        else if (error instanceof PlaybackRequestError && error.code === 'drain-exhausted') {
          setEndedReason('media');
        } else if (error instanceof PlaybackRequestError && error.status === 503 && error.retryAfter !== undefined) {
          setMessage(error.message);
          setRetryAfter(error.retryAfter);
        } else {
          if (isTransientRequestError(error)) {
            const pending = pendingChange.current;
            if (changePriority(changes) === 0) {
              if (!pending) {
                const delays = [1000, 2000, 5000, 10000, 30000, 60000];
                const delay = delays[Math.min(transportFailures.current++, delays.length - 1)];
                commandTimer.current = window.setTimeout(() => {
                  commandTimer.current = null;
                  if (sessionRef.current?.id === session.id) void changeRef.current({});
                }, delay);
              }
            } else {
              if (!pending || changePriority(pending) <= changePriority(changes)) reconcileIntent.current = { changes, priorId: session.id, kind: 'uncertain' };
              openFailures.current = Math.max(openFailures.current, transportFailures.current++);
              reopen();
            }
          } else {
            setMessage(error instanceof Error ? error.message : 'Player unavailable.');
          }
        }
      }
    } finally {
      if (serial !== commandSerial.current) return;
      inFlight.current = false;
      const pending = pendingChange.current;
      pendingChange.current = null;
      if (pending && sessionRef.current?.id === session.id) void changeRef.current(pending);
    }
  }, [reopen, endingDeadline]);
  useEffect(() => { changeRef.current = change; }, [change]);

  useEffect(() => {
    if (retryAfter === null || ended || !playback) return;
    const timer = window.setTimeout(() => void change({}), Math.max(0, retryAfter - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAfter, ended, playback, change]);

  const session = playback?.session;
  const candidate = playback?.candidates.find(item => item.id === session?.candidateId);
  const feed = playback && manualFeed ? manualFeed : (session && candidate ? {
    url: `/api/stream/${encodeURIComponent(gameId)}/index.m3u8?session=${encodeURIComponent(session.id)}&candidate=${encodeURIComponent(candidate.id)}&generation=${session.generation}`,
    label: candidate.label,
  } : null);

  return <div className="provider-player">
    <div className="provider-surface">
      {ended ? <div className="player-message"><AlertCircle/><strong>{endedReason === 'final' ? 'Game stream ended' : 'Video ended'}</strong><p>{endedReason === 'final' ? 'Playback ended after the game became final.' : 'This video reached its end.'}</p></div>
        : feed ? <GamePlayer feed={feed} focused={focused} audible={audible} volume={volume} playing={playing} delay={delay} onPlayingChange={onPlayingChange} onAudibleChange={onAudibleChange} onVolumeChange={onVolumeChange} onFatal={manualFeed ? undefined : () => void change({ failure: true })} onEnded={() => { if (!manualFeed && session?.state === 'active') void change({ failure: true }); else setEndedReason('media'); }} onRetry={manualFeed ? undefined : () => void change({ retry: true })} errorHint={message || 'This server is unavailable. Try again or switch to another listed server.'}/>
        : <div className="player-message">{message === 'Finding your game…' || message === 'Reconnecting to your game…' ? <LoaderCircle className="spin"/> : <AlertCircle/>}<strong>{message === 'Finding your game…' ? 'Opening the live player' : message === 'Reconnecting to your game…' ? 'Reconnecting' : 'Player unavailable'}</strong><p>{message}</p>{message !== 'Finding your game…' && <button className="button" onClick={() => { if (openTimer.current !== null) { window.clearTimeout(openTimer.current); openTimer.current = null; } setRetry(value => value + 1); }}><RefreshCw size={14}/>Try again</button>}</div>}
    </div>
    {!manualFeed && <ServerControls candidates={playback?.candidates ?? []} selectedCandidateId={session?.candidateId ?? ''} discovered={discoveredServers} disabled={ended}
      onSelect={candidateId => void change({ candidateId })} onSwitch={() => {
        if (!playback?.candidates.length || !session) return;
        const index = playback.candidates.findIndex(item => item.id === session.candidateId);
        const next = playback.candidates[(index + 1) % playback.candidates.length];
        if (next && next.id !== session.candidateId) void change({ candidateId: next.id });
      }}/>}
  </div>;
}
