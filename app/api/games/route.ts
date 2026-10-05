import { command } from '@/lib/football/runtime/client';
import { CommandSchema } from '@/lib/football/shared';

export const dynamic = 'force-dynamic';

export async function GET() {
  const reply = await command({ kind: 'board' });
  if (reply.kind === 'error') return Response.json({ error: reply.message }, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
  if (reply.kind !== 'board') return Response.json({ error: 'Unexpected game response.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(reply.board, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request:Request) {
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')
    return Response.json({error:'Use application/json for retention settings.'},{status:415});
  let body:unknown;
  try {body=await request.json();}
  catch {return Response.json({error:'Invalid retention setting.'},{status:400});}
  const parsed=CommandSchema.safeParse(body);
  if(!parsed.success||parsed.data.kind!=='set-retention')
    return Response.json({error:'Choose a retention time from 5 to 10,080 minutes.'},{status:400});
  const reply=await command(parsed.data);
  if(reply.kind==='error')return Response.json({error:reply.message},{status:reply.status,headers:{'Cache-Control':'no-store'}});
  if(reply.kind!=='board')return Response.json({error:'Could not save the retention setting.'},{status:502,headers:{'Cache-Control':'no-store'}});
  return Response.json(reply.board,{headers:{'Cache-Control':'no-store'}});
}
