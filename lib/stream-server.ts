import { command } from './football/runtime/client.ts';
import { boundedText, ProviderCapacityError, ProviderDeferredError, ProviderHttpError, ProviderNoFeedError, type ProviderResource } from './playback/provider.ts';
import { openGeneration, registeredResource, registerResource,retainGenerationPlayer,revokeStreamGeneration, rewritePlaylist, streamSignal, validByteRange, StreamPlaylistError, type StreamGrant } from './stream-relay.ts';
import type {Presentation} from './playback/presentation.ts';
import type {PlayerDocument} from './playback/provider.ts';
import type {PlayerCapability} from './stream-relay.ts';
import type {MediaCheckResult,MediaPhase} from './football/shared.ts';
import verificationPolicy from './playback/verification-policy.json' with {type:'json'};

const noStore={'Cache-Control':'no-store'};
const transientNetworkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
function relayFailure(error:unknown,message:string,phase:MediaPhase='replay'):Response {
  const cause=error instanceof Error&&error.cause!==undefined?error.cause:error;
  const code=cause&&typeof cause==='object'&&'code' in cause?cause.code:undefined;
  if(error instanceof ProviderDeferredError||error instanceof Error&&error.name==='TimeoutError'||typeof code==='string'&&transientNetworkCodes.has(code)){
    const capacity=error instanceof ProviderCapacityError;
    const delay=error instanceof ProviderDeferredError?error.retryAfterMs:30_000;
    const retryAfterMs=Number.isFinite(delay)?Math.min(120_000,Math.max(2000,delay)):30_000;
    const outcome:MediaCheckResult={kind:'deferred',reason:capacity?'capacity':error instanceof ProviderDeferredError?error.reason??'upstream':'upstream',
      phase:error instanceof ProviderDeferredError?error.phase??phase:phase,retryAfterMs};
    return Response.json({error:'The provider stream is still being checked.',outcome},
      {status:capacity?429:503,headers:{...noStore,'Retry-After':String(Math.ceil(retryAfterMs/1000))}});
  }
  const status=error instanceof StreamPlaylistError?(error.reason==='invalid-media'?422:415):
    error instanceof ProviderNoFeedError?404:error instanceof ProviderHttpError&&(error.status===403||error.status===404)?error.status:502;
  console.warn(message,error instanceof Error?error.message:'Unknown error');
  const outcome:MediaCheckResult={kind:'unavailable',reason:error instanceof StreamPlaylistError?error.reason:
    error instanceof ProviderNoFeedError?'no-feed':status===403?'blocked':status===404?'not-found':'upstream',
    phase:error instanceof ProviderNoFeedError?error.phase:phase};
  return Response.json({error:'The provider stream is unavailable. Try another server.',outcome},{status,headers:noStore});
}
type ReadGate={active:number};
declare global {var sundayRoomVerificationReads:ReadGate|undefined;}
const verificationReads:ReadGate=globalThis.sundayRoomVerificationReads??={active:0};
function verificationPermit(signal:AbortSignal):()=>void {
  signal.throwIfAborted();
  if(verificationReads.active>=verificationPolicy.concurrency*2)throw new ProviderCapacityError();
  verificationReads.active++;
  let released=false;
  return ()=>{if(released)return;released=true;verificationReads.active--;};
}
async function readResource(resource:ProviderResource,grant:StreamGrant,signal:AbortSignal,range?:string){
  if(grant.purpose!=='verification')return resource.read({signal,range});
  const release=verificationPermit(signal);
  let read:Awaited<ReturnType<ProviderResource['read']>>;
  try{read=await resource.read({signal,range});}catch(error){release();throw error;}
  if(!read.body){release();return read;}
  const reader=read.body.getReader();
  let closed=false;
  const finish=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',abort);release();};
  const abort=()=>{void reader.cancel(signal.reason).then(finish,finish);};
  const body=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        const part=await reader.read();
        if(part.done){controller.close();finish();}
        else controller.enqueue(part.value);
      }catch(error){try{controller.error(error);}catch{}finish();}
    },
    async cancel(reason){try{await reader.cancel(reason);}finally{finish();}},
  });
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  return {...read,body};
}
async function authorize(grant:StreamGrant,send:typeof command):Promise<Response | null> {
  const reply=await send({kind:'authorize',sessionId:grant.sessionId,candidateId:grant.candidateId,generation:grant.generation});
  if (reply.kind==='error') {
    if (reply.status===410) revokeStreamGeneration(grant.sessionId,grant.generation);
    return Response.json({error:reply.message},{status:reply.status,headers:noStore});
  }
  if ((reply.kind!=='authorized'&&reply.kind!=='verification-authorized') ||
    (reply.kind==='authorized'?reply.session.gameId:reply.target.gameId)!==grant.gameId ||
    reply.candidate.id!==grant.candidateId)
    return Response.json({error:'Stream authorization failed.'},{status:403,headers:noStore});
  return null;
}
async function playlist(resource:ProviderResource,grant:StreamGrant,requestSignal:AbortSignal,send:typeof command):Promise<Response> {
  const signal=AbortSignal.any([requestSignal,streamSignal(grant)]);
  const read=await readResource(resource,grant,signal);
  if (read.status!==200) {await read.body?.cancel();throw new Error('Provider playlist is unavailable');}
  const response=new Response(read.body,{status:read.status,headers:read.contentLength?{'Content-Length':read.contentLength}:undefined});
  const body=await boundedText(response);
  if (signal.aborted || await authorize(grant,send)) throw new Error('Stream generation ended');
  const rewritten=rewritePlaylist(body,resource,grant);
  return new Response(rewritten,{headers:{...noStore,'Content-Type':'application/vnd.apple.mpegurl; charset=utf-8'}});
}

export async function streamIndex(gameId:string,sessionId:string|null,candidateId:string|null,generation:string|null,
  requestSignal:AbortSignal=new AbortController().signal,send:typeof command=command,
  opener?:Parameters<typeof openGeneration>[3]):Promise<Response> {
  if (!sessionId || !candidateId || generation===null || !/^\d{1,8}$/.test(generation))
    return Response.json({error:'Invalid stream session.'},{status:400,headers:noStore});
  const number=Number(generation);
  const reply=await send({kind:'authorize',sessionId,candidateId,generation:number});
  if (reply.kind==='error') {
    if (reply.status===410) revokeStreamGeneration(sessionId,number);
    return Response.json({error:reply.message},{status:reply.status,headers:noStore});
  }
  if ((reply.kind!=='authorized'&&reply.kind!=='verification-authorized') ||
    (reply.kind==='authorized'?reply.session.gameId:reply.target.gameId)!==gameId)
    return Response.json({error:'Stream authorization failed.'},{status:403,headers:noStore});
  const grant:StreamGrant={sessionId,candidateId,generation:number,gameId,
    ...(reply.kind==='verification-authorized'?{purpose:'verification' as const}:{})};
  let phase:MediaPhase='resolution';
  try {
    const playback=await openGeneration(grant,reply.candidate.locator,requestSignal,opener,
      reply.kind==='verification-authorized'?'probe':'playback',
      reply.kind==='verification-authorized'?reply.deadline:undefined);
    if(!playback.root||playback.root.kind!=='playlist')throw new StreamPlaylistError('unsupported','This source requires its resolved player');
    phase='replay';
    return await playlist(playback.root,grant,requestSignal,send);
  } catch (error) {
    return relayFailure(error,'Browser stream lookup failed:',phase);
  }
}

export async function streamPresentation({gameId,sessionId,candidateId,generation,intent,signal:requestSignal}:{
  gameId:string;sessionId:string|null;candidateId:string|null;generation:string|null;
  intent:'primary'|'fallback';signal:AbortSignal;
},{send=command,opener,offer=offerIsolatedPlayer}:{
  send?:typeof command;opener?:Parameters<typeof openGeneration>[3];offer?:typeof offerIsolatedPlayer;
}={}):Promise<Response>{
  if(!sessionId||!candidateId||generation===null||!/^\d{1,8}$/.test(generation))return new Response(null,{status:400});
  requestSignal.throwIfAborted();
  let onAbort:()=>void=()=>{};
  const aborted=new Promise<never>((_resolve,reject)=>{
    onAbort=()=>reject(requestSignal.reason);requestSignal.addEventListener('abort',onAbort,{once:true});
  });
  try{
    const number=Number(generation),reply=await Promise.race([send({kind:'authorize',sessionId,candidateId,generation:number}),aborted]);
    if(reply.kind==='error'){if(reply.status===410)revokeStreamGeneration(sessionId,number);return Response.json({error:reply.message},{status:reply.status,headers:noStore});}
    if((reply.kind!=='authorized'&&reply.kind!=='verification-authorized')||
      (reply.kind==='authorized'?reply.session.gameId:reply.target.gameId)!==gameId||reply.candidate.id!==candidateId)return new Response(null,{status:403});
    const grant:StreamGrant={sessionId,candidateId,generation:number,gameId,...(reply.kind==='verification-authorized'?{purpose:'verification' as const}:{})};
    const deadline=reply.kind==='verification-authorized'?reply.deadline:undefined;
    const playback=await openGeneration(grant,reply.candidate.locator,requestSignal,opener,grant.purpose?'probe':'playback',deadline);
    requestSignal.throwIfAborted();
    let presentation:Presentation;
    if(intent==='primary'&&playback.root){
      const query=new URLSearchParams({session:sessionId,candidate:candidateId,generation:String(number),intent:'fallback'});
      presentation={kind:playback.root.kind==='playlist'?'hls':'progressive',
        url:playback.root.kind==='playlist'?`/api/stream/${encodeURIComponent(gameId)}/index.m3u8?session=${encodeURIComponent(sessionId)}&candidate=${encodeURIComponent(candidateId)}&generation=${number}`:
          `/api/stream/media/${registerResource(grant,playback.root)}`,
        ...(playback.player?{fallbackUrl:`/api/stream/${encodeURIComponent(gameId)}/presentation?${query}`}:{})};
    }else{
      const player=playback.player;
      if(!player)return Response.json({error:'This stream does not have a fallback player.'},{status:404,headers:noStore});
      const {capability}=await Promise.race([retainGenerationPlayer(grant,()=>offer(grant,player,deadline)),aborted]);
      requestSignal.throwIfAborted();
      presentation={kind:'isolated-embed',capability};
    }
    const timing=playback.timings;
    const serverTiming=[timing?.resolutionMs!==undefined?`resolution;dur=${timing.resolutionMs}`:null,
      timing?.captureMs!==undefined?`capture;dur=${timing.captureMs}`:null].filter(Boolean).join(',');
    return Response.json(presentation,{headers:{...noStore,...(serverTiming?{'Server-Timing':serverTiming}:{})}});
  }catch(error){
    if(requestSignal.aborted)throw requestSignal.reason;
    return relayFailure(error,'Player resolution failed:','resolution');
  }finally{requestSignal.removeEventListener('abort',onAbort);}
}

export function revokeVerificationTarget(sessionId:string,generation:number):void {
  revokeStreamGeneration(sessionId,generation);
}

export async function streamToken(token:string,range:string|null,
  requestSignal:AbortSignal=new AbortController().signal,send:typeof command=command):Promise<Response> {
  const record=registeredResource(token);
  if (!record) return Response.json({error:'Stream resource expired or unknown.'},{status:404,headers:noStore});
  if (range && !validByteRange(range)) return Response.json({error:'Invalid byte range.'},{status:416,headers:noStore});
  const denied=await authorize(record,send);
  if (denied) return denied;
  try {
    if (record.kind==='playlist') return await playlist(record.resource,record,requestSignal,send);
    const signal=AbortSignal.any([requestSignal,streamSignal(record)]);
    const read=await readResource(record.resource,record,signal,range || undefined);
    if (signal.aborted) throw new Error('Stream generation ended');
    const headers=new Headers({...noStore,'Content-Type':read.contentType});
    if (read.contentLength) headers.set('Content-Length',read.contentLength);
    if (read.contentRange) headers.set('Content-Range',read.contentRange);
    if (read.acceptRanges) headers.set('Accept-Ranges',read.acceptRanges);
    return new Response(read.body,{status:read.status,headers});
  } catch (error) {
    return relayFailure(error,'Browser media lookup failed:');
  }
}

export async function offerIsolatedPlayer(target:StreamGrant,player:PlayerDocument,deadline?:number):Promise<PlayerCapability>{
  const origin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN,token=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(!origin||!token||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin))throw new ProviderCapacityError();
  const response=await fetch(`${origin}/player`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(3000),
    headers:{'Content-Type':'application/json','x-sunday-control-token':token},body:JSON.stringify({target,player,deadline})});
  if(!response.ok){await response.body?.cancel();throw new ProviderCapacityError();}
  const value:unknown=await response.json();
  if(!value||typeof value!=='object'||!('capability'in value)||typeof value.capability!=='string'||!/^[a-f0-9-]{36}$/.test(value.capability))
    throw new Error('Invalid player capability');
  const capability=value.capability;
  return {capability,close(){void fetch(`${origin}/player/${capability}`,{method:'DELETE',redirect:'manual',
    signal:AbortSignal.timeout(3000),headers:{'x-sunday-control-token':token}}).then(reply=>reply.body?.cancel()).catch(()=>{});}};
}
