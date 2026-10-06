// Airports and runways (OurAirports, public domain): search, nearest lookup, runway meshes with markings,
// terrain flattening under runways and the player's hangar.

import * as THREE from 'three';
import { D2R, R2D, EARTH, llh, enu, gcDist, gcBearing, clamp, smoothstep } from '../core/geo.js';

const R = EARTH.R;

export class Airports {
  constructor() {
    this.ready = false;
    this.airports = [];      // {ident, iata, name, city, cc, lat, lon, type, runways: []}
    this.runways = [];       // {ap, le, he, lat1, lon1, lat2, lon2, w, e1, e2, len, brg, latC, lonC}
    this.grid = new Map();   // "lat|lon" (1 degree) -> runway indices
    this.extra = [];         // extra flattened pads (hangar aprons)
    this.meshes = new Map(); // runway index -> mesh group
    this.group = new THREE.Group();
    this.texCache = new Map();
    this.onReady = null;
  }

  async load() {
    const r = await fetch('./data/airports.json');
    const d = await r.json();
    this.airports = d.airports.map((a, i) => ({ i, ident: a[0], iata: a[1], name: a[2], city: a[3], cc: a[4], lat: a[5], lon: a[6], type: a[7], runways: [], l: (a[2] + ' ' + a[3]).toLowerCase() }));
    for (const w of d.runways) {
      const [api, le, he, lat1, lon1, lat2, lon2, wid, e1, e2] = w;
      const ap = this.airports[api];
      const rw = { idx: this.runways.length, ap, le, he, lat1, lon1, lat2, lon2, w: wid, e1, e2 };
      rw.len = gcDist(lat1, lon1, lat2, lon2);
      rw.brg = gcBearing(lat1, lon1, lat2, lon2);
      rw.latC = (lat1 + lat2) / 2; rw.lonC = (lon1 + lon2) / 2;
      rw.cosC = Math.cos(rw.latC * D2R);
      rw.dx = Math.sin(rw.brg); rw.dy = Math.cos(rw.brg);   // east, north components of runway direction
      this.runways.push(rw);
      ap.runways.push(rw);
      this.index(rw);
    }
    this.ready = true;
    if (this.onReady) this.onReady();
  }

  index(rw) {
    const m = 0.06;
    const la0 = Math.floor(Math.min(rw.lat1, rw.lat2) - m), la1 = Math.floor(Math.max(rw.lat1, rw.lat2) + m);
    const lo0 = Math.floor(Math.min(rw.lon1, rw.lon2) - m / Math.max(0.2, rw.cosC)), lo1 = Math.floor(Math.max(rw.lon1, rw.lon2) + m / Math.max(0.2, rw.cosC));
    for (let a = la0; a <= la1; a++) for (let o = lo0; o <= lo1; o++) {
      const k = a + '|' + o;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(rw);
    }
  }

  // ---- search ----
  search(q, limit = 8) {
    q = q.trim().toLowerCase();
    if (!q || !this.ready) return [];
    const up = q.toUpperCase();
    const hits = [];
    for (const a of this.airports) {
      if (a.type > 2) continue;
      let sc;
      if (a.iata === up || a.ident === up) sc = 0;
      else {
        const i = a.l.indexOf(q);
        if (i < 0) continue;
        // big airports first; a match at the start of the city or name beats one in the middle of a word
        const city = (a.city || '').toLowerCase();
        const start = city.startsWith(q) || a.l.startsWith(q) ? 0 : (i > 0 && a.l[i - 1] === ' ' ? 1 : 2);
        sc = 1 + a.type * 3 + start;
      }
      hits.push([sc, a.name.length, a]);
    }
    hits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return hits.slice(0, limit).map((h) => h[2]);
  }

  nearest(lat, lon, n = 8, maxType = 2) {
    const c = [];
    for (const a of this.airports) {
      if (a.type > maxType) continue;
      if (Math.abs(a.lat - lat) > 6) continue;
      c.push([gcDist(lat, lon, a.lat, a.lon), a]);
    }
    if (c.length < n) for (const a of this.airports) if (a.type <= maxType && Math.abs(a.lat - lat) > 6) c.push([gcDist(lat, lon, a.lat, a.lon), a]);
    c.sort((x, y) => x[0] - y[0]);
    return c.slice(0, n).map(([d, a]) => ({ d, a }));
  }

  runwaysNear(lat, lon) {
    return this.grid.get(Math.floor(lat) + '|' + Math.floor(lon)) || [];
  }

  // nearest runway end to a position (for landing aids)
  nearestRunway(lat, lon, maxDist = 60000) {
    let best = null, bd = maxDist;
    for (let a = -1; a <= 1; a++) for (let o = -1; o <= 1; o++) {
      const list = this.grid.get((Math.floor(lat) + a) + '|' + (Math.floor(lon) + o));
      if (!list) continue;
      for (const rw of list) {
        const d = gcDist(lat, lon, rw.latC, rw.lonC);
        if (d < bd) { bd = d; best = rw; }
      }
    }
    return best ? { rw: best, d: bd } : null;
  }

  // ---- runway local coordinates ----
  local(rw, lat, lon) {
    const x = (lon - rw.lonC) * D2R * R * rw.cosC, y = (lat - rw.latC) * D2R * R;
    return { along: x * rw.dx + y * rw.dy, cross: x * rw.dy - y * rw.dx };
  }
  elevAt(rw, along) { const t = clamp(along / rw.len + 0.5, 0, 1); return rw.e1 + (rw.e2 - rw.e1) * t; }

  // ---- terrain flattening interface used by the Earth planet ----
  flattener() {
    const self = this;
    const pick = (t) => {
      if (!self.ready) return [];
      const res = [];
      const la0 = Math.floor(t.latS - 0.05), la1 = Math.floor(t.latN + 0.05);
      const lo0 = Math.floor(t.lonW - 0.05), lo1 = Math.floor(t.lonE + 0.05);
      for (let a = la0; a <= la1; a++) for (let o = lo0; o <= lo1; o++) {
        const list = self.grid.get(a + '|' + o);
        if (!list) continue;
        for (const rw of list) {
          if (res.includes(rw)) continue;
          const mlat = (rw.len / 2 + 800) / (R * D2R), mlon = mlat / Math.max(0.15, rw.cosC);
          if (rw.latC + mlat < t.latS || rw.latC - mlat > t.latN || rw.lonC + mlon < t.lonW || rw.lonC - mlon > t.lonE) continue;
          res.push(rw);
        }
      }
      for (const p of self.extra) {
        const mlat = (p.len / 2 + 800) / (R * D2R), mlon = mlat / Math.max(0.15, p.cosC);
        if (p.latC + mlat < t.latS || p.latC - mlat > t.latN || p.lonC + mlon < t.lonW || p.lonC - mlon > t.lonE) continue;
        res.push(p);
      }
      return res;
    };
    return {
      has: (t) => pick(t).length > 0,
      list: pick,
      apply: (list, lat, lon, h, cell) => {
        let best = h, wbest = 0;
        for (const rw of list) {
          const { along, cross } = self.local(rw, lat, lon);
          const fw = rw.w / 2 + Math.max(45, cell * 1.6), fl = rw.len / 2 + Math.max(150, cell * 1.6);
          const bz = Math.max(250, cell * 3);
          const ex = Math.max(Math.abs(cross) - fw, Math.abs(along) - fl, 0);
          if (ex >= bz) continue;
          const w = 1 - smoothstep(0, bz, ex);
          if (w > wbest) {
            wbest = w;
            best = (self.elevAt(rw, along) - 0.25) * w + h * (1 - w);
          }
        }
        return best;
      },
    };
  }

  // ---- meshes ----
  // build runway meshes for runways within dist of (lat,lon); drop far ones. Meshes are in Earth-fixed coords.
  updateMeshes(lat, lon, dist, shared) {
    if (!this.ready) return;
    const want = new Set(), near = [];
    for (let a = -1; a <= 1; a++) for (let o = -1; o <= 1; o++) {
      const list = this.grid.get((Math.floor(lat) + a) + '|' + (Math.floor(lon) + o));
      if (!list) continue;
      for (const rw of list) {
        const d = gcDist(lat, lon, rw.latC, rw.lonC);
        if (d < dist) { want.add(rw.idx); if (!this.meshes.has(rw.idx)) near.push([d, rw.idx]); }
      }
    }
    for (const [i, g] of this.meshes) if (!want.has(i)) { this.group.remove(g); g.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.meshes.delete(i); }
    // a few at a time, nearest first (the runway under the wheels before the ones across the bay)
    near.sort((a, b) => a[0] - b[0]);
    for (const [, i] of near.slice(0, 3)) { const g = this.buildRunway(this.runways[i], shared); this.meshes.set(i, g); this.group.add(g); }
  }

  buildRunway(rw, shared) {
    const g = new THREE.Group();
    const C = llh(rw.latC, rw.lonC, this.elevAt(rw, 0), R, new THREE.Vector3());
    g.position.copy(C);
    const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3();
    enu(C, up, east, north);
    const dir = east.clone().multiplyScalar(rw.dx).addScaledVector(north, rw.dy);
    const side = new THREE.Vector3().crossVectors(dir, up);   // right of direction of travel (le -> he)
    const hw = rw.w / 2;
    const seg = Math.max(8, Math.ceil(rw.len / 150));
    const pos = [], uv = [], idx = [], nor = [];
    const v = new THREE.Vector3();
    for (let s = 0; s <= seg; s++) {
      const along = -rw.len / 2 + (rw.len * s) / seg;
      const e = this.elevAt(rw, along) + 0.12;
      for (const k of [-1, 1]) {
        // point = centre + dir*along + side*k*hw, lifted to the sphere at elevation e
        v.copy(C).addScaledVector(dir, along).addScaledVector(side, k * hw);
        v.setLength(R + e).sub(C);
        pos.push(v.x, v.y, v.z);
        nor.push(up.x, up.y, up.z);
        uv.push(k < 0 ? 0 : 1, along + rw.len / 2);              // v in metres from the 'le' end
      }
    }
    for (let s = 0; s < seg; s++) { const a = s * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const mat = runwayMaterial(shared, this.endTex(rw.le, rw.w), this.endTex(rw.he, rw.w), rw.len, rw.w);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    g.add(mesh);
    // edge, threshold and end lights
    const lp = [], lc = [];
    const addL = (along, cross, col) => {
      v.copy(C).addScaledVector(dir, along).addScaledVector(side, cross);
      v.setLength(R + this.elevAt(rw, along) + 0.6).sub(C);
      lp.push(v.x, v.y, v.z); lc.push(...col);
    };
    for (let a = -rw.len / 2; a <= rw.len / 2 + 0.1; a += 60) { addL(a, -hw - 1.5, [1, 0.95, 0.8]); addL(a, hw + 1.5, [1, 0.95, 0.8]); }
    for (let c = -hw; c <= hw; c += 4) { addL(-rw.len / 2 - 2, c, [0.2, 1, 0.4]); addL(rw.len / 2 + 2, c, [0.2, 1, 0.4]); }
    // approach lights
    for (const sgn of [-1, 1]) for (let d = 60; d <= 900; d += 60) for (const c of [-6, 0, 6]) addL(sgn * (rw.len / 2 + d), c, [1, 1, 0.95]);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    const lm = new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lights = new THREE.Points(lg, lm);
    lights.frustumCulled = false;
    lights.renderOrder = 2;
    lights.userData.isLights = true;
    g.add(lights);
    g.userData.rw = rw;
    return g;
  }

  setNight(k) {
    for (const g of this.meshes.values()) g.traverse((o) => { if (o.userData.isLights) { o.visible = k > 0.05; o.material.opacity = k; } });
  }

  // threshold markings for one runway end, drawn to scale: the texture spans the full width and 512 m of length
  endTex(ident, width) {
    const key = ident + '|' + Math.round(width);
    if (this.texCache.has(key)) return this.texCache.get(key);
    const c = document.createElement('canvas'); c.width = 256; c.height = 1024;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, 256, 1024);
    x.fillStyle = '#fff';
    const pxM = 1024 / 512;                 // px per metre along
    const pxW = 256 / width;                // px per metre across
    const m = (v) => v * pxM, w = (v) => v * pxW;
    // threshold bar and piano keys (start 6 m in, 30 m long)
    x.fillRect(0, m(1), 256, m(1.8));
    const keys = width >= 55 ? 16 : width >= 44 ? 12 : width >= 29 ? 8 : 6;
    const kw = 1.8, gap = (width - 6 - keys * kw) / (keys - 1 + 2);
    for (let i = 0; i < keys; i++) {
      const half = i < keys / 2;
      const pos = 3 + gap * 0.5 + i * (kw + gap * 0.9) + (half ? 0 : gap * 1.2);
      x.fillRect(w(pos), m(6), w(kw), m(30));
    }
    // designation: 9 m tall digits starting 48 m in
    let txt = (ident || '').replace(/^0(?=\d)/, '');
    const mm = txt.match(/^(\d+)([LRC]?)$/);
    x.save(); x.translate(128, m(48 + 9 + 13 * (mm && mm[2] ? 1 : 0))); x.scale(Math.min(1, w(14) / 110), -m(9) / 100);
    x.font = 'bold 120px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(mm ? mm[1] : txt.slice(0, 3), 0, 0);
    x.restore();
    if (mm && mm[2]) { x.save(); x.translate(128, m(48 + 6)); x.scale(Math.min(1, w(10) / 90), -m(8) / 100); x.font = 'bold 110px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(mm[2], 0, 0); x.restore(); }
    // touchdown zone bars (150 m, 300 m, 450 m) and aiming point (300 m)
    const bar = (along, len, n) => { for (let i = 0; i < n; i++) for (const sgn of [-1, 1]) x.fillRect(128 + sgn * w(4 + i * 3) - (sgn < 0 ? w(1.8) : 0), m(along), w(1.8), m(len)); };
    bar(150, 22.5, 3);
    bar(450, 22.5, 2);
    for (const sgn of [-1, 1]) x.fillRect(128 + sgn * w(9) - (sgn < 0 ? w(10) : 0), m(300), w(10), m(45));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 8;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    this.texCache.set(key, t);
    return t;
  }

  // the hangar + apron next to the departure end of a runway
  hangarFor(rw, fromLe = true) {
    const sign = fromLe ? 1 : -1;
    const along = -sign * (rw.len / 2 - 260);
    const cross = sign * (rw.w / 2 + 170);          // right of the departure direction
    // lat/lon of apron centre
    const dE = along * rw.dx + cross * rw.dy, dN = along * rw.dy - cross * rw.dx;
    const lat = rw.latC + (dN / R) * R2D, lon = rw.lonC + (dE / (R * rw.cosC)) * R2D;
    const elev = this.elevAt(rw, along);
    const pad = { idx: -1, latC: lat, lonC: lon, cosC: Math.cos(lat * D2R), dx: rw.dx, dy: rw.dy, len: 260, w: 260, e1: elev, e2: elev, ap: rw.ap };
    return { pad, lat, lon, elev, heading: fromLe ? rw.brg : rw.brg + Math.PI };
  }
  addPad(pad) { this.extra = [pad]; }
}

const RWY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
void main(){ vUv = uv; vN = mat3(modelMatrix) * normal; vec4 wp = modelMatrix * vec4(position,1.0);
  wp.xyz *= 0.995;   // a touch more view-ray depth bias than roads (0.4 %), so a road under the runway stays under it
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const RWY_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uEnd1; uniform sampler2D uEnd2; uniform float uLen; uniform float uW;
uniform vec3 uSun; uniform float uCamAlt; uniform float uFogK;
varying vec2 vUv; varying vec3 vW; varying vec3 vN;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  #include <logdepthbuf_fragment>
  float v = vUv.y;                  // metres from the 'le' end
  float u = vUv.x;
  float m = 0.0;
  if (v < 512.0) m = texture2D(uEnd1, vec2(u, 1.0 - v / 512.0)).r;
  else if (v > uLen - 512.0) m = texture2D(uEnd2, vec2(1.0 - u, 1.0 - (uLen - v) / 512.0)).r;
  // centreline: 30 m stripes with 20 m gaps, 0.9 m wide
  float cx = abs(u - 0.5) * uW;
  if (v > 520.0 && v < uLen - 520.0) m = max(m, step(cx, 0.45) * step(mod(v, 50.0), 30.0));
  // edge lines
  m = max(m, step((0.5 - abs(u - 0.5)) * uW, 0.9));
  float n = hash(floor(vec2(u * uW * 1.5, v * 1.5)));
  float n2 = hash(floor(vec2(u * uW * 0.2, v * 0.05)));
  vec3 asphalt = vec3(0.075, 0.078, 0.085) * (0.88 + 0.18 * n + 0.15 * n2);
  float skid = smoothstep(9.0, 0.0, cx) * (smoothstep(250.0, 400.0, v) * smoothstep(900.0, 600.0, v) + smoothstep(uLen - 250.0, uLen - 400.0, v) * smoothstep(uLen - 900.0, uLen - 600.0, v));
  asphalt *= 1.0 - 0.5 * skid;
  vec3 alb = mix(asphalt, vec3(0.85), m * 0.92);
  vec3 N = normalize(vN);
  float sd = dot(N, uSun);
  vec3 sunCol = mix(vec3(1.0, 0.52, 0.28), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.3, sd));
  vec3 col = alb * sunCol * 1.18 * pow(max(sd, 0.0), 0.62) * smoothstep(-0.05, 0.08, sd) + alb * 0.012;
  float Hs = 8000.0; float hc = max(uCamAlt, 0.0);
  float fog = 1.0 - exp(-length(vW) * exp(-min(hc, 3000.0) / Hs) * uFogK);
  vec3 haze = mix(vec3(1.0, 0.55, 0.32), vec3(0.56, 0.68, 0.88), smoothstep(0.0, 0.35, sd)) * smoothstep(-0.18, 0.12, sd);
  col = mix(col, haze, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function runwayMaterial(shared, t1, t2, len, w) {
  return new THREE.ShaderMaterial({
    uniforms: { uEnd1: { value: t1 }, uEnd2: { value: t2 }, uLen: { value: len }, uW: { value: w }, uSun: shared.uSun, uCamAlt: shared.uCamAlt, uFogK: shared.uFogK },
    vertexShader: RWY_VERT, fragmentShader: RWY_FRAG,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...PAVED,
  });
}
// runways and aprons mark their pixels in the stencil buffer; roads and water skip those pixels
export const PAVED = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp };

// A hangar building with apron, built in a local frame (x = right of runway direction, y = up, -z = toward runway direction)
// A launch pad: concrete square with a flame trench, a lattice service tower with an access arm, floodlights
// and red obstruction lights. Local frame: y up, the rocket stands at the origin.
export function buildLaunchPad() {
  const g = new THREE.Group();
  const conc = new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.92, metalness: 0.0, ...PAVED });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc23a2a, roughness: 0.6, metalness: 0.3 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x9aa1aa, roughness: 0.5, metalness: 0.6 });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(110, 1.2, 110), conc); pad.position.y = -0.55; g.add(pad);
  const ring = new THREE.Mesh(new THREE.RingGeometry(9, 10, 48), new THREE.MeshBasicMaterial({ color: 0xffb347 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.07; g.add(ring);
  const trench = new THREE.Mesh(new THREE.BoxGeometry(10, 0.2, 46), dark); trench.position.set(0, 0.02, 30); g.add(trench);
  // service tower: four legs with braces every 6 m, a top deck and an access arm toward the rocket
  const tx = -22, H = 66;
  for (const [x, z] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) { const c = new THREE.Mesh(new THREE.BoxGeometry(0.7, H, 0.7), steel); c.position.set(tx + x, H / 2, z); g.add(c); }
  for (let y = 6; y < H; y += 6) {
    for (const z of [-3, 3]) { const b = new THREE.Mesh(new THREE.BoxGeometry(6.7, 0.35, 0.35), steel); b.position.set(tx, y, z); g.add(b); }
    for (const x of [-3, 3]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 6.7), steel); b.position.set(tx + x, y, 0); g.add(b); }
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.25, 8.5, 0.25), steel); d.position.set(tx, y - 3, 3); d.rotation.z = 0.78; g.add(d);
  }
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 8), grey); deck.position.set(tx, H, 0); g.add(deck);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(17, 1.4, 2), grey); arm.position.set(tx + 11, H * 0.55, 0); g.add(arm);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 14, 8), grey); mast.position.set(tx, H + 7, 0); g.add(mast);
  const red = new THREE.MeshBasicMaterial({ color: 0xff3020 });
  for (const y of [H + 14.2, H * 0.5]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), red); l.position.set(tx, y, 3.5); g.add(l); }
  // floodlight poles at the corners
  const lampM = new THREE.MeshBasicMaterial({ color: 0xfff1d0 });
  for (const [x, z] of [[48, 48], [-48, 48], [48, -48], [-48, -48]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 26, 8), grey); pole.position.set(x, 13, z); g.add(pole);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 1), lampM); lamp.position.set(x * 0.97, 26, z * 0.97); lamp.lookAt(0, 0, 0); g.add(lamp);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function buildHangar() {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.4, roughness: 0.55 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x5d6670, metalness: 0.5, roughness: 0.5 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0x3a2200, metalness: 0.2, roughness: 0.6 });
  const floor = new THREE.MeshStandardMaterial({ color: 0x6f7378, metalness: 0.0, roughness: 0.9, ...PAVED });
  const W = 70, D = 60, H = 18;
  // apron
  const apron = new THREE.Mesh(new THREE.BoxGeometry(240, 0.4, 230), floor);
  apron.position.set(0, 0.0, -60); g.add(apron);
  // walls (open front facing -z)
  const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 1), wall); back.position.set(0, H / 2, D / 2); g.add(back);
  for (const s of [-1, 1]) { const sw = new THREE.Mesh(new THREE.BoxGeometry(1, H, D), wall); sw.position.set(s * W / 2, H / 2, 0); g.add(sw); }
  // curved roof
  const rg = new THREE.CylinderGeometry(W / 2 + 1, W / 2 + 1, D + 2, 32, 1, true, -Math.PI / 2, Math.PI);
  const rm = new THREE.Mesh(rg, roof); rm.rotation.x = Math.PI / 2; rm.rotation.y = 0; rm.scale.set(1, 1, 0.32);
  rm.rotation.set(Math.PI / 2, 0, 0); rm.position.set(0, H, 0);
  rm.material.side = THREE.DoubleSide; g.add(rm);
  // door header + stripe
  const hd = new THREE.Mesh(new THREE.BoxGeometry(W + 2, 3, 1.5), accent); hd.position.set(0, H + 0.5, -D / 2); g.add(hd);
  // interior floor marking
  const fl = new THREE.Mesh(new THREE.BoxGeometry(W - 2, 0.1, D - 2), new THREE.MeshStandardMaterial({ color: 0x3b4048, roughness: 0.8 }));
  fl.position.set(0, 0.25, 0); g.add(fl);
  // lights under the roof
  for (let i = -1; i <= 1; i++) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(14, 0.3, 2), new THREE.MeshBasicMaterial({ color: 0xfff2d6 }));
    l.position.set(i * 20, H - 0.5, 0); g.add(l);
  }
  // taxi line from hangar to runway
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.05, 220), new THREE.MeshBasicMaterial({ color: 0xd9b23a }));
  line.position.set(0, 0.25, -140); g.add(line);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}
