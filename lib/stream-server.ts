import { command } from './football/runtime/client.ts';
import { boundedText, type ProviderResource } from './playback/provider.ts';
import { openGeneration, registeredResource, revokeStreamGeneration, rewritePlaylist, streamSignal, validByteRange, type StreamGrant } from './stream-relay.ts';

const noStore={'Cache-Control':'no-store'};
type ReadWaiter={signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:unknown)=>void;abort:()=>void};
type ReadGate={active:number;waiting:ReadWaiter[]};
declare global {var sundayRoomVerificationReads:ReadGate|undefined;}
const verificationReads:ReadGate=globalThis.sundayRoomVerificationReads??={active:0,waiting:[]};
function drainVerificationReads():void {
  while(verificationReads.active<8&&verificationReads.waiting.length){
    const waiter=verificationReads.waiting.shift()!;
    waiter.signal.removeEventListener('abort',waiter.abort);
    if(waiter.signal.aborted){waiter.reject(waiter.signal.reason);continue;}
    verificationReads.active++;
    let released=false;
    waiter.resolve(()=>{
      if(released)return;
      released=true;
      verificationReads.active--;
      drainVerificationReads();
    });
  }
}
function verificationPermit(signal:AbortSignal):Promise<()=>void>{
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const waiter:ReadWaiter={signal,resolve,reject,abort:()=>{
      const index=verificationReads.waiting.indexOf(waiter);
      if(index>=0)verificationReads.waiting.splice(index,1);
      reject(signal.reason);
    }};
    signal.addEventListener('abort',waiter.abort,{once:true});
    verificationReads.waiting.push(waiter);
    drainVerificationReads();
  });
}
async function readResource(resource:ProviderResource,grant:StreamGrant,signal:AbortSignal,range?:string){
  if(grant.purpose!=='verification')return resource.read({signal,range});
  const release=await verificationPermit(signal);
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
  try {
    const playback=await openGeneration(grant,reply.candidate.locator,requestSignal,opener,
      reply.kind==='verification-authorized'?'probe':'playback',
      reply.kind==='verification-authorized'?reply.deadline:undefined);
    return await playlist(playback.root,grant,requestSignal,send);
  } catch (error) {
    console.warn('Browser stream lookup failed:',error instanceof Error?error.message:'Unknown error');
    return Response.json({error:'The provider stream is unavailable. Try another server.'},{status:502,headers:noStore});
  }
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
    console.warn('Browser media lookup failed:',error instanceof Error?error.message:'Unknown error');
    return Response.json({error:'The provider media is unavailable.'},{status:502,headers:noStore});
  }
}
