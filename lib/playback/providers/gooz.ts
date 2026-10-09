import type { CandidateLocator } from '../../football/shared.ts';
import { boundedText, sanitizedRead, type PlaybackProvider, type ProviderPlayback, type ProviderResource, type ResourceKind } from '../provider.ts';
import {scopedFetch,timedFetch} from '../probe-capacity.ts';

type GoozLocator = Extract<CandidateLocator,{provider:'gooz'}>;
const VARIANT_HOSTS = new Set(['red.redirector1.space','pl.kamfir5.space','pl.goozekhar2.space','pl.playlist3.space','pl.playlist4.space','pl.playlist5.space','pl.playlist6.space']);
const headers = {'User-Agent':'Mozilla/5.0',Referer:'https://gooz.aapmains.net/',Origin:'https://gooz.aapmains.net'};

export function validGoozResourceUrl(value: string, playerId: string, kind: ResourceKind): boolean {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    if (!authority || authority.includes(':') || authority.includes('@')) return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.port || url.hostname !== authority) return false;
    if (kind === 'playlist') {
      if (url.search) return false;
      if (url.hostname === 'chatgpt.hereisman.net') return url.pathname === `/playlist/${playerId}/load-playlist`;
      if (!VARIANT_HOSTS.has(url.hostname)) return false;
      const match = /^\/playlist\/\d{1,20}\/([a-z0-9]{1,32}(?:\.[a-z0-9]{1,32}){0,3})\/(caxi(?:-low|-fhd)?)$/.exec(url.pathname);
      return !!match && url.pathname === `/playlist/${playerId}/${match[1]}/${match[2]}`;
    }
    if (!/^[a-z0-9]{1,32}\.[a-f0-9]{32}(?:\.(?:us|eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)) return false;
    const match = /^\/scripts\/([^/]+)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
    if (!match || match[1] !== encodeURIComponent(Buffer.from(playerId,'utf8').toString('base64'))) return false;
    const signatures=url.searchParams.getAll('X-Amz-Signature');
    return signatures.length===1 && /^[a-f0-9]{64}$/i.test(signatures[0]);
  } catch { return false; }
}

export function goozSourceFromEmbed(html: string, playerId: string): string | null {
  const direct=/\b(?:const|let|var)\s+source\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1];
  const encoded=/\batobClappr\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/.exec(html)?.[1];
  const url=direct || (encoded ? Buffer.from(encoded,'base64').toString('utf8') : null);
  return url && validGoozResourceUrl(url,playerId,'playlist') ? url : null;
}

function identity(url: string, kind: ResourceKind): string {
  if (kind === 'playlist') return url;
  const address=new URL(url);
  for (const name of [...address.searchParams.keys()]) if (/^X-Amz-(?:Signature|Date|Expires|Credential|Security-Token|Algorithm|SignedHeaders)$/i.test(name)) address.searchParams.delete(name);
  return address.href;
}

function nflSegment(reference: string, playlist: string, fetcher: typeof fetch): ProviderResource | null {
  const wrapper=new URL(reference,playlist);
  const backend=new URL(playlist).pathname.split('/')[3];
  const segment=/^\/redirect\/video-[135](segment_[a-z0-9]+)\.txt$/.exec(wrapper.pathname);
  if (!segment || wrapper.origin!==`https://${backend}` || wrapper.username || wrapper.password || wrapper.hash ||
    [...wrapper.searchParams.keys()].join(',')!=='path') return null;
  const target=new URL(wrapper.searchParams.get('path') || '');
  const authority=/^https:\/\/([^/?#]+)/.exec(target.href)?.[1];
  const credentials=/^o\d{6}-mp-lura-live\.fsy\.nfl\.com$/.test(target.hostname) ? ['token'] :
    /^o\d{6}-mp-lura-live\.akamaized\.net$/.test(target.hostname) ? ['hdntl'] :
      /^o\d{6}\.mp\.lura\.live$/.test(target.hostname) ? ['Expires','KeyName','Signature'] : null;
  if (authority!==target.hostname || !credentials ||
    !/^\/live\/ephemeral\/(?:[A-Za-z0-9_-]+\/)+segment_[a-z0-9]+\.ts$/.test(target.pathname) ||
    !target.pathname.endsWith(`/${segment[1]}.ts`) || target.hash || target.href.length>4096 ||
    target.searchParams.size!==credentials.length ||
    !credentials.every(name=>target.searchParams.getAll(name).length===1&&!!target.searchParams.get(name))) return null;
  const stable=new URL(target);
  stable.search='';
  return {
    kind:'media',identity:stable.href,
    async read({signal,range}) {
      return sanitizedRead(await timedFetch(fetcher,target.href,{cache:'no-store',redirect:'manual',
        signal,headers:range?{Range:range}:{}},10000));
    },
    resolve() { return null; },
  };
}

export function goozResource(url: string, playerId: string, kind: ResourceKind, fetcher: typeof fetch = scopedFetch): ProviderResource | null {
  if (!validGoozResourceUrl(url,playerId,kind)) return null;
  return {
    kind,identity:identity(url,kind),
    async read({signal,range}) {
      const response=await timedFetch(fetcher,url,{cache:'no-store',redirect:'manual',signal,
        headers:{...headers,...(range?{Range:range}:{})}},10000);
      return sanitizedRead(response);
    },
    resolve(reference,expected) {
      try {
        return goozResource(new URL(reference,url).href,playerId,expected,fetcher) ||
          (kind==='playlist' && expected==='media' ? nflSegment(reference,url,fetcher) : null);
      } catch { return null; }
    },
  };
}

export const goozProvider: PlaybackProvider<GoozLocator> = {
  provider:'gooz',
  async open(locator,signal): Promise<ProviderPlayback> {
    const {playerId}=locator;
    if (!/^\d{1,20}$/.test(playerId)) throw new Error('Unsupported Gooz player');
    const response=await timedFetch(scopedFetch,`https://gooz.aapmains.net/new-stream-embed/${playerId}`,
      {cache:'no-store',redirect:'manual',signal,headers},10000);
    const source=goozSourceFromEmbed(await boundedText(response),playerId);
    const root=source && goozResource(source,playerId,'playlist');
    if (!root) throw new Error('Gooz player did not publish supported HLS');
    return {root,close() {}};
  },
};
