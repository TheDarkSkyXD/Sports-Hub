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
    ['components/probe.tsx','import "@/lib/football/domain/matching";'],
    ['components/probe.tsx','import "@/lib/football/domain/sportsurge-catalog";'],
    ['components/probe.tsx','import "@/lib/playback/providers/streamcenter-player";'],
    ['lib/football/domain/probe.ts','import "../adapters/store.ts";'],
    ['lib/football/domain/probe.ts','import "../../../desktop/sportsurge-catalog.cjs";'],
  ]) assert.equal((await boundaryMessages(path,source)).length,1,`${path}: ${source}`);
});

test('routes use the client or HTTP facade and the worker uses composition', async () => {
  for (const source of [
    'import "@/lib/football/runtime/coordinator";',
    'import "@/lib/football/runtime/worker";',
    'import "@/lib/football/adapters/store";',
    'import "@/lib/football/domain/sportsurge-catalog";',
  ]) assert.equal((await boundaryMessages('app/api/probe/route.ts',source)).length,1,source);

  for (const [path,source] of [
    ['app/api/probe/route.ts','import "@/lib/football/runtime/client";'],
    ['app/api/probe/route.ts','import "@/lib/playback-server";'],
    ['components/probe.tsx','import "@/lib/football/shared";'],
    ['lib/football/runtime/worker.ts','import "./composition.ts";'],
    ['lib/football/runtime/composition.ts','import "../adapters/store.ts";'],
    ['lib/football/adapters/sources.ts','import "../../playback/providers/streamcenter-player.ts";'],
    ['lib/playback/providers/streamcenter.ts','import "./streamcenter-player.ts";'],
  ]) assert.deepEqual(await boundaryMessages(path,source),[],`${path}: ${source}`);

  assert.equal((await boundaryMessages('lib/football/runtime/coordinator.ts','import "../adapters/store.ts";')).length,1);
  assert.equal((await boundaryMessages('lib/football/runtime/worker.ts','import "./coordinator.ts";')).length,1);
});

test('desktop and diagnostic scripts have explicit import boundaries', async () => {
  for (const [path,source] of [
    ['desktop/probe.cjs','require("../lib/football/runtime/coordinator.ts");'],
    ['desktop/probe.cjs','require("../lib/football/domain/sportsurge-catalog.ts");'],
    ['scripts/probe.mjs','import "../lib/football/runtime/worker.ts";'],
  ]) assert.equal((await boundaryMessages(path,source)).length,1,`${path}: ${source}`);

  for (const [path,source] of [
    ['desktop/probe.cjs','require("./port.cjs");'],
    ['scripts/probe.mjs','import "../lib/football/adapters/sources.ts";'],
    ['scripts/verify-sportsurge-catalog.cjs','require("../desktop/main.cjs");'],
    ['tests/probe.ts','import "../lib/football/runtime/coordinator.ts";'],
  ]) assert.deepEqual(await boundaryMessages(path,source),[],`${path}: ${source}`);
});

test('the update contract is written twice and the boundary is what forces it', async () => {
  // `desktop/update.cjs` holds its own copy of the union because a desktop module may
  // not import `lib/`. `tests/desktop-update.test.ts` is what keeps that copy true.
  assert.equal((await boundaryMessages('desktop/probe.cjs','require("../lib/desktop-update.ts");')).length,1);
  assert.deepEqual(await boundaryMessages('desktop/probe.cjs','require("./update.cjs");'),[]);
  assert.deepEqual(await boundaryMessages('tests/probe.ts','import "../desktop/update.cjs";'),[]);
  assert.deepEqual(await boundaryMessages('components/probe.tsx','import "@/lib/desktop-update";'),[]);
  assert.equal((await boundaryMessages('components/probe.tsx','import "@/lib/football/runtime/client";')).length,1);
});
