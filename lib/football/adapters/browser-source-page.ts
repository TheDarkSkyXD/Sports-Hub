import {z} from 'zod';

const MAX_BYTES=4*1024*1024;
const Reply=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('complete'),url:z.string().url(),body:z.string()}).strict(),
  z.object({kind:z.literal('failed'),reason:z.enum(['unavailable','unsupported-address','capacity','closed','window-closed',
    'timeout','challenge','network-error','page-changed','response-too-large'])}).strict(),
]);
const SourcePath=/^\/(?:nba|nfl|nhl|mlb|cfb|wnba|mma|boxing|f1|nascar|motogp|wwe)[1-9][0-9]{0,2}\/$/;

export async function readBrowserSourcePage(value:string,signal:AbortSignal):Promise<string|null> {
  const url=new URL(value);
  if(value!==url.href||url.origin!=='https://dudestream1.com'||url.username||url.password||url.port||url.search||url.hash||!SourcePath.test(url.pathname))return null;
  const origin=process.env.SUNDAY_ROOM_SPORTSURGE_OBSERVER_ORIGIN,token=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(!origin||!token||!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin))return null;
  const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(40_000)]);
  let response:Response;
  try {
    response=await fetch(`${origin}/source-page`,{method:'POST',cache:'no-store',redirect:'manual',
      signal:requestSignal,headers:{'content-type':'application/json','x-sunday-control-token':token},
      body:JSON.stringify({url:value})});
  } catch(error) {
    signal.throwIfAborted();
    if(requestSignal.aborted||error instanceof Error&&error.name==='TimeoutError')throw new Error('source-page-timeout');
    return null;
  }
  if(!response.ok){await response.body?.cancel();return null;}
  if(!/application\/json/i.test(response.headers.get('content-type')??'')||!response.body) {
    await response.body?.cancel();throw new Error('source-page-invalid-response');
  }
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let bytes=0;
  try {
    for(;;) {
      signal.throwIfAborted();
      const chunk=await reader.read();if(chunk.done)break;
      bytes+=chunk.value.byteLength;
      if(bytes>MAX_BYTES*2+4096)throw new Error('source-page-response-too-large');
      chunks.push(chunk.value);
    }
  } catch(error){
    await reader.cancel().catch(()=>{});
    signal.throwIfAborted();
    if(requestSignal.aborted)throw new Error('source-page-timeout');
    throw error;
  } finally {reader.releaseLock();}
  let json:unknown;
  try {json=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('source-page-invalid-response');}
  const parsed=Reply.safeParse(json);
  if(!parsed.success)throw new Error('source-page-invalid-response');
  const reply=parsed.data;
  if(reply.kind==='failed') {
    if(reply.reason==='unavailable')return null;
    throw new Error(`source-page-${reply.reason}`);
  }
  if(reply.url!==value)throw new Error('source-page-changed');
  if(Buffer.byteLength(reply.body,'utf8')>MAX_BYTES)throw new Error('source-page-response-too-large');
  return reply.body;
}
