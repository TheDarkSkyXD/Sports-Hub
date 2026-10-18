import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {PassThrough} from 'node:stream';
import {crc32,gzipSync} from 'node:zlib';
import test from 'node:test';
import sharp from 'sharp';
import {sportsurgeUrl} from '../lib/playback/providers/public-page.ts';

const require=createRequire(import.meta.url),{createObservedMedia}=require('../desktop/observed-media.cjs');
const actual=readFileSync(new URL('./fixtures/wrapped-media/sportsfeed-pixel-fragment.png',import.meta.url));
async function relay(bytes:Buffer,type:string,range?:string){
  class Request extends EventEmitter {
    aborted=false;setHeader(){};abort(){if(!this.aborted){this.aborted=true;this.emit('abort');}}
    end(){setImmediate(()=>{if(this.aborted)return;const incoming=Object.assign(new PassThrough(),{statusCode:range?206:200,headers:{'content-type':type,'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`,'accept-ranges':'bytes'}});this.emit('response',incoming);incoming.end(bytes);});}
  }
  const media=createObservedMedia({pinAddress:async()=>({address:'93.184.216.34',family:4}),validateUrl:sportsurgeUrl,
    network:{request:()=>new Request()},sessions:{fromPartition:()=>({cookies:{async set(){}},setPermissionRequestHandler(){},setPermissionCheckHandler(){},webRequest:{onBeforeRequest(){}},async setProxy(){},async closeAllConnections(){},async clearAuthCache(){},async clearStorageData(){}})}});
  const capability=await media.register({url:'https://media.example/root.m3u8',userAgent:'Fixture'});
  const server=createServer((_request,response)=>media.read(capability,'https://media.example/fragment',range,response));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  try{const response=await fetch(`http://127.0.0.1:${address.port}`);return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};}
  finally{media.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
test('actual SportsFeed pixel fragment becomes MPEG-TS through the shared observed-media relay',async()=>{
  const result=await relay(actual,'image/png');
  assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'video/mp2t');
  assert.equal(result.bytes.length,4_105_920);assert.equal(result.headers.get('content-length'),'4105920');
  assert.equal(result.headers.get('content-range'),null);assert.equal(result.headers.get('accept-ranges'),null);
  for(let offset=0;offset<result.bytes.length;offset+=188)assert.equal(result.bytes[offset],0x47);
});
test('ordinary TS, fMP4 and ranged fragments remain byte-for-byte unchanged',async()=>{
  const ts=Buffer.alloc(188*3);for(let offset=0;offset<ts.length;offset+=188)ts[offset]=0x47;
  const mp4=Buffer.from([0,0,0,16,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x36,0,0,0,0]);
  for(const [bytes,type] of [[ts,'video/mp2t'],[mp4,'video/mp4']] as const){const result=await relay(bytes,type);assert.deepEqual(result.bytes,bytes);assert.equal(result.headers.get('content-type'),type);}
  const ranged=await relay(actual,'image/png','bytes=0-');assert.equal(ranged.status,206);assert.deepEqual(ranged.bytes,actual);
});
test('malformed wrapped pixels fail as invalid media rather than being sent to the decoder',async()=>{
  const result=await relay(Buffer.from([137,80,78,71,13,10,26,10]),'image/png');assert.equal(result.status,422);
});

test('bounded decoder unwraps the actual PNG without changing its recovered TS bytes',async()=>{
  const {decodeWrappedMedia}=require('../desktop/wrapped-media.cjs');
  const ts:Buffer=await decodeWrappedMedia(actual,new AbortController().signal);
  assert.equal(ts.length,4_105_920);assert.equal(createHash('sha256').update(ts).digest('hex'),'d804e7bba7663f50dbe14d3ed50220f2d1538499f5e038d5bdeeb9eaf9c7fb9d');
});
test('bounded decoder recognizes published raw, gzip, PNG-tail and WebP-EXIF wrappers',async()=>{
  const {decodeWrappedMedia}=require('../desktop/wrapped-media.cjs');
  const ts=Buffer.alloc(188*3);for(let offset=0;offset<ts.length;offset+=188)ts[offset]=0x47;
  const png=await sharp({create:{width:1,height:1,channels:3,background:'#000000'}}).png().toBuffer();
  const webp=(payload:Buffer)=>{const riff=Buffer.alloc(20);riff.write('RIFF');riff.writeUInt32LE(12+payload.length+(payload.length&1),4);riff.write('WEBP',8);riff.write('EXIF',12);riff.writeUInt32LE(payload.length,16);return Buffer.concat([riff,payload,Buffer.alloc(payload.length&1)]);};
  for(const wrapped of [Buffer.concat([Buffer.from('TIKTIKRAW'),ts]),Buffer.concat([Buffer.from('TIKTIKTSGZ'),gzipSync(ts)]),Buffer.concat([png,ts]),webp(ts),webp(gzipSync(ts)),webp(Buffer.concat([Buffer.from('TIKTIKRAW'),ts]))])assert.deepEqual(await decodeWrappedMedia(wrapped,new AbortController().signal),ts);
});
test('bounded decoder rejects inflate bombs, malformed pixels and canceled work',async()=>{
  const {decodeWrappedMedia}=require('../desktop/wrapped-media.cjs');
  const bomb=Buffer.concat([Buffer.from('TIKTIKTSGZ'),gzipSync(Buffer.alloc(33*1024*1024))]);
  await assert.rejects(decodeWrappedMedia(bomb,new AbortController().signal));
  await assert.rejects(decodeWrappedMedia(Buffer.from('TIKTIKTSGZbadgzip'),new AbortController().signal));
  await assert.rejects(decodeWrappedMedia(actual,AbortSignal.abort()));
  const controller=new AbortController(),work=decodeWrappedMedia(actual,controller.signal);controller.abort();await assert.rejects(work);
  const oversized=Buffer.from(actual);oversized.writeUInt32BE(0xffff_ffff,16);oversized.writeUInt32BE(crc32(oversized.subarray(12,29)),29);
  await assert.rejects(decodeWrappedMedia(oversized,new AbortController().signal));
  const pixels=Buffer.alloc(12+188*3);pixels.write('TIKTIKPX');pixels.writeUInt32BE(188*3,8);
  const png=await sharp(pixels,{raw:{width:1,height:pixels.length/3,channels:3}}).png().toBuffer();
  await assert.rejects(decodeWrappedMedia(png,new AbortController().signal));
});

test('recognized PNG tails and WebP EXIF payloads support bounded published offsets',async()=>{
  const {decodeWrappedMedia}=require('../desktop/wrapped-media.cjs');
  const ts=Buffer.alloc(188*3);for(let offset=0;offset<ts.length;offset+=188)ts[offset]=0x47;
  const png=await sharp({create:{width:1,height:1,channels:3,background:'#000000'}}).png().toBuffer();
  const prefix=Buffer.from('Exif\0\0metadata');
  for(const inner of [ts,Buffer.concat([Buffer.from('TIKTIKRAW'),ts]),Buffer.concat([Buffer.from('TIKTIKTSGZ'),gzipSync(ts)])]){
    const payload=Buffer.concat([prefix,inner]);
    const riff=Buffer.alloc(20);riff.write('RIFF');riff.writeUInt32LE(12+payload.length+(payload.length&1),4);riff.write('WEBP',8);riff.write('EXIF',12);riff.writeUInt32LE(payload.length,16);
    for(const wrapped of [Buffer.concat([png,payload]),Buffer.concat([riff,payload,Buffer.alloc(payload.length&1)])])assert.deepEqual(await decodeWrappedMedia(wrapped,new AbortController().signal),ts);
  }
  const ordinary=Buffer.concat([prefix,Buffer.from('TIKTIKRAW'),ts]);assert.deepEqual(await decodeWrappedMedia(ordinary,new AbortController().signal),ordinary);
  for(const invalid of [ts.subarray(0,ts.length-1),Buffer.alloc(188*3),Buffer.concat([Buffer.from('TIKTIKTSGZ'),Buffer.from('badgzip')])])await assert.rejects(decodeWrappedMedia(Buffer.concat([png,prefix,invalid]),new AbortController().signal));
  await assert.rejects(decodeWrappedMedia(Buffer.concat([png,prefix,Buffer.from('TIKTIKTSGZ'),gzipSync(Buffer.alloc(33*1024*1024))]),new AbortController().signal));
});
