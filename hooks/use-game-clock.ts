'use client';

import { useSyncExternalStore } from 'react';

const noClock = () => null;
const noSubscribe = () => () => {};

function createClock(cadence: 'second' | 'day') {
  const listeners = new Set<() => void>();
  let clock = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function tick() {
    clock = Date.now();
    listeners.forEach(listener => listener());
    let delay = 1000;
    if (cadence === 'day') {
      const midnight = new Date(clock);
      midnight.setHours(24, 0, 0, 0);
      delay = midnight.getTime() - clock;
    }
    timer = setTimeout(tick, delay);
  }

  return {
    getSnapshot: () => clock,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (timer === null) tick();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}

const clocks = { second: createClock('second'), day: createClock('day') };

export function useGameClock(enabled = true, cadence: 'second' | 'day' = 'second'): number | null {
  const clock = clocks[cadence];
  return useSyncExternalStore(enabled ? clock.subscribe : noSubscribe, enabled ? clock.getSnapshot : noClock, noClock);
}
