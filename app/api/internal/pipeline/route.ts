import { command } from '@/lib/football/runtime/client';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.SUNDAY_ROOM_CONTROL_TOKEN;
  if (!secret || request.headers.get('x-sunday-control-token') !== secret) return new Response(null,{status:404});
  const reply = await command({kind:'stop'});
  return new Response(null,{status:reply.kind === 'ok' ? 204 : 503});
}
