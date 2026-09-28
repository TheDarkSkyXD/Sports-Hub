import { closePlayback, resolvePlayback, updatePlayback } from '@/lib/playback-server';
import { CommandSchema } from '@/lib/football/shared';

export const dynamic = 'force-dynamic';
const isJson = (request: Request) => request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() === 'application/json';

export async function POST(request: Request) {
  if (!isJson(request)) return Response.json({ error: 'Use JSON for playback requests.' }, { status: 415 });
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: 'Invalid playback request.' }, { status: 400 }); }
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'open') return Response.json({ error: 'Invalid playback request.' }, { status: 400 });
  const result = await resolvePlayback(parsed.data.gameId, parsed.data.manual, parsed.data.requestId, parsed.data.initialCandidateId);
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: Request) {
  if (!isJson(request)) return Response.json({ error: 'Use JSON for playback requests.' }, { status: 415 });
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: 'Invalid playback request.' }, { status: 400 }); }
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success || parsed.data.kind !== 'session') return Response.json({ error: 'Invalid playback request.' }, { status: 400 });
  const body = parsed.data;
  const result = await updatePlayback(body.sessionId, body.generation, body.candidateId, body.failure, body.retry);
  if ('error' in result) return Response.json({ error: result.error, retryAfter: result.retryAfter, code: result.code }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}

export async function DELETE(request: Request) {
  const result = await closePlayback(new URL(request.url).searchParams.get('session'));
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
