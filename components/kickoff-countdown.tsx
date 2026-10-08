'use client';

import { useGameClock } from '@/hooks/use-game-clock';
import { countdown, gameTiming } from '@/lib/game-timing';
import type { Game } from '@/lib/sunday';

export function KickoffCountdown({ game }: { game: Pick<Game, 'date' | 'status'> & {league?:Game['league']} }) {
  const now = useGameClock();
  const timing = gameTiming(game, now);
  const start=game.league==='nba'||game.league==='wnba'||game.league==='ncaab'?'Tipoff':
    game.league==='nhl'||game.league==='ncaah'||game.league==='ncaawh'?'Puck drop':game.league==='mlb'?'First pitch':'Kickoff';
  if (timing.kind === 'counting') return <strong>{start} in {countdown(timing.remainingSeconds)}</strong>;
  if (timing.kind === 'awaiting') return <strong>Awaiting {start.toLowerCase()}</strong>;
  return null;
}
