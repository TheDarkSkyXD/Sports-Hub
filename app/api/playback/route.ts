import { resolvePlayback } from '@/lib/playback-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const result = await resolvePlayback(new URL(request.url).searchParams.get('game'));
  if (result.status !== 200) return Response.json({ error: result.error, sourceUrl: result.sourceUrl }, { status: result.status });
  return Response.json(result.value, { headers: { 'Cache-Control': 'no-store' } });
}
