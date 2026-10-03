// Streamed quadtree terrain for a spherical body (Earth: Web Mercator tiles, Moon: equirectangular tiles).
// Tiles are built in body-fixed coordinates; the body group is placed relative to the camera each frame
// (floating origin) so all GPU coordinates stay small.

import * as THREE from 'three';
import { D2R, R2D, tileLat, tileLon, mercY, llh, clamp } from '../core/geo.js';

const _v = new THREE.Vector3(), _c = new THREE.Vector3(), _u = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _m4 = new THREE.Matrix4();

// ---------------- shaders ----------------
const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aH;
uniform vec3 uCenter;
varying vec2 vUv; varying vec3 vN; varying vec3 vSN; varying vec3 vW; varying float vH;
void main(){
  vUv = uv; vH = aH;
  mat3 R = mat3(modelMatrix);
  vN = R * normal;
  vSN = R * normalize(uCenter + position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FRAG_EARTH = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map; uniform sampler2D nightMap;
uniform vec3 uImg; uniform vec3 uNight; uniform float uHasNight;
uniform vec3 uSun; uniform float uCamAlt; uniform float uFogK; uniform float uNightK; uniform float uDebug;
varying vec2 vUv; varying vec3 vN; varying vec3 vSN; varying vec3 vW; varying float vH;
void main(){
  #include <logdepthbuf_fragment>
  vec3 alb = texture2D(map, uImg.xy + vUv * uImg.z).rgb;
  vec3 N = normalize(vN), SN = normalize(vSN), V = normalize(-vW);
  float sd = dot(SN, uSun);
  float ndl = max(dot(N, uSun), 0.0);
  float lit = mix(max(sd, 0.0), ndl, 0.55);
  float day = smoothstep(-0.10, 0.10, sd);
  vec3 sunCol = mix(vec3(1.0, 0.52, 0.28), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.3, sd));
  vec3 col = alb * sunCol * (1.18 * pow(lit, 0.62)) * smoothstep(-0.05, 0.08, sd) + alb * 0.012;
  if (vH < -0.5) {
    vec3 Hh = normalize(uSun + V);
    col += sunCol * pow(max(dot(N, Hh), 0.0), 120.0) * 0.55 * day;
  }
  if (uHasNight > 0.5) {
    vec3 nl = texture2D(nightMap, uNight.xy + vUv * uNight.z).rgb;
    col += nl * nl * vec3(1.0, 0.82, 0.55) * 1.6 * (1.0 - smoothstep(-0.15, 0.02, sd)) * uNightK;
  }
  float Hs = 8000.0;
  float hc = max(uCamAlt, 0.0), hf = max(vH, 0.0), dh = hc - hf;
  float dens = abs(dh) < 100.0 ? exp(-hf / Hs) : Hs * (exp(-hf / Hs) - exp(-hc / Hs)) / dh;
  float fog = 1.0 - exp(-length(vW) * dens * uFogK);
  vec3 haze = mix(vec3(1.0, 0.55, 0.32), vec3(0.56, 0.68, 0.88), smoothstep(0.0, 0.35, sd)) * smoothstep(-0.18, 0.12, sd);
  col = mix(col, haze, clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const FRAG_MOON = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map; uniform vec3 uImg; uniform vec3 uSun; uniform float uEarthshine;
varying vec2 vUv; varying vec3 vN; varying vec3 vSN; varying vec3 vW; varying float vH;
void main(){
  #include <logdepthbuf_fragment>
  vec3 alb = texture2D(map, uImg.xy + vUv * uImg.z).rgb;
  vec3 N = normalize(vN), SN = normalize(vSN);
  float ndl = max(dot(N, uSun), 0.0);
  float sd = dot(SN, uSun);
  float lit = mix(max(sd, 0.0), ndl, 0.8);
  vec3 col = alb * 1.45 * lit * smoothstep(-0.02, 0.04, sd) + alb * uEarthshine;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// ---------------- tiles ----------------
class Tile {
  constructor(planet, z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent;
    this.key = `${z}/${x}/${y}`;
    this.state = 'idle';
    this.mesh = null; this.heights = null; this.N = 0;
    this.vis = -1; this.seen = 0; this.kids = null; this.tries = 0;
    const b = planet.bounds(z, x, y);
    this.latN = b.latN; this.latS = b.latS; this.lonW = b.lonW; this.lonE = b.lonE;
    this.lat = (b.latN + b.latS) / 2; this.lon = (b.lonW + b.lonE) / 2;
    this.center = llh(planet.midLat(this), this.lon, 0, planet.R, new THREE.Vector3());
    const R = planet.R;
    const ns = R * D2R * (b.latN - b.latS);
    const ew = R * D2R * (b.lonE - b.lonW) * Math.cos(Math.min(Math.abs(b.latN), Math.abs(b.latS)) * D2R);
    this.size = Math.max(ns, ew, 1);
    this.radius = Math.hypot(ns, ew) * 0.5 + (this.size * this.size) / (4 * R) + planet.maxRelief;
    this.angRadius = Math.min(Math.PI, this.radius / R);
    this.unit = this.center.clone().normalize();
  }
  contains(lat, lon) { return lat <= this.latN && lat >= this.latS && lon >= this.lonW && lon <= this.lonE; }
}

export class Planet {
  constructor(opts) {
    this.body = opts.body;
    this.R = opts.body.R;
    this.loader = opts.loader;
    this.kind = opts.kind;            // 'earth' | 'moon'
    this.maxZ = opts.maxZ;
    this.maxRelief = opts.maxRelief;
    this.shared = opts.shared;        // shared uniform objects
    this.flatten = null;              // (tile, lat, lon, h, cell) -> h   (runway flattening)
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    this.tiles = new Map();
    this.roots = [];
    this.frame = 0;
    this.meshCount = 0;
    this.maxTiles = opts.maxTiles || 380;
    this.splitRatio = opts.splitRatio || 0.6;
    this.stats = { drawn: 0, loading: 0 };
    this.texCache = new Map();
    this.camFixed = new THREE.Vector3();
    this.frustum = new THREE.Frustum();
    this.enabled = true;
    this.whiteTex = makeSolidTex(opts.capColor || '#e8eef5');
    const rootsX = this.kind === 'moon' ? 2 : 1;
    for (let x = 0; x < rootsX; x++) { const t = new Tile(this, 0, x, 0, null); this.tiles.set(t.key, t); this.roots.push(t); }
    if (this.kind === 'earth') this.addPolarCaps();
  }

  // ---- tiling scheme ----
  bounds(z, x, y) {
    if (this.kind === 'earth') return { latN: tileLat(y, z), latS: tileLat(y + 1, z), lonW: tileLon(x, z), lonE: tileLon(x + 1, z) };
    const s = 180 / 2 ** z;
    return { latN: 90 - y * s, latS: 90 - (y + 1) * s, lonW: -180 + x * s, lonE: -180 + (x + 1) * s };
  }
  midLat(t) { return this.kind === 'earth' ? tileLat(t.y + 0.5, t.z) : (t.latN + t.latS) / 2; }
  vertexLat(t, j, N) { return this.kind === 'earth' ? tileLat(t.y + j / N, t.z) : t.latN + (t.latS - t.latN) * (j / N); }
  // fractional position (0..1) of lat/lon inside tile, matching vertex spacing
  frac(t, lat, lon) {
    const fx = (lon - t.lonW) / (t.lonE - t.lonW);
    let fy;
    if (this.kind === 'earth') { const n = 2 ** t.z; fy = mercY(lat) * n - t.y; }
    else fy = (t.latN - lat) / (t.latN - t.latS);
    return [fx, fy];
  }
  tileAt(z, lat, lon) {
    const n = 2 ** z;
    let x, y;
    if (this.kind === 'earth') { x = Math.floor((lon + 180) / 360 * n); y = Math.floor(mercY(lat) * n); }
    else { x = Math.floor((lon + 180) / 180 * n); y = Math.floor((90 - lat) / 180 * n); }
    const nx = this.kind === 'earth' ? n : 2 * n;
    return { x: clamp(x, 0, nx - 1), y: clamp(y, 0, n - 1) };
  }

  addPolarCaps() {
    this.caps = [];
    const lim = 85.0511;
    for (const sign of [1, -1]) {
      const pos = [], idx = [], nor = [], uv = [], hh = [];
      const N = 64;
      llh(sign * 90, 0, 0, this.R, _v); pos.push(_v.x, _v.y, _v.z); _v.normalize(); nor.push(_v.x, _v.y, _v.z); uv.push(0.5, 0.5); hh.push(1);
      for (let i = 0; i < N; i++) {
        llh(sign * lim, (i / N) * 360 - 180, -200, this.R, _v); pos.push(_v.x, _v.y, _v.z); _v.normalize(); nor.push(_v.x, _v.y, _v.z); uv.push(0.5, 0.5); hh.push(1);
      }
      for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + ((i + 1) % N));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aH', new THREE.Float32BufferAttribute(hh, 1));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, this.material(this.whiteTex, [0, 0, 1], null, null, new THREE.Vector3()));
      m.material.side = THREE.DoubleSide;
      m.frustumCulled = false;
      this.group.add(m);
      this.caps.push(m);
    }
  }

  material(tex, win, ntex, nwin, center) {
    const s = this.shared;
    const u = {
      map: { value: tex }, uImg: { value: new THREE.Vector3(...win) }, uCenter: { value: center.clone() },
      uSun: s.uSun,
    };
    if (this.kind === 'earth') {
      Object.assign(u, {
        nightMap: { value: ntex || this.whiteTex }, uNight: { value: new THREE.Vector3(...(nwin || [0, 0, 1])) }, uHasNight: { value: ntex ? 1 : 0 },
        uCamAlt: s.uCamAlt, uFogK: s.uFogK, uNightK: s.uNightK, uDebug: s.uDebug,
      });
    } else u.uEarthshine = s.uEarthshine;
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: VERT, fragmentShader: this.kind === 'earth' ? FRAG_EARTH : FRAG_MOON });
  }

  // ---- texture sharing ----
  acquireTex(key, bmp) {
    let e = this.texCache.get(key);
    if (!e) {
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.shared.anisotropy || 4;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      e = { tex, refs: 0, bmp };
      this.texCache.set(key, e);
    }
    e.refs++;
    return e.tex;
  }
  releaseTex(key) {
    const e = this.texCache.get(key);
    if (!e) return;
    if (--e.refs <= 0) {
      e.tex.dispose();
      this.texCache.delete(key);
      this.loader.cache.delete(key);
      if (e.bmp && e.bmp.close) try { e.bmp.close(); } catch (er) { /* ignore */ }
    }
  }

  // ---- per-frame update ----
  // camFixed: camera position in body-fixed coords. viewProjFixed: projection*view*bodyMatrix (for frustum in fixed coords)
  update(camFixed, viewProjFixed, active) {
    this.frame++;
    this.camFixed.copy(camFixed);
    this.frustum.setFromProjectionMatrix(viewProjFixed);
    const camR = camFixed.length();
    _u.copy(camFixed).normalize();
    const camUnit = _u.clone();
    if (active) {
      for (const r of this.roots) this.visit(r, camFixed, camUnit, camR);
      if (this.frame % 2 === 0) this.ensureChain(camFixed);
    } else {
      for (const r of this.roots) this.visitCoarse(r, camFixed, camUnit, camR);
    }
    let drawn = 0, loading = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'loading') loading++;
      if (!t.mesh) continue;
      const on = t.vis === this.frame;
      t.mesh.visible = on;
      if (on) { t.seen = this.frame; drawn++; }
      if (t.patches.size) for (const [k, m] of t.patches) {
        const po = m.userData.vis === this.frame && !on;
        m.visible = po;
        if (po) { t.seen = this.frame; drawn++; }
        else if (this.frame - m.userData.vis > 300) { this.group.remove(m); m.geometry.dispose(); t.patches.delete(k); }
      }
    }
    this.stats.drawn = drawn; this.stats.loading = loading;
    if (this.meshCount > this.maxTiles) this.evict();
  }

  visible(t, camPos, camUnit, camR) {
    const horizon = Math.acos(Math.min(1, this.R / camR)) + Math.acos(Math.min(1, this.R / (this.R + this.maxRelief)));
    const ang = Math.acos(clamp(t.unit.dot(camUnit), -1, 1));
    if (ang > horizon + t.angRadius + 0.02) return false;
    _sph.center.copy(t.center); _sph.radius = t.radius;
    return this.frustum.intersectsSphere(_sph);
  }

  shouldSplit(t, camPos) {
    if (t.z >= this.maxZ) return false;
    const d = Math.max(1, _c.copy(t.center).sub(camPos).length() - t.radius * 0.5);
    return t.size / d > this.splitRatio;
  }

  visit(t, camPos, camUnit, camR) {
    const res = this.cover(t, camPos, camUnit, camR);
    for (const d of res.draws) {
      if (d.p === undefined) d.t.vis = this.frame;
      else this.patchMesh(d.t, d.p).userData.vis = this.frame;
    }
  }

  // Returns {draws, holes}: meshes covering tile t, plus regions nothing could cover yet.
  // A loaded ancestor fills holes with a sub-patch of its own mesh, so detail appears as soon as it streams in.
  cover(t, camPos, camUnit, camR) {
    if (!this.visible(t, camPos, camUnit, camR)) return { draws: [], holes: [] };
    t.seen = this.frame;
    if (this.shouldSplit(t, camPos)) {
      const kids = this.children(t);
      const draws = [], holes = [];
      for (const k of kids) {
        if (k.state === 'ready' || k.kids) {
          const r = this.cover(k, camPos, camUnit, camR);
          draws.push(...r.draws); holes.push(...r.holes);
          if (k.state !== 'ready') { if (k.state === 'idle') this.start(k, camPos); else if (k.state === 'loading') this.touch(k); }
        } else {
          if (k.state === 'idle') this.start(k, camPos); else if (k.state === 'loading') this.touch(k);
          if (this.visible(k, camPos, camUnit, camR)) holes.push(k);
        }
      }
      if (t.state === 'ready' && holes.length) {
        for (const h of holes) draws.push({ t, p: this.patchKey(t, h) });
        return { draws, holes: [] };
      }
      if (t.state !== 'ready') { if (t.state === 'idle') this.start(t, camPos); else if (t.state === 'loading') this.touch(t); }
      return { draws, holes };
    }
    if (t.state === 'ready') return { draws: [{ t }], holes: [] };
    if (t.state === 'idle') this.start(t, camPos); else if (t.state === 'loading') this.touch(t);
    return { draws: [], holes: [t] };
  }

  // sub-square of tile t covering descendant h (clamped to the finest the grid allows)
  patchKey(t, h) {
    let d = h.z - t.z, x = h.x, y = h.y;
    const maxD = Math.round(Math.log2(t.N));
    while (d > maxD) { d--; x >>= 1; y >>= 1; }
    const ox = x - (t.x << d), oy = y - (t.y << d);
    return `${d}/${ox}/${oy}`;
  }
  patchMesh(t, key) {
    let m = t.patches.get(key);
    if (m) return m;
    const [d, ox, oy] = key.split('/').map(Number);
    const N = t.N, st = N + 1, size = N >> d;
    const i0 = ox * size, j0 = oy * size, i1 = i0 + size, j1 = j0 + size;
    const idx = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const p = j * st + i, q = p + 1, r = p + st, s2 = r + 1;
      idx.push(p, r, q, q, r, s2);
    }
    // skirt segments on the tile's outer edges that lie inside this patch
    const edge = t.edge, nv = st * st, cnt = edge.length;
    for (let e = 0; e < cnt; e++) {
      const e2 = (e + 1) % cnt;
      const ka = edge[e], kb = edge[e2];
      const ia = ka % st, ja = (ka / st) | 0, ib = kb % st, jb = (kb / st) | 0;
      if (Math.min(ia, ib) >= i0 && Math.max(ia, ib) <= i1 && Math.min(ja, jb) >= j0 && Math.max(ja, jb) <= j1) idx.push(ka, nv + e, kb, kb, nv + e, nv + e2);
    }
    const g = new THREE.BufferGeometry();
    const src = t.mesh.geometry;
    for (const name of ['position', 'normal', 'uv', 'aH']) g.setAttribute(name, src.getAttribute(name));
    g.setIndex(idx);
    g.boundingSphere = src.boundingSphere;
    m = new THREE.Mesh(g, t.mesh.material);
    m.position.copy(t.center); m.frustumCulled = false; m.visible = false; m.matrixAutoUpdate = false; m.updateMatrix();
    m.userData.vis = -1;
    this.group.add(m);
    t.patches.set(key, m);
    return m;
  }

  // inactive body (e.g. the Moon seen from Earth): draw a few coarse tiles only
  visitCoarse(t, camPos, camUnit, camR) {
    if (t.z >= 2 || !this.shouldSplit(t, camPos)) {
      if (t.state === 'ready') t.vis = this.frame; else if (t.state === 'idle') this.start(t, camPos); else this.touch(t);
      return;
    }
    const kids = this.children(t);
    if (kids.every((k) => k.state === 'ready')) { for (const k of kids) this.visitCoarse(k, camPos, camUnit, camR); }
    else {
      for (const k of kids) if (k.state === 'idle') this.start(k, camPos);
      if (t.state === 'ready') t.vis = this.frame; else if (t.state === 'idle') this.start(t, camPos);
    }
  }

  children(t) {
    if (!t.kids) {
      const z = t.z + 1, x = t.x * 2, y = t.y * 2;
      t.kids = [new Tile(this, z, x, y, t), new Tile(this, z, x + 1, y, t), new Tile(this, z, x, y + 1, t), new Tile(this, z, x + 1, y + 1, t)];
      for (const k of t.kids) this.tiles.set(k.key, k);
    }
    return t.kids;
  }

  // request every tile on the path straight down so deep levels load in parallel with the LOD walk
  ensureChain(camPos) {
    const ll = this.camLL(camPos);
    const ground = this.heightAt(ll.lat, ll.lon).h;
    const alt = Math.max(5, ll.h - ground);
    let node = this.roots[this.kind === 'moon' ? (ll.lon < 0 ? 0 : 1) : 0];
    for (let z = 1; z <= this.maxZ; z++) {
      const size = (this.R * Math.PI) / 2 ** z;
      if (size / alt < this.splitRatio * 0.7) break;
      const tc = this.tileAt(z, ll.lat, ll.lon);
      const kids = this.children(node);
      const next = kids.find((k) => k.x === tc.x && k.y === tc.y);
      if (!next) break;
      if (next.state === 'idle') this.start(next, camPos, -1e7);
      else if (next.state === 'loading') this.touch(next);
      node = next;
    }
  }

  camLL(p) {
    const r = p.length();
    return { lat: Math.asin(clamp(p.y / r, -1, 1)) * R2D, lon: Math.atan2(-p.z, p.x) * R2D, h: r - this.R };
  }

  touch(t) { if (t._req) for (const r of t._req) this.loader.get(...r); }

  // ---- loading and building ----
  start(t, camPos, bias = 0) {
    if (t.state !== 'idle') return;
    t.state = 'loading';
    const dist = _c.copy(t.center).sub(camPos).length();
    const prio = dist / 1000 + t.z * 2 + bias / 1000;
    if (this.kind === 'earth') {
      const iz = Math.min(t.z, 13), id = t.z - iz;
      const dz = Math.min(t.z, 12), dd = t.z - dz;
      const reqs = [['img', iz, t.x >> id, t.y >> id, prio], ['dem', dz, t.x >> dd, t.y >> dd, prio]];
      t._req = reqs;
      Promise.all(reqs.map((r) => this.loader.get(...r))).then(([img, dem]) => {
        if (t.state !== 'loading') return;
        if (img === undefined || dem === undefined) { t.state = 'idle'; return; }     // dropped as stale
        if (!img) { t.tries++; t.state = t.tries > 2 ? 'failed' : 'idle'; return; }
        try { this.buildEarth(t, img, dem, id, dd); t.state = 'ready'; } catch (e) { console.error('tile build', t.key, e); t.state = 'failed'; }
        t._req = null;
      });
    } else {
      const iz = Math.min(t.z, 8), id = t.z - iz;
      const reqs = [['moon', iz, t.x >> id, t.y >> id, prio]];
      const chunk = this.moonChunkFor(t);
      if (chunk) reqs.push(['moonh', 0, chunk, 0, prio]);
      t._req = reqs;
      Promise.all(reqs.map((r) => this.loader.get(...r))).then(([img, hm]) => {
        if (t.state !== 'loading') return;
        if (img === undefined || hm === undefined) { t.state = 'idle'; return; }
        if (!img) { t.tries++; t.state = t.tries > 2 ? 'failed' : 'idle'; return; }
        try { this.buildMoon(t, img, hm, id); t.state = 'ready'; } catch (e) { console.error('moon tile', t.key, e); t.state = 'failed'; }
        t._req = null;
      });
    }
  }

  gridN(z) { return z <= 3 ? 64 : 32; }

  // shared mesh builder: hFn(lat, lon, i, j) -> metres
  buildMesh(t, N, hFn, texKey, tex, win, ntexKey, ntex, nwin) {
    const stride = N + 1, nv = stride * stride;
    const heights = new Float32Array(nv);
    const rawH = new Float32Array(nv);
    const pos = new Float32Array((nv + 4 * N) * 3);
    const uv = new Float32Array((nv + 4 * N) * 2);
    const hh = new Float32Array(nv + 4 * N);
    const lats = new Float64Array(stride), lons = new Float64Array(stride);
    for (let j = 0; j <= N; j++) lats[j] = this.vertexLat(t, j, N);
    for (let i = 0; i <= N; i++) lons[i] = t.lonW + (t.lonE - t.lonW) * (i / N);
    for (let j = 0, k = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++, k++) {
        const raw = hFn(lats[j], lons[i], i, j);
        const h = this.kind === 'earth' ? Math.max(0, raw) : raw;
        heights[k] = h;
        rawH[k] = raw;
        llh(lats[j], lons[i], h, this.R, _v).sub(t.center);
        pos[k * 3] = _v.x; pos[k * 3 + 1] = _v.y; pos[k * 3 + 2] = _v.z;
        uv[k * 2] = i / N; uv[k * 2 + 1] = j / N;
        hh[k] = raw;
      }
    }
    // normals from the grid
    const nor = new Float32Array(pos.length);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      const k = j * stride + i;
      const il = Math.max(0, i - 1), ir = Math.min(N, i + 1), ju = Math.max(0, j - 1), jd = Math.min(N, j + 1);
      const kl = j * stride + il, kr = j * stride + ir, ku = ju * stride + i, kd = jd * stride + i;
      a.set(pos[kr * 3] - pos[kl * 3], pos[kr * 3 + 1] - pos[kl * 3 + 1], pos[kr * 3 + 2] - pos[kl * 3 + 2]);
      b.set(pos[kd * 3] - pos[ku * 3], pos[kd * 3 + 1] - pos[ku * 3 + 1], pos[kd * 3 + 2] - pos[ku * 3 + 2]);
      n.crossVectors(b, a);
      if (n.lengthSq() < 1e-12) { n.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]).add(t.center); }
      n.normalize();
      // orient outward
      _c.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]).add(t.center);
      if (n.dot(_c) < 0) n.negate();
      nor[k * 3] = n.x; nor[k * 3 + 1] = n.y; nor[k * 3 + 2] = n.z;
    }
    const idx = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p = j * stride + i, q = p + 1, r = p + stride, s = r + 1;
      idx.push(p, r, q, q, r, s);
    }
    // skirts
    const edge = [];
    for (let i = 0; i <= N; i++) edge.push(i);
    for (let j = 1; j <= N; j++) edge.push(j * stride + N);
    for (let i = N - 1; i >= 0; i--) edge.push(N * stride + i);
    for (let j = N - 1; j >= 1; j--) edge.push(j * stride);
    const skirt = Math.max(30, t.size * 0.03);
    for (let e = 0; e < edge.length; e++) {
      const k = edge[e], o = nv + e;
      _v.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]).add(t.center);
      const len = _v.length();
      _v.multiplyScalar((len - skirt) / len).sub(t.center);
      pos[o * 3] = _v.x; pos[o * 3 + 1] = _v.y; pos[o * 3 + 2] = _v.z;
      nor[o * 3] = nor[k * 3]; nor[o * 3 + 1] = nor[k * 3 + 1]; nor[o * 3 + 2] = nor[k * 3 + 2];
      uv[o * 2] = uv[k * 2]; uv[o * 2 + 1] = uv[k * 2 + 1];
      hh[o] = hh[k];
    }
    const cnt = edge.length;
    for (let e = 0; e < cnt; e++) {
      const e2 = (e + 1) % cnt;
      idx.push(edge[e], nv + e, edge[e2], edge[e2], nv + e, nv + e2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aH', new THREE.BufferAttribute(hh, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius);
    const mat = this.material(tex, win, ntex, nwin, t.center);
    mat.side = THREE.FrontSide;
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.copy(t.center);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    t.edge = edge;
    t.patches = new Map();
    t.mesh = mesh; t.heights = heights; t.raw = rawH; t.N = N;
    t.texKey = texKey; t.ntexKey = ntexKey;
    this.meshCount++;
    this.group.add(mesh);
  }

  buildEarth(t, img, dem, id, dd) {
    const N = this.flatten && t.z >= 11 && this.flatten.has(t) ? 64 : this.gridN(t.z);
    const nt = 2 ** dd, h0x = (t.x % nt) / nt, h0y = (t.y % nt) / nt, hs = 1 / nt;
    const cell = t.size / N;
    const flat = this.flatten && t.z >= 11 ? this.flatten.list(t) : null;
    const hFn = (lat, lon, i, j) => {
      let h = dem ? sampleBilinear(dem, h0x + (i / N) * hs, h0y + (j / N) * hs) : 0;
      if (flat && flat.length) { const f = this.flatten.apply(flat, lat, lon, Math.max(0, h), cell); if (f !== Math.max(0, h)) h = f; }
      return h;
    };
    const iz = t.z - id, ni = 2 ** id;
    const imgKey = `img/${iz}/${t.x >> id}/${t.y >> id}`;
    const tex = this.acquireTex(imgKey, img);
    const win = [(t.x % ni) / ni, (t.y % ni) / ni, 1 / ni];
    // night lights: use cached tile if present (z<=8), fetched lazily below
    const nz = Math.min(t.z, 8), nd = t.z - nz, nn = 2 ** nd;
    const nKey = `night/${nz}/${t.x >> nd}/${t.y >> nd}`;
    const nb = this.loader.peek('night', nz, t.x >> nd, t.y >> nd);
    let ntex = null, nwin = null;
    if (nb) { ntex = this.acquireTex(nKey, nb); nwin = [(t.x % nn) / nn, (t.y % nn) / nn, 1 / nn]; }
    this.buildMesh(t, N, hFn, imgKey, tex, win, ntex ? nKey : null, ntex, nwin);
    if (!nb) {
      this.loader.get('night', nz, t.x >> nd, t.y >> nd, 50 + t.z).then((b) => {
        if (!b || !t.mesh || t.ntexKey) return;
        const tx = this.acquireTex(nKey, b);
        const u = t.mesh.material.uniforms;
        u.nightMap.value = tx; u.uNight.value.set((t.x % nn) / nn, (t.y % nn) / nn, 1 / nn); u.uHasNight.value = 1;
        t.ntexKey = nKey;
      });
    }
  }

  moonChunkFor(t) {
    if (t.z < 2) return 'global';
    const i = Math.floor((t.lon + 180) / 45), j = Math.floor((90 - t.lat) / 45);
    return `${clamp(j, 0, 3)}_${clamp(i, 0, 7)}`;
  }

  moonHeight(hm, lat, lon, lat0, lon0) {
    if (!hm) return 0;
    if (hm.w === 720) return sampleGrid(hm, (lon + 180) * 2 - 0.5, (90 - lat) * 2 - 0.5);   // global 2 ppd
    // 45x45 degree chunk at 16 ppd with one overlap pixel
    return sampleGrid(hm, (lon - lon0) * 16, (lat0 - lat) * 16);
  }

  buildMoon(t, img, hm, id) {
    const N = this.gridN(t.z);
    const ci = clamp(Math.floor((t.lon + 180) / 45), 0, 7), cj = clamp(Math.floor((90 - t.lat) / 45), 0, 3);
    const lon0 = -180 + ci * 45, lat0 = 90 - cj * 45;
    const hFn = (lat, lon) => this.moonHeight(hm, lat, lon, lat0, lon0);
    const ni = 2 ** id;
    const imgKey = `moon/${t.z - id}/${t.x >> id}/${t.y >> id}`;
    const tex = this.acquireTex(imgKey, img);
    this.buildMesh(t, N, hFn, imgKey, tex, [(t.x % ni) / ni, (t.y % ni) / ni, 1 / ni], null, null, null);
  }

  // ---- height queries (match the rendered mesh exactly) ----
  heightAt(lat, lon) {
    let node = null;
    for (const r of this.roots) if (r.contains(lat, lon)) { node = r; break; }
    let best = null;
    while (node) {
      if (node.state === 'ready' && node.heights) best = node;
      if (!node.kids) break;
      let next = null;
      for (const k of node.kids) if (k.contains(lat, lon)) { next = k; break; }
      node = next;
    }
    if (!best) return { h: 0, z: -1 };
    return { h: this.sampleTile(best, lat, lon), z: best.z };
  }
  waterAt(lat, lon) {
    let node = null;
    for (const r of this.roots) if (r.contains(lat, lon)) { node = r; break; }
    let best = null;
    while (node) {
      if (node.state === 'ready' && node.raw) best = node;
      if (!node.kids) break;
      let next = null;
      for (const k of node.kids) if (k.contains(lat, lon)) { next = k; break; }
      node = next;
    }
    if (!best) return false;
    const N = best.N;
    let [fx, fy] = this.frac(best, lat, lon);
    const i = clamp(Math.round(fx * N), 0, N), j = clamp(Math.round(fy * N), 0, N);
    return best.raw[j * (N + 1) + i] < -0.5;
  }
  sampleTile(t, lat, lon) {
    const N = t.N, H = t.heights;
    let [fx, fy] = this.frac(t, lat, lon);
    fx = clamp(fx * N, 0, N - 1e-6); fy = clamp(fy * N, 0, N - 1e-6);
    const i = fx | 0, j = fy | 0, s = fx - i, u = fy - j, st = N + 1;
    const ha = H[j * st + i], hb = H[j * st + i + 1], hc = H[(j + 1) * st + i], hd = H[(j + 1) * st + i + 1];
    if (s + u <= 1) return ha + (hb - ha) * s + (hc - ha) * u;
    return hd + (hc - hd) * (1 - s) + (hb - hd) * (1 - u);
  }

  evict() {
    const cand = [];
    for (const t of this.tiles.values()) if (t.mesh && t.z > 2 && this.frame - t.seen > 60) cand.push(t);
    cand.sort((a, b) => a.seen - b.seen);
    let remove = this.meshCount - this.maxTiles + 30;
    for (const t of cand) {
      if (remove-- <= 0) break;
      this.dropTile(t);
    }
    // forget deep untouched subtrees entirely so the tile map does not grow without bound
    if (this.frame % 600 === 0) {
      for (const t of [...this.tiles.values()]) {
        if (t.z > 3 && !t.mesh && t.state !== 'loading' && this.frame - t.seen > 1200 && t.parent && t.parent.kids) {
          if (t.parent.kids.every((k) => !k.mesh && k.state !== 'loading' && !k.kids)) {
            for (const k of t.parent.kids) this.tiles.delete(k.key);
            t.parent.kids = null;
          }
        }
      }
    }
  }
  dropTile(t) {
    if (!t.mesh) return;
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh.material.dispose();
    if (t.patches) { for (const m of t.patches.values()) { this.group.remove(m); m.geometry.dispose(); } t.patches.clear(); }
    this.releaseTex(t.texKey);
    if (t.ntexKey) this.releaseTex(t.ntexKey);
    t.mesh = null; t.heights = null; t.state = 'idle'; t.ntexKey = null;
    this.meshCount--;
  }
  // rebuild tiles intersecting a region (used when runways load after tiles)
  invalidate(pred) {
    for (const t of this.tiles.values()) if (t.mesh && t.z >= 11 && pred(t)) this.dropTile(t);
  }
}

export function sampleBilinear(d, fx, fy) {
  const w = d.size;
  const x = clamp(fx * (w - 1), 0, w - 1.001), y = clamp(fy * (w - 1), 0, w - 1.001);
  const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
  const a = d[y0 * w + x0], b = d[y0 * w + x0 + 1], c = d[(y0 + 1) * w + x0], e = d[(y0 + 1) * w + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}
function sampleGrid(d, x, y) {
  const w = d.w, h = d.h;
  x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
  const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
  const a = d[y0 * w + x0], b = d[y0 * w + x0 + 1], c = d[(y0 + 1) * w + x0], e = d[(y0 + 1) * w + x0 + 1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
}

function makeSolidTex(css) {
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const g = c.getContext('2d'); g.fillStyle = css; g.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
