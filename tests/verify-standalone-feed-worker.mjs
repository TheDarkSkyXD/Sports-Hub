import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const directory=mkdtempSync(join(tmpdir(),'sunday-standalone-feed-'));
const worker=new Worker(resolve('.next/standalone/lib/football/runtime/worker.ts'),{
  workerData:{dataDir:directory,browserCollectorsAvailable:false},execArgv:['--experimental-strip-types'],
});
let timer;
try {
  await new Promise((done,fail)=>{
    timer=setTimeout(()=>fail(new Error('Standalone feed worker timed out')),15000);
    worker.once('error',fail);
    worker.on('message',message=>{
      try {
        if(message.id===1){
          assert.equal(message.reply.kind,'sources');
          assert.equal(message.reply.snapshot.sources.length,42);
          assert.equal(message.reply.snapshot.scheduleScopes.length,14);
          worker.postMessage({id:2,command:{kind:'stop'}});
        }
        if(message.id===2){assert.equal(message.reply.kind,'ok');done();}
      }catch(error){fail(error);}
    });
    worker.postMessage({id:1,command:{kind:'sources'}});
  });
  console.log('Standalone feed worker loaded 42 sources and 14 league scopes, then stopped.');
}finally{
  clearTimeout(timer);
  await worker.terminate();
  assert.equal(dirname(directory),resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('sunday-standalone-feed-'));
  rmSync(directory,{recursive:true,force:true});
}
