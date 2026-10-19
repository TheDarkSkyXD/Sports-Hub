import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';

const hooks=registerHooks({resolve(specifier,context,nextResolve){
  return nextResolve(specifier==='@/lib/stream-server'?new URL('../lib/stream-server.ts',import.meta.url).href:specifier,context);
}});
const {GET}=await import('../app/api/stream/media/[token]/route.ts');
hooks.deregister();
const token='f'.repeat(48);
const read=(query:string)=>GET(new Request(`http://localhost/api/stream/media/${token}${query}`),{params:Promise.resolve({token})});

test('media route preserves low-latency HLS query forwarding to its existing resource lookup',async()=>{
  for(const query of ['', '?_HLS_msn=10&_HLS_part=2','?_HLS_skip=YES','?cache=1&cache=2'])
    assert.equal((await read(query)).status,404,query);
});
test('media route still rejects malformed, duplicate and extra DASH operation fields',async()=>{
  for(const query of ['?reference=child','?kind=segment','?reference=child&kind=license',
    '?reference=child&kind=segment&kind=segment','?reference=child&kind=segment&extra=1',
    '?reference=child&kind=segment&_HLS_msn=10'])assert.equal((await read(query)).status,400,query);
  assert.equal((await read('?reference=child&kind=segment')).status,404);
});
