import { useLayoutEffect, type ReactNode } from 'react';
import type { Board, Playback, SourcesSnapshot } from '../lib/football/shared';
import { parseUpdateFeedUrl, type DesktopUpdateBridge, type UpdateStatus } from '../lib/desktop-update';

type MockApiProps = { children: ReactNode } & (
  | { kind: 'playback'; playback: Playback }
  | { kind: 'sources'; snapshot: SourcesSnapshot }
);

export function MockApi({ children, ...mock }: MockApiProps) {
  const kind = mock.kind;
  const playback = mock.kind === 'playback' ? mock.playback : undefined;
  const snapshot = mock.kind === 'sources' ? mock.snapshot : undefined;
  useLayoutEffect(() => {
    const original = window.fetch;
    let current = playback;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (kind === 'playback' && url.startsWith('/api/playback')) {
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') return Promise.resolve(Response.json({}));
        if (method === 'PATCH' && current && typeof init?.body === 'string') {
          const changes: unknown = JSON.parse(init.body);
          if (changes && typeof changes === 'object' && 'candidateId' in changes && typeof changes.candidateId === 'string') {
            current = { ...current, session: { ...current.session, candidateId: changes.candidateId, generation: current.session.generation + 1 } };
          }
        }
        return Promise.resolve(Response.json(current));
      }
      if (kind === 'sources' && url === '/api/sources') {
        return Promise.resolve(Response.json(init?.method === 'POST' ? {} : snapshot));
      }
      if (url.startsWith('/api/stream/')) return Promise.resolve(new Response(null, { status: 404 }));
      return original(input, init);
    };
    return () => { window.fetch = original; };
  }, [kind, playback, snapshot]);
  return children;
}

export function MockDesktop({ children, status }: { children: ReactNode; status: UpdateStatus }) {
  useLayoutEffect(() => {
    const previous = window.sundayDesktop;
    const dismissed = localStorage.getItem('sunday-room:dismissed-update');
    localStorage.removeItem('sunday-room:dismissed-update');
    const listeners = new Set<(next: UpdateStatus) => void>();
    const timers = new Set<number>();
    let current = status;
    const publish = (next: UpdateStatus) => {
      current = next;
      listeners.forEach(listener => listener(next));
      return Promise.resolve(next);
    };
    const bridge: DesktopUpdateBridge = {
      get: async () => current,
      check: () => publish({ ...current, state: { kind: 'current', lastCheckedAt: Date.now() }, commands: ['check'] }),
      download: () => {
        if (current.state.kind !== 'available') return Promise.resolve(current);
        const release = current.state.release;
        const result = publish({ ...current, state: { kind: 'downloading', release, percent: 42 }, commands: [] });
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          void publish({ ...current, state: { kind: 'ready', release, verifiedAt: Date.now() }, commands: ['check', 'install'] });
        }, 800);
        timers.add(timer);
        return result;
      },
      install: () => {
        if (current.state.kind !== 'ready') return Promise.resolve(current);
        const release = current.state.release;
        const result = publish({ ...current, state: { kind: 'installing', release }, commands: [] });
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          void publish({ ...current, currentVersion: release.version, state: { kind: 'current', lastCheckedAt: Date.now() }, commands: ['check'] });
        }, 800);
        timers.add(timer);
        return result;
      },
      setSource: (url) => {
        const parsed = parseUpdateFeedUrl(url);
        return parsed ? publish({ ...current, source: { ...current.source, url: parsed } }) : Promise.resolve(current);
      },
      setPreferences: (value) => publish({ ...current, preferences: { ...current.preferences, ...value } }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    window.sundayDesktop = bridge;
    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      window.sundayDesktop = previous;
      if (dismissed === null) localStorage.removeItem('sunday-room:dismissed-update');
      else localStorage.setItem('sunday-room:dismissed-update', dismissed);
    };
  }, [status]);
  return children;
}

export function MockProduct({ children, board, snapshot, playback }: {
  children: ReactNode; board: Board; snapshot: SourcesSnapshot; playback: Playback;
}) {
  useLayoutEffect(() => {
    const original = window.fetch;
    const savedRoom = localStorage.getItem('sunday-room:v1');
    localStorage.removeItem('sunday-room:v1');
    let current = playback;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/games') return Promise.resolve(Response.json(board));
      if (url === '/api/sources') return Promise.resolve(Response.json(init?.method === 'POST' ? {} : snapshot));
      if (url.startsWith('/api/playback')) {
        if (init?.method === 'DELETE') return Promise.resolve(Response.json({}));
        if (init?.method === 'PATCH' && typeof init.body === 'string') {
          const changes: unknown = JSON.parse(init.body);
          if (changes && typeof changes === 'object' && 'candidateId' in changes && typeof changes.candidateId === 'string') {
            current = { ...current, session: { ...current.session, candidateId: changes.candidateId, generation: current.session.generation + 1 } };
          }
        }
        return Promise.resolve(Response.json(current));
      }
      if (url.startsWith('/api/stream/')) return Promise.resolve(new Response(null, { status: 404 }));
      return original(input, init);
    };
    return () => {
      window.fetch = original;
      if (savedRoom === null) localStorage.removeItem('sunday-room:v1');
      else localStorage.setItem('sunday-room:v1', savedRoom);
    };
  }, [board, snapshot, playback]);
  return children;
}
