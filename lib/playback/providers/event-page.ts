import type { CandidateLocator } from '../../football/shared.ts';
import type { PlaybackProvider, ProviderPlayback } from '../provider.ts';
import { validEventPagePair } from './event-page-policy.ts';
import { observedPublicPage, publishedPublicVideo } from './public-page.ts';

type EventPageLocator = Extract<CandidateLocator,{provider:'event-page'}>;
type OpenPage = (destination:URL,signal:AbortSignal,purpose:'playback'|'probe',embeddedEvent?:URL)=>Promise<ProviderPlayback|null>;

export function eventPageProbeIdentity(locator:EventPageLocator):string {
  if(validEventPagePair(locator.eventUrl,locator.serverUrl)) {
    const eventHost=new URL(locator.eventUrl).hostname;
    if((eventHost==='crackstreams.st'||eventHost==='methstreams.st')&&new URL(locator.serverUrl).hostname==='fxtrend.st')
      return JSON.stringify(['event-page','fxtrend',locator.gameId,locator.serverUrl]);
  }
  return JSON.stringify(locator);
}

export function eventPageProvider(openPage:OpenPage=observedPublicPage):PlaybackProvider<EventPageLocator> {
  return {provider:'event-page',async open(locator,signal,purpose='playback') {
    if (!validEventPagePair(locator.eventUrl,locator.serverUrl)) throw new Error('Unsupported event page');
    if (new URL(locator.eventUrl).hostname==='ppv.st') {
      try {
        const staticPlayback=await publishedPublicVideo(new URL(locator.serverUrl),new URL(locator.eventUrl),signal);
        if (staticPlayback) return staticPlayback;
      } catch(error) { if(signal.aborted) throw error; }
    }
    const eventUrl=new URL(locator.eventUrl);
    const embeddedEvent=['nflstreams.org','ms.buffstream.io'].includes(eventUrl.hostname)?eventUrl:undefined;
    const playback=await openPage(new URL(locator.serverUrl),signal,purpose,embeddedEvent);
    if (!playback) throw new Error('Event page did not publish supported media');
    return playback;
  }};
}
