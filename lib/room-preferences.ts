import { validFeedUrl } from './sunday.ts';
import type { Feed } from './sunday.ts';

export type Layout = 'quad' | 'focus' | 'duo' | 'single';
export type RoomPreferences = {
  selected: string[];
  favorites: string[];
  feeds: Record<string, Feed>;
  layout: Layout;
  volume: number;
  spoilers: boolean;
};

const layouts: readonly Layout[] = ['quad', 'focus', 'duo', 'single'];
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && !Object.keys(value).some(key => unsafeKeys.has(key));
}

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && !unsafeKeys.has(id) && !Object.prototype.hasOwnProperty.call(Object.prototype, id) ? id : null;
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(safeId).filter((id): id is string => id !== null))];
}

/** Restore local preferences without letting corrupt storage break the room. */
export function parseRoomPreferences(raw: string | null): RoomPreferences | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;

  const feeds: Record<string, Feed> = {};
  if (isRecord(value.feeds)) {
    for (const [key, candidate] of Object.entries(value.feeds)) {
      const id = safeId(key);
      if (!id || !isRecord(candidate) || typeof candidate.url !== 'string') continue;
      const url = validFeedUrl(candidate.url);
      if (!url) continue;
      feeds[id] = {
        url,
        label: typeof candidate.label === 'string' && candidate.label.trim()
          ? candidate.label.trim().slice(0, 60)
          : 'My feed',
      };
    }
  }

  return {
    selected: uniqueIds(value.selected).slice(0, 4),
    favorites: uniqueIds(value.favorites),
    feeds,
    layout: layouts.includes(value.layout as Layout) ? value.layout as Layout : 'quad',
    volume: typeof value.volume === 'number' && Number.isFinite(value.volume)
      ? Math.min(100, Math.max(0, value.volume))
      : 70,
    spoilers: value.spoilers === true,
  };
}
