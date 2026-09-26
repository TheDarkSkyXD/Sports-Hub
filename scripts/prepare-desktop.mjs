import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const standalone = path.resolve('.next/standalone');
const server = path.join(standalone, 'server.js');
const staticFiles = path.resolve('.next/static');

await stat(server);
await stat(staticFiles);
await mkdir(path.join(standalone, '.next'), { recursive: true });
await cp(staticFiles, path.join(standalone, '.next/static'), { recursive: true, force: true });
await cp(path.resolve('public'), path.join(standalone, 'public'), { recursive: true, force: true });
