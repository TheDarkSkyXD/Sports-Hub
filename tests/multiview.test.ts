import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToSlots, placeInSlot, remapSlots, removeFromSlots, restoreSlots, selectedGames, slotsFromIds } from '../lib/multiview.ts';
import { validGameId } from '../lib/sunday.ts';

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

test('alias migration preserves positions and removes canonical duplicates', () => {
 assert.deepEqual(remapSlots(['1', null, '2', '3'], { '1': '2', '3': '4' }), ['2', null, null, '4']);
 assert.deepEqual(selectedGames(remapSlots(['1', null, '2', '3'], { '1': '2', '3': '4' })), ['2', '4']);
});
