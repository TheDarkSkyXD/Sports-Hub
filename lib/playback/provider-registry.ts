import type { CandidateLocator } from '../football/shared.ts';
import type { ProviderPlayback } from './provider.ts';
import { goozProvider } from './providers/gooz.ts';
import { streamcenterProvider } from './providers/streamcenter.ts';

const streamcenter=streamcenterProvider();

export function openProvider(locator: CandidateLocator, signal: AbortSignal): Promise<ProviderPlayback> {
  switch(locator.provider) {
    case 'gooz': return goozProvider.open(locator,signal);
    case 'streamcenter': return streamcenter.open(locator,signal);
  }
}
