import { crc32, gunzipSync } from 'node:zlib';
import sharp from 'sharp';
import type { ProviderReadResult, ProviderResource } from '../provider.ts';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PIXEL_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = 8192;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PIXEL_MARKER = Buffer.from('TIKTIKPX');

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Invalid Dlive pixel media');
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let afterIdat = false;
  let ended = false;
  for (let count = 0; count < MAX_CHUNKS && offset + 12 <= bytes.length; count++) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error('Invalid Dlive PNG chunk');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const check = crc32(bytes.subarray(offset + 4, dataStart + length));
    if (check !== bytes.readUInt32BE(dataStart + length)) throw new Error('Invalid Dlive PNG checksum');
    if (count === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('Invalid Dlive PNG header');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      if (!width || !height || width > 16384 || height > 16384 || width * height * 3 > MAX_PIXEL_BYTES ||
        bytes[dataStart + 8] !== 8 || bytes[dataStart + 9] !== 2 ||
        bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] !== 0)
        throw new Error('Unsupported Dlive PNG pixels');
    } else if (type === 'IHDR') throw new Error('Duplicate Dlive PNG header');
    if (type === 'IDAT') {
      if (afterIdat) throw new Error('Disordered Dlive PNG data');
      sawIdat = true;
    } else if (sawIdat) afterIdat = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || offset + 12 !== bytes.length) throw new Error('Invalid Dlive PNG end');
      ended = true;
      break;
    }
    if (type !== 'IHDR' && type !== 'IDAT' && type !== 'IEND' && /^[A-Z]/.test(type))
      throw new Error('Unsupported Dlive PNG chunk');
    offset += 12 + length;
  }
  if (!ended) throw new Error('Unfinished Dlive PNG');
  return { width, height };
}

async function completeBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      received += item.value.byteLength;
      if (received > MAX_BYTES) throw new Error('Dlive pixel media is too large');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks, received);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function decodePixelTs(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
  const { width, height } = pngDimensions(bytes);
  signal.throwIfAborted();
  const { data, info } = await sharp(bytes, { failOn: 'warning', limitInputPixels: Math.floor(MAX_PIXEL_BYTES / 3) })
    .raw().toBuffer({ resolveWithObject: true });
  signal.throwIfAborted();
  if (info.width !== width || info.height !== height || info.channels !== 3 ||
    data.length !== width * height * 3 || data.length < 12 || !data.subarray(0, 8).equals(PIXEL_MARKER))
    throw new Error('Invalid Dlive pixel marker');
  const gzipLength = data.readUInt32BE(8);
  if (gzipLength < 2 || gzipLength > MAX_BYTES || gzipLength > data.length - 12 ||
    data[12] !== 0x1f || data[13] !== 0x8b) throw new Error('Invalid Dlive pixel payload');
  const ts = gunzipSync(data.subarray(12, 12 + gzipLength), { maxOutputLength: MAX_BYTES });
  signal.throwIfAborted();
  if (ts.length < 3 * 188 || ts.length % 188 !== 0) throw new Error('Invalid Dlive MPEG-TS length');
  for (let offset = 0; offset < ts.length; offset += 188) {
    if (ts[offset] !== 0x47) throw new Error('Invalid Dlive MPEG-TS sync');
  }
  return ts;
}

export function wrapDlivePixelResource(root: ProviderResource): ProviderResource {
  function wrap(resource: ProviderResource): ProviderResource {
    return {
      kind: resource.kind,
      identity: resource.identity,
      async read(input): Promise<ProviderReadResult> {
        if (resource.kind !== 'media') return resource.read(input);
        input.signal.throwIfAborted();
        if (input.range) return { status: 416, body: null, contentType: 'video/mp2t' };
        const result = await resource.read(input);
        if (input.signal.aborted) {
          await result.body?.cancel().catch(() => {});
          input.signal.throwIfAborted();
        }
        if (!/^image\/png(?:\s*;|$)/i.test(result.contentType)) return result;
        if (result.status !== 200) {
          await result.body?.cancel().catch(() => {});
          throw new Error('Unsupported Dlive pixel media response');
        }
        if (!result.body) throw new Error('Dlive pixel media has no body');
        const declaredLength = Number(result.contentLength);
        if (result.contentLength && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_BYTES)) {
          await result.body.cancel().catch(() => {});
          throw new Error('Dlive pixel media is too large');
        }
        const bytes = await completeBody(result.body, input.signal);
        const ts = await decodePixelTs(bytes, input.signal);
        input.signal.throwIfAborted();
        return { status: 200, contentType: 'video/mp2t', contentLength: String(ts.length),
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(ts); controller.close(); } }) };
      },
      resolve(reference, expected) {
        const child = resource.resolve(reference, expected);
        return child ? wrap(child) : null;
      },
    };
  }
  return wrap(root);
}
