import {z} from 'zod';
import {nativeDomain} from './native.ts';

export function combatCardTitle(value:string):{title:string;segment:'Early Prelims'|'Prelims'|'Main Card'|null} {
  return nativeDomain('combatCardTitle',[value],z.object({title:z.string(),segment:z.enum(['Early Prelims','Prelims','Main Card']).nullable()}));
}