'use client';

import { useSyncExternalStore } from 'react';
import type { Game } from '@/lib/sunday';
import { countdown, gameTiming } from '@/lib/game-timing';

const startFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const noSubscribe = () => () => {};
const isClient = () => true;
const isServer = () => false;
const noClock = () => null;
const listeners = new Set<() => void>();
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function tick() {
  clock = Date.now();
  listeners.forEach(listener => listener());
}

function subscribeClock(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(tick, 1000);
    tick();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getClock() { return clock; }

function KickoffCountdown({ game }: { game: Pick<Game, 'date' | 'status'> }) {
  const now = useSyncExternalStore(subscribeClock, getClock, noClock);
  const timing = gameTiming(game, now);
  if (timing.kind === 'counting') return <strong>Kickoff in {countdown(timing.remainingSeconds)}</strong>;
  if (timing.kind === 'awaiting') return <strong>Awaiting kickoff</strong>;
  return null;
}

export function GameTiming({ game }: { game: Pick<Game, 'date' | 'status'> }) {
  const mounted = useSyncExternalStore(noSubscribe, isClient, isServer);
  const timing = gameTiming(game, null);
  if (timing.kind === 'unavailable') return <span className="game-timing">Start time unavailable</span>;
  return <span className="game-timing"><span>{mounted ? startFormatter.format(timing.start) : 'Start time loading…'}</span>{game.status === 'pre' && <KickoffCountdown game={game}/>}</span>;
}
