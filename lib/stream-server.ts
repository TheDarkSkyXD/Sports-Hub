import { resolvePlayback } from './playback-server';
import { limitedText, providerHeaders, registeredResource, rewritePlaylist, sourceFromEmbed, validByteRange, validResourceUrl } from './stream-relay';

const noStore = { 'Cache-Control': 'no-store' };
async function read(url: string, range?: string): Promise<Response> {
  return fetch(url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { ...providerHeaders, ...(range ? { Range: range } : {}) } });
}
async function playlist(url: string, gameId: string, playerId: string): Promise<Response> {
  if (!validResourceUrl(url, playerId, 'playlist')) return Response.json({ error: 'Unsupported stream address.' }, { status: 502 });
  const upstream = await read(url);
  if (!upstream.ok) throw new Error(`Playlist returned ${upstream.status}`);
  const body = rewritePlaylist(await limitedText(upstream), url, gameId, playerId);
  return new Response(body, { headers: { ...noStore, 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' } });
}

export async function streamIndex(gameId: string, server: string | null): Promise<Response> {
  const index = server === null ? 0 : Number(server);
  if (!Number.isInteger(index) || index < 0 || index > 5) return Response.json({ error: 'Choose a valid server.' }, { status: 400 });
  const playback = await resolvePlayback(gameId);
  if (playback.status !== 200) return Response.json({ error: playback.error }, { status: playback.status });
  const player = playback.value.players[index];
  if (!player) return Response.json({ error: 'This server is not listed for the game.' }, { status: 404 });
  try {
    const embed = await read(player.url);
    if (!embed.ok) throw new Error(`Player returned ${embed.status}`);
    const source = sourceFromEmbed(await limitedText(embed), player.id);
    if (!source) throw new Error('Player did not publish a supported HLS source');
    return await playlist(source, gameId, player.id);
  } catch (error) {
    console.warn('Browser stream lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: 'The provider stream is unavailable. Try another server.' }, { status: 502, headers: noStore });
  }
}

export async function streamToken(token: string, range: string | null): Promise<Response> {
  const resource = registeredResource(token);
  if (!resource) return Response.json({ error: 'Stream resource expired or unknown.' }, { status: 404, headers: noStore });
  if (range && !validByteRange(range)) return Response.json({ error: 'Invalid byte range.' }, { status: 416, headers: noStore });
  try {
    if (resource.kind === 'playlist') return await playlist(resource.url, resource.gameId, resource.playerId);
    const upstream = await read(resource.url, range || undefined);
    if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) throw new Error(`Media returned ${upstream.status}`);
    const headers = new Headers({ ...noStore, 'Content-Type': 'video/mp2t' });
    for (const name of ['content-range', 'content-length', 'accept-ranges']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    console.warn('Browser media lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: 'The provider media is unavailable.' }, { status: 502, headers: noStore });
  }
}
