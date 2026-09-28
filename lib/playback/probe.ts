import { createDecipheriv } from 'node:crypto';
import type { CandidateProbeResult } from '../football/domain/ports.ts';
import type { CandidateLocator } from '../football/shared.ts';
import { openProvider } from './provider-registry.ts';
import { ProviderDeferredError, type ProviderPlayback, type ProviderResource } from './provider.ts';

type Range = { start: number; length: number };
type Encryption = { uri: string; iv?: string };
type Media = { uri: string; range?: Range; encryption?: Encryption; sequence: bigint };
type Segment = Media & { map?: Media };
type Budget = { bytes: number; playlists: number };
class ProbeFailure extends Error {
  readonly reason: 'unsupported' | 'invalid-media';
  constructor(reason: 'unsupported' | 'invalid-media') { super(reason); this.reason=reason; }
}
const invalid = (): never => { throw new ProbeFailure('invalid-media'); };
const unsupported = (): never => { throw new ProbeFailure('unsupported'); };

function attributes(line: string): Record<string,string> {
  return Object.fromEntries([...line.slice(line.indexOf(':')+1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
    .map(match=>[match[1],match[2].replace(/^"|"$/g,'')]));
}

function range(value: string, uri: string, previous?: Media): Range {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) return invalid();
  const length = Number(match[1]);
  const start = match[2] !== undefined ? Number(match[2]) :
    previous?.uri === uri && previous.range ? previous.range.start + previous.range.length : NaN;
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(start) || start < 0 ||
    !Number.isSafeInteger(start + length)) return invalid();
  return {start,length};
}

function segments(lines: string[]): Segment[] {
  let sequence = BigInt(0);
  let encryption: Encryption | undefined;
  let map: Media | undefined;
  let pendingRange: string | undefined;
  let duration = false;
  let gap = false;
  let previous: Media | undefined;
  const result: Segment[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const value = line.slice(line.indexOf(':')+1);
      if (!/^\d+$/.test(value)) return invalid();
      sequence = BigInt(value);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const values = attributes(line);
      if (values.METHOD === 'NONE') encryption = undefined;
      else {
        if (values.METHOD !== 'AES-128' || values.KEYFORMAT && values.KEYFORMAT !== 'identity') return unsupported();
        if (!values.URI || values.IV && !/^0x[\da-f]{1,32}$/i.test(values.IV)) return invalid();
        encryption = {uri:values.URI,iv:values.IV};
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const values = attributes(line);
      if (!values.URI || encryption && !encryption.iv) return invalid();
      map = {uri:values.URI,encryption,sequence,
        ...(values.BYTERANGE ? {range:range(values.BYTERANGE,values.URI,map)} : {})};
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(line.indexOf(':')+1);
    else if (line.startsWith('#EXTINF:')) duration = true;
    else if (line === '#EXT-X-GAP') gap = true;
    else if (line && !line.startsWith('#')) {
      if (!duration) return invalid();
      const item: Segment = {uri:line,encryption,map,sequence,
        ...(pendingRange ? {range:range(pendingRange,line,previous)} : {})};
      previous = item;
      if (!gap) result.push(item);
      sequence++;
      duration = false;
      gap = false;
      pendingRange = undefined;
    }
  }
  return result;
}

function mediaSignature(prefix: Buffer, audio: boolean): boolean {
  for (let offset=0;offset<188 && offset+376<prefix.length;offset++)
    if (prefix[offset]===0x47 && prefix[offset+188]===0x47 && prefix[offset+376]===0x47) return true;
  if (prefix.length>=12 && ['ftyp','styp','moof','moov'].includes(prefix.toString('ascii',4,8)) && prefix.readUInt32BE(0)>=8) return true;
  if (!audio) return false;
  let offset = 0;
  if (prefix.toString('ascii',0,3)==='ID3' && prefix.length>=10) {
    offset = 10 + ((prefix[6]&127)<<21) + ((prefix[7]&127)<<14) + ((prefix[8]&127)<<7) + (prefix[9]&127);
  }
  return prefix.length>offset+1 && prefix[offset]===0xff && (prefix[offset+1]&0xe0)===0xe0;
}

async function consume(resource: ProviderResource, signal: AbortSignal, budget: Budget, limit: number,
  prefixLimit: number, byteRange?: Range, decrypt?: ReturnType<typeof createDecipheriv>): Promise<{prefix:Buffer;bytes:number}> {
  const read = await resource.read({signal,range:byteRange ? `bytes=${byteRange.start}-${byteRange.start+byteRange.length-1}` : undefined});
  const expectedRange = byteRange && new RegExp(`^bytes ${byteRange.start}-${byteRange.start+byteRange.length-1}/(?:\\d+|\\*)$`);
  if (!read.body || (byteRange ? read.status!==206 || !expectedRange?.test(read.contentRange || '') : read.status!==200)) {
    await read.body?.cancel();
    return invalid();
  }
  const reader = read.body.getReader();
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  const keep = (part: Buffer) => {
    if (prefix.length<prefixLimit) prefix=Buffer.concat([prefix,part.subarray(0,prefixLimit-prefix.length)]);
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes+=item.value.byteLength;
      budget.bytes+=item.value.byteLength;
      if (bytes>limit || budget.bytes>64*1024*1024) return invalid();
      const value = Buffer.from(item.value);
      keep(decrypt ? decrypt.update(value) : value);
    }
    if (decrypt) {
      try { keep(decrypt.final()); } catch { return invalid(); }
    }
    if (!bytes || byteRange && bytes!==byteRange.length ||
      read.contentLength && bytes!==Number(read.contentLength)) return invalid();
    return {prefix,bytes};
  } finally { await reader.cancel().catch(()=>{}); }
}

function resolve(resource: ProviderResource, uri: string, kind: 'playlist'|'media'): ProviderResource {
  return resource.resolve(uri,kind) || invalid();
}

async function checkMedia(parent: ProviderResource, media: Media, signal: AbortSignal, budget: Budget, audio: boolean): Promise<void> {
  let decrypt: ReturnType<typeof createDecipheriv> | undefined;
  if (media.encryption) {
    const key = await consume(resolve(parent,media.encryption.uri,'media'),signal,budget,16,16);
    if (key.bytes!==16) return invalid();
    const hex = media.encryption.iv ? media.encryption.iv.slice(2) : media.sequence.toString(16);
    if (hex.length>32) return invalid();
    decrypt = createDecipheriv('aes-128-cbc',key.prefix,Buffer.from(hex.padStart(32,'0'),'hex'));
  }
  const value = await consume(resolve(parent,media.uri,'media'),signal,budget,64*1024*1024,4096,media.range,decrypt);
  if (!mediaSignature(value.prefix,audio)) return invalid();
}

async function checkPlaylist(resource: ProviderResource, signal: AbortSignal, budget: Budget, visited: Set<string>, audio=false): Promise<void> {
  if (++budget.playlists>12 || visited.has(resource.identity)) return invalid();
  visited.add(resource.identity);
  const {prefix} = await consume(resource,signal,budget,1024*1024,1024*1024);
  const text = prefix.toString('utf8').replace(/^\uFEFF/,'');
  if (!text.startsWith('#EXTM3U')) return invalid();
  const lines = text.split(/\r?\n/).map(line=>line.trim());
  const variants: Record<string,string>[] = lines.flatMap((line,index)=>{
    if (!line.startsWith('#EXT-X-STREAM-INF:')) return [];
    const uri = lines.slice(index+1).find(value=>value && !value.startsWith('#'));
    return uri ? [{...attributes(line),URI:uri}] : [];
  });
  if (variants.length) {
    const video = variants.filter(variant=>variant.RESOLUTION || /avc|hev|hvc|av01|vp0[89]/i.test(variant.CODECS || ''));
    const selected = [...(video.length ? video : variants)].sort((left,right)=>Number(right.BANDWIDTH||0)-Number(left.BANDWIDTH||0))[0];
    await checkPlaylist(resolve(resource,selected.URI,'playlist'),signal,budget,visited,audio);
    if (selected.AUDIO) {
      const renditions = lines.filter(line=>line.startsWith('#EXT-X-MEDIA:')).map(attributes)
        .filter(item=>item.TYPE==='AUDIO' && item['GROUP-ID']===selected.AUDIO);
      const rendition = renditions.find(item=>item.DEFAULT==='YES') || renditions.find(item=>item.AUTOSELECT==='YES') || renditions[0];
      if (rendition?.URI) await checkPlaylist(resolve(resource,rendition.URI,'playlist'),signal,budget,visited,true);
    }
    return;
  }
  const available = segments(lines);
  const segment = available[Math.max(0,available.length-3)];
  if (!segment) return invalid();
  if (segment.map) await checkMedia(resource,segment.map,signal,budget,false);
  await checkMedia(resource,segment,signal,budget,audio);
}

export async function probeCandidate(locator: CandidateLocator, signal: AbortSignal,
  opener: typeof openProvider = openProvider): Promise<CandidateProbeResult> {
  const timeout = AbortSignal.timeout(65000);
  const boundedSignal = AbortSignal.any([signal,timeout]);
  let playback: ProviderPlayback | undefined;
  try {
    playback = await opener(locator,boundedSignal,'probe');
    await checkPlaylist(playback.root,boundedSignal,{bytes:0,playlists:0},new Set());
    return {kind:'playable',proof:'media'};
  } catch (error) {
    if (signal.aborted) return {kind:'deferred',retryAfterMs:2000};
    if (error instanceof ProviderDeferredError) return {kind:'deferred',retryAfterMs:error.retryAfterMs};
    if (timeout.aborted || error instanceof Error && error.name==='TimeoutError') return {kind:'unavailable',reason:'timeout'};
    return {kind:'unavailable',reason:error instanceof ProbeFailure ? error.reason : 'upstream'};
  } finally { playback?.close(); }
}
