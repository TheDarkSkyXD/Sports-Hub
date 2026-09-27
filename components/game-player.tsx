'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import Hls from 'hls.js';
import { Popover } from 'radix-ui';
import { AlertCircle, LoaderCircle, Maximize, Minimize, Pause, PictureInPicture2, Play, Radio, RotateCcw, Settings2, Volume2, VolumeX } from 'lucide-react';
import type { Feed } from '@/lib/sunday';

type Status = 'loading' | 'ready' | 'buffering' | 'error' | 'gesture' | 'audio-gesture' | 'ended';
type Quality = { index: number; label: string };
type Timeline = { start: number; end: number; current: number; live: boolean };
type Props = {
  feed: Feed;
  focused: boolean;
  audible: boolean;
  volume: number;
  playing: boolean;
  delay: number;
  onPlayingChange: (playing: boolean) => void;
  onAudibleChange: (audible: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onFatal?: () => void;
  onEnded?: () => void;
  onRetry?: () => void;
  errorHint?: string;
};

function time(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 3600) ? `${Math.floor(whole / 3600)}:` : ''}${Math.floor(whole % 3600 / 60).toString().padStart(whole >= 3600 ? 2 : 1, '0')}:${(whole % 60).toString().padStart(2, '0')}`;
}

export function GamePlayer({ feed, focused, audible, volume, playing, delay, onPlayingChange, onAudibleChange, onVolumeChange, onFatal, onEnded, onRetry, errorHint }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sourceGeneration = useRef(0);
  const needsGesture = useRef(false);
  const pointerTimer = useRef<number | null>(null);
  const pointerActiveRef = useRef(false);
  const liveRef = useRef(false);
  const previousDelay = useRef(delay);
  const playingRef = useRef(playing);
  const [status, setStatus] = useState<Status>('loading');
  const [retry, setRetry] = useState(0);
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [quality, setQuality] = useState(-1);
  const [nativeHls, setNativeHls] = useState(false);
  const [usesHls, setUsesHls] = useState(false);
  const [syncPosition, setSyncPosition] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [pip, setPip] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const [canPip, setCanPip] = useState(false);
  const [notice, setNotice] = useState('');
  const [pointerActive, setPointerActive] = useState(false);
  const callbacks = useRef({ onFatal, onEnded, onPlayingChange, onAudibleChange, onVolumeChange });
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { callbacks.current = { onFatal, onEnded, onPlayingChange, onAudibleChange, onVolumeChange }; }, [onFatal, onEnded, onPlayingChange, onAudibleChange, onVolumeChange]);

  const updateTimeline = useCallback(() => {
    const video = ref.current;
    if (!video || !video.seekable.length) { setTimeline(null); return; }
    const start = video.seekable.start(0);
    const end = video.seekable.end(video.seekable.length - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 1) { setTimeline(null); return; }
    const live = liveRef.current || !Number.isFinite(video.duration);
    setTimeline({ start, end, current: Math.min(end, Math.max(start, video.currentTime)), live });
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    sourceGeneration.current += 1;
    let failed = false;
    let hasLoaded = false;
    let deferredFailure = false;
    let startupElapsed = 0;
    let lastTick = performance.now();
    needsGesture.current = false;
    liveRef.current = false;
    const native = /\.m3u8(?:\?|$)/i.test(feed.url) && !Hls.isSupported();
    const reset = window.setTimeout(() => { setStatus('loading'); setSettings(false); setQualities([]); setQuality(-1); setTimeline(null); setNativeHls(native); setUsesHls(false); setSyncPosition(null); setNotice(''); }, 0);
    const ready = () => { if (active) { hasLoaded = true; setStatus(needsGesture.current ? 'audio-gesture' : 'ready'); updateTimeline(); } };
    const loaded = () => { if (!active) return; hasLoaded = true; if (!playingRef.current) setStatus('ready'); updateTimeline(); };
    const canRecover = () => playingRef.current && navigator.onLine && !document.hidden;
    const error = () => {
      if (!active || failed) return;
      if (!canRecover() || (hasLoaded && video.paused) || performance.now() - lastTick > 6000) {
        deferredFailure = true;
        if (playingRef.current) setStatus('buffering');
        return;
      }
      failed = true;
      setStatus('error');
      callbacks.current.onFatal?.();
    };
    const ended = () => { if (active) { setStatus('ended'); callbacks.current.onEnded?.(); } };
    const waiting = () => { if (active) setStatus(current => current === 'ready' ? 'buffering' : current); };
    const paused = () => { if (active && !playingRef.current) setStatus(current => current === 'buffering' ? 'ready' : current); };
    const enterPip = () => { if (active) setPip(true); };
    const leavePip = () => { if (active) setPip(false); };
    const playInPip = () => { if (active && document.pictureInPictureElement === video) callbacks.current.onPlayingChange(true); };
    const pauseInPip = () => { if (active && document.pictureInPictureElement === video) callbacks.current.onPlayingChange(false); };
    video.addEventListener('playing', ready);
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', error);
    video.addEventListener('ended', ended);
    video.addEventListener('waiting', waiting);
    video.addEventListener('pause', paused);
    video.addEventListener('enterpictureinpicture', enterPip);
    video.addEventListener('leavepictureinpicture', leavePip);
    video.addEventListener('play', playInPip);
    video.addEventListener('pause', pauseInPip);
    video.addEventListener('timeupdate', updateTimeline);
    video.addEventListener('durationchange', updateTimeline);
    video.addEventListener('progress', updateTimeline);
    let lastPosition = video.currentTime;
    let lastProgress = performance.now();
    const stallCheck = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTick;
      const slept = elapsed > 6000;
      lastTick = now;
      const position = video.currentTime;
      if (deferredFailure && !slept && canRecover()) { deferredFailure = false; setRetry(value => value + 1); return; }
      if (!hasLoaded && !slept && canRecover()) {
        startupElapsed += elapsed;
        if (startupElapsed >= 20000 && video.readyState < 2) error();
      }
      if (slept || !hasLoaded || !canRecover() || video.paused || video.ended) {
        lastPosition = position;
        lastProgress = now;
        return;
      }
      if (Math.abs(position - lastPosition) >= 0.25) { lastPosition = position; lastProgress = now; }
      else if (now - lastProgress >= 15000) error();
    }, 2000);
    let hls: Hls | null = null;
    if (/\.m3u8(?:\?|$)/i.test(feed.url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 45, backBufferLength: 90, liveSyncDurationCount: 3 });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!active || !hls) return;
        const levels = hls.levels.map((level, index) => ({ index, label: level.height ? `${level.height}p${level.bitrate ? ` · ${Math.round(level.bitrate / 1000)} kbps` : ''}` : `${Math.round(level.bitrate / 1000)} kbps` }));
        setQualities(levels);
        setUsesHls(true);
      });
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => { if (active) { liveRef.current = data.details.live; setSyncPosition(hls?.liveSyncPosition ?? null); updateTimeline(); } });
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => { if (active) { liveRef.current = data.details.live; setSyncPosition(hls?.liveSyncPosition ?? null); updateTimeline(); } });
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) error(); });
      hls.loadSource(feed.url);
      hls.attachMedia(video);
    } else {
      video.src = feed.url;
    }
    return () => {
      active = false;
      sourceGeneration.current += 1;
      window.clearInterval(stallCheck);
      window.clearTimeout(reset);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      video.pause();
      video.removeEventListener('playing', ready); video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', error); video.removeEventListener('ended', ended);
      video.removeEventListener('waiting', waiting); video.removeEventListener('pause', paused);
      video.removeEventListener('enterpictureinpicture', enterPip); video.removeEventListener('leavepictureinpicture', leavePip);
      video.removeEventListener('play', playInPip); video.removeEventListener('pause', pauseInPip);
      video.removeEventListener('timeupdate', updateTimeline);
      video.removeEventListener('durationchange', updateTimeline); video.removeEventListener('progress', updateTimeline);
      video.removeAttribute('src'); video.load();
    };
  }, [feed.url, retry, updateTimeline]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = !audible || needsGesture.current;
    video.volume = volume / 100;
  }, [audible, volume, feed.url]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    const sync = () => {
      if (!playing) { video.pause(); return; }
      void video.play().catch(async reason => {
        if (!active || reason?.name === 'AbortError') return;
        if (reason?.name === 'NotAllowedError' && !video.muted) {
          needsGesture.current = true;
          video.muted = true;
          try { await video.play(); if (active) setStatus('audio-gesture'); return; }
          catch (again) { if (!active || (again instanceof Error && again.name === 'AbortError')) return; }
        }
        if (active) setStatus(current => current === 'error' ? current : 'gesture');
      });
    };
    video.addEventListener('loadedmetadata', sync);
    sync();
    return () => { active = false; video.removeEventListener('loadedmetadata', sync); };
  }, [playing, feed.url, retry]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const returningLive = previousDelay.current > 0 && delay === 0;
    previousDelay.current = delay;
    let applied = false;
    const apply = () => {
      if (applied || !video.seekable.length) return;
      const end = video.seekable.end(video.seekable.length - 1);
      if (delay > 0) video.currentTime = Math.max(video.seekable.start(0), end - Math.max(3, delay));
      else if (returningLive && (liveRef.current || video.duration === Infinity)) {
        const sync = hlsRef.current?.liveSyncPosition;
        video.currentTime = Math.min(end, Math.max(video.seekable.start(0), sync != null && Number.isFinite(sync) ? sync : end - 3));
      } else return;
      applied = true;
    };
    video.addEventListener('loadedmetadata', apply);
    video.addEventListener('progress', apply);
    apply();
    return () => { video.removeEventListener('loadedmetadata', apply); video.removeEventListener('progress', apply); };
  }, [delay, feed.url, retry]);

  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4000); return () => window.clearTimeout(timer); }, [notice]);

  useEffect(() => {
    const update = () => {
      const element = document.fullscreenElement;
      setFullscreen(element === shell.current);
      setPortalContainer(element instanceof HTMLElement ? element : null);
    };
    document.addEventListener('fullscreenchange', update);
    update();
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => { setCanPip(document.pictureInPictureEnabled && typeof ref.current?.requestPictureInPicture === 'function'); }, []);

  useEffect(() => () => { if (pointerTimer.current !== null) window.clearTimeout(pointerTimer.current); }, []);

  const hideControls = () => {
    if (pointerTimer.current !== null) window.clearTimeout(pointerTimer.current);
    pointerTimer.current = null;
    if (pointerActiveRef.current) { pointerActiveRef.current = false; setPointerActive(false); }
  };
  const showControls = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (!pointerActiveRef.current) { pointerActiveRef.current = true; setPointerActive(true); }
    if (pointerTimer.current !== null) window.clearTimeout(pointerTimer.current);
    pointerTimer.current = window.setTimeout(() => {
      pointerTimer.current = null;
      if (pointerActiveRef.current) { pointerActiveRef.current = false; setPointerActive(false); }
    }, 3000);
  };

  useEffect(() => {
    if (!focused) queueMicrotask(() => setSettings(false));
    if (!focused && document.fullscreenElement === shell.current) {
      void document.exitFullscreen().catch(() => setNotice('Press Esc to leave this stream fullscreen.'));
    }
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || document.querySelector('[role="dialog"]') || (event.target instanceof HTMLElement && event.target.closest('input,textarea,select,button,[role="slider"],[contenteditable]'))) return;
      const video = ref.current;
      if (!video?.seekable.length) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const start = video.seekable.start(0), end = video.seekable.end(video.seekable.length - 1);
        video.currentTime = Math.min(end, Math.max(start, video.currentTime + (event.key === 'ArrowLeft' ? -10 : 10)));
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  const seek = (value: number) => { const video = ref.current; if (video && timeline) video.currentTime = timeline.start + (timeline.end - timeline.start) * value / 1000; };
  const live = () => {
    const video = ref.current; if (!video?.seekable.length) return;
    const start = video.seekable.start(0), end = video.seekable.end(video.seekable.length - 1);
    const sync = hlsRef.current?.liveSyncPosition;
    video.currentTime = Math.min(end, Math.max(start, sync != null && Number.isFinite(sync) ? sync : end - 3));
  };
  const toggleFullscreen = async () => { try { if (document.fullscreenElement === shell.current) await document.exitFullscreen(); else await shell.current?.requestFullscreen(); } catch { setNotice('Fullscreen is unavailable for this stream.'); } };
  const togglePip = async () => {
    const video = ref.current;
    if (!video || !document.pictureInPictureEnabled) return;
    try { if (document.pictureInPictureElement === video) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { setNotice('Picture in picture is unavailable for this stream.'); }
  };
  const chooseQuality = (index: number) => { if (hlsRef.current) { hlsRef.current.currentLevel = index; setQuality(index); } setSettings(false); };
  const enablePlayback = () => {
    const video = ref.current; if (!video) return;
    const generation = sourceGeneration.current;
    video.muted = !audible;
    void video.play().then(() => { if (sourceGeneration.current === generation) { needsGesture.current = false; setStatus('ready'); } }).catch(() => { if (sourceGeneration.current === generation) setStatus('gesture'); });
  };
  const enableAudio = () => {
    const video = ref.current; if (!video) return;
    const generation = sourceGeneration.current;
    video.muted = false;
    void video.play().then(() => { if (sourceGeneration.current === generation) { needsGesture.current = false; setStatus('ready'); } }).catch(() => { if (sourceGeneration.current === generation) { video.muted = true; setStatus('audio-gesture'); } });
  };
  const safeLivePosition = timeline && syncPosition != null && Number.isFinite(syncPosition) ? syncPosition : timeline ? timeline.end - 3 : 0;
  const behindLive = timeline?.live && timeline.current < Math.max(timeline.start, safeLivePosition - 2);

  return <div ref={shell} className={`native-player ${focused ? 'player-focused' : ''} ${settings ? 'player-settings-open' : ''} ${pointerActive ? 'player-pointer-active' : ''}`} onPointerEnter={showControls} onPointerMove={showControls} onPointerLeave={hideControls}>
    <video ref={ref} playsInline autoPlay={playing} muted={!audible} aria-label={feed.label}/>
    {notice && <div className="player-notice" role="status">{notice}</div>}
    {status === 'loading' && <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
    {status === 'buffering' && <div className="player-buffering" role="status"><LoaderCircle className="spin" size={20}/><span>Buffering</span></div>}
    {status === 'gesture' && playing && <button className="player-message gesture" onClick={enablePlayback}><Play/><span>{audible ? 'Click to enable audio' : 'Click to start playback'}</span></button>}
    {status === 'audio-gesture' && audible && playing && <button className="feed-audio-prompt" onClick={enableAudio}>Enable audio</button>}
    {status === 'ended' && playing && <button className="player-message gesture" onClick={() => { if (ref.current) { ref.current.currentTime = 0; enablePlayback(); } }}><RotateCcw/><span>Replay video</span></button>}
    {status === 'error' && <div className="player-message"><AlertCircle/><strong>Feed couldn&apos;t play</strong><p>{errorHint || 'Check the URL, availability, and whether the provider allows playback here.'}</p><button className="button" onClick={() => onRetry ? onRetry() : setRetry(value => value + 1)}>Try again</button></div>}
    {status === 'ready' && !focused && <span className="feed-label"><Radio size={12}/>{feed.label}</span>}
    {focused && status !== 'error' && <div className="player-controls" role="group" aria-label="Focused stream controls">
      {timeline && <div className="player-timeline"><input type="range" min="0" max="1000" step="1" value={Math.round((timeline.current - timeline.start) / (timeline.end - timeline.start) * 1000)} aria-label={`Seek ${feed.label}`} onChange={event => seek(Number(event.target.value))}/><span>{timeline.live ? behindLive ? `-${time(timeline.end - timeline.current)}` : 'LIVE' : time(timeline.current - timeline.start)}</span>{timeline.live ? <button className={behindLive ? 'go-live' : 'at-live'} onClick={live} disabled={!behindLive}>● LIVE</button> : <span>{time(timeline.end - timeline.start)}</span>}</div>}
      <div className="player-control-row">
        <button aria-label={playing ? 'Pause stream' : 'Play stream'} title={playing ? 'Pause focused game (Space)' : 'Play focused game (Space)'} onClick={() => callbacks.current.onPlayingChange(!playing)}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</button>
        <button aria-label={audible ? 'Mute stream' : 'Unmute stream'} title="Toggle focused audio (M)" onClick={() => callbacks.current.onAudibleChange(!audible)}>{audible ? <Volume2 size={17}/> : <VolumeX size={17}/>}</button>
        <input className="player-volume" type="range" min="0" max="100" step="1" value={volume} aria-label="Stream volume" onChange={event => callbacks.current.onVolumeChange(Number(event.target.value))}/>
        <span className="player-source">{feed.label}</span>
        {canPip && <button aria-label={pip ? 'Exit picture in picture' : 'Picture in picture'} title="Picture in picture" onClick={() => void togglePip()}><PictureInPicture2 size={17}/></button>}
        <Popover.Root open={settings} onOpenChange={setSettings}>
          <Popover.Trigger asChild><button aria-label="Video quality" title="Quality settings"><Settings2 size={17}/></button></Popover.Trigger>
          <Popover.Portal container={portalContainer ?? undefined}>
            <Popover.Content className="player-settings" side="top" align="end" sideOffset={6} collisionPadding={8} aria-label="Playback quality">
              <strong>Quality</strong>
              <div className="player-settings-options" role="group" aria-label="Playback quality options">
                {usesHls ? <><button className={quality === -1 ? 'selected' : ''} onClick={() => chooseQuality(-1)}>Auto {quality === -1 ? '✓' : ''}</button>{qualities.map(level => <button key={level.index} className={quality === level.index ? 'selected' : ''} onClick={() => chooseQuality(level.index)}>{level.label} {quality === level.index ? '✓' : ''}</button>)}</> : <span>{nativeHls ? 'Managed by your browser' : 'This feed has one quality'}</span>}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button aria-label={fullscreen ? 'Exit fullscreen stream' : 'Fullscreen stream'} title="Fullscreen focused game" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={17}/> : <Maximize size={17}/>}</button>
      </div>
    </div>}
  </div>;
}
