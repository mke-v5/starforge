// Streams OpenStreetMap buildings (OpenFreeMap vector tiles, z14) around the camera and extrudes them in a worker.

import * as THREE from 'three';
import { D2R, R2D, EARTH, mercY, tileLat, tileLon, clamp } from '../core/geo.js';

const Z = 14;

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aFac;
varying vec3 vN; varying vec3 vW; varying vec3 vCol; varying vec3 vFac; varying float vH;
void main(){
  vN = mat3(modelMatrix) * normal; vCol = color; vFac = aFac;
  vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uSun; uniform float uCamAlt; uniform float uFogK; uniform float uNight;
varying vec3 vN; varying vec3 vW; varying vec3 vCol; varying vec3 vFac;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(-vW);
  vec3 alb = vCol;
  vec3 emit = vec3(0.0);
  if (vFac.x + vFac.y > 0.5) {
    float u = vFac.x, v = vFac.y, rnd = vFac.z;
    float bay = 3.4 + rnd * 1.4, floorH = 3.3;
    vec2 cell = vec2(floor(u / bay), floor(v / floorH));
    vec2 f = vec2(fract(u / bay), fract(v / floorH));
    float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.30, f.y) * step(f.y, 0.85) * step(1.0, v);
    float glassy = step(0.72, rnd);
    win = max(win, glassy * step(1.0, v) * step(0.06, f.y));
    vec3 glass = vec3(0.07, 0.09, 0.12) + vec3(0.25, 0.30, 0.36) * pow(1.0 - abs(dot(V, N)), 3.0);
    alb = mix(alb, glass, win * 0.85);
    float on = step(0.45, hash(cell + rnd * 31.0));
    emit = vec3(1.0, 0.78, 0.48) * win * on * uNight * 0.9;
  }
  float day = 1.0 - uNight;
  float ndl = max(dot(N, uSun), 0.0);
  vec3 col = alb * (vec3(1.0, 0.95, 0.88) * ndl * 1.05 * day + vec3(0.30, 0.34, 0.42) * (0.06 + 0.94 * day)) + emit;
  float Hs = 8000.0; float hc = max(uCamAlt, 0.0);
  float fog = 1.0 - exp(-length(vW) * exp(-min(hc, 3000.0) / Hs) * uFogK);
  col = mix(col, vec3(0.56, 0.68, 0.88) * (0.05 + 0.95 * day), clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Buildings {
  constructor(loader, shared) {
    this.loader = loader;
    this.shared = shared;
    this.group = new THREE.Group();
    this.tiles = new Map();      // key -> {state, mesh, foot, latC, lonC, x, y}
    this.urlTpl = null;
    this.radius = 1;
    this.enabled = true;
    this.nightU = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uSun: shared.uSun, uCamAlt: shared.uCamAlt, uFogK: shared.uFogK, uNight: this.nightU },
      vertexShader: VERT, fragmentShader: FRAG, vertexColors: true, side: THREE.DoubleSide,
    });
    this.worker = null;
    this.jobs = new Map();
    this.jobId = 0;
    this.busy = 0;
    try {
      this.worker = new Worker(new URL('./bworker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onResult(e.data);
      this.worker.onerror = (e) => { console.warn('building worker failed', e.message); this.worker = null; };
    } catch (e) { console.warn('no module workers; buildings disabled'); }
    fetch('https://tiles.openfreemap.org/planet').then((r) => r.json()).then((j) => { this.urlTpl = j.tiles[0]; }).catch(() => {});
  }

  key(x, y) { return `${x}/${y}`; }

  // lat/lon of the camera (Earth-fixed), altitude above ground (m), earth planet for terrain heights
  update(lat, lon, agl, earth) {
    if (!this.enabled || !this.urlTpl || !this.worker) return;
    const n = 2 ** Z;
    const cx = Math.floor((lon + 180) / 360 * n), cy = Math.floor(mercY(lat) * n);
    const show = agl < 6000;
    const r = agl < 1500 ? this.radius + 1 : this.radius;
    const want = new Set();
    if (show) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = (cx + dx + n) % n, y = cy + dy;
        if (y < 0 || y >= n) continue;
        want.add(this.key(x, y));
      }
    }
    // drop far tiles
    for (const [k, t] of this.tiles) {
      const [x, y] = k.split('/').map(Number);
      if (Math.abs(x - cx) > r + 1 || Math.abs(y - cy) > r + 1 || !show) this.drop(k);
    }
    // request nearest first
    const order = [...want].filter((k) => !this.tiles.has(k)).map((k) => { const [x, y] = k.split('/').map(Number); return [Math.hypot(x - cx, y - cy), k, x, y]; }).sort((a, b) => a[0] - b[0]);
    for (const [, k, x, y] of order) {
      if (this.busy >= 2) break;
      const et = earth.tiles.get(`${Z}/${x}/${y}`);
      if (!et || et.state !== 'ready' || !et.heights) continue;   // wait for terrain so buildings sit on it
      this.request(k, x, y, et);
    }
    // keep requests alive
    for (const [k, t] of this.tiles) if (t.state === 'fetch') this.loader.get('raw', 0, t.url, 0, 5);
    this.nightU.value = this.shared.night;
  }

  request(k, x, y, et) {
    const url = this.urlTpl.replace('{z}', Z).replace('{x}', x).replace('{y}', y);
    const t = { state: 'fetch', mesh: null, foot: null, x, y, url };
    this.tiles.set(k, t);
    this.busy++;
    this.loader.get('raw', 0, url, 0, 5).then((buf) => {
      if (this.tiles.get(k) !== t) { this.busy--; return; }
      if (!buf) { this.busy--; t.state = buf === undefined ? 'retry' : 'empty'; if (buf === undefined) this.tiles.delete(k); return; }
      const id = ++this.jobId;
      t.state = 'build';
      this.jobs.set(id, { k, t });
      // copy: the loader cache keeps the original buffer
      const copy = buf.slice(0);
      this.worker.postMessage({ id, buf: copy, z: Z, x, y, heights: et.heights, N: et.N }, [copy]);
    });
  }

  onResult(m) {
    const job = this.jobs.get(m.id);
    this.jobs.delete(m.id);
    this.busy = Math.max(0, this.busy - 1);
    if (!job || this.tiles.get(job.k) !== job.t) return;
    const t = job.t;
    if (!m.ok || !m.pos.length) { t.state = 'empty'; return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.col, 3));
    g.setAttribute('aFac', new THREE.BufferAttribute(m.fac, 3));
    g.setIndex(new THREE.BufferAttribute(m.idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.position.set(m.center[0], m.center[1], m.center[2]);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    this.group.add(mesh);
    t.mesh = mesh; t.state = 'ready';
    t.latC = m.latC; t.lonC = m.lonC; t.cosC = Math.cos(m.latC * D2R);
    t.foot = parseFoot(m.foot);
  }

  drop(k) {
    const t = this.tiles.get(k);
    if (!t) return;
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    this.tiles.delete(k);
  }

  // building collision: returns roof height (m ASL) if point is inside a building volume, else null
  hit(lat, lon, h) {
    const n = 2 ** Z;
    const x = Math.floor((lon + 180) / 360 * n), y = Math.floor(mercY(lat) * n);
    const t = this.tiles.get(this.key(x, y));
    if (!t || !t.foot) return null;
    const px = (lon - t.lonC) * D2R * EARTH.R * t.cosC, py = (lat - t.latC) * D2R * EARTH.R;
    for (const b of t.foot) {
      if (h > b.top || h < b.base || px < b.x0 || px > b.x1 || py < b.y0 || py > b.y1) continue;
      if (pointInPoly(px, py, b.pts)) return b.top;
    }
    return null;
  }

  get count() { let c = 0; for (const t of this.tiles.values()) if (t.mesh) c++; return c; }
}

function parseFoot(f) {
  const out = [];
  let i = 0;
  while (i < f.length) {
    const n = f[i], base = f[i + 1], top = f[i + 2];
    const pts = f.subarray(i + 3, i + 3 + n * 2);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < n; k++) { const x = pts[k * 2], y = pts[k * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    out.push({ base, top, pts, x0, x1, y0, y1 });
    i += 3 + n * 2;
  }
  return out;
}
function pointInPoly(x, y, p) {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
