import { browserCategory } from '../../football/source-registry.ts';
import type { CandidateLocator } from '../../football/shared.ts';
import type { PlaybackProvider,ProviderPlayback } from '../provider.ts';
import { observedStreameastServerPage } from './public-page.ts';

type Locator=Extract<CandidateLocator,{provider:'streameast-server'}>;
const EVENT_PATH=/^\/([a-z0-9-]+)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;

export function streameastServerUrl(locator:Locator):URL|null {
  try {
    const event=new URL(locator.eventUrl);
    const path=EVENT_PATH.exec(event.pathname);
    const league=locator.sourceEventId.split(':')[0];
    if(event.origin!=='https://v2.streameast.ga'||event.username||event.password||event.search||event.hash||
      event.href!==locator.eventUrl||!path||path[1] !== browserCategory('streameast',league)?.pathCode||
      !(league==='nfl'?/^\d+$/.test(locator.gameId):locator.gameId.startsWith(`${league}-`))||
      !/^[a-z0-9-]+:\d{1,12}$/.test(locator.sourceEventId)||
      !/^[1-9]\d{0,3}$/.test(locator.serverId))return null;
    return new URL(`${event.href}${locator.serverId}`);
  } catch{return null;}
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
