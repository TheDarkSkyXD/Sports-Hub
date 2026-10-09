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
