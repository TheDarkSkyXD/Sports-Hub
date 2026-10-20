import {z} from 'zod';
import type {WrestlingLeague} from '../shared.ts';
import {nativeDomain} from './native.ts';

export function wrestlingPromotion(title:string):WrestlingLeague|null {
  return nativeDomain('wrestlingPromotion',[title],z.enum(['wwe','tna','aew','wrestling']).nullable());
}
export function wrestlingShowKey(league:WrestlingLeague,title:string):string|null {
  return nativeDomain('wrestlingShowKey',[league,title],z.string().nullable());
}
export function wrestlingEventKey(league:WrestlingLeague,title:string,kickoff:number):string|null {
  return nativeDomain('wrestlingEventKey',[league,title,kickoff],z.string().nullable());
}