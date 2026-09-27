import { command } from './football/runtime/client';
import { boundedText, type ProviderResource } from './playback/provider.ts';
import { openGeneration, registeredResource, revokeStreamGeneration, rewritePlaylist, streamSignal, validByteRange, type StreamGrant } from './stream-relay.ts';

const noStore={'Cache-Control':'no-store'};
async function authorize(grant:StreamGrant):Promise<Response | null> {
  const reply=await command({kind:'authorize',sessionId:grant.sessionId,candidateId:grant.candidateId,generation:grant.generation});
  if (reply.kind==='error') {
    if (reply.status===410) revokeStreamGeneration(grant.sessionId,grant.generation);
    return Response.json({error:reply.message},{status:reply.status,headers:noStore});
  }
  if (reply.kind!=='authorized' || reply.session.gameId!==grant.gameId || reply.candidate.id!==grant.candidateId)
    return Response.json({error:'Stream authorization failed.'},{status:403,headers:noStore});
  return null;
}
async function playlist(resource:ProviderResource,grant:StreamGrant,requestSignal:AbortSignal):Promise<Response> {
  const signal=AbortSignal.any([requestSignal,streamSignal(grant)]);
  const read=await resource.read({signal});
  if (read.status!==200) {await read.body?.cancel();throw new Error('Provider playlist is unavailable');}
  const response=new Response(read.body,{status:read.status,headers:read.contentLength?{'Content-Length':read.contentLength}:undefined});
  const body=await boundedText(response);
  if (signal.aborted || await authorize(grant)) throw new Error('Stream generation ended');
  const rewritten=rewritePlaylist(body,resource,grant);
  return new Response(rewritten,{headers:{...noStore,'Content-Type':'application/vnd.apple.mpegurl; charset=utf-8'}});
}

export async function streamIndex(gameId:string,sessionId:string|null,candidateId:string|null,generation:string|null,
  requestSignal:AbortSignal=new AbortController().signal):Promise<Response> {
  if (!sessionId || !candidateId || generation===null || !/^\d{1,8}$/.test(generation))
    return Response.json({error:'Invalid stream session.'},{status:400,headers:noStore});
  const number=Number(generation);
  const reply=await command({kind:'authorize',sessionId,candidateId,generation:number});
  if (reply.kind==='error') {
    if (reply.status===410) revokeStreamGeneration(sessionId,number);
    return Response.json({error:reply.message},{status:reply.status,headers:noStore});
  }
  if (reply.kind!=='authorized' || reply.session.gameId!==gameId)
    return Response.json({error:'Stream authorization failed.'},{status:403,headers:noStore});
  const grant={sessionId,candidateId,generation:number,gameId};
  try {
    const playback=await openGeneration(grant,reply.candidate.locator,requestSignal);
    return await playlist(playback.root,grant,requestSignal);
  } catch (error) {
    console.warn('Browser stream lookup failed:',error instanceof Error?error.message:'Unknown error');
    return Response.json({error:'The provider stream is unavailable. Try another server.'},{status:502,headers:noStore});
  }
}

export async function streamToken(token:string,range:string|null,
  requestSignal:AbortSignal=new AbortController().signal):Promise<Response> {
  const record=registeredResource(token);
  if (!record) return Response.json({error:'Stream resource expired or unknown.'},{status:404,headers:noStore});
  if (range && !validByteRange(range)) return Response.json({error:'Invalid byte range.'},{status:416,headers:noStore});
  const denied=await authorize(record);
  if (denied) return denied;
  try {
    if (record.kind==='playlist') return await playlist(record.resource,record,requestSignal);
    const signal=AbortSignal.any([requestSignal,streamSignal(record)]);
    const read=await record.resource.read({signal,range:range || undefined});
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
