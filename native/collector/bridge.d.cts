export interface NativeCollector {
  sourceCount(): number;
  beginRequest(): number;
  cancelRequest(id: number): void;
  readHtml(id: number, url: string): Promise<string>;
  enqueueFixture(scriptJson: string): void;
  fixtureRequests(): string;
  fixtureCancels(): string;
  parseListings(sourceJson: string, body: string, now: number): string;
  enrichObservation(rowJson: string, body: string): string;
  compatiblePlayers(gameId: string, rowJson: string, body: string): string;
  missingPlayerReason(rowJson: string, body: string): string;
  allowedDiscoveryUrl(value: string): boolean;
  digest(value: string): string;
  parseKickoff(value: string): number | null;
  beginResolve(gameId: string, rowJson: string, body: string): string;
  validateResolveResponse(id: number, requestIndex: number, body: string): boolean;
  advanceResolve(id: number, responsesJson: string): string;
  closeResolve(id: number): void;
  beginSweep(kind: string, runId: string, now: number): string;
  advanceSweep(id: number, resultJson: string, now: number): string;
  closeSweep(id: number): void;
  browserHelper(kind: string, helper: string, argsJson: string): string;
}

export function createNativeCollector(fixtureMode?: boolean): NativeCollector;

export interface NativeStore {
  call(operation: string, argsJson: string): string;
  close(): void;
  createPipeline(configJson: string): NativePipeline;
}

export interface NativePipeline {
  step(inputJson: string, at?: number): string;
}

export function createNativeStore(databasePath: string, ownerToken?: string, reclaimToken?: string): NativeStore;
export function createNativePipeline(databasePath: string, configJson: string): NativePipeline;
export function pipelineDomain(operation: string, inputJson: string): string;
export function pipelineView(operation: string, inputJson: string): string;
export interface NativeMatcher { call(inputJson: string): string; }
export function createNativeMatcher(kind: 'observation' | 'source' | 'finished', gamesJson: string, mode?: 'current' | 'inventory-live'): NativeMatcher;

export interface NativeSchedule {
  begin(): number;
  read(sourceJson: string, now: number, requestId: number, onProgress: (json: string) => void): Promise<string>;
  membership(season: number, requestId: number): Promise<string>;
  cancel(requestId: number): void;
  close(): void;
  enqueueFixture(scriptJson: string): void;
  fixtureRequests(): string;
  fixtureCancels(): string;
  releaseFixtureGate(gate: string): void;
}
export function createNativeSchedule(fixtureMode?: boolean): NativeSchedule;
