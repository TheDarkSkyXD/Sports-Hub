import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint();

async function boundaryMessages(filePath: string, source: string): Promise<string[]> {
  const [result] = await eslint.lintText(source,{filePath});
  return result.messages.filter(message => message.ruleId === 'boundaries/dependencies').map(message => message.message);
}

test('browser and domain imports stay outside the football worker and adapters', async () => {
  for (const [path,source] of [
    ['components/probe.tsx','import "@/lib/football/runtime/client";'],
    ['app/page.tsx','import "@/lib/football/adapters/sources";'],
    ['components/probe.tsx','import "@/lib/playback-server";'],
    ['lib/football/domain/probe.ts','import "../adapters/store.ts";'],
  ]) assert.equal((await boundaryMessages(path,source)).length,1,`${path}: ${source}`);
});

test('routes use the client or HTTP facade and only the worker owns the coordinator', async () => {
  for (const source of [
    'import "@/lib/football/runtime/coordinator";',
    'import "@/lib/football/runtime/worker";',
    'import "@/lib/football/adapters/store";',
  ]) assert.equal((await boundaryMessages('app/api/probe/route.ts',source)).length,1,source);

  for (const [path,source] of [
    ['app/api/probe/route.ts','import "@/lib/football/runtime/client";'],
    ['app/api/probe/route.ts','import "@/lib/playback-server";'],
    ['components/probe.tsx','import "@/lib/football/shared";'],
    ['lib/football/runtime/worker.ts','import "./coordinator.ts";'],
    ['lib/football/runtime/coordinator.ts','import "../adapters/store.ts";'],
  ]) assert.deepEqual(await boundaryMessages(path,source),[],`${path}: ${source}`);
});
