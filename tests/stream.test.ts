import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registeredResource, registerResource, resourceCount, revokeGeneration, revokeSession, rewritePlaylist, sourceFromEmbed, streamSignal, validByteRange, validResourceUrl } from '../lib/stream-relay.ts';

const grant = (gameId: string, playerId: string, generation = 0) => ({ sessionId: '11111111-1111-4111-8111-111111111111', candidateId: `gooz-${playerId}`, generation, gameId, playerId });

const root = 'https://chatgpt.hereisman.net/playlist/57069/load-playlist';
const variant = 'https://pl.playlist3.space/playlist/57069/proton1/caxi';
const segment = `https://proton1.2f4049362e3069c1dbb69a47b280e76a.r2.cloudflarestorage.com/scripts/NTcwNjk%3D/segment.txt?X-Amz-Signature=${'a'.repeat(64)}`;

test('player embed source accepts only the same player HLS root', () => {
  assert.equal(sourceFromEmbed(`<script>const source = "${root}";</script>`, '57069'), root);
  assert.equal(sourceFromEmbed(`atobClappr("${Buffer.from(root).toString('base64')}")`, '57069'), root);
  assert.equal(sourceFromEmbed(`<script>const source = "${root}";</script>`, '57068'), null);
});

test('stream resources reject arbitrary hosts, ports, credentials, and other players', () => {
  assert.equal(validResourceUrl(root, '57069', 'playlist'), true);
  assert.equal(validResourceUrl(variant, '57069', 'playlist'), true);
  assert.equal(validResourceUrl('https://pl.playlist5.space/playlist/57083/mountainstormbreeze25/caxi', '57083', 'playlist'), true);
  assert.equal(validResourceUrl('https://pl.playlist5.space/playlist/57083/proton1/caxi', '57083', 'playlist'), true);
  assert.equal(validResourceUrl('https://pl.playlist6.space/playlist/57083/mountainstormbreeze25/caxi', '57083', 'playlist'), true);
  assert.equal(validResourceUrl('https://pl.playlist6.space/playlist/57083/other_backend/caxi', '57083', 'playlist'), false);
  assert.equal(validResourceUrl(segment, '57069', 'media'), true);
  assert.equal(validResourceUrl(`https://mountainstormbreeze25.be7468eda0ec8673601e4234464e169b.r2.cloudflarestorage.com/scripts/NTcwODM%3D/segment.txt?X-Amz-Signature=${'a'.repeat(64)}`,'57083','media'),true);
  for (const bad of [root.replace('https:', 'http:'), root.replace('chatgpt.hereisman.net', 'chatgpt.hereisman.net.attacker.test'), root.replace('https://', 'https://user@'), root.replace('hereisman.net', 'hereisman.net:8443'), `${root}#part`]) assert.equal(validResourceUrl(bad, '57069', 'playlist'), false);
  assert.equal(validResourceUrl(variant, '57068', 'playlist'), false);
  assert.equal(validResourceUrl(segment, '57068', 'media'), false);
  assert.equal(registeredResource('a'.repeat(48)), null);
});

test('HLS master, media, and URI attributes rewrite to registered local resources', () => {
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n# provider note\n${variant}\n`;
  const rewritten = rewritePlaylist(master, root, grant('ncaaf-source-1', '57069'));
  const playlistToken = /\/api\/stream\/media\/([a-f0-9]{48})/.exec(rewritten)?.[1];
  assert.ok(playlistToken);
  assert.deepEqual(registeredResource(playlistToken)?.kind, 'playlist');
  assert.equal(registeredResource(playlistToken)?.playerId, '57069');
  const media = rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${segment}\n#EXT-X-MAP:URI="${segment}"\n`, variant, grant('ncaaf-source-1', '57069'));
  const tokens = [...media.matchAll(/\/api\/stream\/media\/([a-f0-9]{48})/g)].map(match => match[1]);
  assert.equal(tokens.length, 2);
  assert.equal(registeredResource(tokens[0])?.kind, 'media');
  assert.equal(registeredResource(tokens[0])?.url, segment);
  assert.equal(tokens[0], tokens[1]);
  assert.throws(() => rewritePlaylist(`#EXTM3U\nhttps://attacker.test/segment.ts`, variant, grant('ncaaf-source-1', '57069')));
});

test('hiphop6 game playlists relay signed segments only for the listed player and exact hosts', () => {
  const gameId = 'ncaaf-401858461';
  const playerId = '57083';
  const root = 'https://chatgpt.hereisman.net/playlist/57083/load-playlist';
  const variant = 'https://pl.kamfir5.space/playlist/57083/hiphop6/caxi';
  const segment = `https://hiphop6.8d5a997f8030bbd45913e73de2feda23.r2.cloudflarestorage.com/scripts/NTcwODM%3D/p1790380623060659213_1728.txt?X-Amz-Signature=${'a'.repeat(64)}`;
  const master = rewritePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n${variant}\n`, root, grant(gameId, playerId));
  const variantToken = /\/api\/stream\/media\/([a-f0-9]{48})/.exec(master)?.[1];
  assert.ok(variantToken);
  assert.equal(registeredResource(variantToken)?.url, variant);
  assert.equal(registeredResource(variantToken)?.kind, 'playlist');
  const media = rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${segment}\n`, variant, grant(gameId, playerId));
  const segmentToken = /\/api\/stream\/media\/([a-f0-9]{48})/.exec(media)?.[1];
  assert.ok(segmentToken);
  assert.equal(registeredResource(segmentToken)?.url, segment);
  assert.equal(registeredResource(segmentToken)?.kind, 'media');
  assert.throws(() => rewritePlaylist(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n${variant}`, root, grant(gameId, '57084')));
  assert.throws(() => rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${segment}`, variant, grant(gameId, '57084')));
  assert.equal(validResourceUrl(variant.replace('pl.kamfir5.space', 'pl.kamfir5.space.attacker.test'), playerId, 'playlist'), false);
  assert.equal(validResourceUrl(segment.replace('r2.cloudflarestorage.com', 'r2.cloudflarestorage.com.attacker.test'), playerId, 'media'), false);
  assert.equal(validResourceUrl(segment.replace('8d5a997f8030bbd45913e73de2feda23', '8d5a997f8030bbd45913e73de2feda2z'), playerId, 'media'), false);
});

test('byte ranges reject empty and inverted requests', () => {
  for (const good of ['bytes=0-375','bytes=10-','bytes=-500']) assert.equal(validByteRange(good), true);
  for (const bad of ['bytes=-','bytes=10-1','bytes=-0','bytes=0-1,5-6','bytes=abc-def']) assert.equal(validByteRange(bad), false);
});

test('rotating provider buckets stay scoped to signed player media on public R2', () => {
  const playerId = '57083';
  const variant = 'https://pl.playlist3.space/playlist/57083/kirekharrrr/caxi';
  const media = `https://kirekharrrr.a42ea149c7d4000586abe3c1cef97ea1.r2.cloudflarestorage.com/scripts/NTcwODM%3D/p1790380623060659213_1808.txt?X-Amz-Signature=${'f'.repeat(64)}`;
  assert.equal(validResourceUrl(variant, playerId, 'playlist'), true);
  assert.equal(validResourceUrl(media, playerId, 'media'), true);
  assert.equal(validResourceUrl(variant, '57084', 'playlist'), false);
  assert.equal(validResourceUrl(media, '57084', 'media'), false);
  for (const bad of [
    media.replace('r2.cloudflarestorage.com', 'r2.cloudflarestorage.com.attacker.test'),
    media.replace('.r2.cloudflarestorage.com', '.extra.r2.cloudflarestorage.com'),
    media.replace('https://', 'https://user@'),
    media.replace('r2.cloudflarestorage.com', 'r2.cloudflarestorage.com:8443'),
    media.replace('kirekharrrr.a42ea149c7d4000586abe3c1cef97ea1.r2.cloudflarestorage.com', '127.0.0.1'),
    media.replace('NTcwODM%3D', 'NTcwODM%253D'),
    media.replace('p1790380623060659213_1808.txt', 'p1790380623060659213_%2F1808.txt'),
    media.replace('X-Amz-Signature=', 'X-Amz-Signature=oops&X-Amz-Signature='),
    media.replace('f'.repeat(64), 'short'),
  ]) assert.equal(validResourceUrl(bad, playerId, 'media'), false, bad.split('?')[0]);
});

test('regional R2 jurisdictions relay signed media without accepting extra host labels', () => {
  const playerId = '57083';
  const variant = 'https://pl.playlist3.space/playlist/57083/kirekharrrr/caxi';
  const global = `https://goozesag1.8bd5ffaead8467475d12ef2f409e0b16.r2.cloudflarestorage.com/scripts/NTcwODM%3D/p1790380623060659213_1812.txt?X-Amz-Signature=${'a'.repeat(64)}`;
  for (const jurisdiction of ['us', 'eu', 'fedramp']) {
    const media = global.replace('.r2.cloudflarestorage.com', `.${jurisdiction}.r2.cloudflarestorage.com`);
    const rewritten = rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${media}\n`, variant, grant('ncaaf-401858461', playerId));
    const token = /\/api\/stream\/media\/([a-f0-9]{48})/.exec(rewritten)?.[1];
    assert.ok(token);
    assert.equal(registeredResource(token)?.url, media);
    assert.equal(validResourceUrl(media, '57084', 'media'), false);
  }
  for (const label of ['apac', 'us.us', 'us.extra']) {
    const media = global.replace('.r2.cloudflarestorage.com', `.${label}.r2.cloudflarestorage.com`);
    assert.equal(validResourceUrl(media, playerId, 'media'), false);
  }
});

test('rotating signed media URLs keep one HLS segment identity and use the latest signature', () => {
  const first=registerResource(grant('ncaaf-401858468','57069'),segment,'media');
  const renewed=segment.replace('a'.repeat(64),'b'.repeat(64));
  const second=registerResource(grant('ncaaf-401858468','57069'),renewed,'media');
  assert.equal(second,first);
  assert.equal(registeredResource(first)?.url,renewed);
  const semantic=registerResource(grant('ncaaf-401858468','57069'),`${renewed}&part=2`,'media');
  assert.notEqual(semantic,first);
  const nextGeneration=registerResource(grant('ncaaf-401858468','57069',1),renewed,'media');
  assert.notEqual(nextGeneration,first);
  assert.equal(registeredResource(nextGeneration)?.generation,1);
});

test('generation switch and close abort reads and release only that session resources', () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const otherSessionId = '33333333-3333-4333-8333-333333333333';
  const firstGrant = { ...grant('ncaaf-401858468', '57069'), sessionId };
  const nextGrant = { ...firstGrant, generation: 1 };
  const otherGrant = { ...firstGrant, sessionId: otherSessionId };
  const baseline = resourceCount();
  const oldToken = registerResource(firstGrant, segment, 'media');
  const nextToken = registerResource(nextGrant, segment, 'media');
  const otherToken = registerResource(otherGrant, segment, 'media');
  const oldSignal = streamSignal(firstGrant);
  const nextSignal = streamSignal(nextGrant);
  revokeGeneration(sessionId, 1);
  assert.equal(oldSignal.aborted, true);
  assert.equal(registeredResource(oldToken), null);
  assert.equal(registeredResource(nextToken)?.generation, 1);
  assert.equal(registeredResource(otherToken)?.sessionId, otherSessionId);
  assert.throws(() => registerResource(firstGrant, segment, 'media'), /generation ended/);
  assert.throws(() => rewritePlaylist(`#EXTM3U\n#EXTINF:5,\n${segment}\n`, variant, firstGrant), /generation ended/);
  revokeSession(sessionId);
  assert.equal(nextSignal.aborted, true);
  assert.equal(registeredResource(nextToken), null);
  assert.equal(registeredResource(otherToken)?.sessionId, otherSessionId);
  revokeSession(otherSessionId);
  assert.equal(resourceCount(), baseline);
});
