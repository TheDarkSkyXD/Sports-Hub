import { getFootballBoard } from '@/lib/sunday-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await getFootballBoard(), { headers: { 'Cache-Control': 'no-store' } });
}
