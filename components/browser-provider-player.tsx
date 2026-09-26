'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { PlaybackSchema, type Playback, type Session } from '@/lib/football/shared';
import type { Feed } from '@/lib/sunday';
import { GamePlayer } from './game-player';

type Props = {
  gameId: string;
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

async function readError(response: Response): Promise<{ message: string; retryAfter?: number }> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      return { message: body.error, retryAfter: 'retryAfter' in body && typeof body.retryAfter === 'number' ? body.retryAfter : undefined };
    }
  }
  catch {}
  return { message: `Playback request failed (${response.status}).` };
}

class PlaybackRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message); }
}

async function updateSession(session: Session, changes: { failure?: boolean; candidateId?: string; retry?: boolean } = {}): Promise<Playback> {
  const response = await fetch('/api/playback', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'session', sessionId: session.id, generation: session.generation, ...changes }),
  });
  if (!response.ok) { const failure = await readError(response); throw new PlaybackRequestError(failure.message, response.status, failure.retryAfter); }
  const parsed = PlaybackSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('The player returned an invalid playback.');
  return parsed.data;
}

export function BrowserProviderPlayer({ gameId, manualFeed, graceEndsAt, focused, audible, volume, playing, delay, onPlayingChange, onAudibleChange, onVolumeChange }: Props) {
  const [playback, setPlayback] = useState<Playback | null>(null);
  const [message, setMessage] = useState('Finding your game…');
  const [endedReason, setEndedReason] = useState<'final' | 'session' | 'media' | null>(null);
  const ended = endedReason !== null;
  const [retry, setRetry] = useState(0);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const inFlight = useRef(false);
  const pendingChange = useRef<{ failure?: boolean; candidateId?: string; retry?: boolean } | null>(null);
  const changeRef = useRef<(changes: { failure?: boolean; candidateId?: string; retry?: boolean }) => Promise<void>>(async () => {});
  const currentGame = useRef(gameId);
  const currentMode = useRef(!!manualFeed);
  const requestSerial = useRef(0);
  const intent = useRef<{ key: string; requestId: string } | null>(null);

  useEffect(() => {
    let active = true;
    const serial = ++requestSerial.current;
    currentGame.current = gameId;
    currentMode.current = !!manualFeed;
    const key = `${gameId}:${!!manualFeed}`;
    if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
    const requestId = intent.current.requestId;
    inFlight.current = false;
    pendingChange.current = null;
    const body = JSON.stringify({ kind: 'open', gameId, manual: !!manualFeed, requestId });
    const open = window.setTimeout(() => {
      setEndedReason(null);
      setMessage('Finding your game…');
      setPlayback(null);
      setRetryAfter(null);
      void fetch('/api/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(async response => {
      if (!response.ok) throw new Error((await readError(response)).message);
      const parsed = PlaybackSchema.safeParse(await response.json());
      if (!parsed.success || (!manualFeed && !parsed.data.candidates.length)) throw new Error('No player is listed for this game.');
      if (!active) {
        if (currentGame.current !== gameId || currentMode.current !== !!manualFeed || requestSerial.current === serial) void fetch(`/api/playback?session=${encodeURIComponent(parsed.data.session.id)}`, { method: 'DELETE', keepalive: true });
        return;
      }
      sessionRef.current = parsed.data.session;
      setPlayback(parsed.data);
    }).catch(error => { if (active) setMessage(error instanceof Error ? error.message : 'Player unavailable.'); }); }, 0);
    return () => {
      active = false;
      window.clearTimeout(open);
      const session = sessionRef.current;
      if (session?.gameId === gameId) {
        void fetch(`/api/playback?session=${encodeURIComponent(session.id)}`, { method: 'DELETE', keepalive: true });
        sessionRef.current = null;
      }
    };
  }, [gameId, manualFeed, retry]);

  useEffect(() => {
    if (!playback || ended) return;
    const timer = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session || inFlight.current) return;
      inFlight.current = true;
      void updateSession(session).then(next => {
        if (sessionRef.current?.id !== next.session.id || next.session.generation < sessionRef.current.generation) return;
        sessionRef.current = next.session;
        if (next.session.state === 'closed') setEndedReason(next.session.graceEndsAt !== null && next.session.graceEndsAt <= Date.now() ? 'final' : 'session');
        else { setRetryAfter(null); setPlayback(next); }
      }).catch(error => {
        if (sessionRef.current?.id === session.id && error instanceof PlaybackRequestError && error.status === 410) setEndedReason('session');
        else if (sessionRef.current?.id === session.id && error instanceof PlaybackRequestError && error.status === 503 && error.retryAfter !== undefined) setRetryAfter(error.retryAfter);
      }).finally(() => {
        inFlight.current = false;
        const pending = pendingChange.current;
        pendingChange.current = null;
        if (pending && sessionRef.current?.id === session.id) void changeRef.current(pending);
      });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [playback, ended]);

  useEffect(() => {
    const deadline = graceEndsAt ?? playback?.session.graceEndsAt;
    if (!playback || deadline === undefined || deadline === null || ended) return;
    const timer = window.setTimeout(() => setEndedReason('final'), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [graceEndsAt, playback, ended]);

  useEffect(() => {
    if (!ended || !sessionRef.current) return;
    const session = sessionRef.current;
    sessionRef.current = null;
    void fetch(`/api/playback?session=${encodeURIComponent(session.id)}`, { method: 'DELETE', keepalive: true });
  }, [ended]);

  const change = useCallback(async (changes: { failure?: boolean; candidateId?: string; retry?: boolean }) => {
    const session = sessionRef.current;
    if (!session) return;
    if (inFlight.current) {
      if (changes.failure || !pendingChange.current?.failure) pendingChange.current = changes;
      return;
    }
    inFlight.current = true;
    try {
      const next = await updateSession(session, changes);
      if (sessionRef.current?.id !== session.id || next.session.generation < sessionRef.current.generation) return;
      sessionRef.current = next.session;
      if (next.session.state === 'closed') setEndedReason(next.session.graceEndsAt !== null && next.session.graceEndsAt <= Date.now() ? 'final' : 'session');
      else { setMessage(''); setRetryAfter(null); setPlayback(next); }
    } catch (error) {
      if (sessionRef.current?.id === session.id) {
        setMessage(error instanceof Error ? error.message : 'Player unavailable.');
        if (error instanceof PlaybackRequestError && error.status === 503 && error.retryAfter !== undefined) setRetryAfter(error.retryAfter);
      }
    } finally {
      inFlight.current = false;
      const pending = pendingChange.current;
      pendingChange.current = null;
      if (pending && sessionRef.current?.id === session.id) void changeRef.current(pending);
    }
  }, []);
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
      {ended ? <div className="player-message"><AlertCircle/><strong>{endedReason === 'final' ? 'Game stream ended' : endedReason === 'media' ? 'Video ended' : 'Playback session ended'}</strong><p>{endedReason === 'final' ? 'Playback ended after the game became final.' : endedReason === 'media' ? 'This video reached its end.' : 'Reconnect this game to start a new playback session.'}</p>{endedReason === 'session' && <button className="button" onClick={() => { intent.current = { key: `${gameId}:${!!manualFeed}`, requestId: crypto.randomUUID() }; setRetry(value => value + 1); }}><RefreshCw size={14}/>Reconnect</button>}</div>
        : feed ? <GamePlayer feed={feed} focused={focused} audible={audible} volume={volume} playing={playing} delay={delay} onPlayingChange={onPlayingChange} onAudibleChange={onAudibleChange} onVolumeChange={onVolumeChange} onFatal={manualFeed ? undefined : () => void change({ failure: true })} onEnded={() => { if (!manualFeed && session?.state === 'active') void change({ failure: true }); else setEndedReason('media'); }} onRetry={manualFeed ? undefined : () => void change({ retry: true })} errorHint={message || 'This server is unavailable. Try again or switch to another listed server.'}/>
        : <div className="player-message">{message === 'Finding your game…' ? <LoaderCircle className="spin"/> : <AlertCircle/>}<strong>{message === 'Finding your game…' ? 'Opening the live player' : 'Player unavailable'}</strong><p>{message}</p>{message !== 'Finding your game…' && <button className="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>Try again</button>}</div>}
    </div>
    {!manualFeed && <div className="provider-controls"><button onClick={() => {
      if (!playback?.candidates.length || !session) return;
      const index = playback.candidates.findIndex(item => item.id === session.candidateId);
      const next = playback.candidates[(index + 1) % playback.candidates.length];
      if (next && next.id !== session.candidateId) void change({ candidateId: next.id });
    }} disabled={!playback || playback.candidates.length < 2 || ended} title="Switch provider server"><RefreshCw size={12}/>Switch server</button></div>}
  </div>;
}
