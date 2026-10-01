import type { Game } from './sunday';

export type GameTimingState =
  | { kind: 'unavailable' }
  | { kind: 'scheduled'; start: number }
  | { kind: 'counting'; start: number; remainingSeconds: number }
  | { kind: 'awaiting'; start: number };

export function gameTiming(game: Pick<Game, 'date' | 'status'>, now: number | null): GameTimingState {
  if (!game.date || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(game.date)) return { kind: 'unavailable' };
  const start = Date.parse(game.date);
  if (!Number.isFinite(start)) return { kind: 'unavailable' };
  const day = game.date.slice(0, 10);
  const calendar = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== day) return { kind: 'unavailable' };
  if (game.status !== 'pre' || now === null) return { kind: 'scheduled', start };
  const remainingSeconds = Math.ceil((start - now) / 1000);
  return remainingSeconds > 0 ? { kind: 'counting', start, remainingSeconds } : { kind: 'awaiting', start };
}

export function countdown(remainingSeconds: number): string {
  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor(remainingSeconds % 86400 / 3600);
  const minutes = Math.floor(remainingSeconds % 3600 / 60);
  const seconds = remainingSeconds % 60;
  const clock = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  return days ? `${days}d ${clock}` : clock;
}

export function relativeStartDay({ start, now }: { start: number; now: number }): 'Today' | 'Tomorrow' | null {
  const startDay = new Date(start).toDateString();
  const today = new Date(now);
  if (startDay === today.toDateString()) return 'Today';
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return startDay === tomorrow.toDateString() ? 'Tomorrow' : null;
}
