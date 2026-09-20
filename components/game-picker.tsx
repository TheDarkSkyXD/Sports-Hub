'use client';

import { useRef, useState } from 'react';
import { Check, ChevronRight, Plus, Search, Star, X } from 'lucide-react';
import { TeamBadge } from '@/components/team-badge';
import { matchesGameSearch } from '@/lib/game-discovery';
import type { Game } from '@/lib/sunday';

type Props = {
  games: Game[];
  selected: string[];
  favorites: string[];
  loading: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
};

export function GamePicker({ games, selected, favorites, loading, onSelect, onRefresh }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const searchInput = useRef<HTMLInputElement>(null);
  const matches = games.filter(game => matchesGameSearch(game, query)
    && (filter === 'all' || filter === 'live' && game.status === 'in' || filter === 'favorites' && favorites.includes(game.id)));
  const full = selected.length >= 4;

  return <div className="game-picker">
    <div className="picker-search">
      <Search size={18}/>
      <input ref={searchInput} aria-label="Search matchups" placeholder="Team, city, or matchup…" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off"/>
      {query && <button aria-label="Clear matchup search" onClick={() => {setQuery('');searchInput.current?.focus();}}><X size={16}/></button>}
      <kbd>Esc</kbd>
    </div>
    <div className="picker-filters" role="group" aria-label="Filter matchups">
      {[['all', 'All games'], ['live', 'Live now'], ['favorites', 'Favorites']].map(([value, label]) =>
        <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'favorites' && <Star size={12}/>} {label}</button>)}
      <span role="status">{matches.length} {matches.length === 1 ? 'matchup' : 'matchups'}</span>
    </div>
    <div className="picker-results" role="region" aria-label="Matching games">
      {matches.map(game => {
        const inRoom = selected.includes(game.id);
        return <button key={game.id} className={`picker-game ${inRoom ? 'in-room' : ''}`} onClick={() => onSelect(game.id)} aria-label={`${inRoom ? 'Focus' : full ? 'Choose' : 'Add'} ${game.name}`}>
          <span className="picker-badges"><TeamBadge team={game.away}/><TeamBadge team={game.home}/></span>
          <span className="picker-matchup"><strong>{game.away.short}<span> at </span>{game.home.short}</strong><small><span className={`picker-status ${game.status}`}>{game.status === 'in' && <i/>}{game.detail}</span>{game.broadcast && <span> · {game.broadcast}</span>}</small></span>
          <span className="picker-action">{inRoom ? <><Check size={14}/><span>In room</span></> : full ? <><span>Replace</span><ChevronRight size={14}/></> : <><Plus size={14}/><span>Add</span></>}</span>
        </button>;
      })}
      {!matches.length && <div className="picker-empty"><Search size={28}/><strong>{loading && !games.length ? 'Finding this week’s games…' : query.trim() ? 'No matching games' : filter === 'favorites' ? 'Your favorites will appear here' : filter === 'live' ? 'No games live right now' : 'The schedule is unavailable'}</strong><p>{query.trim() ? 'Try a team name or abbreviation, like “CHI” or “Bears”.' : filter === 'favorites' ? 'Star a matchup in Game center to save it.' : filter === 'live' ? 'Browse all games to plan your room.' : 'Refresh to try the game feed again.'}</p>{query.trim() || filter !== 'all' ? <button className="button subtle" onClick={() => {setQuery('');setFilter('all');searchInput.current?.focus();}}>Show all games</button> : <button className="button" disabled={loading} onClick={onRefresh}>Refresh games</button>}</div>}
    </div>
    <div className="picker-footnote"><span>{selected.length} of 4 room slots selected</span><span>{full ? 'Choose a game, then a slot to replace.' : 'Your other streams stay connected.'}</span></div>
  </div>;
}
