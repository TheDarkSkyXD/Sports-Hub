import {z} from 'zod';
import type {CandidateLocator} from '../../football/shared.ts';
import {parseSwacEvent,swacApiUrl} from './swac-catalog.ts';
import {boundedText,sanitizedRead,type PlaybackProvider,type ProviderResource,type ResourceKind} from '../provider.ts';
import {publicHttpsRequest,type Requester} from './public-page.ts';

const mediaResponse=z.object({videoId:z.string(),urls:z.array(z.object({url:z.string(),streamFormat:z.string()}))});
const dvrAsset=z.object({url:z.string(),beg:z.number().int()});
type SwacLocator=Extract<CandidateLocator,{provider:'swac'}>;
type MediaScope={assetPath:string;channelPath:string};

function exactUrl(value:string):URL|null {
  try{
    const url=new URL(value);
    return url.protocol==='https:' && value===url.href && !url.username && !url.password && !url.port && !url.hash && !url.search ? url : null;
  }catch{return null;}
}

function mediaScope(value:string,kickoff:number):MediaScope|null {
  const url=exactUrl(value);
  const asset=url && /^\/livedvr\/([A-Za-z0-9_-]+)\/master\.m3u8$/.exec(url.pathname);
  if(!url || url.hostname!=='live-vod.gideo.video' || !asset)return null;
  let input:unknown;
  try{input=JSON.parse(Buffer.from(asset[1],'base64url').toString('utf8'));}catch{return null;}
  const parsed=dvrAsset.safeParse(input);
  if(!parsed.success || parsed.data.beg!==kickoff/1000)return null;
  const live=exactUrl(parsed.data.url);
  const channel=live && /^(\/brutus\/swac-live\d{1,2}\/)index-\d+-\d+\.m3u8$/.exec(live.pathname);
  return live?.hostname==='live.gideo.video' && channel ? {assetPath:`/livedvr/${asset[1]}/`,channelPath:channel[1]} : null;
}

function permitted(url:URL,scope:MediaScope,kind:ResourceKind):boolean {
  if(!exactUrl(url.href))return false;
  if(kind==='playlist')return url.hostname==='live-vod.gideo.video' && url.pathname.startsWith(scope.assetPath) &&
    /^(?:master\.m3u8|\d{1,2})$/.test(url.pathname.slice(scope.assetPath.length));
  return url.hostname==='live.gideo.video' && url.pathname.startsWith(scope.channelPath) &&
    /^tracks-v\d+a\d+\/dvr-\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}-\d+\.ts$/.test(url.pathname.slice(scope.channelPath.length));
}

function swacResource(url:URL,scope:MediaScope,kind:ResourceKind,requester:Requester):ProviderResource {
  return {
    kind,identity:url.href,
    async read({signal,range}){
      const headers=new Headers({Accept:kind==='playlist'?'application/vnd.apple.mpegurl':'video/MP2T'});
      if(range){if(!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))throw new Error('Unsupported media range');headers.set('Range',range);}
      let address=url;
      for(let hop=0;hop<=3;hop++){
        const response=await requester(address,signal,headers,30000);
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');await response.body?.cancel();
          if(!location || hop===3)throw new Error('Unsupported SWAC media redirect');
          const next=new URL(location,address);
          if(!permitted(next,scope,kind))throw new Error('Unsupported SWAC media redirect');
          address=next;continue;
        }
        return sanitizedRead(response);
      }
      throw new Error('SWAC redirect limit');
    },
    resolve(reference,expected){
      try{const next=new URL(reference,url);return permitted(next,scope,expected)?swacResource(next,scope,expected,requester):null;}catch{return null;}
    },
  };
}

export function swacProvider(requester:Requester=(url,signal,headers,timeout)=>publicHttpsRequest(url,signal,headers,undefined,timeout)):PlaybackProvider<SwacLocator> {
  return {
    provider:'swac',
    async open(locator,signal){
      const read=async(command:'getVideo'|'getVideoUrls'):Promise<unknown>=>{
        const response=await requester(new URL(swacApiUrl(command,locator.eventId)),signal,
          new Headers({Accept:'application/json'}),10000);
        return JSON.parse(await boundedText(response));
      };
      const event=parseSwacEvent(await read('getVideo'));
      if(!event || event.event.id!==locator.eventId)throw new Error('SWAC event is not live free football');
      if(Date.parse(event.event.goLiveTime || '')>Date.now())throw new Error('SWAC broadcast has not started');
      const parsed=mediaResponse.safeParse(await read('getVideoUrls'));
      if(!parsed.success || parsed.data.videoId!==locator.eventId)throw new Error('SWAC event media changed');
      for(const media of parsed.data.urls){
        if(media.streamFormat!=='hls')continue;
        const scope=mediaScope(media.url,event.kickoff),url=exactUrl(media.url);
        if(scope && url)return {root:swacResource(url,scope,'playlist',requester),close(){}};
      }
      throw new Error('SWAC event did not publish supported HLS');
    },
  };
}
