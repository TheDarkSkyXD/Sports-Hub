import { streamIndex } from '@/lib/stream-server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  const search = new URL(_request.url).searchParams;
  return streamIndex(gameId, search.get('session'), search.get('candidate'), search.get('generation'), _request.signal);
}
