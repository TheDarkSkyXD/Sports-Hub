import { command } from '@/lib/football/runtime/client';
import { CommandSchema } from '@/lib/football/shared';

export const dynamic='force-dynamic';

export async function GET() {
  const reply=await command({kind:'sources'});
  if (reply.kind==='error') return Response.json({error:reply.message},{status:reply.status,headers:{'Cache-Control':'no-store'}});
  if (reply.kind!=='sources') return Response.json({error:'Source inventory is unavailable.'},{status:502,headers:{'Cache-Control':'no-store'}});
  return Response.json(reply.snapshot,{headers:{'Cache-Control':'no-store'}});
}

export async function POST(request:Request) {
  let body:unknown;
  try{body=await request.json();}catch{return Response.json({error:'Invalid source check request.'},{status:400});}
  const parsed=CommandSchema.safeParse(body);
  if(!parsed.success||parsed.data.kind!=='check-sources')return Response.json({error:'Invalid source check request.'},{status:400});
  const reply=await command(parsed.data);
  if(reply.kind==='error')return Response.json({error:reply.message},{status:reply.status,headers:{'Cache-Control':'no-store'}});
  if(reply.kind!=='ok')return Response.json({error:'Source checks could not start.'},{status:502,headers:{'Cache-Control':'no-store'}});
  return Response.json({checking:true},{headers:{'Cache-Control':'no-store'}});
}
