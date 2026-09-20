'use client';
import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertCircle, LoaderCircle, Play, Radio } from 'lucide-react';
import type { Feed } from '@/lib/sunday';

export function GamePlayer({ feed, audible, volume, playing, delay }: { feed: Feed; audible: boolean; volume: number; playing: boolean; delay: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'gesture' | 'ended'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const video = ref.current; if (!video) return;
    setState('loading');
    let hls: Hls | undefined;
    const onReady = () => { setState('ready'); };
    const onError = () => setState('error');
    const onEnded = () => setState('ended');
    video.addEventListener('playing', onReady); video.addEventListener('loadeddata', onReady); video.addEventListener('error', onError); video.addEventListener('ended', onEnded);
    if (/\.m3u8(?:\?|$)/i.test(feed.url) && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 45, backBufferLength: 90, liveSyncDurationCount: 3 });
      hls.loadSource(feed.url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setState('error'); });
    } else video.src = feed.url;
    const timer = setTimeout(() => setState(s => s === 'loading' ? 'error' : s), 20000);
    return () => { clearTimeout(timer); hls?.destroy(); video.pause(); video.removeEventListener('playing', onReady); video.removeEventListener('loadeddata', onReady); video.removeEventListener('error', onError); video.removeEventListener('ended', onEnded); video.removeAttribute('src'); video.load(); };
  }, [feed.url, retry]);
  useEffect(() => { const v = ref.current; if (v) { v.muted = !audible; v.volume = volume / 100; } }, [audible, volume]);
  useEffect(() => { const v = ref.current; if (!v) return; const sync = () => { if (playing) v.play().catch(() => setState(s => s === 'error' ? s : 'gesture')); else v.pause(); }; v.addEventListener('loadedmetadata',sync); sync(); return () => v.removeEventListener('loadedmetadata',sync); }, [playing, feed.url, retry]);
  useEffect(() => { const v = ref.current; if (v?.seekable.length) v.currentTime = Math.max(v.seekable.start(0), v.seekable.end(v.seekable.length - 1) - Math.max(3, delay)); }, [delay]);
  return <div className="native-player"><video ref={ref} playsInline autoPlay={playing} muted={!audible} aria-label={feed.label} />
    {state === 'loading' && <div className="player-message"><LoaderCircle className="spin"/><span>Connecting to your feed…</span></div>}
    {state === 'gesture' && <button className="player-message gesture" onClick={() => ref.current?.play().then(() => setState('ready')).catch(() => setState('error'))}><Play/><span>Click to start playback</span></button>}
    {state === 'ended' && <button className="player-message gesture" onClick={() => { if(ref.current){ref.current.currentTime=0;void ref.current.play().catch(()=>setState('gesture'));} }}><Play/><span>This video has ended. Play again</span></button>}
    {state === 'error' && <div className="player-message"><AlertCircle/><strong>Feed couldn’t play</strong><p>Check the URL, availability, and whether the provider allows playback here.</p><button className="button" onClick={() => setRetry(n => n + 1)}>Try again</button></div>}
    {state === 'ready' && <span className="feed-label"><Radio size={12}/>{feed.label}</span>}
  </div>;
}
