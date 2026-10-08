import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

test('desktop output guard survives closed inherited pipes', async () => {
  const child = spawn(process.execPath, ['-e', `
    require('./desktop/closed-stdio.cjs');
    setTimeout(() => {
      for (let index = 0; index < 10; index++) {
        process.stdout.write('closed-output'.repeat(65536));
        process.stderr.write('closed-error'.repeat(65536));
      }
      process.emitWarning('closed diagnostic pipe');
      setTimeout(() => process.exit(0), 250);
    }, 100);
  `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  child.stderr.destroy();
  const [exitCode, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(exitCode, 0);
});

test('desktop output guard does not absorb unrelated stream errors', async () => {
  const child = spawn(process.execPath, ['-e', `
    require('./desktop/closed-stdio.cjs');
    process.stderr.emit('error', new Error('unrelated output failure'));
  `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0);
});
