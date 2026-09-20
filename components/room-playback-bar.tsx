'use client';

import { Headphones, Pause, Play, Volume2, VolumeX, Zap } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { Game } from '@/lib/sunday';

type Props = {
  games: Game[];
  audioId?: string;
  playing: boolean;
  muted: boolean;
  volume: number;
  hasFeeds: boolean;
  smart: boolean;
  spoilers: boolean;
  onPlay: () => void;
  onMute: () => void;
  onVolume: (value: number) => void;
  onAudio: (id: string) => void;
  onSmart: (value: boolean) => void;
  onMenuOpen: (value: boolean) => void;
};

export function RoomPlaybackBar(props: Props) {
  const { games, audioId, playing, muted, volume, hasFeeds, smart, spoilers } = props;
  const silent = muted || volume === 0;
  const status = !hasFeeds ? 'Press play on a game to begin' : !playing ? 'Room paused' : !games.length ? 'Waiting for a ready stream' : silent ? 'Room muted' : 'One game on audio';
  return <div className="playback-bar">
    <div className="playback-left">
      <button className="icon-button" disabled={!hasFeeds} aria-label={playing ? 'Pause all feeds' : 'Play all feeds'} title={playing ? 'Pause all feeds (Space)' : 'Play all feeds (Space)'} onClick={props.onPlay}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button>
      <button className="icon-button" disabled={!hasFeeds} aria-label={silent ? 'Unmute audio' : 'Mute audio'} title={silent ? 'Unmute audio (M)' : 'Mute audio (M)'} onClick={props.onMute}>{silent ? <VolumeX size={17}/> : <Volume2 size={17}/>}</button>
      <Slider className="volume-slider" aria-label="Room volume" value={[muted ? 0 : volume]} onValueChange={v => props.onVolume(v[0])} max={100} step={1}/>
      <span className="volume-value">{muted ? 0 : volume}%</span>
      <div className="audio-picker">
        <Headphones size={14}/>
        <Select value={audioId || 'none'} onValueChange={props.onAudio} onOpenChange={props.onMenuOpen} disabled={!games.length}>
          <SelectTrigger aria-label="Game audio"><SelectValue/></SelectTrigger>
          <SelectContent>
            {!games.length && <SelectItem value="none">No stream ready</SelectItem>}
            {games.map(game => <SelectItem key={game.id} value={game.id}>{game.away.abbreviation} / {game.home.abbreviation}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <span className="playback-status" role="status">{status}</span>
    </div>
    <div className="smart-focus" title={spoilers ? 'Turn off spoiler-free mode to use smart focus' : 'Follow red-zone action in your room'}><Zap size={14} className={smart ? 'coral' : ''}/><label htmlFor="smart-focus">Smart focus</label><Switch id="smart-focus" checked={smart} disabled={spoilers} onCheckedChange={props.onSmart}/></div>
  </div>;
}
