import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { boundedText, type ProviderPlayback, type ProviderReadResult, type ProviderResource } from '../provider.ts';
import { get, publicHttpsRequest, resource, sportsurgeUrl, type Requester } from './public-page.ts';

type Variant = { name: string; info: string; playlist: string; media: ReadonlyMap<string, URL> };
type Snapshot = { channel: string; variants: ReadonlyMap<string, Variant> };

const PAGE_LIMIT = 1024 * 1024;
const PLAYLIST_LIMIT = 256 * 1024;
const PAGE_TIMEOUT_MS = 10000;
const VARIANT_NAME = /^\d{1,2}_[a-z0-9-]{1,64}\.m3u8$/;
const CHANNEL = /^[a-z0-9-]{1,64}$/;
const PLAYLIST_TAG = /^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE):\d+|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-DISCONTINUITY|EXT-X-ENDLIST|EXTINF:\d+(?:\.\d+)?,?)$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object(value) : null;
}

function assignment(html: string, name: string): unknown {
  const marker = `var ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0 || html.indexOf(marker, start + marker.length) >= 0) return null;
  const open = html.indexOf('{', start + marker.length);
  if (open < 0 || open > start + marker.length + 8) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = open; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(open, index + 1)); }
      catch { return null; }
    }
  }
  return null;
}

function exactHost(value: string, host: string): URL | null {
  const url = sportsurgeUrl(value);
  return url?.hostname === host && !url.search && !url.hash ? url : null;
}

function parseSnapshot(html: string, page: URL): Snapshot | null {
  if (html.length > PAGE_LIMIT) return null;
  const master = record(assignment(html, 'masterinf'));
  const payload = record(assignment(html, 'payload'));
  const channel = payload?.name;
  const renditions = record(payload?.renditions);
  if (!master || !renditions || typeof channel !== 'string' || !CHANNEL.test(channel) ||
    page.pathname.split('/').at(-1) !== channel) return null;
  const entries = Object.entries(master);
  if (!entries.length || entries.length > 16 || entries.length !== Object.keys(renditions).length) return null;
  const variants = new Map<string, Variant>();
  for (const [name, value] of entries) {
    if (!VARIANT_NAME.test(name) || !name.endsWith(`_${channel}.m3u8`)) return null;
    const item = record(value);
    const key = name.slice(0, -'.m3u8'.length);
    const info = item?.inf;
    const subfolder = typeof item?.subfolder === 'string' ? sportsurgeUrl(item.subfolder) : null;
    const playlist = renditions[key];
    if (typeof info !== 'string' || info.length > 512 ||
      !/^#EXT-X-STREAM-INF:[A-Za-z0-9,.=" -]+$/.test(info) ||
      !subfolder || !subfolder.pathname.endsWith('/') || typeof playlist !== 'string' ||
      playlist.length > PLAYLIST_LIMIT || !playlist.startsWith('#EXTM3U\n')) return null;
    const lines = playlist.split(/\r?\n/);
    const media = new Map<string, URL>();
    for (const line of lines) {
      if (!line) continue;
      if (line.length > 2048) return null;
      if (line.startsWith('#')) {
        if (!PLAYLIST_TAG.test(line)) return null;
        continue;
      }
      let destination: URL;
      try { destination = new URL(line, subfolder); } catch { return null; }
      const allowed = sportsurgeUrl(destination.href);
      if (!allowed || !allowed.pathname.includes('/ephemeral/') || !/\.ts$/i.test(allowed.pathname)) return null;
      media.set(line, allowed);
    }
    if (!media.size || !lines.some(line => /^#EXT-X-MEDIA-SEQUENCE:\d+$/.test(line))) return null;
    variants.set(name,{name,info,playlist,media});
  }
  return {channel,variants};
}

function playlistRead(value: string): ProviderReadResult {
  const bytes = Buffer.from(value,'utf8');
  return {status:200,body:new Response(bytes).body,contentType:'application/vnd.apple.mpegurl',
    contentLength:String(bytes.byteLength)};
}

async function readPage(url: URL, referer: URL, signal: AbortSignal, requester: Requester): Promise<string> {
  const {url:final,response} = await get(url.href,signal,
    requester,referer,undefined,PAGE_TIMEOUT_MS);
  if (final.href !== url.href || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new Error('Provider wrapper changed');
  }
  const encoding = response.headers.get('content-encoding')?.toLowerCase();
  if (!encoding || encoding === 'identity') return boundedText(response,PAGE_LIMIT);
  if (encoding !== 'gzip' || !response.body) {
    await response.body?.cancel();
    throw new Error('Unsupported provider page encoding');
  }
  return boundedText(new Response(response.body.pipeThrough(new DecompressionStream('gzip'))),PAGE_LIMIT);
}

function nestedPlayer(html: string): URL | null {
  const declarations = [...html.matchAll(/\bf\.src\s*=\s*("https:\/\/[^"\r\n]{1,512}")\s*;/g)];
  if (declarations.length !== 1) return null;
  let declared: unknown;
  try { declared = JSON.parse(declarations[0][1]); } catch { return null; }
  const target = typeof declared === 'string' ? exactHost(declared,'topstreamer.site') : null;
  if (!target || !/^\/iframe\/[a-z0-9-]{1,32}\/[a-z0-9-]{1,64}$/.test(target.pathname)) return null;
  const $ = load(html);
  const noscript = $('noscript');
  if (noscript.length !== 1) return null;
  const fallback = load(noscript.html() || '')('iframe[src]');
  return fallback.length === 1 && fallback.attr('src') === target.href ? target : null;
}

export async function publishedTopstreamerVideo(server: URL, parent: URL, signal: AbortSignal,
  requester: Requester = (url,active,headers,timeoutMs) => publicHttpsRequest(url,active,headers,undefined,timeoutMs)): Promise<ProviderPlayback | null> {
  signal.throwIfAborted();
  const serverHtml = await readPage(server,parent,signal,requester);
  const $ = load(serverHtml);
  const canonical = $('link[rel="canonical"]');
  const frame = $('.player-embed-wrap iframe[src]');
  const basePath = server.pathname.replace(/\/(?:core|vector|vertex|foxtrot|main|hotel)\/[1-9]\d{0,2}$/, '');
  const eventBase = new URL(basePath,server.origin);
  if (basePath !== parent.pathname || canonical.length !== 1 || canonical.attr('href') !== eventBase.href ||
    frame.length !== 1) return null;
  const middle = exactHost(frame.attr('src') || '', 'trendy48.site');
  if (!middle || !/^\/top\/[a-z0-9-]{1,64}$/.test(middle.pathname)) return null;
  const player = nestedPlayer(await readPage(middle,server,signal,requester));
  if (!player || player.pathname.split('/').at(-1) !== middle.pathname.split('/').at(-1)) return null;
  const initial = parseSnapshot(await readPage(player,middle,signal,requester),player);
  signal.throwIfAborted();
  if (!initial) return null;

  const lifetime = new AbortController();
  let closed = false;
  let latest = initial;
  const activeSignal = (requested: AbortSignal) => {
    if (closed) throw new Error('Topstreamer playback is closed');
    return AbortSignal.any([requested,lifetime.signal]);
  };
  const refreshSnapshot = async (requested: AbortSignal) => {
    const active = activeSignal(requested);
    const next = parseSnapshot(await readPage(player,middle,active,requester),player);
    active.throwIfAborted();
    if (!next || next.channel !== initial.channel ||
      [...next.variants.keys()].some(name => !initial.variants.has(name))) throw new Error('Topstreamer playlist changed');
    latest = next;
    return next;
  };
  const mediaResource = (url: URL): ProviderResource => {
    const source = resource(url,player,'media',requester);
    return {kind:'media',identity:`topstreamer:media:${createHash('sha256').update(url.href).digest('hex')}`,
      read({signal:requested,range}) { return source.read({signal:activeSignal(requested),range}); },
      resolve() { return null; }};
  };
  const variantResource = (name: string): ProviderResource => {
    const recent = new Map(latest.variants.get(name)?.media);
    return {kind:'playlist',identity:`topstreamer:variant:${player.href}:${name}`,
      async read({signal:requested}) {
        const next = await refreshSnapshot(requested);
        const variant = next.variants.get(name);
        if (!variant) throw new Error('Topstreamer rendition changed');
        for (const [reference,url] of variant.media) {
          const previous = recent.get(reference);
          if (previous && previous.href !== url.href) throw new Error('Topstreamer media reference changed');
          recent.set(reference,url);
        }
        while (recent.size > 256) {
          const oldest = recent.keys().next();
          if (oldest.done) break;
          recent.delete(oldest.value);
        }
        return playlistRead(variant.playlist);
      },
      resolve(reference,expected) {
        if (closed || expected !== 'media') return null;
        const url = recent.get(reference);
        return url ? mediaResource(url) : null;
      },
    };
  };
  return {root:{kind:'playlist',identity:`topstreamer:master:${player.href}`,
    async read({signal:requested}) {
      activeSignal(requested).throwIfAborted();
      return playlistRead(`#EXTM3U\n#EXT-X-VERSION:6\n${[...initial.variants.values()]
        .map(item=>`${item.info}\n${item.name}\n`).join('')}`);
    },
    resolve(reference,expected) {
      return !closed && expected === 'playlist' && initial.variants.has(reference) ? variantResource(reference) : null;
    }},
    close() { if (closed) return; closed=true; lifetime.abort(); latest={channel:initial.channel,variants:new Map()}; },
  };
}
