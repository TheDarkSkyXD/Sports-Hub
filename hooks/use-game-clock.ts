'use client';

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let clock = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const noClock = () => null;
const noSubscribe = () => () => {};

function tick() {
  clock = Date.now();
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
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

const getClock = () => clock;

export function useGameClock(enabled = true): number | null {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, enabled ? getClock : noClock, noClock);
}
