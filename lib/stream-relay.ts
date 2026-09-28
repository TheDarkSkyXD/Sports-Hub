import { randomBytes } from 'node:crypto';
import { SESSION_LEASE_MS } from './football/domain/lifecycle.ts';
import type { CandidateLocator } from './football/shared.ts';
import { openProvider } from './playback/provider-registry.ts';
import type { ProviderPlayback, ProviderResource, ResourceKind } from './playback/provider.ts';

export type StreamGrant = {sessionId:string; candidateId:string; generation:number; gameId:string};
type Resource = StreamGrant & {kind:ResourceKind; identity:string; resource:ProviderResource; usedAt:number};
type PlaybackState = {locator:CandidateLocator; opening?:Promise<ProviderPlayback>; openingController?:AbortController;
  waiters:number; playback?:ProviderPlayback};
type Registry = {
  byToken:Map<string,Resource>; byResource:Map<string,string>;
  controllers:Map<string,AbortController>; controllerUsedAt:Map<string,number>;
  playbacks:Map<string,PlaybackState>; revoked:Map<string,number>; timer?:ReturnType<typeof setInterval>;
};
declare global {var sundayRoomStreamRegistry:Registry | undefined;}
const registry:Registry=globalThis.sundayRoomStreamRegistry ??= {
  byToken:new Map(),byResource:new Map(),controllers:new Map(),controllerUsedAt:new Map(),playbacks:new Map(),revoked:new Map(),
};
const IDLE_MS=5*60_000;
const MAX_RESOURCES=4096;
const grantKey=(grant:Pick<StreamGrant,'sessionId'|'generation'>)=>`${grant.sessionId}:${grant.generation}`;

export function validByteRange(value:string):boolean {
  const start=/^bytes=(\d+)-(\d*)$/.exec(value);
  if (start) return !start[2] || BigInt(start[1])<=BigInt(start[2]);
  const suffix=/^bytes=-(\d+)$/.exec(value);
  return !!suffix && BigInt(suffix[1])>BigInt(0);
}

function key(record:Pick<Resource,keyof StreamGrant|'kind'|'identity'>):string {
  return `${grantKey(record)}\n${record.candidateId}\n${record.gameId}\n${record.kind}\n${record.identity}`;
}
function remove(token:string,resource:Resource):void {
  registry.byToken.delete(token);
  const resourceKey=key(resource);
  if (registry.byResource.get(resourceKey)===token) registry.byResource.delete(resourceKey);
}
function closePlayback(id:string):void {
  const state=registry.playbacks.get(id);
  registry.playbacks.delete(id);
  state?.openingController?.abort();
  state?.playback?.close();
}

export function streamSignal(grant:StreamGrant):AbortSignal {
  const id=grantKey(grant);
  const now=Date.now();
  for (const [revoked,at] of registry.revoked) if (now-at>10*60_000) registry.revoked.delete(revoked);
  if (registry.revoked.has(id) || registry.revoked.has(grant.sessionId)) return AbortSignal.abort();
  let controller=registry.controllers.get(id);
  if (!controller) {controller=new AbortController();registry.controllers.set(id,controller);}
  registry.controllerUsedAt.set(id,now);
  return controller.signal;
}

export async function openGeneration(grant:StreamGrant,locator:CandidateLocator,requestSignal:AbortSignal,
  opener:typeof openProvider=openProvider):Promise<ProviderPlayback> {
  const id=grantKey(grant);
  const generationSignal=streamSignal(grant);
  if (generationSignal.aborted || requestSignal.aborted) throw new Error('Stream generation ended');
  let state=registry.playbacks.get(id);
  if (state && JSON.stringify(state.locator)!==JSON.stringify(locator)) throw new Error('Stream candidate changed');
  if (state?.playback) return state.playback;
  if (!state) {state={locator,waiters:0};registry.playbacks.set(id,state);}
  if (!state.opening) {
    const owned=state;
    owned.openingController=new AbortController();
    const signal=AbortSignal.any([generationSignal,owned.openingController.signal]);
    owned.opening=Promise.resolve().then(()=>opener(locator,signal)).then(playback=>{
      if (signal.aborted || registry.playbacks.get(id)!==owned) {playback.close();throw new Error('Stream generation ended');}
      owned.playback=playback;
      owned.opening=undefined;
      return playback;
    }).catch(error=>{
      if (registry.playbacks.get(id)===owned) registry.playbacks.delete(id);
      owned.opening=undefined;
      throw error;
    });
  }
  if (!state.opening) throw new Error('Provider opening ended');
  state.waiters++;
  const owned=state;
  const opening=state.opening;
  let onAbort:()=>void=()=>{};
  const cancelled=new Promise<never>((_resolve,reject)=>{
    onAbort=()=>reject(new Error('Stream request ended'));
    requestSignal.addEventListener('abort',onAbort,{once:true});
  });
  try {return await Promise.race([opening,cancelled]);}
  finally {
    requestSignal.removeEventListener('abort',onAbort);
    owned.waiters--;
    if (owned.waiters===0 && owned.opening && registry.playbacks.get(id)===owned) {
      registry.playbacks.delete(id);
      owned.openingController?.abort();
    }
  }
}

export function touchStreamSession(sessionId:string,generation:number,now=Date.now()):void {
  const id=`${sessionId}:${generation}`;
  if (registry.controllers.has(id)) registry.controllerUsedAt.set(id,now);
}
export function revokeGeneration(sessionId:string,keepGeneration:number):void {
  for (const id of registry.controllers.keys()) if (id.startsWith(`${sessionId}:`) && id!==`${sessionId}:${keepGeneration}`)
    revokeStreamGeneration(sessionId,Number(id.slice(sessionId.length+1)));
  for (const resource of registry.byToken.values()) if (resource.sessionId===sessionId && resource.generation!==keepGeneration)
    revokeStreamGeneration(sessionId,resource.generation);
}
export function revokeStreamGeneration(sessionId:string,generation:number):void {
  const id=`${sessionId}:${generation}`;
  registry.controllers.get(id)?.abort();
  registry.controllers.delete(id);
  registry.controllerUsedAt.delete(id);
  registry.revoked.set(id,Date.now());
  closePlayback(id);
  for (const [token,resource] of registry.byToken) if (resource.sessionId===sessionId && resource.generation===generation) remove(token,resource);
}
export function revokeSession(sessionId:string):void {
  registry.revoked.set(sessionId,Date.now());
  for (const id of registry.controllers.keys()) if (id.startsWith(`${sessionId}:`)) {
    registry.controllers.get(id)?.abort();
    registry.controllers.delete(id);
    registry.controllerUsedAt.delete(id);
    closePlayback(id);
  }
  for (const [token,resource] of registry.byToken) if (resource.sessionId===sessionId) remove(token,resource);
}
export function resourceCount():number {return registry.byToken.size;}
export function expireIdleStreams(now=Date.now()):void {
  for (const [id,usedAt] of registry.controllerUsedAt) if (now-usedAt>SESSION_LEASE_MS+30_000) {
    const split=id.lastIndexOf(':');
    revokeStreamGeneration(id.slice(0,split),Number(id.slice(split+1)));
  }
  for (const [token,resource] of registry.byToken) if (now-resource.usedAt>IDLE_MS) remove(token,resource);
  for (const [id,at] of registry.revoked) if (now-at>10*60_000) registry.revoked.delete(id);
}
registry.timer ??=setInterval(()=>expireIdleStreams(),15_000);
registry.timer.unref();
function prune():void {
  expireIdleStreams();
  while (registry.byToken.size>=MAX_RESOURCES) {
    const oldest=[...registry.byToken].reduce((a,b)=>a[1].usedAt<=b[1].usedAt?a:b);
    remove(oldest[0],oldest[1]);
  }
}

export function registerResource(grant:StreamGrant,resource:ProviderResource,identity=resource.identity):string {
  if (streamSignal(grant).aborted) throw new Error('Stream generation ended');
  prune();
  const record={...grant,kind:resource.kind,identity,resource};
  const previous=registry.byResource.get(key(record));
  if (previous) {
    const saved=registry.byToken.get(previous);
    if (saved) {saved.resource=resource;saved.usedAt=Date.now();return previous;}
  }
  const token=randomBytes(24).toString('hex');
  registry.byToken.set(token,{...record,usedAt:Date.now()});
  registry.byResource.set(key(record),token);
  return token;
}
export function registeredResource(token:string):Resource | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const record=registry.byToken.get(token);
  if (!record) return null;
  if (Date.now()-record.usedAt>IDLE_MS) {remove(token,record);return null;}
  record.usedAt=Date.now();
  return record;
}

export function rewritePlaylist(body:string,source:ProviderResource,grant:StreamGrant):string {
  if (!body.startsWith('#EXTM3U')) throw new Error('Invalid HLS playlist');
  let nextIsPlaylist=false;
  let sequence:bigint | undefined;
  let byteRange=false;
  return body.split(/\r?\n/).map(line=>{
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) nextIsPlaylist=true;
      if (line.startsWith('#EXT-X-BYTERANGE:')) byteRange=true;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const value=line.slice(line.indexOf(':')+1).trim();
        if (!/^\d+$/.test(value)) throw new Error('Invalid media sequence');
        sequence=BigInt(value);
      }
      return line.replace(/URI="([^"]+)"/g,(_attribute,value:string)=>{
        const kind:ResourceKind=/^(#EXT-X-MEDIA|#EXT-X-I-FRAME-STREAM-INF|#EXT-X-RENDITION-REPORT)/.test(line)?'playlist':'media';
        const child=source.resolve(value,kind);
        if (!child) throw new Error('Unsupported stream resource');
        return `URI="/api/stream/media/${registerResource(grant,child)}"`;
      });
    }
    if (!line.trim()) return line;
    const kind:ResourceKind=nextIsPlaylist?'playlist':'media';
    nextIsPlaylist=false;
    const child=source.resolve(line.trim(),kind);
    if (!child) throw new Error('Unsupported stream resource');
    const identity=kind==='media' && sequence!==undefined && !byteRange ? JSON.stringify([source.identity,'segment',String(sequence)]) : child.identity;
    if (kind==='media' && sequence!==undefined) sequence++;
    byteRange=false;
    return `/api/stream/media/${registerResource(grant,child,identity)}`;
  }).join('\n');
}
