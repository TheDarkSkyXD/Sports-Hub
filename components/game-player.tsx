'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import Hls from 'hls.js';
import {AlertCircle,LoaderCircle,Play,Radio,RotateCcw} from 'lucide-react';
import { chooseDefaultLevel, type QualityLevel, type QualityPreference } from '@/lib/playback-quality';
import type { Feed } from '@/lib/sunday';
import type { AdvancingVideo } from '@/lib/playback/advancing-video';
import { observeVideoEvidence } from '@/lib/playback/video-evidence';
import type { MediaFailureReason,MediaPhase,MediaDeferralReason,MediaTimings } from '@/lib/football/shared';
import {relayOutcome} from '@/lib/playback/presentation';
import {PlayerControlsSurface,type PlayerControlsQuality} from './player-controls-surface';
import {QualityLevelIdSchema,type PlayerUiResult,type QualitySelection} from '@/lib/desktop-player';
import type {DashPlayback} from './dash-playback';

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
  onFocus?:()=>void;
  onFatal?: (feedUrl:string,reason?:MediaFailureReason,phase?:MediaPhase) => void;
  onDeferred?: (feedUrl:string,reason:MediaDeferralReason,details?:{phase?:MediaPhase;retryAfterMs?:number}) => void;
  onDecoded?: (feedUrl:string,evidence:AdvancingVideo,timings?:MediaTimings) => void;
  onEnded?: (feedUrl:string) => void;
  onRetry?: (feedUrl:string) => void;
  errorHint?: string;
  startupTimeoutMs?: number;
  noProgressTimeoutMs?: number;
  purpose?: 'viewing'|'verification';
  format?:'hls'|'dash'|'progressive'|'flv'|'mpegts';
};

export function GamePlayer({ feed, focused, audible, volume, defaultQuality, playing, onPlayingChange, onAudibleChange, onVolumeChange, onFatal, onDeferred, onDecoded, onEnded, onRetry, errorHint, startupTimeoutMs = 20000, noProgressTimeoutMs, purpose='viewing',format }: Props) {
  const shell = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const dashRef=useRef<DashPlayback|null>(null);
  const preferenceRef = useRef(defaultQuality);
  const applyDefaultRef = useRef<(() => void) | null>(null);
  const manualQualityRef = useRef(false);
  const sourceGeneration = useRef(0);
  const needsGesture = useRef(false);
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
  const [live, setLive] = useState(false);
  const [pip, setPip] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const callbacks = useRef({ onFatal, onDeferred, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange });
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { callbacks.current = { onFatal, onDeferred, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange }; }, [onFatal, onDeferred, onDecoded, onEnded, onPlayingChange, onAudibleChange, onVolumeChange]);
  useEffect(() => {
    preferenceRef.current = defaultQuality;
    manualQualityRef.current = false;
    applyDefaultRef.current?.();
  }, [defaultQuality]);

  const syncToLive = useCallback((force = false) => {
    const video = ref.current;
    if (!video || !playingRef.current || !force && (video.paused || hlsRef.current || format==='dash'||format==='flv'||format==='mpegts') || !(liveRef.current || !hlsRef.current && video.duration === Infinity) || !video.seekable.length) return;
    const start = video.seekable.start(video.seekable.length - 1);
    const end = video.seekable.end(video.seekable.length - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const sync = hlsRef.current?.liveSyncPosition;
    const target = sync != null && Number.isFinite(sync) && sync >= start && sync <= end ? sync : Math.max(start, end - 3);
    if (force ? Math.abs(video.currentTime - target) > 0.5 : video.currentTime < target - 8 || video.currentTime > end) video.currentTime = target;
  }, [format]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    const controller=new AbortController();
    sourceGeneration.current += 1;
    let failed = false;
    let hasLoaded = false;
    let startupState:'waiting'|'moving'|'proved'='waiting';
    let deferredFailure = false;
    let manifestParsed = false;
    let metadataLoaded = false;
    let startupElapsed = 0;
    let lastTick = performance.now();
    needsGesture.current = false;
    liveRef.current = false;
    const isHls=format==='hls'||format===undefined&&/\.m3u8(?:\?|$)/i.test(feed.url);
    const native = isHls && !Hls.isSupported();
    const reset = window.setTimeout(() => { if (!active) return; setStatus('loading'); if (!manifestParsed) { setQualities([]); setQuality(-1); setUsesHls(false); } if (!metadataLoaded) setNativeHeight(null); if (!liveRef.current && video.duration !== Infinity) setLive(false); setNativeHls(native); }, 0);
    const ready = () => { if (active) { hasLoaded = true; setStatus(needsGesture.current ? 'audio-gesture' : 'ready'); syncToLive(); } };
    const loaded = () => { if (!active) return; hasLoaded = true; if (!playingRef.current) setStatus('ready'); syncToLive(); };
    const canRecover = () => playingRef.current && navigator.onLine && (purpose==='verification'||!document.hidden);
    const evidence = observeVideoEvidence({ video, sourceStartedAt: performance.now(), sampleIntervalMs: purpose === 'verification' ? 0 : 1000,
      canSample: () => active && !failed && canRecover() && !needsGesture.current,
      onProof: proof => { startupState='proved'; callbacks.current.onDecoded?.(feed.url, proof,{decodeMs:proof.startupMs}); },
    });
    const fail = (reason:MediaFailureReason,phase:MediaPhase='decode') => {
      if (!active || failed) return;
      if (!canRecover() || (hasLoaded && video.paused) || performance.now() - lastTick > 6000) {
        deferredFailure = true;
        if (playingRef.current) setStatus('buffering');
        return;
      }
      failed = true;
      setStatus('error');
      callbacks.current.onFatal?.(feed.url,reason,phase);
    };
    const error = () => fail(video.error?.code===3?'invalid-media':video.error?.code===4?'unsupported':video.error?.code===2?'upstream':'playback');
    const ended = () => { if (active) { setStatus('ended'); callbacks.current.onEnded?.(feed.url); } };
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
    const durationChanged = () => { if (!hlsRef.current) setLive(video.duration === Infinity); syncToLive(); };
    const progressed = () => syncToLive();
    video.addEventListener('durationchange', durationChanged);
    video.addEventListener('progress', progressed);
    let lastPosition = video.currentTime;
    const initialQuality = video.getVideoPlaybackQuality?.();
    let lastFrames = initialQuality ? initialQuality.totalVideoFrames - initialQuality.droppedVideoFrames : undefined;
    let lastProgress = performance.now();
    const stallCheck = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTick;
      const slept = elapsed > 6000;
      lastTick = now;
      const position = video.currentTime;
      const quality = video.getVideoPlaybackQuality?.();
      const frames = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined;
      if (deferredFailure && !slept && canRecover()) { deferredFailure = false; setRetry(value => value + 1); return; }
      const forwardMs=(position-lastPosition)*1000;
      if(startupState==='waiting'&&!slept&&hasLoaded&&canRecover()&&!video.paused&&!video.ended&&!video.seeking&&video.readyState>=2&&
        forwardMs>=250&&forwardMs<=elapsed*1.5+500)startupState='moving';
      if (!slept) syncToLive();
      if (startupState!=='proved' && !slept && canRecover()) {
        startupElapsed += elapsed;
        if(startupElapsed>=startupTimeoutMs||startupState==='waiting'&&noProgressTimeoutMs!==undefined&&startupElapsed>=noProgressTimeoutMs)fail('timeout');
      }
      if (slept || !hasLoaded || !canRecover() || video.paused || video.ended || purpose==='verification'&&startupState!=='proved') {
        lastPosition = position;
        lastFrames = frames;
        lastProgress = now;
        return;
      }
      const framesReset = frames !== undefined && lastFrames !== undefined && frames < lastFrames;
      const framesAdvance = frames === undefined || lastFrames === undefined || frames > lastFrames;
      if (framesReset || Math.abs(position - lastPosition) >= 0.25 && framesAdvance) {
        lastPosition = position; lastFrames = frames; lastProgress = now;
      }
      else if (now - lastProgress >= 15000) error();
    }, 2000);
    let hls: Hls | null = null;
    let decodedHeight: number | null = null;
    let qualityLevels: QualityLevel[] = [];
    manualQualityRef.current = false;
    const applyDefault = () => {
      if (!active || !hls&&!dashRef.current || manualQualityRef.current || qualityLevels.length === 0) return;
      const index = chooseDefaultLevel({ preference: preferenceRef.current, levels: qualityLevels });
      if(hls)hls.nextLevel = index;
      else dashRef.current?.chooseQuality(index);
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
    if(format==='dash'){
      void import('./dash-playback').then(({loadDashPlayback})=>loadDashPlayback({video,url:feed.url,signal:controller.signal,purpose,
        onFailure:outcome=>{
          if(!active||failed)return;
          if(outcome.kind==='deferred'&&purpose==='verification'&&callbacks.current.onDeferred){
            failed=true;controller.abort();callbacks.current.onDeferred(feed.url,outcome.reason??'upstream',{phase:outcome.phase,retryAfterMs:outcome.retryAfterMs});
          }else{fail(outcome.kind==='unavailable'?outcome.reason??'playback':'upstream',outcome.phase??'replay');if(failed)controller.abort();}
        },
      })).then(player=>{
        if(!active)return;
        dashRef.current=player;manifestParsed=true;
        qualityLevels=player.qualities.map((level,index)=>({...level,index}));
        setQualities(qualityLevels.map(level=>({index:level.index,label:level.height?`${level.height}p`:'Quality unavailable'})));
        setUsesHls(true);liveRef.current=player.live;setLive(player.live);applyDefault();
      }).catch(()=>{if(active&&!failed)fail('unsupported','replay');});
    }else if(format==='flv'||format==='mpegts'){
      void import('./container-playback').then(({loadContainerPlayback})=>loadContainerPlayback({video,url:feed.url,format,
        signal:controller.signal,purpose,onFailure:outcome=>{
          if(!active||failed)return;
          if(outcome.kind==='deferred'&&purpose==='verification'&&callbacks.current.onDeferred){
            failed=true;controller.abort();callbacks.current.onDeferred(feed.url,outcome.reason??'upstream',{phase:outcome.phase,retryAfterMs:outcome.retryAfterMs});
          }else{fail(outcome.kind==='unavailable'?outcome.reason??'playback':'upstream',outcome.phase??'replay');if(failed)controller.abort();}
        },
      })).catch(()=>{if(active&&!failed)fail('unsupported','replay');});
    }else if (isHls && Hls.isSupported()) {
      hls = new Hls({ workerPath: '/generated/hls.worker.js', ...(purpose === 'verification'
        ? { maxBufferLength: 4, maxMaxBufferLength: 8, maxBufferSize: 8_000_000, backBufferLength: 0 }
        : { maxBufferLength: 45, maxMaxBufferLength: 60, backBufferLength: 15 }), liveSyncDurationCount: 3,
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
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if(!active||failed)return;
        const code=data.response?.code;
        const reported=relayOutcome(data.networkDetails)??relayOutcome(data.response?.data);
        const invalidPlaylist=data.details===Hls.ErrorDetails.MANIFEST_PARSING_ERROR||data.details===Hls.ErrorDetails.LEVEL_PARSING_ERROR;
        const unsupportedCodec=data.details===Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR&&
          (data.error?.name==='NotSupportedError'||!!data.mimeType&&typeof MediaSource!=='undefined'&&!MediaSource.isTypeSupported(data.mimeType));
        if(purpose==='verification'&&callbacks.current.onDeferred&&
          (code===429||code===503||data.fatal&&data.type===Hls.ErrorTypes.NETWORK_ERROR&&!invalidPlaylist&&
            (code===undefined||code===0||code===408||code>=500))){
          failed=true;
          hls?.stopLoad();
          const deferred=reported?.kind==='deferred'?reported:null;
          callbacks.current.onDeferred(feed.url,deferred?.reason??(code===429?'capacity':'upstream'),
            {phase:deferred?.phase??'replay',retryAfterMs:deferred?.retryAfterMs??(code===429?2000:30000)});
          return;
        }
        if(data.fatal){
          fail(reported?.kind==='unavailable'?reported.reason:code===401||code===403?'blocked':code===404||code===410?'not-found':
            code===415||unsupportedCodec?'unsupported':code===422||data.type===Hls.ErrorTypes.MEDIA_ERROR||invalidPlaylist?'invalid-media':
              data.type===Hls.ErrorTypes.NETWORK_ERROR?'upstream':'playback',reported?.phase??'replay');
        }
      });
      hls.loadSource(feed.url);
      hls.attachMedia(video);
    } else {
      video.src = feed.url;
    }
    return () => {
      active = false;
      controller.abort();dashRef.current=null;
      evidence.stop();
      sourceGeneration.current += 1;
      window.clearInterval(stallCheck);
      window.clearTimeout(reset);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
      if (applyDefaultRef.current === applyDefault) applyDefaultRef.current = null;
      video.pause();
      video.removeEventListener('playing', ready); video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', error); video.removeEventListener('ended', ended);
      video.removeEventListener('waiting', waiting); video.removeEventListener('pause', paused);
      video.removeEventListener('enterpictureinpicture', enterPip); video.removeEventListener('leavepictureinpicture', leavePip);
      video.removeEventListener('play', playInPip); video.removeEventListener('pause', pauseInPip);
      video.removeEventListener('durationchange', durationChanged); video.removeEventListener('progress', progressed);
      video.removeEventListener('loadedmetadata', onVideoDimensions); video.removeEventListener('resize', onVideoDimensions);
      video.removeAttribute('src'); video.load();
    };
  }, [feed.url, retry, startupTimeoutMs, noProgressTimeoutMs, syncToLive, purpose,format]);

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
    let recovery: ReturnType<typeof setTimeout> | undefined;
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
    const canResume = () => active && playingRef.current && video.paused && !video.ended && !video.error && !needsGesture.current && !document.hidden && document.pictureInPictureElement !== video;
    const recover = () => {
      clearTimeout(recovery);
      if (canResume()) recovery = setTimeout(() => { if (canResume()) sync(); }, 500);
    };
    video.addEventListener('pause', recover);
    document.addEventListener('visibilitychange', recover);
    video.addEventListener('loadedmetadata', sync);
    sync();
    wasPlayingRef.current = playing;
    return () => {
      active = false;
      clearTimeout(recovery);
      video.removeEventListener('pause', recover);
      document.removeEventListener('visibilitychange', recover);
      video.removeEventListener('loadedmetadata', sync);
    };
  }, [playing, feed.url, retry, syncToLive, pip]);

  useEffect(() => {
    const update = () => {
      const element = document.fullscreenElement;
      setFullscreen(element === shell.current);
    };
    document.addEventListener('fullscreenchange', update);
    update();
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => { setCanPip(document.pictureInPictureEnabled && typeof ref.current?.requestPictureInPicture === 'function'); }, []);

  useEffect(() => {
    if (!focused && document.fullscreenElement === shell.current) {
      void document.exitFullscreen().catch(()=>{});
    }
  }, [focused]);

  const setFullscreenActive=async(active:boolean):Promise<PlayerUiResult>=>{
    try{
      if(active){if(document.fullscreenElement!==shell.current)await shell.current?.requestFullscreen();}
      else if(document.fullscreenElement===shell.current)await document.exitFullscreen();
      return {kind:'applied'};
    }catch{return {kind:'unavailable'};}
  };
  const setPictureInPictureActive=async(active:boolean):Promise<PlayerUiResult>=>{
    const video = ref.current;
    if(!video||!document.pictureInPictureEnabled)return {kind:'unavailable'};
    try{
      if(active){if(document.pictureInPictureElement!==video)await video.requestPictureInPicture();}
      else if(document.pictureInPictureElement===video)await document.exitPictureInPicture();
      return {kind:'applied'};
    }catch{return {kind:'unavailable'};}
  };
  const chooseQuality=async(selection:QualitySelection):Promise<PlayerUiResult>=>{
    if(!hlsRef.current&&!dashRef.current)return {kind:'unavailable'};
    const index=selection.kind==='auto'?-1:Number(selection.id);
    if(index!==-1&&(!Number.isInteger(index)||!qualities.some(level=>level.index===index)))return {kind:'unavailable'};
    manualQualityRef.current=true;
    if(hlsRef.current)hlsRef.current.currentLevel=index;
    else dashRef.current?.chooseQuality(index);
    setQuality(index);return {kind:'applied'};
  };
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
  const controlsQuality:PlayerControlsQuality=usesHls?{
    kind:'selectable',automatic:true,
    selection:quality===-1?{kind:'auto'}:{kind:'level',id:QualityLevelIdSchema.parse(String(quality))},
    options:qualities.map(level=>({id:QualityLevelIdSchema.parse(String(level.index)),label:level.label,height:null,bitrate:null})),
  }:{kind:'message',text:`${nativeHeight?`${nativeHeight}p · `:''}${nativeHls?'Managed by your browser':'This feed has one quality'}`};
  return <div ref={shell} className={`native-player ${focused?'player-focused':''}`}>
    <video ref={ref} playsInline autoPlay={playing} muted={!audible} aria-label={feed.label}/>
    {status === 'loading' && <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
    {status === 'buffering' && <div className="player-buffering" role="status"><LoaderCircle className="spin" size={20}/><span>Buffering</span></div>}
    {status === 'gesture' && playing && <button className="player-message gesture" onClick={enablePlayback}><Play/><span>{audible ? 'Click to enable audio' : 'Click to start playback'}</span></button>}
    {status === 'audio-gesture' && audible && playing && <button className="feed-audio-prompt" onClick={enableAudio}>Enable audio</button>}
    {status === 'ended' && playing && <button className="player-message gesture" onClick={() => { if (ref.current) { ref.current.currentTime = 0; enablePlayback(); } }}><RotateCcw/><span>Replay video</span></button>}
    {status === 'error' && <div className="player-message"><AlertCircle/><strong>Feed couldn&apos;t play</strong><p>{errorHint || 'Check the URL, availability, and whether the provider allows playback here.'}</p><button className="button" onClick={() => onRetry ? onRetry(feed.url) : setRetry(value => value + 1)}>Try again</button></div>}
    {status === 'ready' && !focused && <span className="feed-label"><Radio size={12}/>{feed.label}</span>}
    {focused&&status!=='error'&&purpose!=='verification'&&<PlayerControlsSurface interactionRoot={shell} label={feed.label}
      playing={playing} audible={audible} volume={volume} playback={live?'live':'unknown'} quality={controlsQuality}
      pictureInPicture={canPip?{kind:'available',active:pip}:{kind:'unsupported'}} fullscreen={fullscreen}
      onPlayingChange={onPlayingChange} onAudibleChange={onAudibleChange}
      onVolumeChange={onVolumeChange} onQualityChange={chooseQuality}
      onPictureInPictureChange={setPictureInPictureActive} onFullscreenChange={setFullscreenActive}/>}
  </div>;
}
