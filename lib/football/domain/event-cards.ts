import type { League } from '../shared.ts';
import { feedCalendarDay } from './feed-eligibility.ts';

export type WrestlingLeague = Extract<League, 'wwe' | 'tna'>;

function cleanTitle(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\s+(?:watch\s+)?(?:live\s+stream|live)$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function wrestlingShowKey(league: WrestlingLeague, title: string): string | null {
  const value=cleanTitle(title);
  if(league==='wwe') {
    if(/^(?:wwe )?(?:monday night )?raw$/.test(value))return 'raw';
    if(/^(?:wwe )?(?:friday night )?smackdown$/.test(value))return 'smackdown';
    if(/^(?:wwe )?nxt$/.test(value))return 'nxt';
    if(/^(?:wwe )?nxt [a-z0-9]/.test(value))return value.replace(/^(?:wwe )?nxt /,'nxt ');
    if(/^wwe [a-z0-9]/.test(value))return value.slice(4);
  } else {
    if(/^(?:tna )?impact(?: wrestling)?$/.test(value))return 'impact';
    if(/^impact wrestling [a-z0-9]/.test(value))return value.slice('impact wrestling '.length);
    if(/^tna [a-z0-9]/.test(value))return value.slice(4).replace(/^impact wrestling /,'');
  }
  return null;
}

export function wrestlingEventKey(league: WrestlingLeague, title: string, kickoff: number): string | null {
  const show=wrestlingShowKey(league,title);
  const day=feedCalendarDay(kickoff);
  return show!==null&&day!==null?`${league}|${show}|${new Date(day*86_400_000).toISOString().slice(0,10)}`:null;
}
