import {z} from 'zod';
import {command} from '@/lib/football/runtime/client';

const Target=z.object({sessionId:z.string().uuid(),candidateId:z.string().min(1).max(100),
  generation:z.number().int().nonnegative(),gameId:z.string().min(1).max(100),purpose:z.literal('verification').optional()}).strict();
export const dynamic='force-dynamic';
export async function POST(request:Request){
  const secret=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(!secret||request.headers.get('x-sunday-control-token')!==secret)return new Response(null,{status:404});
  const input=Target.safeParse(await request.json().catch(()=>null));
  if(!input.success)return new Response(null,{status:400});
  const target=input.data,reply=await command({kind:'authorize',sessionId:target.sessionId,candidateId:target.candidateId,generation:target.generation});
  const valid=reply.kind==='authorized'&&target.purpose===undefined&&reply.session.gameId===target.gameId&&reply.candidate.id===target.candidateId||
    reply.kind==='verification-authorized'&&target.purpose==='verification'&&reply.target.gameId===target.gameId&&reply.candidate.id===target.candidateId;
  return new Response(null,{status:valid?204:403});
}
