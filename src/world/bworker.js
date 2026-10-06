// Web worker: decode an OpenMapTiles z14 vector tile and extrude its buildings into one mesh.
import Pbf from '../../vendor/pbf.js';
import { VectorTile } from '../../vendor/vector-tile.js';
import earcut from '../../vendor/earcut.js';

const R = 6371000, D2R = Math.PI / 180;
const tileLat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return Math.atan(Math.sinh(n)) / D2R; };
const tileLon = (x, z) => x / 2 ** z * 360 - 180;

function llh(lat, lon, h, out, o) {
  const p = lat * D2R, l = lon * D2R, r = R + h, c = Math.cos(p);
  out[o] = r * c * Math.cos(l); out[o + 1] = r * Math.sin(p); out[o + 2] = -r * c * Math.sin(l);
}

self.onmessage = (ev) => {
  const { id, buf, z, x, y, heights, N } = ev.data;
  try {
    const res = build(buf, z, x, y, heights, N);
    const ground = groundFn(z, x, y, heights, N);
    const vt = new VectorTile(new Pbf(buf));
    const rd = roads(vt, z, x, y, ground, res.center, res.latC, res.lonC);
    const wt = water(vt, z, x, y, ground, res.center, res.latC, res.lonC);
    const list = [res.pos.buffer, res.nor.buffer, res.col.buffer, res.fac.buffer, res.idx.buffer, res.foot.buffer];
    for (const o of [rd, wt]) for (const k of ['pos', 'att', 'idx']) list.push(o[k].buffer);
    self.postMessage({ id, ok: true, ...res, roads: rd, water: wt }, list);
  } catch (e) {
    self.postMessage({ id, ok: false, err: String(e) });
  }
};

function build(buf, z, x, y, heights, N) {
  const vt = new VectorTile(new Pbf(buf));
  const layer = vt.layers.building;
  const lonW = tileLon(x, z), lonE = tileLon(x + 1, z);
  const latC = tileLat(y + 0.5, z), lonC = (lonW + lonE) / 2;
  const C = [0, 0, 0]; llh(latC, lonC, 0, C, 0);
  const cosC = Math.cos(latC * D2R);
  // ground height from the rendered terrain grid (same triangulation as the planet mesh)
  const ground = (fx, fy) => {
    if (!heights) return 0;
    const gx = Math.min(N - 1e-6, Math.max(0, fx * N)), gy = Math.min(N - 1e-6, Math.max(0, fy * N));
    const i = gx | 0, j = gy | 0, s = gx - i, u = gy - j, st = N + 1;
    const ha = heights[j * st + i], hb = heights[j * st + i + 1], hc = heights[(j + 1) * st + i], hd = heights[(j + 1) * st + i + 1];
    return s + u <= 1 ? ha + (hb - ha) * s + (hc - ha) * u : hd + (hc - hd) * (1 - s) + (hb - hd) * (1 - u);
  };
  const pos = [], nor = [], col = [], fac = [], idx = [];
  const foot = [];   // collision: [count, minH, maxH, x0,y0, x1,y1 ...] in local metres (east, north) relative to tile centre
  const tmp = [0, 0, 0];
  if (!layer) return pack();
  const ext = layer.extent;
  const lat = (fy) => tileLat(y + fy, z);
  const lon = (fx) => lonW + (lonE - lonW) * fx;
  let bid = 0;
  for (let f = 0; f < layer.length; f++) {
    const feat = layer.feature(f);
    if (feat.type !== 3) continue;
    const pr = feat.properties;
    if (pr.hide_3d) continue;
    let hgt = +pr.render_height || 0, minH = +pr.render_min_height || 0;
    if (hgt <= 0) hgt = 6;
    if (hgt - minH < 1) continue;
    const c = parseColour(pr.colour);
    const rings = feat.loadGeometry();
    // group rings into polygons (outer ring + holes by winding)
    const polys = [];
    let ccw;
    for (const ring of rings) {
      if (ring.length < 4) continue;
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[i].x - ring[j].x) * (ring[i].y + ring[j].y);
      if (area === 0) continue;
      if (ccw === undefined) ccw = area < 0;
      if (ccw === area < 0 || !polys.length) polys.push([ring]); else polys[polys.length - 1].push(ring);
    }
    for (const poly of polys) {
      bid++;
      const rnd = hash(bid * 7.13 + x * 0.37 + y * 0.91);
      // local metric coords and ground
      const flat = [], holes = [], lats = [], lons = [];
      let gmin = 1e9, gsum = 0, gn = 0;
      for (let r = 0; r < poly.length; r++) {
        if (r > 0) holes.push(flat.length / 2);
        const ring = poly[r];
        for (let i = 0; i < ring.length - 1; i++) {
          const fx = ring[i].x / ext, fy = ring[i].y / ext;
          const la = lat(fy), lo = lon(fx);
          lats.push(la); lons.push(lo);
          flat.push((lo - lonC) * D2R * R * cosC, (la - latC) * D2R * R);
          if (r === 0) { const g = ground(fx, fy); if (g < gmin) gmin = g; gsum += g; gn++; }
        }
      }
      if (!gn) continue;
      const gavg = gsum / gn;
      const base = minH > 0 ? gavg + minH : gmin - 3;
      const top = gavg + hgt;
      const tris = earcut(flat, holes.length ? holes : null, 2);
      // roof
      const v0 = pos.length / 3;
      const roofC = [c[0] * 0.78, c[1] * 0.78, c[2] * 0.8];
      for (let i = 0; i < lats.length; i++) {
        llh(lats[i], lons[i], top, tmp, 0);
        pos.push(tmp[0] - C[0], tmp[1] - C[1], tmp[2] - C[2]);
        const r = Math.hypot(tmp[0], tmp[1], tmp[2]);
        nor.push(tmp[0] / r, tmp[1] / r, tmp[2] / r);
        col.push(roofC[0], roofC[1], roofC[2]);
        fac.push(0, 0, rnd);
      }
      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i], b = tris[i + 1], c2 = tris[i + 2];
        const cr = (flat[b * 2] - flat[a * 2]) * (flat[c2 * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c2 * 2] - flat[a * 2]);
        if (cr >= 0) idx.push(v0 + a, v0 + b, v0 + c2); else idx.push(v0 + a, v0 + c2, v0 + b);
      }
      // walls
      const ringStarts = [0, ...holes, lats.length];
      for (let r = 0; r < ringStarts.length - 1; r++) {
        const a0 = ringStarts[r], a1 = ringStarts[r + 1];
        let A = 0;
        for (let i = a0; i < a1; i++) { const j = i + 1 < a1 ? i + 1 : a0; A += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1]; }
        const flip = r === 0 ? A < 0 : A > 0;        // outer ring should be CCW (east/north), holes CW
        let u = 0;
        for (let i = a0; i < a1; i++) {
          const j = i + 1 < a1 ? i + 1 : a0;
          const ex = flat[j * 2] - flat[i * 2], ey = flat[j * 2 + 1] - flat[i * 2 + 1];
          const len = Math.hypot(ex, ey);
          if (len < 0.3) continue;
          const nx = (flip ? -ey : ey) / len, ny = (flip ? ex : -ex) / len;
          const wv = pos.length / 3;
          const corners = [[i, base], [j, base], [j, top], [i, top]];
          for (const [k, h] of corners) {
            llh(lats[k], lons[k], h, tmp, 0);
            pos.push(tmp[0] - C[0], tmp[1] - C[1], tmp[2] - C[2]);
          }
          const wn = enuToEcef(nx, ny, latC, lonC);
          for (let q = 0; q < 4; q++) { nor.push(wn[0], wn[1], wn[2]); col.push(c[0], c[1], c[2]); }
          const H = top - base;
          fac.push(u, 0, rnd, u + len, 0, rnd, u + len, H, rnd, u, H, rnd);
          u += len;
          if (!flip) idx.push(wv, wv + 1, wv + 2, wv, wv + 2, wv + 3);
          else idx.push(wv, wv + 2, wv + 1, wv, wv + 3, wv + 2);
        }
      }
      // collision footprint (outer ring only)
      const n = holes.length ? holes[0] : lats.length;
      foot.push(n, base, top);
      for (let i = 0; i < n; i++) foot.push(flat[i * 2], flat[i * 2 + 1]);
    }
  }
  return pack();

  function pack() {
    // fix wall winding: ensure each wall quad faces its normal (vector tiles can be either winding)
    return {
      pos: new Float32Array(pos), nor: new Float32Array(nor), col: new Float32Array(col), fac: new Float32Array(fac),
      idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), foot: new Float32Array(foot),
      center: C, latC, lonC, count: bid,
    };
  }
}

function enuToEcef(e, n, lat, lon) {
  const p = lat * D2R, l = lon * D2R;
  // east and north unit vectors in our axis convention
  const ex = -Math.sin(l), ey = 0, ez = -Math.cos(l);
  const ux = Math.cos(p) * Math.cos(l), uy = Math.sin(p), uz = -Math.cos(p) * Math.sin(l);
  const nx = uy * ez - uz * ey, ny = uz * ex - ux * ez, nz = ux * ey - uy * ex;
  return [e * ex + n * nx, e * ey + n * ny, e * ez + n * nz];
}

function hash(x) { const s = Math.sin(x * 127.1) * 43758.5453; return s - Math.floor(s); }

function parseColour(s) {
  if (typeof s === 'string' && s[0] === '#' && s.length >= 7) {
    const r = parseInt(s.slice(1, 3), 16) / 255, g = parseInt(s.slice(3, 5), 16) / 255, b = parseInt(s.slice(5, 7), 16) / 255;
    return [r * r, g * g, b * b];   // to linear-ish
  }
  return [0.45, 0.43, 0.4];
}


// ground height (m) at a fraction of the tile, on the rendered terrain's own triangles
function groundFn(z, x, y, heights, N) {
  return (fx, fy) => {
    if (!heights) return 0;
    const gx = Math.min(N - 1e-6, Math.max(0, fx * N)), gy = Math.min(N - 1e-6, Math.max(0, fy * N));
    const i = gx | 0, j = gy | 0, s = gx - i, u = gy - j, st = N + 1;
    const ha = heights[j * st + i], hb = heights[j * st + i + 1], hc = heights[(j + 1) * st + i], hd = heights[(j + 1) * st + i + 1];
    return s + u <= 1 ? ha + (hb - ha) * s + (hc - ha) * u : hd + (hc - hd) * (1 - s) + (hb - hd) * (1 - u);
  };
}

// Roads: ribbons of the right width for their class, draped on the terrain (subdivided so they follow it),
// with an attribute for the shader's lane markings: att = (distance along, -1..1 across, class, 0)
const ROAD = {
  motorway: [22, 0], trunk: [17, 1], primary: [13, 2], secondary: [10, 3], tertiary: [8, 4],
  minor: [6, 5], service: [4, 6], track: [3.2, 7], raceway: [12, 2], busway: [8, 4],
  rail: [3.5, 8], transit: [3, 8],
};
function roads(vt, z, x, y, ground, C, latC, lonC) {
  const layer = vt.layers.transportation;
  const pos = [], att = [], idx = [];
  const out = () => ({ pos: new Float32Array(pos), att: new Float32Array(att), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) });
  if (!layer) return out();
  const ext = layer.extent, lonW = tileLon(x, z), lonE = tileLon(x + 1, z);
  const cosC = Math.cos(latC * D2R), mx = D2R * R * cosC, my = D2R * R;
  const tmp = [0, 0, 0];
  // features sorted so bigger roads are drawn last (on top where they cross)
  const feats = [];
  for (let f = 0; f < layer.length; f++) {
    const feat = layer.feature(f);
    if (feat.type !== 2) continue;
    const pr = feat.properties;
    const spec = ROAD[pr.class];
    if (!spec || pr.brunnel === 'tunnel' || pr.class === 'path') continue;
    feats.push([spec, feat, pr]);
  }
  feats.sort((a, b) => b[0][1] - a[0][1]);
  for (const [spec, feat] of feats) {
    const w = spec[0] / 2, cls = spec[1], lift = 0.45 + (8 - cls) * 0.04;
    for (const line of feat.loadGeometry()) {
      // densify to <= 25 m steps in local metres (east, north) relative to the tile centre
      const P = [];
      for (let i = 0; i < line.length; i++) {
        const fx = line[i].x / ext, fy = line[i].y / ext;
        const la = tileLat(y + fy, z), lo = lonW + (lonE - lonW) * fx;
        const p = [(lo - lonC) * mx, (la - latC) * my, fx, fy];
        if (P.length) {
          const q = P[P.length - 1], d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < 0.5) continue;
          const n = Math.ceil(d / 25);
          for (let k = 1; k < n; k++) { const t = k / n; P.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t, q[2] + (p[2] - q[2]) * t, q[3] + (p[3] - q[3]) * t]); }
        }
        P.push(p);
      }
      if (P.length < 2) continue;
      if (pos.length / 3 + P.length * 2 > 400000) break;
      const v0 = pos.length / 3;
      let along = 0;
      for (let i = 0; i < P.length; i++) {
        const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
        if (i > 0) along += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
        const g = ground(P[i][2], P[i][3]) + lift;
        for (const side of [-1, 1]) {
          const ex = P[i][0] + -dy * w * side, ny = P[i][1] + dx * w * side;
          const la = latC + ny / my, lo = lonC + ex / mx;
          llh(la, lo, g, tmp, 0);
          pos.push(tmp[0] - C[0], tmp[1] - C[1], tmp[2] - C[2]);
          att.push(along, side, cls, w);
        }
        if (i > 0) { const k = v0 + i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
      }
    }
  }
  return out();
}

// Lakes, reservoirs and rivers: flat water surfaces just above the terrain (the sea is drawn by the terrain itself)
function water(vt, z, x, y, ground, C, latC, lonC) {
  const layer = vt.layers.water;
  const pos = [], att = [], idx = [];
  const out = () => ({ pos: new Float32Array(pos), att: new Float32Array(att), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx) });
  if (!layer) return out();
  const ext = layer.extent, lonW = tileLon(x, z), lonE = tileLon(x + 1, z);
  const cosC = Math.cos(latC * D2R), mx = D2R * R * cosC, my = D2R * R;
  const tmp = [0, 0, 0];
  for (let f = 0; f < layer.length; f++) {
    const feat = layer.feature(f);
    if (feat.type !== 3) continue;
    const pr = feat.properties;
    if (pr.class === 'ocean' || pr.brunnel === 'tunnel') continue;
    const rings = feat.loadGeometry();
    const polys = [];
    let ccw;
    for (const ring of rings) {
      if (ring.length < 4) continue;
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[i].x - ring[j].x) * (ring[i].y + ring[j].y);
      if (area === 0) continue;
      if (ccw === undefined) ccw = area < 0;
      if (ccw === area < 0 || !polys.length) polys.push([ring]); else polys[polys.length - 1].push(ring);
    }
    const river = pr.class === 'river';
    for (const poly of polys) {
      const flat = [], holes = [], F = [];
      let gmin = 1e9;
      for (let r = 0; r < poly.length; r++) {
        if (r > 0) holes.push(flat.length / 2);
        const ring = poly[r];
        for (let i = 0; i < ring.length - 1; i++) {
          const fx = ring[i].x / ext, fy = ring[i].y / ext;
          const la = tileLat(y + fy, z), lo = lonW + (lonE - lonW) * fx;
          flat.push((lo - lonC) * mx, (la - latC) * my);
          const g = ground(fx, fy);
          F.push([la, lo, g]);
          if (g < gmin) gmin = g;
        }
      }
      if (F.length < 3 || pos.length / 3 + F.length > 400000) continue;
      const tris = earcut(flat, holes.length ? holes : null, 2);
      const v0 = pos.length / 3;
      for (const [la, lo, g] of F) {
        // a lake lies flat at its shore's lowest level; a river follows the ground down its valley
        const h = (river ? g : Math.max(gmin, Math.min(g, gmin + 2))) + 0.6;
        llh(la, lo, h, tmp, 0);
        pos.push(tmp[0] - C[0], tmp[1] - C[1], tmp[2] - C[2]);
        att.push(0, 0, river ? 1 : 0, 0);
      }
      for (let i = 0; i < tris.length; i += 3) {
        const a = tris[i], b = tris[i + 1], c = tris[i + 2];
        const cr = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if (cr >= 0) idx.push(v0 + a, v0 + b, v0 + c); else idx.push(v0 + a, v0 + c, v0 + b);
      }
    }
  }
  return out();
}
