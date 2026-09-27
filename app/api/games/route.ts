import { command } from '@/lib/football/runtime/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const reply = await command({ kind: 'board' });
  if (reply.kind === 'error') return Response.json({ error: reply.message }, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
  if (reply.kind !== 'board') return Response.json({ error: 'Unexpected game response.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(reply.board, { headers: { 'Cache-Control': 'no-store' } });
}
