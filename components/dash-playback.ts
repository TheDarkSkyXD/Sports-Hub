import type shaka from 'shaka-player';
import type {MediaCheckResult} from '../lib/football/shared';
import {relayOutcome} from '../lib/playback/presentation.ts';

export function dashFailure(value:unknown):Exclude<MediaCheckResult,{kind:'playable'}>{
  const data=value&&typeof value==='object'&&'data'in value&&Array.isArray(value.data)?value.data:[];
  const status=typeof data[1]==='number'?data[1]:undefined;
  const category=value&&typeof value==='object'&&'category'in value?value.category:undefined;
  const bytes=data[2];
  const body=bytes instanceof ArrayBuffer&&bytes.byteLength<=8192?new TextDecoder().decode(bytes):
    ArrayBuffer.isView(bytes)&&bytes.byteLength<=8192?new TextDecoder().decode(bytes):typeof bytes==='string'?bytes:undefined;
  const outcome=relayOutcome(body);
  if(outcome)return outcome;
  if(category===1&&(status===undefined||status<=0||status===408||status===429||status>=500))return {
    kind:'deferred',reason:status===429?'capacity':'upstream',phase:'replay',retryAfterMs:status===429?2000:30000,
  };
  return {kind:'unavailable',reason:status===401||status===403?'blocked':status===404||status===410?'not-found':
    category===6?'unsupported':category===3||category===4?'invalid-media':'upstream',phase:'replay'};
}

export function dashRequestUrl(root:string,uri:string,kind:'manifest'|'segment',manifest?:string):string{
  const base=new URL(root),address=new URL(uri);
  const token=/^\/api\/stream\/media\/([a-f0-9]{48})$/.exec(base.pathname)?.[1];
  if(!token){
    if(address.origin!==base.origin||address.protocol!==base.protocol)throw new Error('Unsupported DASH request');
    return address.href;
  }
  if(uri===root)return root;
  if(address.username||address.password||address.hash||address.protocol!=='https:')throw new Error('Unsupported DASH request');
  const virtual=/^([a-f0-9]{48})\.dash\.invalid$/.exec(address.hostname)?.[1];
  if(address.port||address.hostname.endsWith('.dash.invalid')&&!virtual)throw new Error('Unsupported DASH request');
  const target=virtual?`${base.origin}/api/stream/media/${virtual}`:root;
  if(kind==='manifest'&&uri===manifest)return target;
  const reference=virtual?address.pathname+address.search:address.href;
  return `${target}?${new URLSearchParams({reference,kind})}`;
}

export type DashPlayback={
  qualities:Array<{height:number;bitrate:number}>;
  live:boolean;
  chooseQuality(index:number):void;
};
export async function loadDashPlayback({video,url,signal,purpose,onFailure}:{
  video:HTMLVideoElement;url:string;signal:AbortSignal;purpose:'viewing'|'verification';
  onFailure:(outcome:Exclude<MediaCheckResult,{kind:'playable'}>)=>void;
}):Promise<DashPlayback>{
  const {default:library}=await import('shaka-player');
  signal.throwIfAborted();
  library.polyfill.installAll();
  if(!library.Player.isBrowserSupported())throw new Error('DASH playback is unsupported');
  const player=new library.Player();
  let closed=false;
  const manifests=new Map<string,string>();
  const close=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',close);void player.destroy().catch(()=>{});};
  signal.addEventListener('abort',close,{once:true});
  const network=player.getNetworkingEngine();
  if(!network){close();throw new Error('DASH networking is unavailable');}
  const types=library.net.NetworkingEngine.RequestType;
  network.registerRequestFilter((type,request)=>{
    signal.throwIfAborted();
    if(type!==types.MANIFEST&&type!==types.SEGMENT)throw new Error('Unsupported DASH resource');
    request.uris=request.uris.map(uri=>dashRequestUrl(url,uri,type===types.MANIFEST?'manifest':'segment',manifests.get(new URL(uri).hostname)));
    const range=Object.entries(request.headers).find(([name])=>name.toLowerCase()==='range')?.[1];
    request.headers=range?{Range:range}:{};
    request.allowCrossSiteCredentials=false;
  });
  network.registerResponseFilter((type,response)=>{
    if(type!==types.MANIFEST)return;
    const base=response.headers['content-location'];
    if(base){
      const address=new URL(base);
      if(!/^https:\/\/[a-f0-9]{48}\.dash\.invalid$/.test(address.origin)||address.username||address.password||address.hash)
        throw new Error('Unsupported DASH base');
      manifests.set(address.hostname,address.href);
      response.uri=address.href;
    }
  });
  const failure=(value:unknown)=>{
    if(closed||signal.aborted||!value||typeof value!=='object')return;
    const severity='severity'in value?value.severity:undefined;
    if(severity!==library.util.Error.Severity.CRITICAL)return;
    onFailure(dashFailure(value));
  };
  player.addEventListener('error',(event:Event)=>{if('detail'in event)failure(event.detail);});
  player.configure({streaming:{bufferingGoal:purpose==='verification'?4:45,bufferBehind:purpose==='verification'?0:15,
    rebufferingGoal:2,retryParameters:{maxAttempts:2,timeout:20000}},
    manifest:{retryParameters:{maxAttempts:2,timeout:20000}},abr:{enabled:true}});
  try{
    await player.attach(video);
    signal.throwIfAborted();
    await player.load(url,undefined,'application/dash+xml');
    signal.throwIfAborted();
    const tracks:shaka.extern.Track[]=player.getVariantTracks();
    return {qualities:tracks.map(track=>({height:track.height??0,bitrate:track.bandwidth??0})),live:player.isLive(),
      chooseQuality(index){
        if(closed)return;
        player.configure({abr:{enabled:index===-1}});
        const track=tracks[index];
        if(index!==-1&&track)player.selectVariantTrack(track,true);
      }};
  }catch(error){failure(error);close();throw error;}
}
