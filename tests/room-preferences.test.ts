import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomPreferences } from '../lib/room-preferences.ts';

test('missing, malformed, and non-object preferences are ignored', () => {
  for (const raw of [null, '', '{', 'null', '[]', '[{}]', 'true', '42', '"room"']) {
    assert.equal(parseRoomPreferences(raw), null, String(raw));
  }
});

test('saved games stay unique and selected games respect room capacity', () => {
  const preferences = parseRoomPreferences(JSON.stringify({
    selected: ['1', '1', null, ' 2 ', '', 3, '3', '4', '5'],
    favorites: ['1', '1', '2', false, ' 3 ', '4', '5'],
  }))!;
  assert.deepEqual(preferences.selected, ['1', '2', '3', '4']);
  assert.deepEqual(preferences.favorites, ['1', '2', '3', '4', '5']);
});

test('an explicitly empty saved room remains empty', () => {
  const preferences = parseRoomPreferences('{"selected":[],"favorites":[],"feeds":{}}');
  assert.ok(preferences);
  assert.deepEqual(preferences.selected, []);
  assert.deepEqual(preferences, {
    selected: [], favorites: [], feeds: {}, layout: 'quad', volume: 70, spoilers: false,
  });
});

test('volume is clamped and non-finite or nonnumeric values use a safe default', () => {
  assert.equal(parseRoomPreferences('{"volume":-10}')?.volume, 0);
  assert.equal(parseRoomPreferences('{"volume":150}')?.volume, 100);
  assert.equal(parseRoomPreferences('{"volume":43}')?.volume, 43);
  for (const volume of ['1e309', '-1e309', 'null', '"NaN"', '"70"', '{}']) {
    assert.equal(parseRoomPreferences(`{"volume":${volume}}`)?.volume, 70, volume);
  }
  assert.equal(parseRoomPreferences('{"volume":NaN}'), null);
  assert.equal(parseRoomPreferences('{"volume":Infinity}'), null);
});

test('only supported layouts and actual spoiler booleans are restored', () => {
  for (const layout of ['quad', 'focus', 'duo', 'single']) {
    assert.equal(parseRoomPreferences(JSON.stringify({ layout, spoilers: true }))?.layout, layout);
  }
  const preferences = parseRoomPreferences('{"layout":"wall","spoilers":"true","selected":{},"favorites":false}')!;
  assert.equal(preferences.layout, 'quad');
  assert.equal(preferences.spoilers, false);
  assert.deepEqual(preferences.selected, []);
  assert.deepEqual(preferences.favorites, []);
  assert.equal(parseRoomPreferences('{"spoilers":true}')?.spoilers, true);
});

test('feeds retain normalized safe URLs and labels while invalid entries are discarded', () => {
  const preferences = parseRoomPreferences(JSON.stringify({ feeds: {
    a: { url: ' https://example.com/live.m3u8 ', label: ' Broadcast ' },
    b: { url: 'http://localhost:3001/video.mp4', label: 7 },
    c: { url: 'https://example.com/video.mp4', label: 'x'.repeat(80) },
    d: { url: 'https://example.com/second.mp4', label: '   ' },
    javascript: { url: 'javascript:alert(1)' },
    credentials: { url: 'https://user:password@example.com/live.m3u8' },
    remoteHttp: { url: 'http://example.com/live.m3u8' },
    missing: { label: 'Missing URL' },
    numeric: { url: 9 },
    array: ['https://example.com/live.m3u8'],
    empty: null,
  } }))!;
  assert.deepEqual(Object.keys(preferences.feeds), ['a', 'b', 'c', 'd']);
  assert.deepEqual(preferences.feeds.a, { url: 'https://example.com/live.m3u8', label: 'Broadcast' });
  assert.equal(preferences.feeds.b.label, 'My feed');
  assert.equal(preferences.feeds.c.label.length, 60);
  assert.equal(preferences.feeds.d.label, 'My feed');
  assert.deepEqual(parseRoomPreferences('{"feeds":[]}')?.feeds, {});
});

test('prototype keys cannot become game IDs or saved feed properties', () => {
  assert.equal(parseRoomPreferences('{"__proto__":{"volume":100}}'), null);
  assert.equal(parseRoomPreferences('{"constructor":{"prototype":{}}}'), null);
  const preferences = parseRoomPreferences('{"selected":["__proto__","constructor","toString","1"],"favorites":["prototype","valueOf","1"],"feeds":{"__proto__":{"url":"https://example.com/live.m3u8"}}}')!;
  assert.deepEqual(preferences.selected, ['1']);
  assert.deepEqual(preferences.favorites, ['1']);
  assert.deepEqual(preferences.feeds, {});
  const badFeed = parseRoomPreferences('{"feeds":{"1":{"url":"https://example.com/live.m3u8","__proto__":{"label":"spoofed"}}}}')!;
  assert.deepEqual(badFeed.feeds, {});
});
