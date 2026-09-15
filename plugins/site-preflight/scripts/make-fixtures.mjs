#!/usr/bin/env node
// The two fixture images are generated rather than committed. One is a
// 1200x630 social preview; the other has to weigh more than the 300 KB image
// threshold to fail the check it exists to fail, and a third of a megabyte of
// incompressible noise does not belong in a git history.
//
// Both land in each fixture's `out/` directory, which the repository already
// ignores. The test suite calls this before serving a fixture; run it by hand
// before checking a fixture yourself. Output is deterministic: the noise comes
// from a seeded generator, so a rerun produces the same bytes.

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Minimal 8-bit truecolour PNG. `pixel(x, y)` returns [r, g, b].
export function encodePng(width, height, pixel) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[rowStart + 1 + x * 3] = r;
      raw[rowStart + 2 + x * 3] = g;
      raw[rowStart + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic noise, so the generated file is the same on every machine.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function makeFixtures(fixturesDir) {
  const written = [];

  // A social preview that clears 1200x630: two flat bands, so it compresses to
  // a couple of kilobytes and its IHDR still reports the real size.
  const ogPath = path.join(fixturesDir, 'pass-site', 'out', 'og.png');
  await mkdir(path.dirname(ogPath), { recursive: true });
  const og = encodePng(1200, 630, (x, y) => (y < 420 ? [244, 236, 224] : [61, 42, 31]));
  await writeFile(ogPath, og);
  written.push({ file: ogPath, bytes: og.length, note: '1200x630, the social-preview minimum' });

  // An image heavy enough to fail the 300 KB threshold. Noise does not deflate,
  // so the file lands a little above its raw size.
  const heroPath = path.join(fixturesDir, 'broken-site', 'out', 'hero.png');
  await mkdir(path.dirname(heroPath), { recursive: true });
  const random = mulberry32(20260915);
  const hero = encodePng(340, 340, () => [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256)]);
  await writeFile(heroPath, hero);
  written.push({ file: heroPath, bytes: hero.length, note: 'over the 307200 byte image threshold' });

  return written;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const written = await makeFixtures(path.resolve(here, '..', 'fixtures'));
  for (const w of written) process.stdout.write(`${w.file}: ${w.bytes} bytes\n`);
}
