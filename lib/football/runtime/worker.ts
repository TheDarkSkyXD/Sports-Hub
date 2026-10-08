import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { CommandSchema, ReplySchema } from '../shared.ts';
import { createFootballCoordinator } from './composition.ts';

if (!parentPort) throw new Error('Football worker requires a parent port.');
const port = parentPort;
const rootDir = typeof workerData?.rootDir === 'string' ? workerData.rootDir : process.cwd();
const dataDir = typeof workerData?.dataDir === 'string' ? workerData.dataDir : join(rootDir,'.desktop-runtime');
mkdirSync(dataDir,{recursive:true});
const coordinator = createFootballCoordinator(join(dataDir,'football.sqlite'),{
  ownerToken:workerData?.ownerToken,
  reclaimToken:workerData?.reclaimToken,
  browserCollectorsAvailable:workerData?.browserCollectorsAvailable===true,
});
coordinator.start();
let lastCommand = Date.now();
let stopping = false;
const idleTimer = setInterval(() => {
  if (workerData?.desktop || stopping || Date.now()-lastCommand < 5*60000) return;
  stopping = true;
  void coordinator.stop().finally(() => { clearInterval(idleTimer); port.close(); });
},30000);

port.on('message',async (input: unknown) => {
  if (!input || typeof input !== 'object' || !('id' in input) || !('command' in input)) return;
  const envelope = input;
  if (typeof envelope.id !== 'number' || !Number.isSafeInteger(envelope.id)) return;
  lastCommand = Date.now();
  const parsed = CommandSchema.safeParse(envelope.command);
  if (!parsed.success) {
    port.postMessage({id:envelope.id,reply:{kind:'error',status:400,message:'Invalid pipeline command.'}});
    return;
  }
  try {
    const reply = ReplySchema.parse(await coordinator.command(parsed.data));
    port.postMessage({id:envelope.id,reply});
    if (parsed.data.kind === 'stop') { stopping=true; clearInterval(idleTimer); port.close(); }
  } catch {
    port.postMessage({id:envelope.id,reply:{kind:'error',status:503,message:'Football pipeline is unavailable.'}});
  }
});
