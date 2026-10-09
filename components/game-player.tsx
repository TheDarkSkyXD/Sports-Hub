'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import Hls from 'hls.js';
import { Popover } from 'radix-ui';
import { AlertCircle, LoaderCircle, Maximize, Minimize, Pause, PictureInPicture2, Play, Radio, RotateCcw, Settings2, Volume2, VolumeX } from 'lucide-react';
import { chooseDefaultLevel, type QualityLevel, type QualityPreference } from '@/lib/playback-quality';
import type { Feed } from '@/lib/sunday';
import { createAdvancingVideoSampler, type AdvancingVideo } from '@/lib/playback/advancing-video';

type Status = 'loading' | 'ready' | 'buffering' | 'error' | 'gesture' | 'audio-gesture' | 'ended';
type Quality = { index: number; label: string };
type Props = {
  feed: Feed;
  focused: boolean;
  audible: boolean;
  volume: number;
  defaultQuality: QualityPreference;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onAudibleChange: (audible: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onFatal?: (feedUrl:string) => void;
  onDecoded?: (feedUrl:string,evidence:AdvancingVideo) => void;
  onEnded?: (feedUrl:string) => void;
  onRetry?: (feedUrl:string) => void;
  errorHint?: string;
  startupTimeoutMs?: number;
  purpose?: 'viewing'|'verification';
};

export function GamePlayer({ feed, focused, audible, volume, defaultQuality, playing, onPlayingChange, onAudibleChange, onVolumeChange, onFatal, onDecoded, onEnded, onRetry, errorHint, startupTimeoutMs = 20000, purpose='viewing' }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const preferenceRef = useRef(defaultQuality);
  const applyDefaultRef = useRef<(() => void) | null>(null);
  const manualQualityRef = useRef(false);
  const sourceGeneration = useRef(0);
  const needsGesture = useRef(false);
  const pointerTimer = useRef<number | null>(null);
  const pointerActiveRef = useRef(false);
  const liveRef = useRef(false);
  const playingRef = useRef(playing);
  const wasPlayingRef = useRef(playing);
  const [status, setStatus] = useState<Status>('loading');
  const [retry, setRetry] = useState(0);
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [quality, setQuality] = useState(-1);
  const [nativeHls, setNativeHls] = useState(false);
  const [nativeHeight, setNativeHeight] = useState<number | null>(null);
  const [usesHls, setUsesHls] = useState(false);
  const [settings, setSettings] = useState(false);
  const [live, setLive] = useState(false);
  const [pip, setPip] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);
  const [canPip, setCanPip] = useState(false);
  const [notice, setNotice] = useState('');
  const [pointerActive, setPointerActive] = useState(false);
  const callbacks = useRef({ onFatal, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange });
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { callbacks.current = { onFatal, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange }; }, [onFatal, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange]);
  useEffect(() => {
    preferenceRef.current = defaultQuality;
    manualQualityRef.current = false;
    applyDefaultRef.current?.();
  }, [defaultQuality]);

  const syncToLive = useCallback((force = false) => {
    const video = ref.current;
    if (!video || !playingRef.current || (!force && video.paused) || !(liveRef.current || !hlsRef.current && video.duration === Infinity) || !video.seekable.length) return;
    const start = video.seekable.start(video.seekable.length - 1);
    const end = video.seekable.end(video.seekable.length - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const sync = hlsRef.current?.liveSyncPosition;
    const target = sync != null && Number.isFinite(sync) && sync >= start && sync <= end ? sync : Math.max(start, end - 3);
    if (force ? Math.abs(video.currentTime - target) > 0.5 : video.currentTime < target - 8 || video.currentTime > end) video.currentTime = target;
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    sourceGeneration.current += 1;
    let failed = false;
    let hasLoaded = false;
    let hasAdvancing = false;
    let deferredFailure = false;
    let manifestParsed = false;
    let metadataLoaded = false;
    let startupElapsed = 0;
    let lastTick = performance.now();
    needsGesture.current = false;
    liveRef.current = false;
    const native = /\.m3u8(?:\?|$)/i.test(feed.url) && !Hls.isSupported();
    const reset = window.setTimeout(() => { if (!active) return; setStatus('loading'); setSettings(false); if (!manifestParsed) { setQualities([]); setQuality(-1); setUsesHls(false); } if (!metadataLoaded) setNativeHeight(null); if (!liveRef.current && video.duration !== Infinity) setLive(false); setNativeHls(native); setNotice(''); }, 0);
    const ready = () => { if (active) { hasLoaded = true; setStatus(needsGesture.current ? 'audio-gesture' : 'ready'); syncToLive(); } };
    const loaded = () => { if (!active) return; hasLoaded = true; if (!playingRef.current) setStatus('ready'); syncToLive(); };
    const canRecover = () => playingRef.current && navigator.onLine && (purpose==='verification'||!document.hidden);
    const sampler=createAdvancingVideoSampler(performance.now());
    let nextEvidenceAt=0;
    let frameCallback: number | undefined;
    const sampleFrame=(mediaMs:number,frames:number)=>{
      if(!active||failed||!canRecover()||needsGesture.current||video.paused){sampler.reset();return;}
      const proof=sampler.sample({wallMs:performance.now(),mediaMs,currentMs:video.currentTime*1000,
        frames,width:video.videoWidth,height:video.videoHeight,playing:true});
      if(!proof)return;
      hasAdvancing=true;
      if(performance.now()>=nextEvidenceAt){
        nextEvidenceAt=performance.now()+60_000;
        callbacks.current.onDecoded?.(feed.url,proof);
      }
    };
    const observeFrame = () => {
      frameCallback = video.requestVideoFrameCallback((_now, metadata) => {
        sampleFrame(metadata.mediaTime*1000,metadata.presentedFrames);
        if (active) observeFrame();
      });
    };
    const decodedProgress = () => {
      if (video.readyState < 2 || typeof video.getVideoPlaybackQuality !== 'function') return;
      const quality = video.getVideoPlaybackQuality();
      sampleFrame(video.currentTime*1000,quality.totalVideoFrames-quality.droppedVideoFrames);
    };
    if (typeof video.requestVideoFrameCallback === 'function') observeFrame();
    else video.addEventListener('timeupdate', decodedProgress);
    const error = () => {
      if (!active || failed) return;
      if (!canRecover() || (hasLoaded && video.paused) || performance.now() - lastTick > 6000) {
        deferredFailure = true;
        if (playingRef.current) setStatus('buffering');
        return;
      }
      failed = true;
      setStatus('error');
      callbacks.current.onFatal?.(feed.url);
    };
    const ended = () => { if (active) { setStatus('ended'); callbacks.current.onEnded?.(feed.url); } };
    const waiting = () => { sampler.reset(); if (active) setStatus(current => current === 'ready' ? 'buffering' : current); };
    const paused = () => { sampler.reset(); if (active && !playingRef.current) setStatus(current => current === 'buffering' ? 'ready' : current); };
    const seeking = () => sampler.reset();
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
    video.addEventListener('seeking',seeking);
    video.addEventListener('enterpictureinpicture', enterPip);
    video.addEventListener('leavepictureinpicture', leavePip);
    video.addEventListener('play', playInPip);
    video.addEventListener('pause', pauseInPip);
    const durationChanged = () => { if (!hlsRef.current) setLive(video.duration === Infinity); syncToLive(); };
    const progressed = () => syncToLive();
    video.addEventListener('durationchange', durationChanged);
    video.addEventListener('progress', progressed);
    let lastPosition = video.currentTime;
    let lastProgress = performance.now();
    const stallCheck = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTick;
      const slept = elapsed > 6000;
      lastTick = now;
      const position = video.currentTime;
      if (deferredFailure && !slept && canRecover()) { deferredFailure = false; setRetry(value => value + 1); return; }
      if (!slept) syncToLive();
      if (!hasAdvancing && !slept && canRecover()) {
        startupElapsed += elapsed;
        if (startupElapsed >= startupTimeoutMs) error();
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
    let decodedHeight: number | null = null;
    let qualityLevels: QualityLevel[] = [];
    manualQualityRef.current = false;
    const applyDefault = () => {
      if (!active || !hls || manualQualityRef.current || qualityLevels.length === 0) return;
      const index = chooseDefaultLevel({ preference: preferenceRef.current, levels: qualityLevels });
      hls.nextLevel = index;
      setQuality(index);
    };
    applyDefaultRef.current = applyDefault;
    const refreshQualities = () => {
      if (!active || !hls) return;
      const singleLevel = hls.levels.length === 1;
      qualityLevels = hls.levels.map((level, index) => ({
        index,
        height: Number.isFinite(level.height) && level.height > 0 ? level.height : singleLevel ? decodedHeight ?? 0 : 0,
        bitrate: Number.isFinite(level.bitrate) && level.bitrate > 0 ? level.bitrate : 0,
      }));
      setQualities(qualityLevels.map(level => {
        const height = level.height;
        const bitrateKbps = level.bitrate > 0 ? Math.round(level.bitrate / 1000) : 0;
        const label = height ? `${height}p${bitrateKbps > 0 ? ` · ${bitrateKbps} kbps` : ''}` : bitrateKbps > 0 ? `${bitrateKbps} kbps` : 'Quality unavailable';
        return { index: level.index, label };
      }));
    };
    const onVideoDimensions = () => {
      if (!active || video.readyState < 1) return;
      metadataLoaded = true;
      decodedHeight = Number.isFinite(video.videoHeight) && video.videoHeight > 0 ? video.videoHeight : null;
      if (!hls) setNativeHeight(decodedHeight);
      const previousHeight = qualityLevels[0]?.height;
      refreshQualities();
      if (manifestParsed && hls?.levels.length === 1 && qualityLevels[0]?.height !== previousHeight) applyDefault();
    };
    video.addEventListener('loadedmetadata', onVideoDimensions);
    video.addEventListener('resize', onVideoDimensions);
    if (/\.m3u8(?:\?|$)/i.test(feed.url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 45, backBufferLength: 90, liveSyncDurationCount: 3,
        ...(startupTimeoutMs > 20000 ? {manifestLoadPolicy:{default:{
          ...Hls.DefaultConfig.manifestLoadPolicy.default,maxLoadTimeMs:startupTimeoutMs-5000,
        }}} : {}) });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!active || !hls) return;
        manifestParsed = true;
        refreshQualities();
        applyDefault();
        setUsesHls(true);
      });
      const updateLive = (isLive: boolean) => { if (active) { liveRef.current = isLive; setLive(isLive); syncToLive(); } };
      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => updateLive(data.details.live));
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, data) => updateLive(data.details.live));
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
      if (applyDefaultRef.current === applyDefault) applyDefaultRef.current = null;
      video.pause();
      video.removeEventListener('playing', ready); video.removeEventListener('loadeddata', loaded);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback(frameCallback);
      video.removeEventListener('timeupdate', decodedProgress);
      video.removeEventListener('error', error); video.removeEventListener('ended', ended);
      video.removeEventListener('waiting', waiting); video.removeEventListener('pause', paused);
      video.removeEventListener('seeking',seeking);
      video.removeEventListener('enterpictureinpicture', enterPip); video.removeEventListener('leavepictureinpicture', leavePip);
      video.removeEventListener('play', playInPip); video.removeEventListener('pause', pauseInPip);
      video.removeEventListener('durationchange', durationChanged); video.removeEventListener('progress', progressed);
      video.removeEventListener('loadedmetadata', onVideoDimensions); video.removeEventListener('resize', onVideoDimensions);
      video.removeAttribute('src'); video.load();
    };
  }, [feed.url, retry, startupTimeoutMs, syncToLive, purpose]);

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
      if (!wasPlayingRef.current) syncToLive(true);
      void video.play().catch(async reason => {
        if (!active || reason?.name === 'AbortError') return;
        if (reason?.name === 'NotAllowedError' && !video.muted) {
          needsGesture.current = true;
          video.muted = true;
          try { await video.play(); if (active) setStatus('audio-gesture'); return; }
          catch (again) { if (!active || (again instanceof Error && again.name === 'AbortError')) return; }
        }
        if (active) {
          needsGesture.current = true;
          setStatus(current => current === 'error' ? current : 'gesture');
        }
      });
    };
    video.addEventListener('loadedmetadata', sync);
    sync();
    wasPlayingRef.current = playing;
    return () => { active = false; video.removeEventListener('loadedmetadata', sync); };
  }, [playing, feed.url, retry, syncToLive]);

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

  const toggleFullscreen = async () => { try { if (document.fullscreenElement === shell.current) await document.exitFullscreen(); else await shell.current?.requestFullscreen(); } catch { setNotice('Fullscreen is unavailable for this stream.'); } };
  const togglePip = async () => {
    const video = ref.current;
    if (!video || !document.pictureInPictureEnabled) return;
    try { if (document.pictureInPictureElement === video) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { setNotice('Picture in picture is unavailable for this stream.'); }
  };
  const chooseQuality = (index: number) => { if (hlsRef.current) { manualQualityRef.current = true; hlsRef.current.currentLevel = index; setQuality(index); } setSettings(false); };
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
  return <div ref={shell} className={`native-player ${focused ? 'player-focused' : ''} ${settings ? 'player-settings-open' : ''} ${pointerActive ? 'player-pointer-active' : ''}`} onPointerEnter={showControls} onPointerMove={showControls} onPointerLeave={hideControls}>
    <video ref={ref} playsInline autoPlay={playing} muted={!audible} aria-label={feed.label}/>
    {notice && <div className="player-notice" role="status">{notice}</div>}
    {status === 'loading' && <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
    {status === 'buffering' && <div className="player-buffering" role="status"><LoaderCircle className="spin" size={20}/><span>Buffering</span></div>}
    {status === 'gesture' && playing && <button className="player-message gesture" onClick={enablePlayback}><Play/><span>{audible ? 'Click to enable audio' : 'Click to start playback'}</span></button>}
    {status === 'audio-gesture' && audible && playing && <button className="feed-audio-prompt" onClick={enableAudio}>Enable audio</button>}
    {status === 'ended' && playing && <button className="player-message gesture" onClick={() => { if (ref.current) { ref.current.currentTime = 0; enablePlayback(); } }}><RotateCcw/><span>Replay video</span></button>}
    {status === 'error' && <div className="player-message"><AlertCircle/><strong>Feed couldn&apos;t play</strong><p>{errorHint || 'Check the URL, availability, and whether the provider allows playback here.'}</p><button className="button" onClick={() => onRetry ? onRetry(feed.url) : setRetry(value => value + 1)}>Try again</button></div>}
    {status === 'ready' && !focused && <span className="feed-label"><Radio size={12}/>{feed.label}</span>}
    {focused && status !== 'error' && <div className="player-controls" role="group" aria-label="Focused stream controls">
      <div className="player-control-row">
        <button aria-label={playing ? 'Pause stream' : 'Play stream'} title={playing ? 'Pause focused game (Space)' : 'Play focused game (Space)'} onClick={() => callbacks.current.onPlayingChange(!playing)}>{playing ? <Pause size={17} fill="currentColor"/> : <Play size={17} fill="currentColor"/>}</button>
        <button aria-label={audible ? 'Mute stream' : 'Unmute stream'} title="Toggle focused audio (M)" onClick={() => callbacks.current.onAudibleChange(!audible)}>{audible ? <Volume2 size={17}/> : <VolumeX size={17}/>}</button>
        <input className="player-volume" type="range" min="0" max="100" step="1" value={volume} aria-label="Stream volume" onChange={event => callbacks.current.onVolumeChange(Number(event.target.value))}/>
        <span className="player-source">{feed.label}</span>
        {live && <span className="player-live"><Radio size={10}/>LIVE</span>}
        {canPip && <button aria-label={pip ? 'Exit picture in picture' : 'Picture in picture'} title="Picture in picture" onClick={() => void togglePip()}><PictureInPicture2 size={17}/></button>}
        <Popover.Root open={settings} onOpenChange={setSettings}>
          <Popover.Trigger asChild><button aria-label="Video quality" title="Quality settings"><Settings2 size={17}/></button></Popover.Trigger>
          <Popover.Portal container={portalContainer ?? undefined}>
            <Popover.Content className="player-settings" side="top" align="end" sideOffset={6} collisionPadding={8} aria-label="Playback quality">
              <strong>Quality</strong>
              <div className="player-settings-options" role="group" aria-label="Playback quality options">
                {usesHls ? <><button className={quality === -1 ? 'selected' : ''} onClick={() => chooseQuality(-1)}>Auto {quality === -1 ? '✓' : ''}</button>{qualities.map(level => <button key={level.index} className={quality === level.index ? 'selected' : ''} onClick={() => chooseQuality(level.index)}>{level.label} {quality === level.index ? '✓' : ''}</button>)}</> : <span>{nativeHeight ? `${nativeHeight}p · ` : ''}{nativeHls ? 'Managed by your browser' : 'This feed has one quality'}</span>}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <button aria-label={fullscreen ? 'Exit fullscreen stream' : 'Fullscreen stream'} title="Fullscreen focused game" onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={17}/> : <Maximize size={17}/>}</button>
      </div>
    </div>}
  </div>;
}
