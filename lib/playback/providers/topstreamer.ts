import type {ProviderPlayback} from '../provider.ts';
import type {Requester} from './public-page.ts';

export async function publishedTopstreamerVideo(_server:URL,_parent:URL,_signal:AbortSignal,_requester?:Requester):Promise<ProviderPlayback|null> {
  return null;
}
