import type { CandidateLocator } from '../football/shared.ts';
import type { ProviderPlayback } from './provider.ts';
import { goozProvider } from './providers/gooz.ts';
import { streamcenterProvider } from './providers/streamcenter.ts';
import { streameastProvider } from './providers/streameast.ts';
import { sportsurgeV2Provider } from './providers/sportsurge-v2.ts';
import { wikisportProvider } from './providers/wikisport.ts';
import { eventPageProbeIdentity, eventPageProvider } from './providers/event-page.ts';
import { swacProvider } from './providers/swac.ts';
export { persistableLocator } from './persistent-locator.ts';

const streamcenter=streamcenterProvider();
const streameast=streameastProvider();
const sportsurgeV2=sportsurgeV2Provider();
const wikisport=wikisportProvider();
const eventPage=eventPageProvider();
const swac=swacProvider();

export function providerProbeIdentity(locator:CandidateLocator):string {
  return locator.provider==='event-page'?eventPageProbeIdentity(locator):JSON.stringify(locator);
}

export function openProvider(locator: CandidateLocator, signal: AbortSignal, purpose: 'playback' | 'probe' = 'playback'): Promise<ProviderPlayback> {
  switch(locator.provider) {
    case 'swac': return swac.open(locator,signal);
    case 'gooz': return goozProvider.open(locator,signal);
    case 'streamcenter': return streamcenter.open(locator,signal);
    case 'streameast': return streameast.open(locator,signal);
    case 'sportsurge-v2': return sportsurgeV2.open(locator,signal,purpose);
    case 'wikisport': return wikisport.open(locator,signal);
    case 'event-page': return eventPage.open(locator,signal,purpose);
  }
}
