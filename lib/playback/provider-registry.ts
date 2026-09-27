import type { CandidateLocator } from '../football/shared.ts';
import type { ProviderPlayback } from './provider.ts';
import { goozProvider } from './providers/gooz.ts';
import { streamcenterProvider } from './providers/streamcenter.ts';
import { streameastProvider } from './providers/streameast.ts';
import { wikisportProvider } from './providers/wikisport.ts';

const streamcenter=streamcenterProvider();
const streameast=streameastProvider();
const wikisport=wikisportProvider();

export function openProvider(locator: CandidateLocator, signal: AbortSignal): Promise<ProviderPlayback> {
  switch(locator.provider) {
    case 'gooz': return goozProvider.open(locator,signal);
    case 'streamcenter': return streamcenter.open(locator,signal);
    case 'streameast': return streameast.open(locator,signal);
    case 'wikisport': return wikisport.open(locator,signal);
  }
}
