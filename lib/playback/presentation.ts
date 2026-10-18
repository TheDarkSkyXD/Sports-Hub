import {z} from 'zod';
import {MediaCheckResultSchema,type MediaDeferralReasonSchema,type MediaFailureReason,type MediaPhase,type MediaTimings} from '../football/shared.ts';

const capability=z.string().uuid();
const relayUrl=z.string().refine(value=>/^\/api\/stream\/(?:media\/[a-f0-9]{48}|[^/?]+\/index\.m3u8\?[^#]+)$/.test(value));
const fallbackUrl=z.string().max(2048).refine(value=>{
  if(!/^\/api\/stream\/[^/?#]+\/presentation\?[^#]+$/.test(value))return false;
  const url=new URL(value,'http://localhost');
  if(url.pathname!==value.split('?')[0])return false;
  const keys=[...url.searchParams.keys()],candidate=url.searchParams.get('candidate');
  return keys.length===4&&new Set(keys).size===4&&keys.every(key=>['session','candidate','generation','intent'].includes(key))&&
    capability.safeParse(url.searchParams.get('session')).success&&candidate!==null&&candidate.length>0&&candidate.length<=100&&
    /^\d{1,8}$/.test(url.searchParams.get('generation')??'')&&url.searchParams.get('intent')==='fallback';
});
export const PresentationSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('hls'),url:relayUrl,fallbackUrl:fallbackUrl.optional()}).strict(),
  z.object({kind:z.literal('progressive'),url:relayUrl,fallbackUrl:fallbackUrl.optional()}).strict(),
  z.object({kind:z.literal('isolated-embed'),capability}).strict(),
]);
export type Presentation=z.infer<typeof PresentationSchema>;
export type PresentationResult={kind:'ready';presentation:Presentation;timings?:MediaTimings}|
  {kind:'deferred';reason:z.infer<typeof MediaDeferralReasonSchema>;retryAfterMs?:number;phase?:MediaPhase}|
  {kind:'unavailable';reason?:MediaFailureReason;phase?:MediaPhase};
export function relayOutcome(value:unknown){
  try{
    if(value&&typeof value==='object'&&'responseText'in value)value=value.responseText;
    if(typeof value==='string'){if(value.length>8192)return null;value=JSON.parse(value);}
    if(!value||typeof value!=='object'||!('outcome'in value))return null;
    const parsed=MediaCheckResultSchema.safeParse(value.outcome);
    return parsed.success&&parsed.data.kind!=='playable'?parsed.data:null;
  }catch{return null;}
}
export async function readPresentation(response:Response):Promise<PresentationResult>{
  if(!response.ok){
    const reported=relayOutcome(await response.text().catch(()=>null));
    if(reported)return reported.kind==='deferred'?{...reported,reason:reported.reason??'upstream'}:reported;
    if(response.status===429||response.status===503){
      const retry=response.headers.get('Retry-After')?.trim();
      const delay=retry?(/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()):NaN;
      return {kind:'deferred',reason:response.status===429?'capacity':'upstream',phase:'resolution',
        retryAfterMs:Number.isFinite(delay)?Math.max(2000,Math.min(300000,delay)):response.status===429?2000:30000};
    }
    return {kind:'unavailable'};
  }
  const parsed=PresentationSchema.safeParse(await response.json().catch(()=>null));
  const timings:MediaTimings={};
  for(const entry of (response.headers.get('Server-Timing')??'').split(',')){
    const match=/^(resolution|capture);dur=(\d{1,6})$/.exec(entry.trim());
    if(match&&Number(match[2])<=300000){if(match[1]==='resolution')timings.resolutionMs=Number(match[2]);else timings.captureMs=Number(match[2]);}
  }
  return parsed.success?{kind:'ready',presentation:parsed.data,...(Object.keys(timings).length?{timings}:{})}:{kind:'unavailable'};
}
