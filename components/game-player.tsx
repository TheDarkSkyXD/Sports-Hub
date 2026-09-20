'use client';

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertCircle, LoaderCircle, Pause, Play, Radio, RotateCw } from 'lucide-react';
import { createLiveSeekRequest, createPlaybackWatchdog, createRecoveryBudget, currentMediaSignal, liveSeekTarget, playbackFailure } from '@/lib/direct-playback';
import type { Feed } from '@/lib/sunday';

type PlayerState = 'loading' | 'ready' | 'buffering' | 'recovering' | 'error' | 'gesture' | 'ended';
type Props = {
  gameId?: string;
  feed: Feed;
  audible: boolean;
  volume: number;
  playing: boolean;
  delay: number;
  onAvailability?: (id: string, ready: boolean) => void;
  onPlayingChange?: (playing: boolean) => void;
};

export function GamePlayer({ gameId, feed, audible, volume, playing, delay, onAvailability, onPlayingChange }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const controls = useRef({ playing, delay });
  controls.current = { playing, delay };
  const playRef = useRef<((play: boolean) => void) | null>(null);
  const seekRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<PlayerState>('loading');
  const [retry, setRetry] = useState(0);
  const available = state === 'ready' || state === 'buffering';

  useEffect(() => {
    if (gameId) onAvailability?.(gameId, available);
  }, [gameId, onAvailability, available]);
  useEffect(() => () => { if (gameId) onAvailability?.(gameId, false); }, [gameId, onAvailability]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let disposed = false, failed = false, live = false, playAttempt = 0;
    let hls: Hls | undefined;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const recover = createRecoveryBudget();
    const update = (next: PlayerState) => { if (!disposed && (!failed || next === 'error')) setState(next); };
    const fail = () => {
      if (disposed) return;
      failed = true;
      watchdog.stop();
      clearTimeout(recoveryTimer);
      hls?.stopLoad();
      video.pause();
      update('error');
    };
    const watchdog = createPlaybackWatchdog(fail);
    const watchConnection = () => watchdog.start();
    const delaySeek = createLiveSeekRequest(
      () => liveSeekTarget(video.seekable, live || (!hls && video.duration === Infinity), controls.current.delay),
      target => { video.currentTime = target; },
    );
    const seek = () => { if (!disposed && !failed) delaySeek.apply(); };
    const sync = (play: boolean) => {
      if (disposed || failed) return;
      const attempt = ++playAttempt;
      if (!play) {
        video.pause();
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          watchdog.stop();
          setState(current => current === 'gesture' || current === 'buffering' ? 'ready' : current);
        } else {
          setState(current => current === 'gesture' || current === 'buffering' ? 'loading' : current);
          watchConnection();
        }
        return;
      }
      void video.play().catch(error => {
        if (disposed || attempt !== playAttempt || !controls.current.playing) return;
        const failure = playbackFailure(error);
        if (failure === 'gesture') { watchdog.stop(); update('gesture'); }
        else if (failure === 'error') fail();
      });
    };
    const onReady = () => {
      if (disposed || failed || !currentMediaSignal('loadeddata', video)) return;
      seek();
      watchdog.stop();
      update('ready');
    };
    const onPlaying = () => { if (currentMediaSignal('playing', video)) onReady(); };
    const onLoadedData = () => {
      if (disposed || failed || !currentMediaSignal('loadeddata', video)) return;
      seek();
      if (!controls.current.playing) onReady();
    };
    const onMetadata = () => {
      if (disposed || failed || !currentMediaSignal('loadedmetadata', video)) return;
      seek();
      sync(controls.current.playing);
    };
    const onWaiting = (event: Event) => {
      if (failed || !controls.current.playing || video.paused || video.ended || video.error) return;
      if (event.type === 'stalled' && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;
      setState(current => current === 'ready' ? 'buffering' : current);
      watchConnection();
    };
    const onPause = () => {
      if (disposed || failed || !controls.current.playing || !currentMediaSignal('pause', video)) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) watchdog.stop();
      setState(current => current === 'ready' || current === 'buffering' ? 'gesture' : current);
    };
    const onEnded = () => {
      if (disposed || failed || !currentMediaSignal('ended', video)) return;
      watchdog.stop();
      update('ended');
    };
    const onError = () => {
      if (disposed || failed || !currentMediaSignal('error', video)) return;
      // hls.js reports decode failures itself and can reattach the media element.
      if (hls && video.error?.code === MediaError.MEDIA_ERR_DECODE) return;
      fail();
    };

    playRef.current = sync;
    seekRef.current = () => { if (!disposed && !failed) delaySeek.request(); };
    update('loading');
    video.addEventListener('playing', onPlaying);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('progress', seek);
    video.addEventListener('canplay', seek);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('stalled', onWaiting);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    watchConnection();

    if (/\.m3u8(?:[?#]|$)/i.test(feed.url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 45, backBufferLength: 90, liveSyncDurationCount: 3 });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (disposed || failed) return;
        live = data.details.live;
        seek();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (disposed || failed || !data.fatal) return;
        const recovery = recover(data.type, data.details);
        if (!recovery) { fail(); return; }
        update('recovering');
        clearTimeout(recoveryTimer);
        watchdog.stop();
        watchConnection();
        recoveryTimer = setTimeout(() => {
          if (disposed || failed) return;
          if (recovery.action === 'manifest') hls?.loadSource(feed.url);
          else if (recovery.action === 'network') hls?.startLoad();
          else hls?.recoverMediaError();
        }, recovery.delay);
      });
      hls.loadSource(feed.url);
      hls.attachMedia(video);
    } else {
      video.src = feed.url;
      video.load();
    }

    return () => {
      disposed = true;
      playRef.current = null;
      seekRef.current = null;
      watchdog.stop();
      clearTimeout(recoveryTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('progress', seek);
      video.removeEventListener('canplay', seek);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [feed.url, retry]);

  useEffect(() => {
    const video = ref.current;
    if (video) {
      video.muted = !audible;
      video.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume / 100)) : 0.7;
    }
  }, [audible, volume]);
  useEffect(() => { playRef.current?.(playing); }, [playing, feed.url, retry]);
  useEffect(() => { seekRef.current?.(); }, [delay]);

  const resume = () => {
    onPlayingChange?.(true);
    controls.current.playing = true;
    if (state === 'ended' && ref.current) ref.current.currentTime = 0;
    playRef.current?.(true);
  };

  return <div className="native-player" data-playback-state={state}>
    <video ref={ref} playsInline muted={!audible} preload="auto" aria-label={feed.label} />
    {(state === 'loading' || state === 'recovering') && <div className="player-message" role="status">
      <LoaderCircle className="spin"/><span>{state === 'recovering' ? 'Reconnecting to your feed…' : 'Connecting to your feed…'}</span>
    </div>}
    {state === 'buffering' && <div className="player-message" role="status"><LoaderCircle className="spin"/><span>Buffering…</span></div>}
    {state === 'gesture' && <button type="button" className="player-message gesture" onClick={resume}><Play/><span>Click to start playback</span></button>}
    {state === 'ended' && <button type="button" className="player-message gesture" onClick={resume}><RotateCw/><span>This video has ended. Play again</span></button>}
    {state === 'error' && <div className="player-message" role="status"><AlertCircle/><strong>Feed couldn’t play</strong><p>Check the URL, availability, and whether the provider allows playback here.</p><button type="button" className="button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>}
    {state === 'ready' && <span className="feed-label">{playing ? <Radio size={12}/> : <Pause size={12}/>}<span>{playing ? feed.label : `Paused · ${feed.label}`}</span></span>}
  </div>;
}
