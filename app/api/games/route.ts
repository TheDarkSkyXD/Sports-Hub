import { after } from 'next/server';
import { getFootballBoard, warmSourceDates } from '@/lib/sunday-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const board = await getFootballBoard();
  after(() => warmSourceDates(board));
  return Response.json(board, { headers: { 'Cache-Control': 'no-store' } });
}
