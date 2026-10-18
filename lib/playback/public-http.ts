import {lookup} from 'node:dns/promises';
import {Agent,request} from 'node:https';
import {isIP} from 'node:net';
import ipaddr from 'ipaddr.js';
import {createBrotliDecompress,createGunzip,createInflate} from 'node:zlib';

export type ContinuousRead={received:(bytes:number)=>boolean;acquire:()=>()=>void};
const MAX_MEDIA_BYTES=64*1024*1024;
const HEADER_WAIT_MS=10000;
const agent=new Agent({keepAlive:true,maxFreeSockets:4,timeout:30000});
const globalV6=ipaddr.parseCIDR('2000::/3'),specialV6=ipaddr.parseCIDR('2001::/23');

export function isPublicAddress(address: string): boolean {
  if(!isIP(address))return false;
  const value=ipaddr.parse(address);
  return value.range()==='unicast'&&(value.kind()==='ipv4'||value.match(globalV6)&&!value.match(specialV6));
}


export function publicHttpsUrl(value: string,maxLength=2048): URL | null {
  try {
    const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
    const url = new URL(value);
    if (!authority || authority.toLowerCase() !== url.host || url.href.length > maxLength ||
      url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '8443' || url.hash ||
      url.hostname.endsWith('.') || isIP(url.hostname) || url.hostname.startsWith('[') ||
      !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

export async function directPublicHttpsRequest(url: URL, signal: AbortSignal, headers: Headers,
  resolveAddresses: (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>> = host => lookup(host, { all: true }),
  timeoutMs = 10000,continuous?:ContinuousRead): Promise<Response> {
  if (!publicHttpsUrl(url.href,8192)) throw new Error('Unsupported provider URL');
  const dnsSignal = AbortSignal.any([signal, AbortSignal.timeout(HEADER_WAIT_MS)]);
  const addresses = await new Promise<ReadonlyArray<{ address: string; family: number }>>((resolve, reject) => {
    if (dnsSignal.aborted) { reject(dnsSignal.reason); return; }
    const onAbort = () => reject(dnsSignal.reason);
    dnsSignal.addEventListener('abort', onAbort, { once: true });
    resolveAddresses(url.hostname).then(resolve, reject).finally(() => dnsSignal.removeEventListener('abort', onAbort));
  });
  if (!addresses.length || addresses.some(item => item.family !== isIP(item.address) || !isPublicAddress(item.address)))
    throw new Error('Provider resolved to a private address');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  const release=continuous?.acquire()??(()=>{});
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(url, {
      method: 'GET', headers: Object.fromEntries(headers), signal,agent,
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, incoming => {
      clearTimeout(headerTimer);
      incoming.once('close',release);
      incoming.on('error', reject);
      try {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') responseHeaders.set(key, value);
          else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
        }
        const length = Number(responseHeaders.get('content-length'));
        if (!continuous&&Number.isFinite(length) && length > MAX_MEDIA_BYTES) throw new Error('Provider response is too large');
        const status = incoming.statusCode || 502;
        if (status === 204 || status === 205 || status === 304) {
          incoming.destroy();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const encoding=responseHeaders.get('content-encoding')?.toLowerCase().trim();
        const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():
          encoding==='br'?createBrotliDecompress():undefined;
        if(encoding&&encoding!=='identity'&&!decoder)throw new Error('Unsupported provider content encoding');
        if(decoder){responseHeaders.delete('content-encoding');responseHeaders.delete('content-length');}
        const source=decoder?incoming.pipe(decoder):incoming;
        if(decoder){
          let compressed=0;
          incoming.on('data',chunk=>{
            compressed+=chunk.length;
            if(compressed>MAX_MEDIA_BYTES)incoming.destroy(new Error('Provider response exceeded its byte budget'));
          });
          incoming.on('error',error=>decoder.destroy(error));
          source.on('error',()=>{});
        }
        let bodyTimer:ReturnType<typeof setTimeout>;
        const armBodyTimer=()=>{
          clearTimeout(bodyTimer);
          bodyTimer=setTimeout(()=>outgoing.destroy(new Error('Provider response timed out')),timeoutMs);
        };
        if(!continuous)armBodyTimer();
        incoming.once('close', () => clearTimeout(bodyTimer));
        const iterator = source[Symbol.asyncIterator]();
        let received = 0;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if(continuous)armBodyTimer();
              const next = await iterator.next();
              if(continuous)clearTimeout(bodyTimer);
              if (next.done) { controller.close(); return; }
              received += next.value.byteLength;
              if (continuous?!continuous.received(next.value.byteLength):received>MAX_MEDIA_BYTES)throw new Error('Provider response exceeded its byte budget');
              controller.enqueue(new Uint8Array(next.value));
            } catch (error) { clearTimeout(bodyTimer);source.destroy();incoming.destroy(); controller.error(error); }
          },
          cancel() { clearTimeout(bodyTimer);source.destroy();incoming.destroy(); },
        });
        resolve(new Response(body, { status, headers: responseHeaders }));
      } catch (error) { incoming.destroy(); reject(error); }
    });
    const headerTimer = setTimeout(() => outgoing.destroy(new Error('Provider response timed out')), HEADER_WAIT_MS);
    outgoing.on('error', error => { clearTimeout(headerTimer);release(); reject(error); });
    outgoing.end();
  });
}

export const publicFetch:typeof fetch=async(input,init={})=>{
  const inherited=input instanceof Request?input:undefined;
  const method=init.method??inherited?.method??'GET';
  if(method.toUpperCase()!=='GET'||init.body!=null||inherited?.body||
    (init.redirect??inherited?.redirect??'manual')!=='manual')throw new Error('Provider transport requires a manual GET');
  const url=new URL(inherited?.url??String(input));
  const headers=new Headers(init.headers??inherited?.headers);
  if(!headers.has('accept-encoding'))headers.set('accept-encoding','gzip, deflate, br');
  return directPublicHttpsRequest(url,init.signal??inherited?.signal??new AbortController().signal,headers);
};

