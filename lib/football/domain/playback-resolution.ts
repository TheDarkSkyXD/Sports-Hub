import {z} from 'zod';
import type {CandidateLocator} from '../shared.ts';
import {nativeDomain} from './native.ts';

export function playbackResolution(locator:CandidateLocator):'http'|'browser' {
  return nativeDomain('playbackResolution',[locator],z.enum(['http','browser']));
}