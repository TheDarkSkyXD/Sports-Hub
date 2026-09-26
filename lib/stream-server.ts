import { command } from './football/runtime/client';
import { limitedText, providerHeaders, registeredResource, revokeStreamGeneration, rewritePlaylist, sourceFromEmbed, streamSignal, validByteRange, validResourceUrl, type StreamGrant } from './stream-relay';

const noStore = { 'Cache-Control': 'no-store' };
async function read(url: string, grant: StreamGrant, requestSignal: AbortSignal, range?: string): Promise<Response> {
  const signal = AbortSignal.any([requestSignal, streamSignal(grant), AbortSignal.timeout(10000)]);
  return fetch(url, { cache: 'no-store', redirect: 'manual', signal, headers: { ...providerHeaders, ...(range ? { Range: range } : {}) } });
}
async function playlist(url: string, grant: StreamGrant, requestSignal: AbortSignal): Promise<Response> {
  if (!validResourceUrl(url, grant.playerId, 'playlist')) return Response.json({ error: 'Unsupported stream address.' }, { status: 502, headers: noStore });
  const upstream = await read(url, grant, requestSignal);
  if (!upstream.ok) throw new Error(`Playlist returned ${upstream.status}`);
  const text = await limitedText(upstream);
  if (requestSignal.aborted || streamSignal(grant).aborted) throw new Error('Stream generation ended');
  const denied = await authorize(grant);
  if (denied || requestSignal.aborted || streamSignal(grant).aborted) throw new Error('Stream generation ended');
  const body = rewritePlaylist(text, url, grant);
  return new Response(body, { headers: { ...noStore, 'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8' } });
}
async function authorize(grant: StreamGrant): Promise<Response | null> {
  const reply = await command({ kind: 'authorize', sessionId: grant.sessionId, candidateId: grant.candidateId, generation: grant.generation });
  if (reply.kind === 'error') { if (reply.status === 410) revokeStreamGeneration(grant.sessionId, grant.generation); return Response.json({ error: reply.message }, { status: reply.status, headers: noStore }); }
  if (reply.kind !== 'authorized' || reply.session.gameId !== grant.gameId || reply.candidate.playerId !== grant.playerId) {
    return Response.json({ error: 'Stream authorization failed.' }, { status: 403, headers: noStore });
  }
  return null;
}

export async function streamIndex(gameId: string, sessionId: string | null, candidateId: string | null, generation: string | null, requestSignal: AbortSignal = new AbortController().signal): Promise<Response> {
  if (!sessionId || !candidateId || generation === null || !/^\d{1,8}$/.test(generation)) return Response.json({ error: 'Invalid stream session.' }, { status: 400, headers: noStore });
  const number = Number(generation);
  const reply = await command({ kind: 'authorize', sessionId, candidateId, generation: number });
  if (reply.kind === 'error') { if (reply.status === 410) revokeStreamGeneration(sessionId, number); return Response.json({ error: reply.message }, { status: reply.status, headers: noStore }); }
  if (reply.kind !== 'authorized' || reply.session.gameId !== gameId) return Response.json({ error: 'Stream authorization failed.' }, { status: 403, headers: noStore });
  const player = reply.candidate;
  const grant: StreamGrant = { sessionId, candidateId, generation: number, gameId, playerId: player.playerId };
  if (!/^\d{1,20}$/.test(player.playerId) || player.url !== `https://gooz.aapmains.net/new-stream-embed/${player.playerId}`) {
    return Response.json({ error: 'Unsupported player address.' }, { status: 502, headers: noStore });
  }
  try {
    const embed = await read(player.url, grant, requestSignal);
    if (!embed.ok) throw new Error(`Player returned ${embed.status}`);
    const source = sourceFromEmbed(await limitedText(embed), player.playerId);
    if (!source) throw new Error('Player did not publish a supported HLS source');
    return await playlist(source, grant, requestSignal);
  } catch (error) {
    console.warn('Browser stream lookup failed:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: 'The provider stream is unavailable. Try another server.' }, { status: 502, headers: noStore });
  }
}

export async function streamToken(token: string, range: string | null, requestSignal: AbortSignal = new AbortController().signal): Promise<Response> {
  const resource = registeredResource(token);
  if (!resource) return Response.json({ error: 'Stream resource expired or unknown.' }, { status: 404, headers: noStore });
  if (range && !validByteRange(range)) return Response.json({ error: 'Invalid byte range.' }, { status: 416, headers: noStore });
  const denied = await authorize(resource);
  if (denied) return denied;
  try {
    if (resource.kind === 'playlist') return await playlist(resource.url, resource, requestSignal);
    const upstream = await read(resource.url, resource, requestSignal, range || undefined);
    if (requestSignal.aborted || streamSignal(resource).aborted) throw new Error('Stream generation ended');
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
