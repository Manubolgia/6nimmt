/*
 * Rasterises the polygon artwork in web/js/art.js into the PNG launcher icons
 * the manifest needs, plus the SVG favicon.
 *
 * No image libraries: polygons are scan-converted with an even-odd rule and
 * 8x vertical supersampling plus analytic horizontal coverage, then encoded as
 * PNG with node's own zlib.
 *
 *   node tools/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BULL, BULL_PATH } from '../web/js/art.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'icons');

const INK = [0x17, 0x18, 0x1a]; // charcoal ground
const ACCENT = [0xe2, 0x45, 0x2b]; // vermilion

/* ---------------------------- rasteriser ---------------------------- */

const SUB = 8; // sample rows per pixel row

/**
 * Coverage buffer (0..1 per pixel) for a set of polygons in a 0..100 space,
 * mapped into a size x size image with the given scale and offset.
 */
function rasterise(polygons, size, scale, offset) {
  const cov = new Float32Array(size * size);
  const edges = [];
  for (const poly of polygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ax = a[0] * scale + offset;
      const ay = a[1] * scale + offset;
      const bx = b[0] * scale + offset;
      const by = b[1] * scale + offset;
      if (ay === by) continue;
      edges.push({ x0: ax, y0: ay, x1: bx, y1: by });
    }
  }

  const xs = [];
  for (let py = 0; py < size; py++) {
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB;
      xs.length = 0;
      for (const e of edges) {
        const lo = Math.min(e.y0, e.y1);
        const hi = Math.max(e.y0, e.y1);
        if (y < lo || y >= hi) continue;
        xs.push(e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        spanCoverage(cov, size, py, xs[i], xs[i + 1]);
      }
    }
  }
  const inv = 1 / SUB;
  for (let i = 0; i < cov.length; i++) cov[i] = Math.min(1, cov[i] * inv);
  return cov;
}

/** Add horizontal coverage of [xa, xb) on one sample row of pixel row py. */
function spanCoverage(cov, size, py, xa, xb) {
  if (xb <= 0 || xa >= size) return;
  const a = Math.max(0, xa);
  const b = Math.min(size, xb);
  if (b <= a) return;
  const base = py * size;
  const first = Math.floor(a);
  const last = Math.ceil(b) - 1;
  for (let px = first; px <= last; px++) {
    const left = Math.max(a, px);
    const right = Math.min(b, px + 1);
    if (right > left) cov[base + px] += right - left;
  }
}

/* ------------------------------ PNG ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** Encode an RGB pixel buffer (size*size*3) as an 8-bit truecolour PNG. */
function encodePng(rgb, size) {
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ icons ------------------------------ */

/**
 * @param {number} size    image edge in px
 * @param {number} inset   fraction of the edge kept clear around the art
 */
function makeIcon(size, inset) {
  const artSize = size * (1 - inset * 2);
  const scale = artSize / 100;
  const offset = size * inset;
  const cov = rasterise(BULL, size, scale, offset);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    const a = cov[i];
    for (let c = 0; c < 3; c++) {
      rgb[i * 3 + c] = Math.round(INK[c] * (1 - a) + ACCENT[c] * a);
    }
  }
  return encodePng(rgb, size);
}

mkdirSync(OUT, { recursive: true });

const targets = [
  ['icon-192.png', 192, 0.14],
  ['icon-512.png', 512, 0.14],
  ['icon-maskable-512.png', 512, 0.22], // art inside the 80% safe zone
  ['apple-touch-icon.png', 180, 0.16],
  ['icon-32.png', 32, 0.08],
];

for (const [name, size, inset] of targets) {
  writeFileSync(join(OUT, name), makeIcon(size, inset));
  process.stdout.write(`wrote icons/${name} (${size}px)\n`);
}

const favicon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100" fill="#17181a"/>' +
  `<path d="${BULL_PATH}" fill="#e2452b" fill-rule="evenodd" ` +
  'transform="translate(50 50) scale(0.78) translate(-50 -50)"/></svg>\n';
writeFileSync(join(OUT, 'favicon.svg'), favicon);
process.stdout.write('wrote icons/favicon.svg\n');
