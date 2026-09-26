'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { GamePlayer } from './game-player';

type Player = { label: string };
export function BrowserProviderPlayer({ gameId, audible, volume, playing, delay, onClose }: { gameId: string; audible: boolean; volume: number; playing: boolean; delay: number; onClose: () => void }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [message, setMessage] = useState('Finding your game…');
  const [server, setServer] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPlayers(null); setServer(0); setMessage('Finding your game…');
    void fetch(`/api/playback?game=${encodeURIComponent(gameId)}`, { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Player unavailable.');
      if (!Array.isArray(result.players) || !result.players.length) throw new Error('No player is listed for this game.');
      setPlayers(result.players);
    }).catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Player unavailable.'); });
    return () => controller.abort();
  }, [gameId, retry]);
  const failover = useCallback(() => setServer(current => players && current + 1 < players.length ? current + 1 : current), [players]);
  const next = () => { if (players?.length) setServer(current => (current + 1) % players.length); };
  const url = `/api/stream/${encodeURIComponent(gameId)}/index.m3u8?server=${server}&retry=${retry}`;
  return <div className="provider-player">
    <div className="provider-surface">
      {players ? <GamePlayer feed={{ url, label: players[server]?.label || `Server ${server + 1}` }} audible={audible} volume={volume} playing={playing} delay={delay} onFatal={failover} errorHint="This server is unavailable. Try again or switch to another listed server."/> : <div className="player-message">{message==='Finding your game…'?<LoaderCircle className="spin"/>:<AlertCircle/>}<strong>{message==='Finding your game…'?'Opening the live player':'Player unavailable'}</strong><p>{message}</p>{message!=='Finding your game…'&&<button className="button" onClick={() => setRetry(current => current + 1)}><RefreshCw size={14}/>Try again</button>}</div>}
    </div>
    <div className="provider-controls"><span>{players ? `${players[server]?.label || 'Server'} · ${server + 1} of ${players.length}` : 'Connecting'}</span><button onClick={next} disabled={!players || players.length < 2} title="Switch provider server"><RefreshCw size={12}/>Switch server</button><button aria-label="Stop this game" onClick={onClose}><X size={13}/></button></div>
  </div>;
}
