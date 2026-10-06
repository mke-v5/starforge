// Clouds you can fly through. From high up the weather is painted on the globe (planet.js); below about 10 km
// the same pattern is built here as heaps of soft, sunlit billboards on a lat/lon grid around the camera —
// cumulus decks between ~1.5 and 3 km where the weather says cloudy, thinner where it is fair. Flying into one
// fills the view with white.

import * as THREE from 'three';
import { clamp, smoothstep, D2R } from '../core/geo.js';

// ---- 3-D simplex noise (Ashima / Stefan Gustavson), the same function the globe shader uses ----
const grad3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);
const perm = new Uint8Array(512);
{ const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i; let s = 1234567; for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
function snoise(x, y, z) {
  const F3 = 1 / 3, G3 = 1 / 6;
  const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3, x0 = x - i + t, y0 = y - j + t, z0 = z - k + t;
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) { if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; } else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; } }
  else { if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; } else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; } else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3, x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3, x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  const c = (gi, xx, yy, zz) => { let tt = 0.6 - xx * xx - yy * yy - zz * zz; if (tt < 0) return 0; tt *= tt; const g = (gi % 12) * 3; return tt * tt * (grad3[g] * xx + grad3[g + 1] * yy + grad3[g + 2] * zz); };
  return 32 * (c(perm[ii + perm[jj + perm[kk]]], x0, y0, z0) + c(perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1) + c(perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2) + c(perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3));
}

// Cloud cover (0..1) at an Earth-fixed unit direction, following the globe's weather belts (cf. clouds() in
// planet.js): the cloudy tropics, clear subtropics, stormy mid-latitudes. u = uCloud (fade, cos, sin, time).
export function cloudCover(px, py, pz, u, oct = 6) {
  const lat = Math.asin(clamp(py, -1, 1)) / D2R, al = Math.abs(lat);
  let qx = (px * u.y - pz * u.z) * 2.6, qy = py * 2.6, qz = (px * u.z + pz * u.y) * 2.6 + u.w;
  const sw = 0.55 + 0.25 * smoothstep(30, 60, al);
  const wx = snoise(qx * 0.7, qy * 0.7, qz * 0.7), wy = snoise(qx * 0.7 + 17.3, qy * 0.7 + 17.3, qz * 0.7 + 17.3), wz = snoise(qx * 0.7 - 9.1, qy * 0.7 - 9.1, qz * 0.7 - 9.1);
  qx += wx * sw; qy += wy * sw; qz += wz * sw;
  let f = 0, a = 0.5, fr = 1;
  for (let i = 0; i < oct; i++) { f += a * snoise(qx * fr, qy * fr, qz * fr); fr *= 2.07; a *= i < 3 ? 0.48 : 0.56; }
  const cover = 0.47 + 0.2 * Math.exp(-(((lat - 6) / 9) ** 2)) - 0.17 * Math.exp(-(((al - 24) / 11) ** 2)) + 0.16 * Math.exp(-(((al - 56) / 13) ** 2)) - 0.08 * smoothstep(70, 88, al);
  return smoothstep(0, 0.42, f + cover - 0.5);
}

const hash = (a, b, c = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return s - Math.floor(s); };

// a soft cauliflower puff, four variants in a 2x2 atlas (alpha in A, a little self-shadow in RGB)
function puffAtlas() {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S * 2;
  const g = c.getContext('2d');
  let sd = 99; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S, oy = Math.floor(v / 2) * S;
    g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
    for (let k = 0; k < 26; k++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * S * 0.26;
      const x = ox + S / 2 + Math.cos(a) * rr, y = oy + S * 0.56 + Math.sin(a) * rr * 0.62 - (rr < S * 0.12 ? rnd() * S * 0.12 : 0);
      const r = S * (0.1 + rnd() * 0.13);
      const gr = g.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r);
      const top = 245 - Math.max(0, (y - oy - S * 0.45)) * 0.35;
      gr.addColorStop(0, `rgba(${top},${top},${top + 6},0.95)`); gr.addColorStop(0.6, `rgba(${top - 20},${top - 18},${top - 10},0.55)`); gr.addColorStop(1, 'rgba(200,205,215,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aPuff;   // offset from the layer origin (Earth-fixed), size
attribute vec4 aInfo;   // atlas cell, brightness, -, -
uniform float uOpacity; uniform vec3 uOrigin; uniform float uRange;
varying vec2 vUv; varying float vA; varying vec3 vW; varying float vShade; varying vec2 vCell; varying float vSunEl;
uniform vec3 uSun;
void main(){
  vec4 c = modelMatrix * vec4(aPuff.xyz, 1.0);
  // face the camera but stay upright on the planet (so they tilt with the horizon when the plane banks)
  vec3 upW = normalize(mat3(modelMatrix) * normalize(uOrigin + aPuff.xyz));
  vec3 vd = normalize(c.xyz);
  vec3 right = cross(vd, upW);
  if (dot(right, right) < 1e-4) right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  right = normalize(right);
  vec3 up = cross(right, vd);
  vec3 wp = c.xyz + (right * position.x + up * position.y) * aPuff.w;
  vW = wp; vUv = uv; vShade = aInfo.y; vSunEl = dot(upW, normalize(uSun));
  vCell = vec2(mod(aInfo.x, 2.0), floor(aInfo.x / 2.0)) * 0.5;
  // fade puffs right up close (the view turns white instead) and far away
  float d = length(c.xyz);
  vA = uOpacity * smoothstep(aPuff.w * 0.35, aPuff.w * 1.1, d) * (1.0 - smoothstep(0.7, 1.0, d / uRange));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}`;
const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap; uniform vec3 uSun; uniform float uNight; uniform float uFogK; uniform float uCamAlt;
varying vec2 vUv; varying float vA; varying vec3 vW; varying float vShade; varying vec2 vCell; varying float vSunEl;
void main(){
  #include <logdepthbuf_fragment>
  vec4 tx = texture2D(uMap, vCell + vUv * 0.5);
  float a = tx.a * vA;
  if (a < 0.01) discard;
  // round puff lighting: brighter toward the sun, a grey underside
  vec3 V = normalize(-vW);
  vec2 q = vUv * 2.0 - 1.0;
  float sunTo = dot(normalize(uSun), -V);                 // sun behind the cloud: a bright rim
  // the sun as it stands over this cloud: golden and low at dawn and dusk, gone at night
  float day = smoothstep(-0.12, 0.04, vSunEl);
  vec3 sunCol = mix(vec3(1.0, 0.52, 0.3), vec3(1.0, 0.98, 0.95), smoothstep(0.0, 0.3, vSunEl));
  float lit = 0.55 + 0.35 * q.y + 0.2 * max(sunTo, 0.0);
  vec3 col = tx.rgb * vShade * (sunCol * lit * day + vec3(0.06, 0.07, 0.1) * (0.3 + 0.7 * day));
  float fog = 1.0 - exp(-length(vW) * exp(-min(uCamAlt, 3000.0) / 8000.0) * uFogK);
  col = mix(col, vec3(0.62, 0.72, 0.88) * (0.05 + 0.95 * day), clamp(fog, 0.0, 0.85));
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

export class CloudLayer {
  constructor(shared) {
    this.shared = shared;
    this.group = new THREE.Group();            // lives in the Earth's (rotating) frame
    this.max = 0; this.radius = 0; this.cell = 1300;
    this.opacityU = { value: 0 };
    this.nightU = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: puffAtlas() }, uSun: shared.uSun, uNight: this.nightU, uFogK: shared.uFogK, uCamAlt: shared.uCamAlt, uOpacity: this.opacityU, uOrigin: { value: new THREE.Vector3() }, uRange: { value: 22000 } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    });
    this.mesh = null;
    this.last = null;
    this.fog = 0;
    this.puffs = [];
    this.setQuality('medium');
  }
  setQuality(q) {
    const [max, radius] = { low: [0, 0], medium: [700, 22000], high: [1600, 32000] }[q] || [700, 22000];
    if (max === this.max && radius === this.radius) return;
    this.max = max; this.radius = radius; this.last = null;
    this.mat.uniforms.uRange.value = Math.max(1, radius);
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh = null; }
    if (!max) return;
    const g = new THREE.InstancedBufferGeometry();
    g.copy(new THREE.PlaneGeometry(1, 1));
    g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4));
    g.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4));
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
  }

  // camF: camera position, Earth-fixed (m); ll: its {lat, lon, h}; on: clouds setting
  update(camF, ll, on, night) {
    this.nightU.value = night;
    const want = on && this.mesh && ll.h < 16000;
    this.opacityU.value = want ? 1 - smoothstep(10000, 16000, ll.h) : 0;
    if (!this.mesh) return;
    this.mesh.visible = want;
    if (!want) { this.fog = 0; return; }
    const u = this.shared.uCloud.value;
    // rebuild the puffs when the camera has moved a couple of cells, or the weather has drifted a little
    if (!this.last || Math.hypot(camF.x - this.last.x, camF.y - this.last.y, camF.z - this.last.z) > this.cell * 2 || Math.abs(u.w - this.lastW) > 0.002) {
      this.build(camF, ll, u);
      this.last = camF.clone(); this.lastW = u.w;
    }
    // inside a cloud: how deep (for the white-out)
    let fog = 0;
    for (const p of this.puffs) {
      const d = Math.hypot(camF.x - p.x, camF.y - p.y, camF.z - p.z);
      if (d < p.s * 0.45) fog = Math.max(fog, 1 - d / (p.s * 0.45));
    }
    this.fog = fog;
  }

  build(camF, ll, u) {
    if (!this.coverCache || this.cacheW !== u.w || this.cacheY !== u.y || this.coverCache.size > 60000) { this.coverCache = new Map(); this.cacheW = u.w; this.cacheY = u.y; }
    const R = 6371000;
    const dLat = this.cell / (R * D2R), cosL = Math.max(0.2, Math.cos(ll.lat * D2R)), dLon = dLat / cosL;
    const n = Math.ceil(this.radius / this.cell);
    const i0 = Math.floor(ll.lat / dLat), j0 = Math.floor(ll.lon / dLon);
    const origin = camF.clone();
    const list = [];
    const v = new THREE.Vector3();
    for (let di = -n; di <= n; di++) for (let dj = -n; dj <= n; dj++) {
      if (di * di + dj * dj > n * n) continue;
      const i = i0 + di, j = j0 + dj;
      const lat = (i + 0.5) * dLat, lon = (j + 0.5) * dLon;
      const cl = Math.cos(lat * D2R);
      const px = cl * Math.cos(lon * D2R), py = Math.sin(lat * D2R), pz = -cl * Math.sin(lon * D2R);
      // the weather of each cell is kept until it changes (most of a rebuild is cells seen before)
      const key = i * 100003 + j;
      let cover = this.coverCache.get(key);
      if (cover === undefined) { cover = cloudCover(px, py, pz, u, 6); this.coverCache.set(key, cover); }
      const h1 = hash(i, j);
      if (cover < 0.18 + h1 * 0.25) continue;
      // a cumulus: a few puffs heaped over a base at 1.5–2.6 km, taller where the cover is thick
      const base = 1500 + 1100 * hash(i * 0.37, j * 0.11, 3);
      const nP = 1 + Math.floor(cover * 3.2 * (0.5 + hash(i, j, 7)));
      for (let k = 0; k < nP; k++) {
        const la = lat + (hash(i, j, k + 11) - 0.5) * dLat * 0.9, lo = lon + (hash(i, j, k + 23) - 0.5) * dLon * 0.9;
        const h = base + k * (180 + 260 * cover) + hash(i, j, k + 31) * 120;
        const big = hash(i, j, 77) < cover * 0.35 ? 1.7 : 1;      // now and then a towering heap
        const size = (480 + 1000 * cover) * (0.6 + 0.7 * hash(i, j, k + 41)) * (1 - k * 0.12) * big;
        const c2 = Math.cos(la * D2R), r = R + h;
        v.set(c2 * Math.cos(lo * D2R) * r, Math.sin(la * D2R) * r, -c2 * Math.sin(lo * D2R) * r);
        const d2 = v.distanceToSquared(camF);
        list.push({ x: v.x, y: v.y, z: v.z, s: size, d2, cell: Math.floor(hash(i, j, k + 53) * 4), shade: 0.82 + 0.18 * hash(i, j, k + 61) - k * 0.03 });
      }
    }
    // nearest first to fill the budget, then drawn far to near
    list.sort((a, b) => a.d2 - b.d2);
    if (list.length > this.max) list.length = this.max;
    list.reverse();
    this.puffs = list;
    const g = this.mesh.geometry, A = g.attributes.aPuff.array, I = g.attributes.aInfo.array;
    list.forEach((p, k) => {
      A[k * 4] = p.x - origin.x; A[k * 4 + 1] = p.y - origin.y; A[k * 4 + 2] = p.z - origin.z; A[k * 4 + 3] = p.s;
      I[k * 4] = p.cell; I[k * 4 + 1] = p.shade;
    });
    g.attributes.aPuff.needsUpdate = true; g.attributes.aInfo.needsUpdate = true;
    g.instanceCount = list.length;
    this.mesh.position.copy(origin);
    this.mat.uniforms.uOrigin.value.copy(origin);
    this.mesh.updateMatrix();
  }
}
