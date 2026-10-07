import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(path.resolve('desktop/server-supervisor.cjs'), 'utf8');
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const fastTimeout: typeof setTimeout = (callback, _delay, ...args) => setTimeout(callback, 10, ...args);

class NextFixture extends EventEmitter {
  pid = 830002;
  exitCode: number | null = null;
  directKills = 0;
  kill() {
    this.directKills++;
    this.exitCode = 0;
    this.emit('exit', 0);
    return true;
  }
}

function supervisor(killer: EventEmitter, timers: { setTimeout?: typeof setTimeout } = {}) {
  const next = new NextFixture();
  const exitCodes: number[] = [];
  let treeKillCalls = 0;
  const runtimeProcess = Object.assign(new EventEmitter(), {
    platform: 'win32', connected: true,
    argv: ['node.exe', 'server-supervisor.cjs', 'fixture-next.cjs', 'standalone', '49300'],
    execPath: 'node.exe', env: {}, cwd: () => path.resolve('.'),
    exit(code: number) { exitCodes.push(code); },
  });
  const wrapper = runInNewContext(`(function(require, process) { ${source}\n})`, {
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout,
  });
  wrapper((name: string) => name === 'node:child_process' ? {
    spawn(command: string) {
      if (command !== 'taskkill.exe') return next;
      treeKillCalls++;
      return killer;
    },
  } : require(name), runtimeProcess);
  return { next, exitCodes, treeKillCalls: () => treeKillCalls,
    disconnect: () => runtimeProcess.emit('disconnect') };
}

test('failed supervisor tree kill does not report a clean stop after direct child exit', async () => {
  const killer = new EventEmitter();
  const room = supervisor(killer);
  room.disconnect();
  killer.emit('error', new Error('injected taskkill failure'));
  await settle();
  assert.equal(room.treeKillCalls(), 1);
  assert.equal(room.next.directKills, 0, 'a direct kill cannot prove descendant cleanup');
  assert.equal(room.next.exitCode, null, 'the supervisor keeps the subtree owner alive on failed tree kill');
  assert.deepEqual(room.exitCodes, [], 'a failed tree kill cannot report exit code zero');
});

test('hung supervisor tree killer reaches a bounded failure without a clean stop', async () => {
  const killer = Object.assign(new EventEmitter(), {
    killCalls: 0,
    kill() { this.killCalls++; return true; },
  });
  const room = supervisor(killer, { setTimeout: fastTimeout });
  room.disconnect();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(room.treeKillCalls(), 1);
  assert.equal(killer.killCalls, 1, 'the stalled helper is terminated by its deadline');
  assert.equal(room.next.directKills, 0);
  assert.deepEqual(room.exitCodes, []);
});
