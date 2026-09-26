import { streamIndex } from '@/lib/stream-server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  return streamIndex(gameId, new URL(_request.url).searchParams.get('server'));
}
