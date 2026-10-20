import {z} from 'zod';
import type {Game} from '../shared.ts';
import {nativeDomain} from './native.ts';

export function feedCalendarDay(at:number):number|null {
  return nativeDomain('feedCalendarDay',[at],z.number().nullable());
}
export function feedWindow(now:number):{timeZone:'America/Chicago';days:[string,string]} {
  return nativeDomain('feedWindow',[now],z.object({timeZone:z.literal('America/Chicago'),days:z.tuple([z.string(),z.string()])}));
}
export function feedDateEligible(kickoff:number,now:number):boolean {
  return nativeDomain('feedDateEligible',[kickoff,now],z.boolean());
}
export function feedEligible(game:Pick<Game,'lifecycle'|'date'|'finalObservedAt'>&{league?:Game['league']},now:number):boolean {
  return nativeDomain('feedEligible',[game,now],z.boolean());
}
export function combatListingFeedEligible(game:Game,now:number):boolean {
  return nativeDomain('combatListingFeedEligible',[game,now],z.boolean());
}
export function feedInventoryEligible(game:Pick<Game,'lifecycle'|'date'|'finalObservedAt'>,now:number):boolean {
  return nativeDomain('feedInventoryEligible',[game,now],z.boolean());
}