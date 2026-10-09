import { VerificationTargetSchema } from '@/lib/football/shared';
import { revokeVerificationTarget } from '@/lib/stream-server';

export const dynamic='force-dynamic';

export async function POST(request:Request){
  const token=process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if(!token||request.headers.get('x-sunday-control-token')!==token)return new Response(null,{status:404});
  let body:unknown;
  try{body=await request.json();}catch{return new Response(null,{status:400});}
  const target=VerificationTargetSchema.safeParse(body);
  if(!target.success)return new Response(null,{status:400});
  revokeVerificationTarget(target.data.sessionId,target.data.generation);
  return new Response(null,{status:204});
}
