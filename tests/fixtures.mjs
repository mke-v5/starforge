// Offline map fixtures: when the imagery and vector-tile hosts can't be reached (CI sandboxes), answer their
// requests with generated stand-ins so the whole ground pipeline — imagery, terrain, buildings, roads, water —
// still loads and renders. Elevation tiles are left to the real host.
//
//   imagery  (EOX, GIBS)      -> a procedural PNG: patchwork fields, darker on hash
//   Moon imagery (Moon Trek)  -> grey regolith
//   OpenFreeMap tile JSON      -> points at the fake vector tiles below
//   vector tiles (z14)         -> a street grid with a motorway and a railway, a lake, a river and a block of buildings

import zlib from 'node:zlib';

// ---------- PNG ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, px) {         // px(x, y) -> [r, g, b]
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const imgCache = new Map();
function imagery(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (imgCache.has(key)) return imgCache.get(key);
  // fields ~ 1/16 of the tile, in greens and browns
  const b = png(256, 256, (px, py) => {
    const fx = Math.floor(px / 32), fy = Math.floor(py / 32);
    const h = hash(fx + x * 8, fy + y * 8);
    const base = h < 0.3 ? [88, 104, 62] : h < 0.6 ? [118, 112, 80] : h < 0.85 ? [70, 90, 52] : [140, 132, 108];
    const n = (hash(px, py + x) - 0.5) * 14;
    return base.map((c) => Math.max(0, Math.min(255, c + n)));
  });
  if (imgCache.size < 400) imgCache.set(key, b);
  return b;
}
const NIGHT = png(256, 256, () => [4, 4, 8]);
const MOONIMG = png(256, 256, (x, y) => { const v = 118 + (hash(x >> 3, y >> 3) - 0.5) * 30; return [v, v, v - 4]; });

// ---------- Mapbox vector tile ----------
const varint = (n, o) => { while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); };
const zz = (n) => (n << 1) ^ (n >> 31);
const key = (tag, wire, o) => varint(tag * 8 + wire, o);
const bytes = (tag, b, o) => { key(tag, 2, o); varint(b.length, o); for (const v of b) o.push(v); };
const str = (tag, s, o) => bytes(tag, [...Buffer.from(s)], o);
const packed = (tag, a, o) => { const b = []; for (const v of a) varint(v, b); bytes(tag, b, o); };
function geom(rings, close) {
  const out = []; let cx = 0, cy = 0;
  for (const r of rings) {
    out.push(1 | (1 << 3), zz(r[0][0] - cx), zz(r[0][1] - cy)); cx = r[0][0]; cy = r[0][1];
    const n = r.length - 1;
    out.push(2 | (n << 3));
    for (let i = 1; i <= n; i++) { out.push(zz(r[i][0] - cx), zz(r[i][1] - cy)); cx = r[i][0]; cy = r[i][1]; }
    if (close) out.push(7 | (1 << 3));
  }
  return out;
}
function layer(name, feats) {
  const keys = [], vals = [], o = [];
  varint(15 * 8, o); varint(2, o);              // version 2
  str(1, name, o);
  const kIdx = (k) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  const vIdx = (v) => { const s = JSON.stringify(v); let i = vals.findIndex((x) => JSON.stringify(x) === s); if (i < 0) { vals.push(v); i = vals.length - 1; } return i; };
  let id = 1;
  for (const f of feats) {
    const fo = [];
    key(1, 0, fo); varint(id++, fo);
    const tags = []; for (const [k, v] of Object.entries(f.props)) tags.push(kIdx(k), vIdx(v));
    packed(2, tags, fo);
    key(3, 0, fo); varint(f.type, fo);
    packed(4, geom(f.rings, f.type === 3), fo);
    bytes(2, fo, o);
  }
  for (const k of keys) str(3, k, o);
  for (const v of vals) { const vo = []; if (typeof v === 'string') str(1, v, vo); else { key(5, 0, vo); varint(v, vo); } bytes(4, vo, o); }
  key(5, 0, o); varint(4096, o);
  return o;
}
let MVT = null;
function vectorTile() {
  if (MVT) return MVT;
  const roads = [], buildings = [], water = [];
  // street grid
  for (let i = 1; i < 8; i++) {
    const c = i * 512, cls = i === 4 ? 'primary' : i % 2 ? 'minor' : 'secondary';
    roads.push({ type: 2, props: { class: cls }, rings: [[[c, -64], [c, 4160]]] });
    roads.push({ type: 2, props: { class: cls }, rings: [[[-64, c], [4160, c]]] });
  }
  roads.push({ type: 2, props: { class: 'motorway' }, rings: [[[-64, 300], [1800, 900], [4160, 2600]]] });
  roads.push({ type: 2, props: { class: 'rail' }, rings: [[[-64, 3900], [4160, 3300]]] });
  // a lake and a river
  const lake = []; for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; lake.push([Math.round(2900 + Math.cos(a) * 520), Math.round(1300 + Math.sin(a) * 380)]); }
  lake.push(lake[0]);
  water.push({ type: 3, props: { class: 'lake' }, rings: [lake] });
  water.push({ type: 3, props: { class: 'river' }, rings: [[[600, -64], [700, -64], [900, 4160], [800, 4160], [600, -64]]] });
  // a block of buildings
  for (let bx = 0; bx < 5; bx++) for (let by = 0; by < 4; by++) {
    const x0 = 1050 + bx * 90, y0 = 1050 + by * 100;
    buildings.push({ type: 3, props: { render_height: 8 + ((bx * 7 + by * 3) % 5) * 9 }, rings: [[[x0, y0], [x0 + 60, y0], [x0 + 60, y0 + 70], [x0, y0 + 70], [x0, y0]]] });
  }
  const tile = [];
  for (const [n, f] of [['transportation', roads], ['water', water], ['building', buildings]]) bytes(3, layer(n, f), tile);
  MVT = Buffer.from(tile);
  return MVT;
}

export async function installFixtures(ctx) {
  const ok = (body, type) => ({ status: 200, contentType: type, body, headers: { 'access-control-allow-origin': '*' } });
  await ctx.route(/tiles\.maps\.eox\.at\/.*\/(\d+)\/(\d+)\/(\d+)\.jpg/, (route) => {
    const m = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.jpg/);
    route.fulfill(ok(imagery(+m[1], +m[3], +m[2]), 'image/png'));
  });
  await ctx.route(/gibs\.earthdata\.nasa\.gov/, (route) => route.fulfill(ok(NIGHT, 'image/png')));
  await ctx.route(/trek\.nasa\.gov/, (route) => route.fulfill(ok(MOONIMG, 'image/png')));
  await ctx.route(/tiles\.openfreemap\.org\/planet$/, (route) => route.fulfill(ok(JSON.stringify({ tiles: ['https://tiles.openfreemap.org/fixture/{z}/{x}/{y}.pbf'] }), 'application/json')));
  await ctx.route(/tiles\.openfreemap\.org\/fixture\//, (route) => route.fulfill(ok(vectorTile(), 'application/x-protobuf')));
}
