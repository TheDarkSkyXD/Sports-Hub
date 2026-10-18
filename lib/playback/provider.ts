import type { CandidateLocator, MediaPhase,MediaTimings,MediaDeferralReason } from '../football/shared.ts';

export type ResourceKind = 'playlist' | 'media';
export type ProviderReadResult = {
  status: 200 | 206 | 416;
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  contentLength?: string;
  contentRange?: string;
  acceptRanges?: string;
};
export interface ProviderResource {
  readonly kind: ResourceKind;
  readonly identity: string;
  read(input: {signal: AbortSignal; range?: string}): Promise<ProviderReadResult>;
  resolve(reference: string, expected: ResourceKind): ProviderResource | null;
}
export type PlayerDocument={url:string;referer:string};
export type ProviderPlayback=({readonly root:ProviderResource;readonly player?:PlayerDocument}|
  {readonly root:null;readonly player:PlayerDocument})&{readonly timings?:MediaTimings;close():void};
export interface PlaybackProvider<L extends CandidateLocator> {
  readonly provider: L['provider'];
  open(locator: L, signal: AbortSignal, purpose?: 'playback' | 'probe'): Promise<ProviderPlayback>;
}

export class ProviderDeferredError extends Error {
  readonly retryAfterMs: number;
  readonly phase?: MediaPhase;
  readonly reason?:MediaDeferralReason;
  constructor(retryAfterMs: number, phase?: MediaPhase,reason?:MediaDeferralReason) {
    super('Provider lookup is temporarily deferred');
    this.name='ProviderDeferredError';
    this.retryAfterMs=retryAfterMs;
    this.phase=phase;
    this.reason=reason;
  }
}

export class ProviderCapacityError extends ProviderDeferredError {
  constructor(){super(2000);this.name='ProviderCapacityError';}
}

export class ProviderNoFeedError extends Error {
  readonly phase: MediaPhase;
  constructor(phase: MediaPhase) {
    super('Selected player is explicitly offline');
    this.name='ProviderNoFeedError';
    this.phase=phase;
  }
}

export class ProviderHttpError extends Error {
  readonly status:number;
  constructor(status:number){super(`Provider media returned ${status}`);this.name='ProviderHttpError';this.status=status;}
}

export function sanitizedRead(response: Response): ProviderReadResult {
  if (response.status !== 200 && response.status !== 206 && response.status !== 416) {
    void response.body?.cancel();
    if(response.status===408||response.status===429||response.status>=500){
      const retryAfter=response.headers.get('Retry-After')?.trim();
      const delay=retryAfter?(/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:Date.parse(retryAfter)-Date.now()):NaN;
      throw new ProviderDeferredError(Number.isFinite(delay)&&delay>=0?Math.min(120_000,Math.max(2000,delay)):30_000,'replay');
    }
    throw new ProviderHttpError(response.status);
  }
  return {
    status:response.status,body:response.body,
    contentType:response.headers.get('content-type') || 'application/octet-stream',
    contentLength:response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
      ? undefined : response.headers.get('content-length') || undefined,
    contentRange:response.headers.get('content-range') || undefined,
    acceptRanges:response.headers.get('accept-ranges') || undefined,
  };
}

export async function boundedText(response: Response, limit = 1024*1024, allowErrorStatus=false): Promise<string> {
  if ((!response.ok && !allowErrorStatus) || !response.body) {
    await response.body?.cancel(); throw new Error(`Provider page returned ${response.status}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body.cancel(); throw new Error('Provider page is too large'); }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      size+=value.byteLength;
      if (size>limit) throw new Error('Provider page is too large');
      parts.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  return Buffer.concat(parts).toString('utf8');
}
