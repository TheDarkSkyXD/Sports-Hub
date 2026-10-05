import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv} from 'node:crypto';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {probeCandidate} from '../lib/playback/probe.ts';
import {ProviderDeferredError, sanitizedRead, type ProviderResource, type ResourceKind} from '../lib/playback/provider.ts';

const locator = {provider:'gooz' as const,playerId:'123'};
const transportStream = Buffer.alloc(188*4);
for (let offset=0;offset<transportStream.length;offset+=188) transportStream[offset]=0x47;
const playlist = (extra='') => `#EXTM3U\n${extra}#EXTINF:4,\nsegment.ts\n`;
const signal = () => new AbortController().signal;
function fixture(files: Record<string,string|Buffer>) {
  const reads: {uri:string;range?:string}[]=[];
  let closed=0;
  const resource = (uri: string,kind: ResourceKind): ProviderResource => ({
    kind,identity:uri,
    resolve(reference,expected) { return resource(new URL(reference,`https://fixture.example/${uri}`).pathname.slice(1),expected); },
    async read(input) {
      input.signal.throwIfAborted();
      reads.push({uri,range:input.range});
      const value=files[uri];
      if (value===undefined) throw new Error(`Missing ${uri}`);
      let bytes=Buffer.from(value);
      const total=bytes.length;
      const match=input.range && /^bytes=(\d+)-(\d+)$/.exec(input.range);
      if (match) bytes=bytes.subarray(Number(match[1]),Number(match[2])+1);
      return {status:match?206:200,contentType:kind==='playlist'?'application/vnd.apple.mpegurl':'application/octet-stream',
        body:new Response(bytes).body,contentLength:String(bytes.length),
        ...(match?{contentRange:`bytes ${match[1]}-${match[2]}/${total}`}:{})};
    },
  });
  return {reads,closed:()=>closed,open:async()=>({root:resource('index.m3u8','playlist'),close(){closed++;}})};
}

test('probe requires complete media rather than a successful manifest',async()=>{
  const good=fixture({'index.m3u8':playlist(),'segment.ts':transportStream});
  assert.deepEqual(await probeCandidate(locator,signal(),good.open),{kind:'playable',proof:'media'});
  assert.equal(good.closed(),1);
  const bad=fixture({'index.m3u8':playlist(),'segment.ts':'<html>upstream unavailable</html>'});
  assert.deepEqual(await probeCandidate(locator,signal(),bad.open),{kind:'unavailable',reason:'invalid-media'});
  assert.equal(bad.closed(),1);
});

test('probe decrypts AES-128 and rejects valid ciphertext containing non-media',async()=>{
  const key=Buffer.alloc(16,4),iv=Buffer.alloc(16);iv[15]=8;
  const encrypt=(bytes:Buffer)=>{const cipher=createCipheriv('aes-128-cbc',key,iv);return Buffer.concat([cipher.update(bytes),cipher.final()]);};
  const manifest=playlist('#EXT-X-MEDIA-SEQUENCE:8\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n');
  for(const valid of [true,false]) {
    const run=fixture({'index.m3u8':manifest,key,'segment.ts':encrypt(valid?transportStream:Buffer.from('not video'))});
    assert.deepEqual(await probeCandidate(locator,signal(),run.open),valid?{kind:'playable',proof:'media'}:{kind:'unavailable',reason:'invalid-media'});
  }
});

test('probe rejects an AES segment with a missing final block',async()=>{
  const key=Buffer.alloc(16,4),iv=Buffer.alloc(16);iv[15]=8;
  const cipher=createCipheriv('aes-128-cbc',key,iv);
  const encrypted=Buffer.concat([cipher.update(transportStream),cipher.final()]);
  const run=fixture({'index.m3u8':playlist('#EXT-X-MEDIA-SEQUENCE:8\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n'),
    key,'segment.ts':encrypted.subarray(0,-16)});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'unavailable',reason:'invalid-media'});
});

test('probe rejects a truncated segment even when its opening signature is valid',async()=>{
  const run=fixture({'index.m3u8':playlist(),'segment.ts':transportStream});
  const open=async()=>{
    const playback=await run.open();
    const resource=(item:ProviderResource):ProviderResource=>({
      ...item,
      resolve(reference,kind){const resolved=item.resolve(reference,kind);return resolved?resource(resolved):null;},
      async read(input){
        const result=await item.read(input);
        return item.identity==='segment.ts'
          ? {...result,body:new Response(transportStream.subarray(0,188*3)).body,contentLength:String(transportStream.length)}
          : result;
      },
    });
    return {...playback,root:resource(playback.root)};
  };
  assert.deepEqual(await probeCandidate(locator,signal(),open),{kind:'unavailable',reason:'invalid-media'});
});

test('probe applies the key state at the chosen segment and METHOD=NONE clears encryption',async()=>{
  const run=fixture({'index.m3u8':'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="old-key"\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\nsegment.ts\n','segment.ts':transportStream});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'playable',proof:'media'});
  assert.equal(run.reads.some(read=>read.uri==='old-key'),false);
});

test('probe resolves ranges after gaps and reads the required initialization map',async()=>{
  const map=Buffer.alloc(16);map.writeUInt32BE(16);map.write('ftyp',4);
  const run=fixture({'index.m3u8':`#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="16@0"\n#EXT-X-GAP\n#EXT-X-BYTERANGE:${transportStream.length}@0\n#EXTINF:4,\nall.ts\n#EXT-X-BYTERANGE:${transportStream.length}\n#EXTINF:4,\nall.ts\n`,
    'init.mp4':map,'all.ts':Buffer.concat([transportStream,transportStream])});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'playable',proof:'media'});
  assert.deepEqual(run.reads.slice(1),[{uri:'init.mp4',range:'bytes=0-15'},{uri:'all.ts',range:`bytes=${transportStream.length}-${transportStream.length*2-1}`}]);
});

test('probe chooses video rather than an audio-only low variant and checks alternate audio',async()=>{
  const run=fixture({'index.m3u8':'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English, main",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="mp4a.40.2"\naudio-only.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500,CODECS="avc1.42e01e,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio"\nvideo.m3u8\n',
    'video.m3u8':playlist(),'segment.ts':transportStream,'audio.m3u8':'#EXTM3U\n#EXTINF:4,\naudio.aac\n','audio.aac':Buffer.from([0xff,0xf1,0x50,0x80,0,0,0])});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'playable',proof:'media'});
  assert.deepEqual(run.reads.map(read=>read.uri),['index.m3u8','video.m3u8','segment.ts','audio.m3u8','audio.aac']);
});

test('probe verifies the smallest video rendition without waiting for a slow larger rendition',async()=>{
  const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1.42e01e",RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.42e01e",RESOLUTION=1920x1080\nhigh.m3u8\n';
  const run=fixture({'index.m3u8':master,'low.m3u8':'#EXTM3U\n#EXTINF:4,\nlow.ts\n','low.ts':transportStream,
    'high.m3u8':'#EXTM3U\n#EXTINF:4,\nhigh.ts\n','high.ts':transportStream});
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),500);
  try {
    const open=async()=>{
      const playback=await run.open();
      const root=playback.root;
      const resource=(item:ProviderResource):ProviderResource=>({
        ...item,
        resolve(reference,kind){const resolved=item.resolve(reference,kind);return resolved?resource(resolved):null;},
        async read(input){
          if(item.identity==='high.ts') await new Promise<never>((_,reject)=>{
            input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});
          });
          return item.read(input);
        },
      });
      return {...playback,root:resource(root)};
    };
    assert.deepEqual(await probeCandidate(locator,controller.signal,open),{kind:'playable',proof:'media'});
    assert.deepEqual(run.reads.map(read=>read.uri),['index.m3u8','low.m3u8','low.ts']);
  } finally {clearTimeout(timeout);}
});

test('probe falls back to a larger video rendition when the smallest has invalid media',async()=>{
  const run=fixture({'index.m3u8':'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200,CODECS="avc1.42e01e",RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.42e01e",RESOLUTION=1920x1080\nhigh.m3u8\n',
    'low.m3u8':'#EXTM3U\n#EXTINF:4,\nlow.ts\n','low.ts':'<html>broken</html>',
    'high.m3u8':'#EXTM3U\n#EXTINF:4,\nhigh.ts\n','high.ts':transportStream});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'playable',proof:'media'});
  assert.deepEqual(run.reads.map(read=>read.uri),['index.m3u8','low.m3u8','low.ts','high.m3u8','high.ts']);
});

test('probe retries a shared video playlist when the next variant has working audio',async()=>{
  const run=fixture({'index.m3u8':'#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="broken",NAME="Broken",DEFAULT=YES,URI="broken.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="working",NAME="Working",DEFAULT=YES,URI="working.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=640x360,AUDIO="broken"\nvideo.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500,RESOLUTION=640x360,AUDIO="working"\nvideo.m3u8\n',
    'video.m3u8':'#EXTM3U\n#EXTINF:4,\nvideo.ts\n','video.ts':transportStream,
    'broken.m3u8':'#EXTM3U\n#EXTINF:4,\nbroken.aac\n','broken.aac':'<html>broken</html>',
    'working.m3u8':'#EXTM3U\n#EXTINF:4,\nworking.aac\n','working.aac':Buffer.from([0xff,0xf1,0x50,0x80,0,0,0])});
  assert.deepEqual(await probeCandidate(locator,signal(),run.open),{kind:'playable',proof:'media'});
  assert.deepEqual(run.reads.map(read=>read.uri),['index.m3u8','video.m3u8','video.ts','broken.m3u8','broken.aac',
    'video.m3u8','video.ts','working.m3u8','working.aac']);
});

test('probe rejects cycles and unsupported encryption',async()=>{
  for(const manifest of ['#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex.m3u8\n',playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n')]) {
    const run=fixture({'index.m3u8':manifest});
    const result=await probeCandidate(locator,signal(),run.open);
    assert.equal(result.kind,'unavailable');
    assert.equal(run.closed(),1);
  }
});

test('observer saturation and cancellation defer a probe without condemning the source',async()=>{
  assert.deepEqual(await probeCandidate(locator,signal(),async()=>{throw new ProviderDeferredError(2000);}),{kind:'deferred',retryAfterMs:2000});
  const controller=new AbortController();controller.abort();
  const run=fixture({'index.m3u8':playlist()});
  assert.deepEqual(await probeCandidate(locator,controller.signal,run.open),{kind:'deferred',retryAfterMs:2000});
  assert.equal(run.closed(),1);
});

test('fetch-based resources normalize compressed lengths before validating decoded media',async()=>{
  const server=createServer((request,response)=>{
    const data=request.url==='/index.m3u8'?playlist():transportStream;
    const compressed=gzipSync(data);
    response.writeHead(200,{'content-encoding':'gzip','content-length':compressed.length});
    response.end(compressed);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();assert.ok(address && typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    const resource=(uri:string,kind:ResourceKind):ProviderResource=>({kind,identity:uri,
      resolve(reference,expected){return resource(new URL(reference,uri).href,expected);},
      async read({signal}){return sanitizedRead(await fetch(uri,{signal}));},
    });
    assert.deepEqual(await probeCandidate(locator,signal(),async()=>({root:resource(`${origin}/index.m3u8`,'playlist'),close(){}})),
      {kind:'playable',proof:'media'});
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
