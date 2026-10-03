import * as THREE from 'three';
import { R, D2R, tileLon, tileLat, llh, toLatLon, lonLatToTile } from './geo.js';
import { SOURCES } from './tiles.js';

const MAX_Z = 14;
const SPLIT_RATIO = 0.6;     // split a tile when (tile size / distance) exceeds this
const MAX_TILES = 420;
const TERR_Z = SOURCES.terrain.maxZ;
const IMG_Z = SOURCES.imagery.maxZ;

const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _sph = new THREE.Sphere();

class Tile {
  constructor(z, x, y, parent) {
    this.z = z; this.x = x; this.y = y; this.parent = parent;
    this.key = `${z}/${x}/${y}`;
    this.state = 'idle';       // idle | loading | ready
    this.mesh = null;
    this.vis = -1;
    this.seen = 0;
    this.kids = null;
    const latC = tileLat(y + 0.5, z), lonC = tileLon(x + 0.5, z);
    this.lat = latC; this.lon = lonC;
    this.center = llh(latC, lonC, 0, new THREE.Vector3());
    const latN = tileLat(y, z), latS = tileLat(y + 1, z);
    this.size = Math.max(0.05, (R * D2R * Math.abs(latN - latS)));          // north-south extent, km
    this.radius = this.size * 0.78 + (this.size * this.size) / (4 * R) + 12;
    this.angRadius = this.radius / R;
    this.unit = this.center.clone().normalize();
  }
  children() {
    if (!this.kids) {
      const z = this.z + 1, x = this.x * 2, y = this.y * 2;
      this.kids = [new Tile(z, x, y, this), new Tile(z, x + 1, y, this), new Tile(z, x, y + 1, this), new Tile(z, x + 1, y + 1, this)];
    }
    return this.kids;
  }
}

export class Globe {
  constructor(scene, loader) {
    this.scene = scene;
    this.loader = loader;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tiles = new Map();
    this.root = new Tile(0, 0, 0, null);
    this.tiles.set(this.root.key, this.root);
    this.frame = 0;
    this.meshCount = 0;
    this.camLL = { lat: 0, lon: 0, h: 0 };
    this.stats = { drawn: 0, loaded: 0, loading: 0 };
    this.addPolarCaps();
  }

  addPolarCaps() {
    this.caps = [];
    const lim = 85.0511;
    for (const sign of [1, -1]) {
      const pos = [], idx = [];
      const N = 48;
      llh(sign * 90, 0, 0, _v); pos.push(_v.x, _v.y, _v.z);
      for (let i = 0; i < N; i++) { llh(sign * lim, (i / N) * 360 - 180, 0, _v); pos.push(_v.x, _v.y, _v.z); }
      for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + ((i + 1) % N));
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: sign > 0 ? 0xdfe8f2 : 0xe9eef4, side: THREE.DoubleSide }));
      m.frustumCulled = false;
      this.group.add(m);
      this.caps.push(m);
    }
  }

  // Height above sea level (km) under a lat/lon from the best terrain tile already in memory.
  groundHeight(lat, lon) {
    for (let z = TERR_Z; z >= 0; z--) {
      const t = lonLatToTile(lat, lon, z);
      const d = this.loader.peek('terrain', z, t.x, t.y);
      if (d) {
        const n = 2 ** z;
        const fx = ((lon + 180) / 360 * n - t.x), s = Math.sin(lat * D2R);
        const fy = ((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n - t.y);
        return Math.max(0, this.sampleBilinear(d, fx, fy)) / 1000;
      }
    }
    return 0;
  }

  sampleBilinear(d, fx, fy) {
    const w = d.size, x = Math.min(w - 1.001, Math.max(0, fx * (w - 1))), y = Math.min(w - 1.001, Math.max(0, fy * (w - 1)));
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0;
    const a = d[y0 * w + x0], b = d[y0 * w + x0 + 1], c = d[(y0 + 1) * w + x0], e = d[(y0 + 1) * w + x0 + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  }

  // ---- visibility and level of detail ----
  visible(t, camPos, camUnit, camR, frustum) {
    // horizon: tile must be within the angular range the camera can see
    const horizon = Math.acos(Math.min(1, R / camR));
    const ang = Math.acos(Math.max(-1, Math.min(1, t.unit.dot(camUnit))));
    if (ang > horizon + t.angRadius + 0.03) return false;
    _sph.center.copy(t.center).sub(camPos);
    _sph.radius = t.radius;
    return frustum.intersectsSphere(_sph);
  }

  shouldSplit(t, camPos) {
    if (t.z >= MAX_Z) return false;
    const d = Math.max(0.005, _c.copy(t.center).sub(camPos).length() - t.size * 0.5);
    return t.size / d > SPLIT_RATIO;
  }

  update(camPos, camera, frustum) {
    this.frame++;
    const camR = camPos.length();
    const camUnit = _v.copy(camPos).normalize().clone();
    this.camLL = toLatLon(camPos);
    this.visit(this.root, camPos, camUnit, camR, frustum);
    this.ensureChain(camPos);

    let drawn = 0, loaded = 0, loading = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'ready') loaded++; else if (t.state === 'loading') loading++;
      if (!t.mesh) continue;
      const on = t.vis === this.frame;
      t.mesh.visible = on;
      if (on) {
        t.seen = this.frame; drawn++;
        t.mesh.position.copy(t.center).sub(camPos);
      }
    }
    for (const m of this.caps) m.position.copy(camPos).negate();
    this.stats = { drawn, loaded, loading };
    if (this.meshCount > MAX_TILES) this.evict();
  }

  visit(t, camPos, camUnit, camR, frustum) {
    if (!this.visible(t, camPos, camUnit, camR, frustum)) return;
    t.seen = this.frame;
    if (this.shouldSplit(t, camPos)) {
      const kids = t.children();
      let allReady = true;
      for (const k of kids) {
        if (!this.tiles.has(k.key)) this.tiles.set(k.key, k);
        if (k.state === 'idle') this.start(k, camPos);
        if (k.state !== 'ready') allReady = false;
      }
      if (allReady) { for (const k of kids) this.visit(k, camPos, camUnit, camR, frustum); return; }
    }
    if (t.state === 'ready') t.vis = this.frame;
    else if (t.state === 'idle') this.start(t, camPos);
  }

  // Request every tile on the path straight down from the camera so deep levels load in parallel.
  ensureChain(camPos) {
    if (this.frame % 10 !== 0) return;
    const ll = this.camLL;
    const alt = Math.max(0.01, ll.h - this.groundHeight(ll.lat, ll.lon));
    let target = 0;
    for (let z = 1; z <= MAX_Z; z++) {
      const size = (R * Math.PI) / 2 ** z;                    // rough tile size, km
      if (size / alt > SPLIT_RATIO * 0.6) target = z; else break;
    }
    let node = this.root;
    for (let z = 1; z <= Math.min(target, MAX_Z); z++) {
      const tc = lonLatToTile(ll.lat, ll.lon, z);
      const kids = node.children();
      let next = null;
      for (const k of kids) {
        if (!this.tiles.has(k.key)) this.tiles.set(k.key, k);
        if (k.x === tc.x && k.y === tc.y) next = k;
      }
      if (!next) break;
      if (next.state === 'idle') this.start(next, camPos);
      node = next;
    }
  }

  start(t, camPos) {
    if (t.state !== 'idle') return;
    t.state = 'loading';
    const dist = _c.copy(t.center).sub(camPos).length();
    const prio = dist + t.z * 5;
    const iz = Math.min(t.z, IMG_Z), id = t.z - iz;
    const ix = t.x >> id, iy = t.y >> id;
    const tz = Math.min(t.z, TERR_Z), td = t.z - tz;
    const tx = t.x >> td, ty = t.y >> td;
    Promise.all([
      this.loader.get('imagery', iz, ix, iy, prio),
      this.loader.get('terrain', tz, tx, ty, prio),
    ]).then(([img, terr]) => {
      if (!img) { t.state = 'idle'; t.retry = (t.retry || 0) + 1; if (t.retry > 2) t.state = 'failed'; return; }
      this.build(t, img, terr, id, td);
      t.state = 'ready';
    });
  }

  build(t, img, terr, imgDepth, terrDepth) {
    const z = t.z;
    const N = z <= 2 ? 48 : z <= 6 ? 32 : 24;
    const n = 2 ** z;
    const pos = [], uv = [], idx = [];
    const stride = N + 1;
    // UV window into the imagery tile (deeper tiles reuse an ancestor image)
    const ni = 2 ** imgDepth;
    const u0 = (t.x % ni) / ni, v0 = (t.y % ni) / ni, us = 1 / ni;
    // terrain window
    const nt = 2 ** terrDepth;
    const h0x = (t.x % nt) / nt, h0y = (t.y % nt) / nt, hs = 1 / nt;
    const vtx = new THREE.Vector3();
    const skirt = Math.max(0.04, t.size * 0.025);
    for (let j = 0; j <= N; j++) {
      const lat = tileLat(t.y + j / N, z);
      for (let i = 0; i <= N; i++) {
        const lon = tileLon(t.x + i / N, z);
        let h = 0;
        if (terr) h = Math.max(0, this.sampleBilinear(terr, h0x + (i / N) * hs, h0y + (j / N) * hs)) / 1000;
        llh(lat, lon, h, vtx).sub(t.center);
        pos.push(vtx.x, vtx.y, vtx.z);
        uv.push(u0 + (i / N) * us, v0 + (j / N) * us);
      }
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    // skirts hide cracks between tiles of different detail
    const base = pos.length / 3;
    const edge = [];
    for (let i = 0; i <= N; i++) edge.push(i);                       // top row
    for (let j = 1; j <= N; j++) edge.push(j * stride + N);          // right col
    for (let i = N - 1; i >= 0; i--) edge.push(N * stride + i);      // bottom row
    for (let j = N - 1; j >= 1; j--) edge.push(j * stride);          // left col
    const cnt = edge.length;
    for (let k = 0; k < cnt; k++) {
      const vi = edge[k] * 3;
      vtx.set(pos[vi], pos[vi + 1], pos[vi + 2]).add(t.center);
      const len = vtx.length();
      vtx.multiplyScalar((len - skirt) / len).sub(t.center);
      pos.push(vtx.x, vtx.y, vtx.z);
      uv.push(uv[edge[k] * 2], uv[edge[k] * 2 + 1]);
    }
    for (let k = 0; k < cnt; k++) {
      const k2 = (k + 1) % cnt;
      idx.push(edge[k], base + k, edge[k2], edge[k2], base + k, base + k2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), t.radius);
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = 4;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    mesh.visible = false;
    t.mesh = mesh;
    this.meshCount++;
    this.group.add(mesh);
  }

  evict() {
    const all = [...this.tiles.values()].filter((t) => t.mesh && t.z > 3 && this.frame - t.seen > 120);
    all.sort((a, b) => a.seen - b.seen);
    let remove = this.meshCount - MAX_TILES + 40;
    for (const t of all) {
      if (remove <= 0) break;
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.map.dispose();
      t.mesh.material.dispose();
      t.mesh = null;
      t.state = 'idle';
      this.meshCount--;
      remove--;
    }
  }
}
