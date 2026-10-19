import { streamToken } from '@/lib/stream-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const query=new URL(request.url).searchParams;
  const reference=query.get('reference'),kind=query.get('kind');
  if((query.has('reference')||query.has('kind'))&&(query.size!==2||reference===null||(kind!=='manifest'&&kind!=='segment')))
    return new Response(null,{status:400});
  return streamToken(token, request.headers.get('range'), request.signal,undefined,
    reference===null?undefined:{reference,kind:kind==='manifest'?'manifest':'segment'});
}
