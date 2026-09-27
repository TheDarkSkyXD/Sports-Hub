import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { localServerPort } = require('../desktop/port.cjs');

test('desktop server chooses another loopback port when the preferred port is occupied',async () => {
  const occupied = net.createServer();
  await new Promise<void>(resolve => occupied.listen(0,'127.0.0.1',resolve));
  try {
    const address = occupied.address();
    assert.ok(address && typeof address !== 'string');
    const fallback = await localServerPort(address.port);
    assert.notEqual(fallback,address.port);
    const check = net.createServer();
    await new Promise<void>(resolve => check.listen(fallback,'127.0.0.1',resolve));
    await new Promise<void>(resolve => check.close(() => resolve()));
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});
