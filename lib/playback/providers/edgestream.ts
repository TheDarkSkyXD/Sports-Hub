import { sanitizedRead, type ProviderResource, type ResourceKind } from '../provider.ts';

export type MediaSession = {stream:string;host:string;referer:string;fetcher:typeof fetch};
const mediaHosts=new Set(['edgestream1.pro','edgestream3.pro','edgestream4.pro','edgestream5.pro','edgestream6.pro','edgestream7.pro']);

function exactHttps(value:string):URL|null {
  try {
    const address=new URL(value);
    const authority=/^https:\/\/([^/?#]+)/.exec(value)?.[1];
    return authority===address.hostname && !address.port && !address.username && !address.password && !address.hash ? address:null;
  } catch {return null;}
}

export function validEdgestreamResourceUrl(value:string,session:Pick<MediaSession,'stream'|'host'>,kind:ResourceKind):boolean {
  const url=exactHttps(value);
  if(!url||url.hostname!==session.host||!mediaHosts.has(url.hostname))return false;
  if(kind==='playlist') {
    if(url.pathname!==`/hls/${session.stream}.m3u8`)return false;
    if([...url.searchParams.keys()].sort().join(',')!=='e,st')return false;
    const expiry=url.searchParams.get('e')||'';
    const signature=url.searchParams.get('st')||'';
    return /^\d{10,13}$/.test(expiry)&&/^[A-Za-z0-9_-]{16,512}$/.test(signature)&&Number(expiry)>Date.now()/1000;
  }
  return !url.search&&new RegExp(`^/hls/${session.stream}-[0-9]{1,16}\\.ts$`).test(url.pathname);
}

export function edgestreamResource(url:string,session:MediaSession,kind:ResourceKind):ProviderResource|null {
  if(!validEdgestreamResourceUrl(url,session,kind))return null;
  return {kind,identity:url,
    async read({signal,range}) {
      const response=await session.fetcher(url,{cache:'no-store',redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)]),
        headers:{Origin:'https://streame.center',Referer:session.referer,...(range?{Range:range}:{})}});
      return sanitizedRead(response);
    },
    resolve(reference,expected) {try{return edgestreamResource(new URL(reference,url).href,session,expected);}catch{return null;}},
  };
}

export function publishedManifest(html:string):string|null {
  const literal=/\bconst\s+streamUrl\s*=\s*("(?:[^"\\]|\\.)*")/.exec(html)?.[1];
  try {const value:unknown=JSON.parse(literal||'null');return typeof value==='string'?value:null;}catch{return null;}
}
