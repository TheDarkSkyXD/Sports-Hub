import type { Game } from '../shared.ts';

const calendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric',
});
const calendarDays = new Map<number,number>();
const calendarDayLimit = 4096;

export function feedCalendarDay(at: number): number | null {
  if (!Number.isFinite(new Date(at).getTime())) return null;
  const cached=calendarDays.get(at);
  if(cached!==undefined){
    calendarDays.delete(at);
    calendarDays.set(at,cached);
    return cached;
  }
  const parts = calendar.formatToParts(at);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const day=Date.UTC(value('year'), value('month') - 1, value('day')) / 86_400_000;
  calendarDays.set(at,day);
  if(calendarDays.size>calendarDayLimit){
    const oldest=calendarDays.keys().next();
    if(!oldest.done)calendarDays.delete(oldest.value);
  }
  return day;
}

export function feedWindow(now:number):{timeZone:'America/Chicago';days:[string,string]} {
  const day=feedCalendarDay(now);
  if(day===null)throw new RangeError('Invalid feed window time');
  const date=(offset:number)=>new Date((day+offset)*86_400_000).toISOString().slice(0,10);
  return {timeZone:'America/Chicago',days:[date(0),date(1)]};
}

export function feedDateEligible(kickoff: number, now: number): boolean {
  const date = feedCalendarDay(kickoff), today = feedCalendarDay(now);
  if (date === null || today === null) return false;
  const difference = date - today;
  return difference === 0 || difference === 1;
}

export function feedEligible(game: Pick<Game, 'lifecycle' | 'date' | 'finalObservedAt'> & {league?:Game['league']}, now: number): boolean {
  if (game.finalObservedAt !== undefined || game.lifecycle === 'final') return false;
  if (game.lifecycle === 'live') return true;
  if ((game.league==='wwe'||game.league==='tna')&&game.lifecycle==='unknown'&&game.date!==undefined) {
    const start=Date.parse(game.date);
    return Number.isFinite(start)&&now>=start&&now-start<=6*60*60_000;
  }
  return game.lifecycle === 'scheduled' && game.date !== undefined && feedDateEligible(Date.parse(game.date), now);
}

export function feedInventoryEligible(game: Pick<Game, 'lifecycle' | 'date' | 'finalObservedAt'>, now:number):boolean {
  return feedEligible(game,now)||game.lifecycle==='unknown'&&game.finalObservedAt===undefined&&
    game.date!==undefined&&feedDateEligible(Date.parse(game.date),now);
}
