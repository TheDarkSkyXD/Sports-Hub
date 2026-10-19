import assert from 'node:assert/strict';
import test from 'node:test';
import {dashManifestScope} from '../lib/playback/dash-manifest.ts';

const base='https://media.example/sport/manifests/main.mpd';
test('DASH scopes inherit BaseURL and templates but keep Location relative to the document',()=>{
  const scope=dashManifestScope('<MPD><BaseURL>../tracks/</BaseURL><Location>alternate.mpd</Location><Period><AdaptationSet><SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/segment-$Number%05d$.m4s"/><Representation id="video"><BaseURL>high/</BaseURL></Representation></AdaptationSet></Period></MPD>',base);
  assert.equal(scope.allows('/sport/manifests/alternate.mpd','manifest'),true);
  assert.equal(scope.allows('/sport/tracks/alternate.mpd','manifest'),false);
  assert.equal(scope.allows('/sport/tracks/high/video/init.mp4','segment'),true);
  assert.equal(scope.allows('/sport/tracks/high/video/segment-00001.m4s','segment'),true);
  for(const reference of ['/sport/tracks/high/other/init.mp4','/sport/tracks/high/video/segment-word.m4s',
    '/sport/tracks/high/video/%2e%2e/private','https://other.example/sport/tracks/high/video/init.mp4',
    '/sport/tracks/high/video/init.mp4?extra=1'])assert.equal(scope.allows(reference,'segment'),false,reference);
});
test('DASH scopes include SegmentList, initialization and SegmentBase byte-range files',()=>{
  const scope=dashManifestScope('<MPD><Period><AdaptationSet><Representation id="a"><BaseURL>file.mp4</BaseURL><SegmentBase indexRange="100-200"><Initialization range="0-99"/></SegmentBase></Representation><Representation id="b"><SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="one.m4s" index="one.idx"/><RepresentationIndex sourceURL="index.bin"/></SegmentList></Representation></AdaptationSet></Period></MPD>',base);
  for(const reference of ['file.mp4','init.mp4','one.m4s','one.idx','index.bin'])assert.equal(scope.allows(reference,'segment'),true);
  assert.equal(scope.allows('not-published.m4s','segment'),false);
});
test('DASH scopes reject HTML, entities, unknown templates and unbounded expansion',()=>{
  for(const body of ['<html><body>Not media</body></html>','<!DOCTYPE MPD [<!ENTITY x "value">]><MPD/>',
    '<MPD><Period><AdaptationSet><Representation id="a"><SegmentTemplate media="$Unknown$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    '<MPD><Period><AdaptationSet><Representation id="a"><SegmentTemplate media="$Number$$Time$$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
    '<MPD><Period><AdaptationSet><Representation id="a"><SegmentTemplate media="$Number%099d$.m4s"/></Representation></AdaptationSet></Period></MPD>'])
    assert.throws(()=>dashManifestScope(body,base));
  assert.throws(()=>dashManifestScope('<MPD>'+Array.from({length:10001},()=>'<Period/>').join('')+'</MPD>',base),/Invalid/);
});
