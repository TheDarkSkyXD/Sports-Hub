import { GET as getGames } from '../games/route';
import { Board, parsePlayers, validSourcePage } from '@/lib/sunday';
export const dynamic = 'force-dynamic';
const cache = new Map<string, { expires: number; value: unknown }>();
export async function GET(request: Request) {
  const game = new URL(request.url).searchParams.get('game');
  if (!game || !/^(?:\d{1,20}|source-\d{1,20}|redzone)$/.test(game)) return Response.json({error:'Choose a valid game.'},{status:400});
  const existing = cache.get(game);
  if (existing && existing.expires > Date.now()) return Response.json(existing.value);
  const board: Board = await (await getGames()).json();
  const sourceUrl = game === 'redzone' ? 'https://isportsurge.ws/event/nfl/nfl-redzone-live-streaming-links' : board.games.find(g => g.id === game)?.sourceUrl;
  if (!sourceUrl || !validSourcePage(sourceUrl)) return Response.json({error:'No source player is listed for this game yet.'},{status:404});
  try {
    const read = () => fetch(sourceUrl, {cache:'no-store' as const, redirect:'error' as const, signal:AbortSignal.timeout(8000), headers:{'User-Agent':'SundayRoom/1.0',Accept:'text/html'}});
    let response = await read();
    if (response.status >= 500) response = await read();
    if (!response.ok) throw new Error(`Provider response ${response.status}`);
    const players = parsePlayers(await response.text());
    if (!players.length) return Response.json({error:'The provider has not published a compatible player for this game.',sourceUrl},{status:502});
    const value = { gameId:game, sourceUrl, players };
    if (cache.size > 64) cache.clear();
    cache.set(game,{expires:Date.now()+90000,value});
    return Response.json(value,{headers:{'Cache-Control':'no-store'}});
  } catch (error) { console.warn('Provider lookup failed:', error instanceof Error ? error.message : 'Unknown error'); return Response.json({error:'The game provider is temporarily unavailable. Try again shortly.',sourceUrl},{status:502}); }
}
