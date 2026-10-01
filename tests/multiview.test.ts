import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToSlots, placeInSlot, reconcileSlots, removeFromSlots, restoreSlots, selectedGames, slotsFromIds, type RoomSlots } from '../lib/multiview.ts';
import { validGameId, type Board } from '../lib/sunday.ts';

const team = { name: 'Team', short: 'Team', abbreviation: 'TM', color: '000000', score: null };
const board = (ids: string[], aliases: Board['aliases'] = {}): Pick<Board, 'games' | 'aliases'> => ({
 games: ids.map(id => ({ id, league: 'nfl', name: id, home: team, away: team, detail: '', redzone: false, status: 'pre', lifecycle: 'scheduled' })),
 aliases,
});

test('adding uses the first vacancy and removal leaves the other squares in place', () => {
 const room = slotsFromIds(['1', '2', '3', '4']);
 assert.deepEqual(removeFromSlots(room, '2'), ['1', null, '3', '4']);
 assert.deepEqual(addToSlots(removeFromSlots(room, '2'), '5'), ['1', '5', '3', '4']);
 assert.equal(addToSlots(room, '5'), room);
});

test('dropping a new game replaces its target and dropping a room game swaps or moves', () => {
 const room = slotsFromIds(['1', '2', '3', '4']);
 assert.deepEqual(placeInSlot(room, '5', 2), ['1', '2', '5', '4']);
 assert.deepEqual(placeInSlot(room, '1', 2), ['3', '2', '1', '4']);
 assert.deepEqual(placeInSlot(removeFromSlots(room, '2'), '1', 1), [null, '1', '3', '4']);
 assert.equal(placeInSlot(room, '3', 2), room);
 assert.deepEqual(selectedGames(placeInSlot(removeFromSlots(room, '2'), '1', 1)), ['1', '3', '4']);
});

test('stored slots retain vacancies, reject malformed data, and restore legacy selections', () => {
 assert.deepEqual(restoreSlots(['1', null, '3', '1'], ['4'], validGameId), ['1', null, '3', null]);
 assert.deepEqual(restoreSlots([null, null, null, null], ['4'], validGameId), [null, null, null, null]);
 assert.deepEqual(restoreSlots(['bad', null, null, null], ['4', '4', '2'], validGameId), ['4', '2', null, null]);
 assert.deepEqual(restoreSlots(undefined, ['1', '2', '1', '3', '4', '5'], validGameId), ['1', '2', '3', '4']);
});

test('stale saved slots clear and a current game takes the first vacancy', () => {
 const cleared = reconcileSlots({ slots: ['1', '2', '3', '4'], board: board(['5']) });
 assert.deepEqual(cleared, [null, null, null, null]);
 assert.deepEqual(addToSlots(cleared, '5'), ['5', null, null, null]);
});

test('reconciliation keeps current games in their original squares', () => {
 assert.deepEqual(reconcileSlots({ slots: ['1', '2', null, '3'], board: board(['1', '3']) }), ['1', null, null, '3']);
});

test('alias migration retains the first present canonical game and clears missing aliases', () => {
 const currentBoard = board(['2', '4'], { '1': '2', '3': '4', '5': '6' });
 assert.deepEqual(reconcileSlots({ slots: ['1', null, '2', '3'], board: currentBoard }), ['2', null, null, '4']);
 assert.deepEqual(reconcileSlots({ slots: ['5', '1', '2', null], board: currentBoard }), [null, '2', null, null]);
});

test('an empty saved room stays empty and an empty board clears obsolete slots', () => {
 assert.deepEqual(reconcileSlots({ slots: [null, null, null, null], board: board(['1']) }), [null, null, null, null]);
 assert.deepEqual(reconcileSlots({ slots: ['1', null, '2', null], board: board([]) }), [null, null, null, null]);
});

test('reconciliation preserves unchanged tuple identity and is idempotent', () => {
 const slots: RoomSlots = ['1', null, '2', null];
 const currentBoard = board(['1', '2']);
 assert.equal(reconcileSlots({ slots, board: currentBoard }), slots);
 const reconciled = reconcileSlots({ slots: ['3', null, '2', null], board: currentBoard });
 assert.deepEqual(reconciled, [null, null, '2', null]);
 assert.equal(reconcileSlots({ slots: reconciled, board: currentBoard }), reconciled);
});
