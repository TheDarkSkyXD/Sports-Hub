import { getFootballBoard } from './sunday-server';
import { parsePlayers, SourcePlayer, validGameId, validSourcePage } from './sunday';

export type Playback = { gameId: string; sourceUrl: string; players: SourcePlayer[] };
export type PlaybackResult = { status: 200; value: Playback } | { status: 400 | 404 | 502; error: string; sourceUrl?: string };
const cache = new Map<string, { expires: number; value: Playback }>();

export async function resolvePlayback(game: unknown): Promise<PlaybackResult> {
  if (!validGameId(game)) return { status: 400, error: 'Choose a valid game.' };
  const existing = cache.get(game);
  if (existing && existing.expires > Date.now()) return { status: 200, value: existing.value };
  const board = await getFootballBoard();
  const sourceUrl = game === 'redzone' ? 'https://isportsurge.ws/event/nfl/nfl-redzone-live-streaming-links' : board.games.find(item => item.id === game)?.sourceUrl;
  if (!sourceUrl || !validSourcePage(sourceUrl)) return { status: 404, error: 'No source player is listed for this game yet.' };
  try {
    const read = () => fetch(sourceUrl, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'SundayRoom/1.0', Accept: 'text/html' } });
    let response = await read();
    if (response.status >= 500) response = await read();
    if (!response.ok) throw new Error(`Provider response ${response.status}`);
    const players = parsePlayers(await response.text());
    if (!players.length) return { status: 502, error: 'The provider has not published a compatible player for this game.', sourceUrl };
    const value = { gameId: game, sourceUrl, players };
    if (cache.size > 64) cache.clear();
    cache.set(game, { expires: Date.now() + 90000, value });
    return { status: 200, value };
  } catch (error) {
    console.warn('Provider lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return { status: 502, error: 'The game provider is temporarily unavailable. Try again shortly.', sourceUrl };
  }
}
