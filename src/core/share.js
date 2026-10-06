// Share codes: a design packed into a short text code (and a link with it after #ship=) that anyone can paste
// into their hangar. The design is written compactly, deflated when the browser can, and base64url-encoded;
// reading one back checks every field, so a pasted code can only ever produce a valid design.

import { PART } from '../ship/parts.js';

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_PARTS = 400;

// design -> compact array form
function pack(d) {
  const r3 = (v) => Math.round(v * 1000) / 1000, r5 = (v) => Math.round(v * 1e5) / 1e5;
  return {
    n: d.name, c: [d.colors?.hull, d.colors?.accent], v: d.vertical ? 1 : 0,
    p: d.parts.map((q) => {
      const row = [q.id, ...q.p.map(r3), ...q.q.map(r5), q.mirror ? 1 : 0, q.parent ?? -1, q.sym ?? -1];
      if (q.w) row.push([q.w.span, q.w.root, q.w.tip, q.w.sweep].map(r3));
      return row;
    }),
  };
}

// compact form -> design, rejecting anything malformed
function unpack(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.p)) throw new Error('not a ship code');
  if (!o.p.length || o.p.length > MAX_PARTS) throw new Error('a ship needs 1–400 parts');
  const n = o.p.length;
  const num = (v, lim) => { if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > lim) throw new Error('bad number'); return v; };
  const idx = (v) => (Number.isInteger(v) && v >= -1 && v < n ? v : -1);
  const parts = o.p.map((row, i) => {
    if (!Array.isArray(row) || row.length < 11) throw new Error('bad part');
    const id = row[0];
    if (typeof id !== 'string' || !PART[id]) throw new Error(`unknown part “${String(id).slice(0, 20)}”`);
    const p = row.slice(1, 4).map((v) => num(v, 500));
    let q = row.slice(4, 8).map((v) => num(v, 2));
    const ql = Math.hypot(...q);
    q = ql > 1e-6 ? q.map((v) => v / ql) : [0, 0, 0, 1];
    const part = { id, p, q, mirror: row[8] === 1, parent: idx(row[9]), sym: idx(row[10]) };
    if (part.parent >= i) part.parent = -1;
    if (Array.isArray(row[11]) && PART[id].wing) {
      const [span, root, tip, sweep] = row[11].map((v) => num(v, 100));
      part.w = { span, root, tip, sweep };
    }
    return part;
  });
  const name = (typeof o.n === 'string' ? o.n : 'Shared ship').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || 'Shared ship';
  const c = Array.isArray(o.c) ? o.c : [];
  return {
    name, parts, vertical: o.v === 1, version: 1,
    colors: { hull: HEX.test(c[0]) ? c[0] : '#e8ecf0', accent: HEX.test(c[1]) ? c[1] : '#ffb347' },
  };
}

const b64u = {
  enc(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(str.replace(/-/g, '+').replace(/_/g, '/')); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
};

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// "SF1." + deflated, or "SF0." + plain when the browser can't compress
export async function encodeDesign(d) {
  const raw = new TextEncoder().encode(JSON.stringify(pack(d)));
  if (typeof CompressionStream !== 'undefined') {
    try { return 'SF1.' + b64u.enc(await pipe(raw, new CompressionStream('deflate-raw'))); } catch (e) { /* fall through */ }
  }
  return 'SF0.' + b64u.enc(raw);
}

export async function decodeDesign(code) {
  let s = String(code || '').trim();
  const m = s.match(/#ship=([A-Za-z0-9._-]+)/);            // a whole link pasted in
  if (m) s = m[1];
  s = s.replace(/\s+/g, '');
  const kind = s.slice(0, 4);
  if (kind !== 'SF1.' && kind !== 'SF0.') throw new Error('not a Starforge ship code');
  if (s.length > 200000) throw new Error('code too long');
  let bytes = b64u.dec(s.slice(4));
  if (kind === 'SF1.') {
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser can’t read compressed codes');
    bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  }
  if (bytes.length > 2e6) throw new Error('code too long');
  return unpack(JSON.parse(new TextDecoder().decode(bytes)));
}

export function shareLink(code) { return `${location.origin}${location.pathname}#ship=${code}`; }
