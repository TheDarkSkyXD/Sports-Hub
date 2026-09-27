import { command } from '@/lib/football/runtime/client';

export const dynamic='force-dynamic';

export async function GET() {
  const reply=await command({kind:'sources'});
  if (reply.kind==='error') return Response.json({error:reply.message},{status:reply.status,headers:{'Cache-Control':'no-store'}});
  if (reply.kind!=='sources') return Response.json({error:'Source inventory is unavailable.'},{status:502,headers:{'Cache-Control':'no-store'}});
  return Response.json(reply.snapshot,{headers:{'Cache-Control':'no-store'}});
}
