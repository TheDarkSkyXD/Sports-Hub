import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import * as sunday from '../lib/sunday.ts';

const source = readFileSync(new URL('../app/play/[gameId]/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
type Resolver = (request: Request) => Promise<Response>;

function routeHarness(resolve: Resolver) {
  const exported: { GET?: (request: Request, context: { params: Promise<{ gameId: string }> }) => Promise<Response> } = {};
  runInContext(compiled, createContext({
    exports: exported, Request, Response, URL,
    require: (name: string) => {
      if (name === '@/app/api/playback/route') return { GET: resolve };
      if (name === '@/lib/sunday') return sunday;
      throw new Error(`Unexpected route dependency: ${name}`);
    },
  }), { filename: 'app/play/[gameId]/route.ts' });
  assert.ok(exported.GET);
  return exported.GET;
}

const context = { params: Promise.resolve({ gameId: '12345' }) };
const gameSource = 'https://isportsurge.ws/watch/nfl/away-home/12345';
const player = 'https://gooz.aapmains.net/new-stream-embed/67890';

test('failed browser playback offers a same-game retry and its validated source', async () => {
  const GET = routeHarness(async () => Response.json({ error: 'Unavailable', sourceUrl: gameSource }, { status: 502 }));
  const response = await GET(new Request('http://localhost:3001/play/12345'), context);
  const html = await response.text();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(html, /href="\/play\/12345">Retry this game/);
  assert.ok(html.includes(`href="${gameSource}"`));
  assert.match(html, /Open game source/);
});

test('untrusted source and redirect query parameters cannot influence retry, fallback, or redirect', async () => {
  const seen: string[] = [];
  const GET = routeHarness(async request => {
    seen.push(request.url);
    return Response.json({ sourceUrl: 'https://attacker.example/" onclick="alert(1)' }, { status: 404 });
  });
  const response = await GET(new Request('http://localhost:3001/play/12345?source=https://attacker.example&redirect=https://attacker.example'), context);
  const html = await response.text();
  assert.deepEqual(seen, ['http://localhost:3001/api/playback?game=12345']);
  assert.ok(html.includes(`href="${sunday.SOURCE}"`));
  assert.ok(!html.includes('attacker.example'));
  assert.equal(response.headers.get('Location'), null);
});

test('successful browser playback redirects only to the resolved provider player', async () => {
  const GET = routeHarness(async () => Response.json({ players: [{ url: player }] }));
  const response = await GET(new Request('http://localhost:3001/play/12345?redirect=https://attacker.example'), context);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), player);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('empty, untrusted, and failed resolver responses retain a usable recovery screen', async () => {
  const resolvers: Resolver[] = [
    async () => Response.json({ players: [] }),
    async () => Response.json({ players: [{ url: 'https://attacker.example/video' }] }),
    async () => { throw new Error('Connection failed'); },
  ];
  for (const resolve of resolvers) {
    const response = await routeHarness(resolve)(new Request('http://localhost:3001/play/12345'), context);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('Location'), null);
    assert.match(await response.text(), /Retry this game/);
  }
});
