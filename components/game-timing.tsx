'use client';

import { useSyncExternalStore } from 'react';
import type { Game } from '@/lib/sunday';
import { countdown, gameTiming, motorsportsTiming, relativeStartDay } from '@/lib/game-timing';
import { isMotorsportsLeague } from '@/lib/football/shared';
import { useGameClock } from '@/hooks/use-game-clock';
import { KickoffCountdown } from './kickoff-countdown';

const startFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const noSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;
type TimingGame = Pick<Game, 'date' | 'status'> & {league?:Game['league']};

function MotorsportsCountdown({ game }: { game: TimingGame }) {
  const now = useGameClock();
  const inferred = motorsportsTiming(game, now);
  return inferred?.kind === 'counting' ? <strong>Start in {countdown(inferred.remainingSeconds)}</strong> :
    inferred?.kind === 'in-progress' ? <strong title="Based on scheduled start time">In progress</strong> : null;
}

export function GameTiming({ game, relativeDay = false }: { game: TimingGame; relativeDay?: boolean }) {
  const motorsports = game.league !== undefined && isMotorsportsLeague(game.league);
  const now = useGameClock(relativeDay || motorsports, 'day');
  const mounted = useSyncExternalStore(noSubscribe, isClient, isServer);
  const timing = gameTiming(game, null);
  if (timing.kind === 'unavailable') return <span className="game-timing">Start time unavailable</span>;
  const inferred = motorsportsTiming(game, now);
  const day = (relativeDay || motorsports) && now !== null ? relativeStartDay({ start: timing.start, now }) : null;
  const start = day ? `${day}, ${timeFormatter.format(timing.start)}` : startFormatter.format(timing.start);
  return <span className="game-timing"><span>{mounted ? start : 'Start time loading…'}</span>{inferred ? <MotorsportsCountdown game={game}/> : game.status === 'pre' && <KickoffCountdown game={game}/>}</span>;
}
