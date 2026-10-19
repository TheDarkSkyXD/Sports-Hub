import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(import.meta.url);
const {observedMediaKind}=require('../desktop/sportsurge-observer.cjs');

test('observer recognizes DASH and compatible native container MIME types without classifying HTML',()=>{
  for(const [url,type,kind] of [
    ['https://media.example/manifest','application/dash+xml','dash'],
    ['https://media.example/main.mpd?token=owned','application/octet-stream','dash'],
    ['https://media.example/main.m3u8','application/vnd.apple.mpegurl','hls'],
    ['https://media.example/video','application/mp4','progressive'],
    ['https://media.example/video','video/x-m4v','progressive'],
    ['https://media.example/video','video/webm; codecs="vp9"','progressive'],
    ['https://media.example/video.mp4?token=owned','application/octet-stream','progressive'],
    ['https://media.example/video.webm','','progressive'],
    ['https://media.example/video.mp4','text/html',null],
    ['https://media.example/main.mpd','application/xhtml+xml',null],
    ['https://media.example/unrelated','application/json',null],
  ])assert.equal(observedMediaKind(url,type),kind,`${url} ${type}`);
});

test('observer distinguishes HTTP FLV and standalone MPEG-TS from progressive containers',()=>{
  for(const [url,type,kind] of [
    ['https://media.example/live','video/x-flv','flv'],['https://media.example/live.flv','application/octet-stream','flv'],
    ['https://media.example/live','video/mp2t','mpegts'],['https://media.example/live.ts','application/octet-stream','mpegts'],
    ['https://media.example/live.flv','text/html',null],['https://media.example/live.ts','application/json',null],
  ])assert.equal(observedMediaKind(url,type),kind);
});
