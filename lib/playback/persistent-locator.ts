import {z} from 'zod';
import type {CandidateLocator} from '../football/shared.ts';
import {nativeDomain} from '../football/domain/native.ts';

export function persistableLocator(locator:CandidateLocator):boolean {
  return nativeDomain('persistableLocator',[locator],z.boolean());
}