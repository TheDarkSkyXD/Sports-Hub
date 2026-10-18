import type { Game } from './sunday';
import { isMotorsportsLeague } from './football/shared.ts';

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

export type MotorsportsTiming =
  | { kind: 'counting'; remainingSeconds: number }
  | { kind: 'in-progress' }
  | null;

export function motorsportsTiming(game: Pick<Game, 'date' | 'status'> & Partial<Pick<Game, 'league'>>, now: number | null): MotorsportsTiming {
  if (now === null || game.league === undefined || !isMotorsportsLeague(game.league) || (game.status !== 'pre' && game.status !== 'unknown')) return null;
  const timing = gameTiming(game, null);
  if (timing.kind === 'unavailable' || relativeStartDay({ start: timing.start, now }) === null) return null;
  const remainingSeconds = Math.ceil((timing.start - now) / 1000);
  return remainingSeconds > 0 ? { kind: 'counting', remainingSeconds } : { kind: 'in-progress' };
}

export function countdown(remainingSeconds: number): string {
  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor(remainingSeconds % 86400 / 3600);
  const minutes = Math.floor(remainingSeconds % 3600 / 60);
  const seconds = remainingSeconds % 60;
  const clock = [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  return days ? `${days}d ${clock}` : clock;
}

const dayFormatters=new Map<string,Intl.DateTimeFormat>();
function calendarDay(at:number,timeZone:string|undefined):number {
  const date=new Date(at);
  if(!timeZone)return Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
  let formatter=dayFormatters.get(timeZone);
  if(!formatter){
    formatter=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'numeric',day:'numeric'});
    dayFormatters.set(timeZone,formatter);
  }
  const parts=formatter.formatToParts(date);
  const value=(type:string)=>Number(parts.find(part=>part.type===type)?.value);
  return Date.UTC(value('year'),value('month')-1,value('day'));
}

export function relativeStartDay({ start, now, timeZone }: { start: number; now: number; timeZone?:string }): 'Today' | 'Tomorrow' | null {
  const difference=calendarDay(start,timeZone)-calendarDay(now,timeZone);
  return difference===0?'Today':difference===86_400_000?'Tomorrow':null;
}
