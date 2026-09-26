import { randomBytes } from 'node:crypto';

export type ResourceKind = 'playlist' | 'media';
export type StreamGrant = { sessionId: string; candidateId: string; generation: number; gameId: string; playerId: string };
type Resource = StreamGrant & { kind: ResourceKind; url: string; usedAt: number };
type Registry = { byToken: Map<string, Resource>; byResource: Map<string, string>; controllers: Map<string, AbortController>; revoked: Map<string, number> };
declare global { var sundayRoomStreamRegistry: Registry | undefined; }
const registry = globalThis.sundayRoomStreamRegistry ??= { byToken: new Map(), byResource: new Map(), controllers: new Map(), revoked: new Map() };
registry.controllers ??= new Map();
registry.revoked ??= new Map();
const IDLE_MS = 5 * 60 * 1000;
const MAX_RESOURCES = 4096;
const VARIANT_HOSTS = new Set(['red.redirector1.space', 'pl.kamfir5.space', 'pl.goozekhar2.space', 'pl.playlist3.space', 'pl.playlist4.space', 'pl.playlist5.space', 'pl.playlist6.space']);
export const providerHeaders = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gooz.aapmains.net/', Origin: 'https://gooz.aapmains.net' };
export function validByteRange(value: string): boolean {
  const start = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (start) return !start[2] || BigInt(start[1]) <= BigInt(start[2]);
  const suffix = /^bytes=-(\d+)$/.exec(value);
  return !!suffix && BigInt(suffix[1]) > BigInt(0);
}

export function validResourceUrl(value: string, playerId: string, kind: ResourceKind): boolean {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    if (!authority || authority.includes(':') || authority.includes('@')) return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.port || url.hostname !== authority) return false;
    if (kind === 'playlist') {
      if (url.search) return false;
      if (url.hostname === 'chatgpt.hereisman.net') return url.pathname === `/playlist/${playerId}/load-playlist`;
      if (!VARIANT_HOSTS.has(url.hostname)) return false;
      const match = /^\/playlist\/\d{1,20}\/([a-z0-9]{1,32})\/caxi$/.exec(url.pathname);
      return !!match && url.pathname === `/playlist/${playerId}/${match[1]}/caxi`;
    }
    if (!/^[a-z0-9]{1,32}\.[a-f0-9]{32}(?:\.(?:us|eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)) return false;
    const match = /^\/scripts\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (!match || match[1] !== encodeURIComponent(Buffer.from(playerId, 'utf8').toString('base64'))) return false;
    const signatures = url.searchParams.getAll('X-Amz-Signature');
    return signatures.length === 1 && /^[a-f0-9]{64}$/i.test(signatures[0]);
  } catch { return false; }
}

export function sourceFromEmbed(html: string, playerId: string): string | null {
  const direct = /\b(?:const|let|var)\s+source\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1];
  const encoded = /\batobClappr\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/.exec(html)?.[1];
  const url = direct || (encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null);
  return url && validResourceUrl(url, playerId, 'playlist') ? url : null;
}

function key(resource: Pick<Resource, keyof StreamGrant | 'kind' | 'url'>): string {
  const address = new URL(resource.url);
  if (resource.kind === 'media') {
    for (const name of [...address.searchParams.keys()]) if (/^X-Amz-(?:Signature|Date|Expires|Credential|Security-Token|Algorithm|SignedHeaders)$/i.test(name)) address.searchParams.delete(name);
  }
  return `${resource.sessionId}\n${resource.candidateId}\n${resource.generation}\n${resource.gameId}\n${resource.playerId}\n${resource.kind}\n${address.href}`;
}
function remove(token: string, resource: Resource): void {
  registry.byToken.delete(token);
  const resourceKey = key(resource);
  if (registry.byResource.get(resourceKey) === token) registry.byResource.delete(resourceKey);
}
const grantKey = (grant: Pick<StreamGrant, 'sessionId' | 'generation'>) => `${grant.sessionId}:${grant.generation}`;
export function streamSignal(grant: StreamGrant): AbortSignal {
  const key = grantKey(grant);
  const now = Date.now();
  for (const [revokedKey, at] of registry.revoked) if (now - at > 10 * 60_000) registry.revoked.delete(revokedKey);
  if (registry.revoked.has(key) || registry.revoked.has(grant.sessionId)) return AbortSignal.abort();
  let controller = registry.controllers.get(key);
  if (!controller) { controller = new AbortController(); registry.controllers.set(key, controller); }
  return controller.signal;
}
export function revokeGeneration(sessionId: string, keepGeneration: number): void {
  for (const key of registry.controllers.keys()) {
    if (key.startsWith(`${sessionId}:`) && key !== `${sessionId}:${keepGeneration}`) revokeStreamGeneration(sessionId, Number(key.slice(sessionId.length + 1)));
  }
  for (const resource of registry.byToken.values()) if (resource.sessionId === sessionId && resource.generation !== keepGeneration) revokeStreamGeneration(sessionId, resource.generation);
}
export function revokeStreamGeneration(sessionId: string, generation: number): void {
  const key = `${sessionId}:${generation}`;
  const controller = registry.controllers.get(key);
  controller?.abort();
  registry.controllers.delete(key);
  registry.revoked.set(key, Date.now());
  for (const [token, resource] of registry.byToken) if (resource.sessionId === sessionId && resource.generation === generation) remove(token, resource);
}
export function revokeSession(sessionId: string): void {
  registry.revoked.set(sessionId, Date.now());
  for (const [key, controller] of registry.controllers) {
    if (key.startsWith(`${sessionId}:`)) { controller.abort(); registry.controllers.delete(key); }
  }
  for (const [token, resource] of registry.byToken) if (resource.sessionId === sessionId) remove(token, resource);
}
export function resourceCount(): number { return registry.byToken.size; }
function prune(): void {
  const now = Date.now();
  for (const [token, resource] of registry.byToken) if (now - resource.usedAt > IDLE_MS) remove(token, resource);
  while (registry.byToken.size >= MAX_RESOURCES) {
    const oldest = [...registry.byToken].reduce((a, b) => a[1].usedAt <= b[1].usedAt ? a : b);
    remove(oldest[0], oldest[1]);
  }
}
export function registerResource(grant: StreamGrant, url: string, kind: ResourceKind): string {
  if (streamSignal(grant).aborted) throw new Error('Stream generation ended');
  if (!validResourceUrl(url, grant.playerId, kind)) {
    console.warn('Unsupported stream resource:', kind);
    throw new Error('Unsupported stream resource');
  }
  prune();
  const resource = { ...grant, kind, url };
  const existing = registry.byResource.get(key(resource));
  if (existing) { const saved = registry.byToken.get(existing); if (saved) { saved.url = url; saved.usedAt = Date.now(); return existing; } }
  const token = randomBytes(24).toString('hex');
  registry.byToken.set(token, { ...resource, usedAt: Date.now() });
  registry.byResource.set(key(resource), token);
  return token;
}
export function registeredResource(token: string): Resource | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const resource = registry.byToken.get(token);
  if (!resource) return null;
  if (Date.now() - resource.usedAt > IDLE_MS) { remove(token, resource); return null; }
  resource.usedAt = Date.now();
  return resource;
}

export function rewritePlaylist(body: string, base: string, grant: StreamGrant): string {
  if (!body.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  let nextIsPlaylist = false;
  return body.split(/\r?\n/).map(line => {
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) nextIsPlaylist = true;
      return line.replace(/URI="([^"]+)"/g, (_attribute, value: string) => {
        const kind: ResourceKind = /^(#EXT-X-MEDIA|#EXT-X-I-FRAME-STREAM-INF|#EXT-X-RENDITION-REPORT)/.test(line) ? 'playlist' : 'media';
        const token = registerResource(grant, new URL(value, base).href, kind);
        return `URI="/api/stream/media/${token}"`;
      });
    }
    if (!line.trim()) return line;
    const kind: ResourceKind = nextIsPlaylist ? 'playlist' : 'media';
    nextIsPlaylist = false;
    const token = registerResource(grant, new URL(line.trim(), base).href, kind);
    return `/api/stream/media/${token}`;
  }).join('\n');
}

export async function limitedText(response: Response, limit = 1024 * 1024): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) throw new Error('Manifest is too large');
  if (!response.body) throw new Error('Manifest is empty');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Manifest is too large');
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  return Buffer.concat(parts).toString('utf8');
}
