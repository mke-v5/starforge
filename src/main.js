import * as THREE from 'three';
import { R, llh, toLatLon, frameAt } from './geo.js';
import { TileLoader } from './tiles.js';
import { Globe } from './globe.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- renderer ---------- */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.001, 2e6);
const frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _pm = new THREE.Matrix4();

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 0.8 ? 80 : 65;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

/* ---------- stars and atmosphere ---------- */
const starMat = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, depthTest: false });
{
  const N = 3500, p = new Float32Array(N * 3), c = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    p[i * 3] = Math.sin(ph) * Math.cos(th) * 1e6; p[i * 3 + 1] = Math.cos(ph) * 1e6; p[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * 1e6;
    const b = 0.35 + Math.random() * 0.65;
    c[i * 3] = b; c[i * 3 + 1] = b * 0.92; c[i * 3 + 2] = b * (Math.random() < 0.3 ? 0.8 : 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const stars = new THREE.Points(g, starMat);
  stars.frustumCulled = false; stars.renderOrder = -10;
  scene.add(stars);
}
const atmoMat = new THREE.ShaderMaterial({
  uniforms: { uF: { value: 0 } },
  vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
  fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vN; uniform float uF;
void main(){
#include <logdepthbuf_fragment>
float i = pow(clamp(-vN.z * 5.0, 0.0, 1.0), 1.4);
gl_FragColor = vec4(vec3(0.30, 0.55, 1.0) * i * uF, i * uF);
}`,
  side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
const atmo = new THREE.Mesh(new THREE.SphereGeometry(R + 95, 96, 48), atmoMat);
atmo.frustumCulled = false; atmo.renderOrder = 5;
scene.add(atmo);

/* ---------- world ---------- */
const loader = new TileLoader();
const globe = new Globe(scene, loader);

/* ---------- flight state ---------- */
const pos = new THREE.Vector3();
let heading = 0, pitch = -0.5, thr = 0.03, speed = 0;
const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3();
const fwd = new THREE.Vector3();
const zero = new THREE.Vector3();

function forwardVec(out) {
  frameAt(pos, up, east, north);
  const cp = Math.cos(pitch);
  return out.set(0, 0, 0).addScaledVector(north, Math.cos(heading) * cp).addScaledVector(east, Math.sin(heading) * cp).addScaledVector(up, Math.sin(pitch));
}

function teleport(lat, lon, altKm, hd = 0, pt = -0.5) {
  const tgt = llh(lat, lon, 0, new THREE.Vector3());
  frameAt(tgt, up, east, north);
  const back = altKm / Math.tan(-pt || 0.5);
  pos.copy(tgt).addScaledVector(north, -Math.cos(hd) * back).addScaledVector(east, -Math.sin(hd) * back).addScaledVector(up, altKm);
  pos.setLength(R + altKm);
  heading = hd; pitch = pt; speed = 0;
  globe.frame = Math.floor(globe.frame / 10) * 10 + 9;   // force an immediate chain request next frame
}
teleport(38.2494, -122.04, 6000, 0, -1.2);                  // start in orbit above Northern California

/* ---------- input ---------- */
const stick = { x: 0, y: 0 };
const keys = {};
const stickEl = $('stick'), knob = $('knob');
let sid = null;
function sMove(e) {
  const r = stickEl.getBoundingClientRect();
  let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
  stick.x = dx; stick.y = dy; knob.style.transform = `translate(${dx * 40}px,${dy * 40}px)`;
}
stickEl.addEventListener('pointerdown', (e) => { sid = e.pointerId; stickEl.setPointerCapture(sid); sMove(e); });
stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === sid) sMove(e); });
const sEnd = (e) => { if (e.pointerId === sid) { sid = null; stick.x = 0; stick.y = 0; knob.style.transform = 'translate(0,0)'; } };
stickEl.addEventListener('pointerup', sEnd); stickEl.addEventListener('pointercancel', sEnd);

const thrEl = $('thr'); let tid = null;
function tSet(e) { const r = thrEl.getBoundingClientRect(); thr = clamp(1 - (e.clientY - r.top) / r.height, 0, 1); if (thr < 0.04) thr = 0; }
thrEl.addEventListener('pointerdown', (e) => { tid = e.pointerId; thrEl.setPointerCapture(tid); tSet(e); });
thrEl.addEventListener('pointermove', (e) => { if (e.pointerId === tid) tSet(e); });
thrEl.addEventListener('pointerup', (e) => { if (e.pointerId === tid) tid = null; });
$('stop').addEventListener('click', () => { thr = 0; });
$('level').addEventListener('click', () => { pitch = -0.05; });
$('orbit').addEventListener('click', () => { const ll = toLatLon(pos); teleport(ll.lat, ll.lon, 9000, heading, -1.45); });
$('down').addEventListener('click', () => { const ll = toLatLon(pos); teleport(ll.lat, ll.lon, 3, heading, -0.1); });

window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  const k = e.key.toLowerCase(); keys[k] = true;
  if (k === ' ') { thr = 0; e.preventDefault(); }
  if (k.startsWith('arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

/* ---------- city search ---------- */
let cities = [];
fetch('./data/cities.json').then((r) => r.json()).then((rows) => { cities = rows.map((r) => ({ n: r[0], c: r[1], lat: r[2], lon: r[3], p: r[4], l: r[0].toLowerCase() })); });
const qEl = $('q'), resEl = $('results');
function fmtPop(p) { return p >= 1e6 ? (p / 1e6).toFixed(1) + 'M' : Math.round(p / 1000) + 'k'; }
function search(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const a = [], b = [];
  for (const c of cities) {
    if (c.l.startsWith(q)) a.push(c); else if (c.l.includes(q)) b.push(c);
    if (a.length >= 8) break;
  }
  return a.concat(b).slice(0, 8);
}
qEl.addEventListener('input', () => {
  const list = search(qEl.value);
  resEl.innerHTML = '';
  list.forEach((c) => {
    const b = document.createElement('button');
    b.innerHTML = `<span>${c.n}, ${c.c}</span><span class="d">${fmtPop(c.p)}</span>`;
    b.addEventListener('click', () => { teleport(c.lat, c.lon, 6, 0, -0.5); resEl.innerHTML = ''; qEl.value = c.n; qEl.blur(); });
    resEl.appendChild(b);
  });
  resEl.hidden = list.length === 0;
});
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#searchbox')) resEl.hidden = true; });

/* ---------- HUD ---------- */
function fmtAlt(h) { return h < 1 ? Math.round(h * 1000) + ' m' : h < 100 ? h.toFixed(1) + ' km' : Math.round(h).toLocaleString('en-US') + ' km'; }
function fmtSpd(v) { return v < 1 ? Math.round(v * 1000) + ' m/s' : v < 100 ? v.toFixed(1) + ' km/s' : Math.round(v).toLocaleString('en-US') + ' km/s'; }
let hudT = 0, fps = 60;

/* ---------- loop ---------- */
let last = performance.now();
const skyDay = new THREE.Color(0x6aa0e8), black = new THREE.Color(0x000000);
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.1;

  const kx = (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  const ky = (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
  if (keys.r) thr = clamp(thr + dt * 0.5, 0, 1);
  if (keys.f) thr = clamp(thr - dt * 0.5, 0, 1);
  const sx = Math.abs(stick.x) < 0.08 ? 0 : stick.x, sy = Math.abs(stick.y) < 0.08 ? 0 : stick.y;
  const yawIn = clamp(sx * Math.abs(sx) + kx, -1, 1);
  const pitchIn = clamp(-sy * Math.abs(sy) + ky, -1, 1);
  heading += yawIn * 0.9 * dt;
  pitch = clamp(pitch + pitchIn * 0.9 * dt, -1.52, 1.52);

  const ll0 = toLatLon(pos);
  const ground0 = globe.groundHeight(ll0.lat, ll0.lon);
  const alt = Math.max(0.001, ll0.h - ground0);
  speed = (0.004 + alt) * thr * thr * 1.6;          // km/s, scales with height so you can cross the planet or hover over a street

  forwardVec(fwd);
  pos.addScaledVector(fwd, speed * dt);
  // re-derive heading and pitch so the path follows a great circle
  frameAt(pos, up, east, north);
  pitch = Math.asin(clamp(fwd.dot(up), -1, 1));
  heading = Math.atan2(fwd.dot(east), fwd.dot(north));

  const ll = toLatLon(pos);
  const ground = globe.groundHeight(ll.lat, ll.lon);
  if (ll.h < ground + 0.008) pos.setLength(R + ground + 0.008);

  forwardVec(fwd);
  _m.lookAt(zero, fwd, up);
  camera.quaternion.setFromRotationMatrix(_m);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(_pm);

  globe.update(pos, camera, frustum);

  const h = Math.max(0, ll.h - ground);
  atmo.position.copy(pos).negate();
  atmoMat.uniforms.uF.value = clamp((h - 25) / 250, 0, 1);
  starMat.opacity = clamp((h - 30) / 120, 0, 1);
  renderer.setClearColor(skyDay.clone().lerp(black, clamp(h / 110, 0, 1)));
  renderer.render(scene, camera);

  hudT += dt;
  if (hudT > 0.2) {
    hudT = 0;
    $('alt').textContent = fmtAlt(h);
    $('spd').textContent = fmtSpd(speed);
    $('pos').textContent = `${Math.abs(ll.lat).toFixed(3)}°${ll.lat >= 0 ? 'N' : 'S'}  ${Math.abs(ll.lon).toFixed(3)}°${ll.lon >= 0 ? 'E' : 'W'}`;
    $('net').textContent = `tiles ${globe.stats.drawn} shown · ${loader.queued} loading · ${Math.round(fps)} fps`;
    $('thrfill').style.height = (thr * 100).toFixed(0) + '%';
  }
}
requestAnimationFrame(frame);

window.__sf = {
  teleport, loader, globe, pos,
  state: () => ({ ll: toLatLon(pos), heading, pitch, thr, speed, stats: globe.stats, net: loader.stats, queued: loader.queued }),
  setThr: (v) => { thr = v; },
};
