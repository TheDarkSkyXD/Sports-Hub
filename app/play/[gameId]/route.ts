import { validGameId } from '@/lib/sunday';

export async function GET(request: Request, context: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await context.params;
  if (!validGameId(gameId)) return new Response('Invalid game.', { status: 400 });
  if (gameId === 'redzone') return new Response('The RedZone channel is unavailable in Sunday Room.', { status: 404 });
  const home = new URL('/', request.url);
  home.searchParams.set('game', gameId);
  return Response.redirect(home, 303);
}
