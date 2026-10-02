type Listener = (event: string, data: { details: { live: boolean }; fatal: boolean }) => void;

export default class MockHls {
  static Events = { MANIFEST_PARSED: 'manifestParsed', LEVEL_LOADED: 'levelLoaded', LEVEL_UPDATED: 'levelUpdated', ERROR: 'error' };
  static DefaultConfig = { manifestLoadPolicy: { default: {} } };
  static isSupported() { return true; }

  levels = [{ height: 270, bitrate: 140_000 }];
  nextLevel = -1;
  currentLevel = -1;
  liveSyncPosition = undefined;
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener) {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], listener]);
  }

  loadSource() {}

  attachMedia(video: HTMLVideoElement) {
    video.src = '/sample.webm';
    queueMicrotask(() => {
      this.listeners.get(MockHls.Events.MANIFEST_PARSED)?.forEach(listener => listener(MockHls.Events.MANIFEST_PARSED, { details: { live: false }, fatal: false }));
      this.listeners.get(MockHls.Events.LEVEL_LOADED)?.forEach(listener => listener(MockHls.Events.LEVEL_LOADED, { details: { live: false }, fatal: false }));
    });
  }

  destroy() { this.listeners.clear(); }
}
