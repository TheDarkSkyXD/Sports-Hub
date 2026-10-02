import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(directory, '../../public/favicon.svg'));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(size =>
  sharp(source, { density: 1152 }).resize(size, size).png().toBuffer()
));

const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  header.writeUInt8(size === 256 ? 0 : size, entry);
  header.writeUInt8(size === 256 ? 0 : size, entry + 1);
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
}

const expected = [
  [path.join(directory, 'sunday-room.ico'), Buffer.concat([header, ...images])],
  [path.join(directory, 'sunday-room.png'), images.at(-1)],
];
let stale = false;
for (const [target, bytes] of expected) {
  const current = await readFile(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current?.equals(bytes)) continue;
  if (process.argv.includes('--check')) {
    console.error(`${path.basename(target)} differs from public/favicon.svg`);
    stale = true;
  } else {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes);
      try {
        await rename(temporary, target);
      } catch (error) {
        const installed = await readFile(target).catch(() => null);
        if (!installed?.equals(bytes)) throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
if (stale) process.exitCode = 1;
