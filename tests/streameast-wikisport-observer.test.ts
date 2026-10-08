import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { selectedWikisportJwFrame } = require('../desktop/sportsurge-observer.cjs');

const eventUrl = 'https://v2.streameast.ga/cfb/jacksonville-state-gamecocks-vs-kennesaw-state-owls/';
const selectedUrl = `${eventUrl}3`;
const wikiUrl = 'https://wikisport.info/ch/128.php';
const streamUrl = 'https://xstream.st/fslivepro.php?stream=F128';

function selectedFrames() {
  const main: { url: string; framesInSubtree: object[] } = { url: selectedUrl, framesInSubtree: [] };
  const root = { url: wikiUrl, parent: main, isDestroyed: () => false };
  const player = { url: streamUrl, parent: root, isDestroyed: () => false };
  const frames = [root, player];
  main.framesInSubtree = frames;
  const current = { url: selectedUrl, window: { webContents: { mainFrame: main } },
    selection: { kind: 'streameast-server', eventUrl, serverId: '3',
      playerUrl: wikiUrl, playerFrame: root } };
  return { current, frames, main, root, player };
}

test('only the selected Wikisport child JW frame can be activated', () => {
  const { current, frames, player } = selectedFrames();
  assert.equal(selectedWikisportJwFrame(current, frames), player);
  const other = selectedFrames();
  other.current.selection.serverId = '2';
  other.current.url = `${eventUrl}2`;
  other.main.url = other.current.url;
  assert.equal(selectedWikisportJwFrame(other.current, other.frames), other.player);
});

test('unrelated siblings cannot replace the sole exact JW child and duplicate players are rejected', () => {
  const { current, frames, main, root, player } = selectedFrames();
  assert.equal(selectedWikisportJwFrame(current, [...frames, { ...player }]), null);
  assert.equal(selectedWikisportJwFrame(current, [...frames,
    { url: 'https://ads.example/frame', parent: root, isDestroyed: () => false }]), player);
  const sibling = { url: streamUrl, parent: main, isDestroyed: () => false };
  assert.equal(selectedWikisportJwFrame(current, [root, sibling]), null);
  assert.equal(selectedWikisportJwFrame(current, [root,
    { url: streamUrl, parent: { ...root }, isDestroyed: () => false }]), null);
  const disposed = { url: streamUrl, isDestroyed: () => true,
    get parent(): unknown { throw new Error('Frame was disposed'); } };
  assert.equal(selectedWikisportJwFrame(current, [root, disposed]), null);
});

test('the selected JW frame requires the exact game, server, parent, and player route', () => {
  const { current, frames, main } = selectedFrames();
  assert.equal(selectedWikisportJwFrame({ ...current, url: `${eventUrl}2` }, frames), null);
  assert.equal(selectedWikisportJwFrame({ ...current, selection: { ...current.selection, serverId: '2' } }, frames), null);
  assert.equal(selectedWikisportJwFrame({ ...current, selection: { ...current.selection, playerUrl: '' } }, frames), null);
  assert.equal(selectedWikisportJwFrame({ ...current, selection: { ...current.selection, playerFrame: null } }, frames), null);
  assert.equal(selectedWikisportJwFrame({ ...current, window: { webContents: { mainFrame: { ...main, url: `${eventUrl}2` } } } }, frames), null);
  assert.equal(selectedWikisportJwFrame({ ...current, selection: { ...current.selection, playerUrl: 'https://wikisport.info/strm/128.php' } }, frames), null);
  for(const url of [
    'https://xstream.st/fslivepro.php?stream=F128&ad=1',
    'https://xstream.st/fslivepro.php?stream=',
    'https://xstream.st/other.php?stream=F128',
    'http://xstream.st/fslivepro.php?stream=F128',
    'https://xstream.st:8443/fslivepro.php?stream=F128',
  ]) {
    const sample=selectedFrames();
    sample.player.url=url;
    assert.equal(selectedWikisportJwFrame(sample.current,sample.frames),null,url);
  }
});
