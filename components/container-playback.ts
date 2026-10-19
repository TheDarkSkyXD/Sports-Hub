import type {MediaCheckResult} from '../lib/football/shared';

export function containerFailure({network,status,unsupported}:{network:boolean;status?:number;unsupported:boolean}):Exclude<MediaCheckResult,{kind:'playable'}>{
  if(network&&(status===undefined||status<=0||status===408||status===429||status>=500))return {
    kind:'deferred',reason:status===429?'capacity':'upstream',phase:'replay',retryAfterMs:status===429?2000:30000,
  };
  return {kind:'unavailable',reason:network?status===401||status===403?'blocked':status===404||status===410?'not-found':'upstream':
    unsupported?'unsupported':'invalid-media',phase:network?'replay':'decode'};
}

export async function loadContainerPlayback({video,url,format,signal,purpose,onFailure}:{
  video:HTMLVideoElement;url:string;format:'flv'|'mpegts';signal:AbortSignal;purpose:'viewing'|'verification';
  onFailure:(outcome:Exclude<MediaCheckResult,{kind:'playable'}>)=>void;
}):Promise<void>{
  const {default:library}=await import('mpegts.js');
  signal.throwIfAborted();
  library.LoggingControl.enableAll=false;
  if(!library.getFeatureList().mseLivePlayback)throw new Error('Container playback is unsupported');
  const player=library.createPlayer({type:format,url,isLive:true},{enableWorker:true,
    autoCleanupSourceBuffer:true,autoCleanupMaxBackwardDuration:purpose==='verification'?2:15,
    autoCleanupMinBackwardDuration:purpose==='verification'?1:10});
  let closed=false;
  const close=()=>{
    if(closed)return;closed=true;signal.removeEventListener('abort',close);
    player.destroy();
  };
  signal.addEventListener('abort',close,{once:true});
  player.on(library.Events.ERROR,(type:unknown,detail:unknown,info:unknown)=>{
    if(closed||signal.aborted)return;
    const status=info&&typeof info==='object'&&'code'in info&&typeof info.code==='number'?info.code:undefined;
    onFailure(containerFailure({network:type===library.ErrorTypes.NETWORK_ERROR,status,
      unsupported:detail===library.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED||detail===library.ErrorDetails.MEDIA_CODEC_UNSUPPORTED}));
    close();
  });
  try{player.attachMediaElement(video);player.load();}
  catch(error){close();throw error;}
}
