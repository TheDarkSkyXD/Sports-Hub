'use client';
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertCircle, LoaderCircle, Play, Radio } from 'lucide-react';
import type { Feed } from '@/lib/sunday';

export function GamePlayer({ feed, audible, volume, playing, delay, onFatal, errorHint }: { feed: Feed; audible: boolean; volume: number; playing: boolean; delay: number; onFatal?: () => void; errorHint?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const needsGesture = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'gesture' | 'audio-gesture' | 'ended'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const video = ref.current; if (!video) return;
    needsGesture.current = false;
    setState('loading');
    let hls: Hls | undefined;
    let hasLoaded = false;
    const onReady = () => { hasLoaded = true; setState(needsGesture.current ? 'audio-gesture' : 'ready'); };
    const onLoaded = () => { hasLoaded = true; };
    let failed = false;
    const onError = () => { if (!failed) { failed = true; setState('error'); onFatal?.(); } };
    const onEnded = () => setState('ended');
    video.addEventListener('playing', onReady); video.addEventListener('loadeddata', onLoaded); video.addEventListener('error', onError); video.addEventListener('ended', onEnded);
    if (/\.m3u8(?:\?|$)/i.test(feed.url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 45, backBufferLength: 90, liveSyncDurationCount: 3 });
      hls.loadSource(feed.url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { console.warn('HLS fatal:', data.type, data.details, String(data.reason || '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 160)); onError(); } });
    } else video.src = feed.url;
    const timer = setTimeout(() => { if (!failed && !hasLoaded && video.readyState < 2) onError(); }, 20000);
    return () => { clearTimeout(timer); hls?.destroy(); video.pause(); video.removeEventListener('playing', onReady); video.removeEventListener('loadeddata', onLoaded); video.removeEventListener('error', onError); video.removeEventListener('ended', onEnded); video.removeAttribute('src'); video.load(); };
  }, [feed.url, retry, onFatal]);
  useEffect(() => { const v = ref.current; if (v) { v.muted = !audible; v.volume = volume / 100; } }, [audible, volume]);
  useEffect(() => { const v = ref.current; if (!v) return; let active=true; const sync = () => { if (playing) void v.play().catch(async error => { if (!active || error?.name === 'AbortError') return; if (error?.name === 'NotAllowedError' && !v.muted) { needsGesture.current=true; v.muted = true; try { await v.play(); if (active) setState('audio-gesture'); return; } catch (retryError) { if (!active || (retryError instanceof Error && retryError.name === 'AbortError')) return; } } if (active) setState(s => s === 'error' ? s : 'gesture'); }); else v.pause(); }; v.addEventListener('loadedmetadata',sync); sync(); return () => { active=false; v.removeEventListener('loadedmetadata',sync); }; }, [playing, feed.url, retry]);
  useEffect(() => { const v = ref.current; if (v?.seekable.length) v.currentTime = Math.max(v.seekable.start(0), v.seekable.end(v.seekable.length - 1) - Math.max(3, delay)); }, [delay]);
  return <div className="native-player"><video ref={ref} playsInline autoPlay={playing} muted={!audible} aria-label={feed.label} />
    {state === 'loading' && <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
    {state === 'gesture' && <button className="player-message gesture" onClick={() => { const video=ref.current; if (!video) return; video.muted=!audible; void video.play().then(() => { needsGesture.current=false; setState('ready'); }).catch(() => setState('error')); }}><Play/><span>{audible?'Click to enable audio':'Click to start playback'}</span></button>}
    {state === 'audio-gesture' && <button className="feed-audio-prompt" onClick={() => { const video=ref.current; if (!video) return; video.muted=false; void video.play().then(() => { needsGesture.current=false; setState('ready'); }).catch(() => { video.muted=true; setState('audio-gesture'); }); }}>Enable audio</button>}
    {state === 'ended' && <button className="player-message gesture" onClick={() => { if(ref.current){ref.current.currentTime=0;void ref.current.play().catch(()=>setState('gesture'));} }}><Play/><span>This video has ended. Play again</span></button>}
    {state === 'error' && <div className="player-message"><AlertCircle/><strong>Feed couldn’t play</strong><p>{errorHint || 'Check the URL, availability, and whether the provider allows playback here.'}</p><button className="button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>}
    {state === 'ready' && <span className="feed-label"><Radio size={12}/>{feed.label}</span>}
  </div>;
}
