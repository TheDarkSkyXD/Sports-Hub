'use client';

import { useSyncExternalStore } from 'react';
import type { Game } from '@/lib/sunday';
import { gameTiming, relativeStartDay } from '@/lib/game-timing';
import { useGameClock } from '@/hooks/use-game-clock';
import { KickoffCountdown } from './kickoff-countdown';

const startFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const noSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;
export function GameTiming({ game, relativeDay = false }: { game: Pick<Game, 'date' | 'status'>; relativeDay?: boolean }) {
  const now = useGameClock(relativeDay);
  const mounted = useSyncExternalStore(noSubscribe, isClient, isServer);
  const timing = gameTiming(game, null);
  if (timing.kind === 'unavailable') return <span className="game-timing">Start time unavailable</span>;
  const day = relativeDay && now !== null ? relativeStartDay({ start: timing.start, now }) : null;
  const start = day ? `${day}, ${timeFormatter.format(timing.start)}` : startFormatter.format(timing.start);
  return <span className="game-timing"><span>{mounted ? start : 'Start time loading…'}</span>{game.status === 'pre' && <KickoffCountdown game={game}/>}</span>;
}
