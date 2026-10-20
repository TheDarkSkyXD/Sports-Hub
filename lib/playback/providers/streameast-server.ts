import {nativeDomain} from '../../football/domain/native.ts';
import {z} from 'zod';
import type { CandidateLocator } from '../../football/shared.ts';
import type { PlaybackProvider,ProviderPlayback } from '../provider.ts';
import { observedStreameastServerPage } from './public-page.ts';

type Locator=Extract<CandidateLocator,{provider:'streameast-server'}>;

export function streameastServerUrl(locator:Locator):URL|null {
  const value=nativeDomain('streameastServerUrl',[locator],z.string().url().nullable());
  return value?new URL(value):null;
}

export function streameastServerProvider():PlaybackProvider<Locator> {
  return {provider:'streameast-server',async open(locator,signal,purpose='playback'):Promise<ProviderPlayback> {
    const serverUrl=streameastServerUrl(locator);
    if(!serverUrl)throw new Error('Unsupported StreamEast server choice');
    const playback=await observedStreameastServerPage({serverUrl,eventUrl:new URL(locator.eventUrl),
      sourceEventId:locator.sourceEventId,serverId:locator.serverId},signal,purpose);
    if(!playback)throw new Error('StreamEast server did not publish supported media');
    return playback;
  }};
}
