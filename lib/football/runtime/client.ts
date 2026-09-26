import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandSchema, ReplySchema } from '../shared.ts';
import type { Command, Reply } from '../shared.ts';

type Pending = {resolve:(reply:Reply)=>void;timer:ReturnType<typeof setTimeout>};
class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number,Pending>();
  private nextId = 1;
  private closed = false;
  private readonly ownerToken = randomUUID();
  constructor(reclaimToken?: string) {
    this.worker = new Worker(join(process.cwd(),'lib','football','runtime','worker.ts'),{
      execArgv:['--experimental-strip-types'],
      workerData:{dataDir:process.env.SUNDAY_ROOM_DATA_DIR,desktop:process.env.SUNDAY_ROOM_DESKTOP==='1',ownerToken:this.ownerToken,reclaimToken},
    });
    this.worker.on('message',(input:unknown) => {
      if (!input || typeof input !== 'object' || !('id' in input) || !('reply' in input) || typeof input.id !== 'number') return;
      const pending = this.pending.get(input.id);
      if (!pending) return;
      this.pending.delete(input.id);
      clearTimeout(pending.timer);
      const parsed = ReplySchema.safeParse(input.reply);
      pending.resolve(parsed.success ? parsed.data : {kind:'error',status:503,message:'Pipeline returned an invalid response.'});
    });
    this.worker.on('error',() => this.failPending());
    this.worker.on('exit',() => {
      this.failPending();
      if (globalThis.footballWorkerClient===this) {
        globalThis.footballWorkerClient=undefined;
        globalThis.footballReclaimToken=this.ownerToken;
      }
    });
  }
  private failPending(): void {
    if (this.closed) return;
    this.closed=true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({kind:'error',status:503,message:'Football pipeline stopped.'});
    }
    this.pending.clear();
  }
  command(input: Command): Promise<Reply> {
    const parsed = CommandSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({kind:'error',status:400,message:'Invalid pipeline command.'});
    if (this.closed) return Promise.resolve({kind:'error',status:503,message:'Football pipeline stopped.'});
    if (this.pending.size>=64) return Promise.resolve({kind:'error',status:429,message:'Pipeline is busy.'});
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({kind:'error',status:504,message:'Pipeline timed out.'});
      },45000);
      this.pending.set(id,{resolve,timer});
      this.worker.postMessage({id,command:parsed.data});
    });
  }
}

declare global {
  var footballWorkerClient: WorkerClient | undefined;
  var footballReclaimToken: string | undefined;
  var footballDesktopWatchdog: ReturnType<typeof setInterval> | undefined;
}

export function command(input: Command): Promise<Reply> {
  if (process.env.SUNDAY_ROOM_DESKTOP==='1' && !globalThis.footballDesktopWatchdog) {
    const parentPid=Number(process.env.SUNDAY_ROOM_DESKTOP_PARENT_PID);
    if (Number.isSafeInteger(parentPid) && parentPid>0 && parentPid!==process.pid) {
      globalThis.footballDesktopWatchdog=setInterval(() => {
        try { process.kill(parentPid,0); }
        catch { process.exit(0); }
      },5000);
      globalThis.footballDesktopWatchdog.unref();
    }
  }
  if (!globalThis.footballWorkerClient) {
    try { globalThis.footballWorkerClient = new WorkerClient(globalThis.footballReclaimToken); globalThis.footballReclaimToken=undefined; }
    catch { return Promise.resolve({kind:'error',status:503,message:'Football pipeline could not start.'}); }
  }
  return globalThis.footballWorkerClient.command(input);
}
