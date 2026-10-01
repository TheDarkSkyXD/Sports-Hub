import type { Board } from './sunday.ts';

export type RoomSlots = [string | null, string | null, string | null, string | null];

export const emptySlots = (): RoomSlots => [null, null, null, null];
export const selectedGames = (slots: RoomSlots): string[] => slots.filter((id): id is string => id !== null);

export function slotsFromIds(ids: string[]): RoomSlots {
 const unique = [...new Set(ids)].slice(0, 4);
 return [unique[0] ?? null, unique[1] ?? null, unique[2] ?? null, unique[3] ?? null];
}

export function restoreSlots(value: unknown, legacy: unknown, validId: (value: unknown) => value is string): RoomSlots {
 if (Array.isArray(value) && value.length === 4 && value.every(id => id === null || validId(id))) {
  const seen = new Set<string>();
  const unique = value.map(id => {
   if (id === null || seen.has(id)) return null;
   seen.add(id);
   return id;
  });
  return [unique[0], unique[1], unique[2], unique[3]];
 }
 return slotsFromIds(Array.isArray(legacy) ? legacy.filter(validId) : []);
}

export function reconcileSlots({ slots, board }: { slots: RoomSlots; board: Pick<Board, 'games' | 'aliases'> }): RoomSlots {
 const available = new Set(board.games.map(game => game.id));
 const seen = new Set<string>();
 const next: RoomSlots = [...slots];
 let changed = false;
 for (let index = 0; index < slots.length; index++) {
  const id = slots[index];
  if (id === null) continue;
  const canonical = board.aliases[id] || id;
  const resolved = available.has(canonical) && !seen.has(canonical) ? canonical : null;
  if (resolved !== null) seen.add(resolved);
  if (resolved !== id) {
   next[index] = resolved;
   changed = true;
  }
 }
 return changed ? next : slots;
}

export function addToSlots(slots: RoomSlots, id: string): RoomSlots {
 if (slots.includes(id)) return slots;
 const vacant = slots.indexOf(null);
 if (vacant < 0) return slots;
 const next: RoomSlots = [...slots];
 next[vacant] = id;
 return next;
}

export function placeInSlot(slots: RoomSlots, id: string, index: number): RoomSlots {
 if (!Number.isInteger(index) || index < 0 || index > 3 || slots[index] === id) return slots;
 const next: RoomSlots = [...slots];
 const previous = slots.indexOf(id);
 if (previous >= 0) next[previous] = slots[index];
 next[index] = id;
 return next;
}

export function removeFromSlots(slots: RoomSlots, id: string): RoomSlots {
 if (!slots.includes(id)) return slots;
 return [slots[0] === id ? null : slots[0], slots[1] === id ? null : slots[1], slots[2] === id ? null : slots[2], slots[3] === id ? null : slots[3]];
}
