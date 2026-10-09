import { z } from 'zod';
import { createNativeCollector, type NativeCollector } from '../../../native/collector/bridge.cjs';
import { MissingPlayerReasonSchema, ObservationSchema, type MissingPlayerReason, type Observation, type ResolvedPlayer } from '../shared.ts';
import { PartialListingReadError, type ListingResult, type ListingSource } from '../domain/ports.ts';

export { SOURCE_REGISTRY as SOURCES } from '../source-registry.ts';

const ListingResultSchema = z.object({
  observations: z.array(ObservationSchema),
  outcome: z.enum(['parsed', 'empty', 'unsupported', 'parser-changed']),
});
const ReadOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete'), body: z.string() }),
  z.object({ kind: z.literal('partial'), body: z.string(), failure: z.object({ message: z.string(), retryAfterMs: z.number().nullish() }) }),
  z.object({ kind: z.literal('failed'), failure: z.object({ message: z.string(), retryAfterMs: z.number().nullish() }) }),
]);
const PlayerWireSchema = z.object({
  id: z.string(), label: z.string(), locator: z.object({ provider: z.string() }).passthrough(),
}).passthrough();
const ResolveActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read-batch'), requests: z.array(z.object({ url: z.string() })), abortSiblingsOnFailure: z.boolean() }),
  z.object({ type: z.literal('done'), players: z.array(PlayerWireSchema) }),
  z.object({ type: z.literal('failed'), error: z.object({ name: z.string(), message: z.string() }) }),
]);

export class SourceFetchError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
function readFailure(failure: { message: string; retryAfterMs?: number | null }): Error {
  if (failure.message === 'timed out') return new DOMException(failure.message, 'TimeoutError');
  return new SourceFetchError(failure.message, failure.retryAfterMs ?? undefined);
}

type FixtureScript = {
  url: string;
  method?: 'GET' | 'POST';
  requestBody?: string;
  status?: number;
  headers?: { location?: string; 'retry-after'?: string };
  body?: string | null;
  chunks?: { body: string; delayMs?: number }[];
  delayMs?: number;
  pending?: boolean;
  failure?: { message: string; retryAfterMs?: number };
};
type FixtureRequest = { method: string; url: string; body: string | null; accept: string };
type Reader = (url: string, signal: AbortSignal) => Promise<string>;

function decode<T>(value: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(value));
}
function players(value: string): ResolvedPlayer[] {
  // Rust owns the locator variants; this helper also accepts caller-supplied game IDs before domain validation.
  return decode(value, z.array(PlayerWireSchema)) as ResolvedPlayer[];
}

function collectorFacade(native: NativeCollector) {
  async function readHtml(url: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const id = native.beginRequest();
    const abort = () => native.cancelRequest(id);
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const outcome = decode(await native.readHtml(id, url), ReadOutcomeSchema);
      signal.throwIfAborted();
      if (outcome.kind === 'complete') return outcome.body;
      const failure = readFailure(outcome.failure);
      if (outcome.kind === 'partial')
        throw new PartialListingReadError(outcome.body, failure, outcome.failure.retryAfterMs ?? 0);
      throw failure;
    } finally {
      signal.removeEventListener('abort', abort);
      native.cancelRequest(id);
    }
  }

  function parseListings(source: ListingSource, html: string, now: number): ListingResult {
    return decode(native.parseListings(JSON.stringify(source), html, now), ListingResultSchema);
  }
  function enrichObservation(observation: Observation, html: string): Observation {
    return decode(native.enrichObservation(JSON.stringify(observation), html), ObservationSchema);
  }
  function compatiblePlayers(gameId: string, observation: Observation, html: string): ResolvedPlayer[] {
    return players(native.compatiblePlayers(gameId, JSON.stringify(observation), html));
  }
  function missingPlayerReason(observation: Observation, html: string): MissingPlayerReason {
    return decode(native.missingPlayerReason(JSON.stringify(observation), html), MissingPlayerReasonSchema);
  }

  async function resolvePlayers(gameId: string, observation: Observation, html: string, signal: AbortSignal,
    read: Reader = readHtml): Promise<ResolvedPlayer[]> {
    signal.throwIfAborted();
    const begin = z.object({ id: z.number().int(), action: ResolveActionSchema }).parse(
      JSON.parse(native.beginResolve(gameId, JSON.stringify(observation), html)));
    let action: z.infer<typeof ResolveActionSchema> = begin.action;
    try {
      while (action.type === 'read-batch') {
        signal.throwIfAborted();
        const group = new AbortController();
        const abort = () => group.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let responses: ({ kind: 'read-ok'; body: string } | { kind: 'read-failed'; error: { name: string; message: string } })[];
        try {
          responses = await Promise.all(action.requests.map(async request => {
            try { return { kind: 'read-ok' as const, body: await read(request.url, group.signal) }; }
            catch (error) {
              if (action.type === 'read-batch' && action.abortSiblingsOnFailure) group.abort(error);
              const failure = error instanceof Error ? error : new Error('unavailable');
              return { kind: 'read-failed' as const, error: { name: failure.name, message: failure.message } };
            }
          }));
        } finally { signal.removeEventListener('abort', abort); }
        signal.throwIfAborted();
        action = decode(native.advanceResolve(begin.id, JSON.stringify(responses)), ResolveActionSchema);
      }
      if (action.type === 'done') return action.players as ResolvedPlayer[];
      const error = new Error(action.error.message);
      error.name = action.error.name;
      throw error;
    } finally { native.closeResolve(begin.id); }
  }

  async function tvappPlayers(gameId: string, observation: Observation, html: string, signal: AbortSignal,
    read: Reader = readHtml): Promise<ResolvedPlayer[]> {
    if (!['tvapp', 'tvapp-nba', 'tvapp-nhl', 'tvapp-mlb'].includes(observation.sourceId)) return [];
    return resolvePlayers(gameId, observation, html, signal, read);
  }
  return {
    readHtml, parseListings, enrichObservation, compatiblePlayers, missingPlayerReason, resolvePlayers, tvappPlayers,
    allowedDiscoveryUrl: (value: string) => native.allowedDiscoveryUrl(value),
    digest: (value: string) => native.digest(value),
    parseKickoff: (value: string) => native.parseKickoff(value),
    enqueueFixture: (script: FixtureScript) => native.enqueueFixture(JSON.stringify(script)),
    fixtureRequests: (): FixtureRequest[] => z.array(z.object({ method: z.string(), url: z.string(), body: z.string().nullable(), accept: z.string() })).parse(JSON.parse(native.fixtureRequests())),
    fixtureCancels: (): string[] => z.array(z.string()).parse(JSON.parse(native.fixtureCancels())),
  };
}

let production: ReturnType<typeof collectorFacade> | undefined;
function current() { return production ??= collectorFacade(createNativeCollector()); }
export function createFixtureCollector() { return collectorFacade(createNativeCollector(true)); }
export const readHtml = (url: string, signal: AbortSignal) => current().readHtml(url, signal);
export const parseListings = (source: ListingSource, html: string, now: number) => current().parseListings(source, html, now);
export const enrichObservation = (row: Observation, html: string) => current().enrichObservation(row, html);
export const compatiblePlayers = (gameId: string, row: Observation, html: string) => current().compatiblePlayers(gameId, row, html);
export const missingPlayerReason = (row: Observation, html: string) => current().missingPlayerReason(row, html);
export const resolvePlayers = (gameId: string, row: Observation, html: string, signal: AbortSignal, read?: Reader) =>
  current().resolvePlayers(gameId, row, html, signal, read);
export const tvappPlayers = (gameId: string, row: Observation, html: string, signal: AbortSignal, read?: Reader) =>
  current().tvappPlayers(gameId, row, html, signal, read);
export const allowedDiscoveryUrl = (value: string) => current().allowedDiscoveryUrl(value);
export const digest = (value: string) => current().digest(value);
export const parseKickoff = (value: string) => current().parseKickoff(value);
