'use client';

import { useGameClock } from '@/hooks/use-game-clock';
import { countdown, gameTiming } from '@/lib/game-timing';
import type { Game } from '@/lib/sunday';

export function KickoffCountdown({ game }: { game: Pick<Game, 'date' | 'status'> }) {
  const now = useGameClock();
  const timing = gameTiming(game, now);
  if (timing.kind === 'counting') return <strong>Kickoff in {countdown(timing.remainingSeconds)}</strong>;
  if (timing.kind === 'awaiting') return <strong>Awaiting kickoff</strong>;
  return null;
}
