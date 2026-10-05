// Interplanetary planning: launch windows (Lambert), departure burns from a parking orbit, course corrections
// toward a planet, capture, and the way back. Works in frame I like everything else; the Sun's pull and the
// planets' motion come from the same ephemeris the physics uses.

import * as THREE from 'three';
import { EARTH, MARS, SUN, AU, clamp, D2R } from '../core/geo.js';
import { helio } from '../core/astro.js';
import { predict, propagate, elements, relState, basis, bodyPos, bodyVelAt, vacPerf, hyperbolaVel, simBurnComp, solve3, yieldFrame, burnTime } from './orbit.js';

const DAY = 86400;
const KEY = { earth: 'earth', mars: 'mars' };
const keyOf = (body) => (body === MARS ? 'mars' : 'earth');

// heliocentric position and velocity of a planet (frame I axes)
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
export function planetPV(key, t) {
  const r = helio(key, t, new THREE.Vector3());
  helio(key, t + 60, _a); helio(key, t - 60, _b);
  return { r, v: _a.clone().sub(_b).divideScalar(120) };
}
// north pole of the ecliptic in frame I (planets go round it anticlockwise)
const ECL_N = new THREE.Vector3(0, Math.cos(23.4393 * D2R), Math.sin(23.4393 * D2R));

// ---- Lambert's problem (universal variables): the orbit from R1 to R2 in time tof about mu ----
function stC(z) { if (z > 1e-8) return (1 - Math.cos(Math.sqrt(z))) / z; if (z < -1e-8) return (Math.cosh(Math.sqrt(-z)) - 1) / -z; return 0.5 - z / 24; }
function stS(z) { if (z > 1e-8) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); } if (z < -1e-8) { const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s); } return 1 / 6 - z / 120; }
export function lambert(R1, R2, tof, mu, refN = ECL_N) {
  const r1 = R1.length(), r2 = R2.length();
  let th = Math.acos(clamp(R1.dot(R2) / (r1 * r2), -1, 1));
  if (new THREE.Vector3().crossVectors(R1, R2).dot(refN) < 0) th = 2 * Math.PI - th;     // prograde
  const A = Math.sin(th) * Math.sqrt((r1 * r2) / (1 - Math.cos(th)));
  if (!isFinite(A) || Math.abs(A) < 1e-6) return null;
  const sm = Math.sqrt(mu);
  const y = (z) => r1 + r2 + (A * (z * stS(z) - 1)) / Math.sqrt(stC(z));
  const F = (z) => { const yz = y(z); if (yz < 0) return -Infinity; return Math.pow(yz / stC(z), 1.5) * stS(z) + A * Math.sqrt(yz) - sm * tof; };
  // F rises with z on a single revolution: bracket and bisect
  let lo = -4 * Math.PI * Math.PI, hi = 4 * Math.PI * Math.PI * 0.999;
  while (lo < hi && !(F(lo) > -Infinity)) lo += 0.5;
  if (!(F(lo) < 0) || !(F(hi) > 0)) return null;
  for (let i = 0; i < 70; i++) { const m = (lo + hi) / 2; if (F(m) < 0) lo = m; else hi = m; }
  const z = (lo + hi) / 2, yz = y(z);
  const f = 1 - yz / r1, g = A * Math.sqrt(yz / mu), gd = 1 - yz / r2;
  const v1 = R2.clone().addScaledVector(R1, -f).divideScalar(g);
  const v2 = R2.clone().multiplyScalar(gd).sub(R1).divideScalar(g);
  return { v1, v2 };
}

// Speed change to leave a circular orbit of radius rp onto a hyperbola with excess speed vinf (and the reverse)
const escapeDv = (vinf, mu, rp) => Math.sqrt(vinf * vinf + (2 * mu) / rp) - Math.sqrt(mu / rp);

// Search the coming months for the cheapest transfer from planet `from` to planet `to`. Returns departure and
// arrival times and the excess velocities (relative to each planet, frame I).
export async function findWindow(t0, from, to, opts = {}, onProgress) {
  const span = opts.span ?? 800 * DAY, step = opts.step ?? 2 * DAY;
  const tofs = []; for (let d = opts.tofMin ?? 110; d <= (opts.tofMax ?? 400); d += 5) tofs.push(d * DAY);
  const muF = from === MARS ? MARS.mu : EARTH.mu, muT = to === MARS ? MARS.mu : EARTH.mu;
  const rpF = opts.rpFrom ?? from.R + 300e3, rpT = opts.rpTo ?? to.R + 300e3;
  const arrW = opts.arrWeight ?? 0.7, waitW = opts.waitWeight ?? 0;   // cost of a day's wait, in m/s
  const tofW = opts.tofWeight ?? 0.8;                                    // ... and of a day in flight
  let best = null;
  const N = Math.ceil(span / step);
  for (let i = 0; i <= N; i++) {
    const td = t0 + i * step;
    const P1 = planetPV(keyOf(from), td);
    for (const tof of tofs) {
      const P2 = planetPV(keyOf(to), td + tof);
      const L = lambert(P1.r, P2.r, tof, SUN.mu);
      if (!L) continue;
      const vd = L.v1.clone().sub(P1.v), va = L.v2.clone().sub(P2.v);
      const dvD = escapeDv(vd.length(), muF, rpF), dvA = escapeDv(va.length(), muT, rpT);
      const cost = dvD + arrW * dvA + waitW * (td - t0) / DAY + tofW * tof / DAY;
      if (!best || cost < best.cost) best = { cost, td, ta: td + tof, tof, vInfD: vd, vInfA: va, dvD, dvA };
    }
    if (i % 20 === 0) { if (onProgress) onProgress(i / N); await yieldFrame(); }
  }
  if (best) {
    // polish the date and flight time on a finer grid
    for (const [dd, dt] of [[DAY, 2 * DAY], [DAY / 4, DAY / 2]]) {
      const c = best;
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) {
        const td = c.td + a * dd, tof = c.tof + b * dt;
        if (td < t0 || tof < 60 * DAY) continue;
        const P1 = planetPV(keyOf(from), td), P2 = planetPV(keyOf(to), td + tof);
        const L = lambert(P1.r, P2.r, tof, SUN.mu);
        if (!L) continue;
        const vd = L.v1.clone().sub(P1.v), va = L.v2.clone().sub(P2.v);
        const dvD = escapeDv(vd.length(), muF, rpF), dvA = escapeDv(va.length(), muT, rpT);
        const cost = dvD + arrW * dvA + waitW * (td - t0) / DAY + tofW * tof / DAY;
        if (cost < best.cost) best = { cost, td, ta: td + tof, tof, vInfD: vd, vInfA: va, dvD, dvA };
      }
    }
  }
  return best;
}

// The departure burn from the ship's current orbit around `body` that leaves on a hyperbola with excess
// velocity vInf (frame I, relative to the body): the cheapest point within one orbit of tCenter.
function departureBurn(ship, body, vInf, tCenter) {
  const rs = relState(ship, body), el = elements(rs.r, rs.v, body.mu);
  const P = el.e < 1 ? el.period : 3600;
  const t0 = Math.max(ship.t + 300, tCenter - P / 2);
  let st = propagate(ship.r, ship.v, ship.t, t0 - ship.t), best = null;
  const K = 120;
  for (let k = 0; k <= K; k++) {
    if (k) st = propagate(st.r, st.v, st.t, P / K);
    const c = bodyPos(body, st.t), cv = bodyVelAt(body, st.t);
    const r = st.r.clone().sub(c), v = st.v.clone().sub(cv);
    const vh = hyperbolaVel(r, vInf, body.mu);
    if (!vh) continue;
    // only leave going the same way round as the parking orbit (no flipping over)
    if (vh.clone().cross(r).dot(v.clone().cross(r)) < 0) continue;
    const dv = vh.sub(v);
    if (!best || dv.length() < best.dv.length()) best = { st, dv, r, v };
  }
  return best;
}

// Aim a burn at state `st` (orbital frame of `frameBody`) so the craft's closest approach to planet `target`
// is at radius `goal`: Levenberg–Marquardt on the closest-approach position, aimed at the goal radius along
// the current miss direction. With `perf` the burn is simulated as the finite burn the executor flies.
export async function aimPlanet(st, frameBody, target, goal, dv0, maxT, onProgress, perf = null, base = null) {
  const c = bodyPos(frameBody, st.t), cv = bodyVelAt(frameBody, st.t);
  const b = basis(st.r.clone().sub(c), st.v.clone().sub(cv));
  const vec = (x) => b.pro.clone().multiplyScalar(x.x).addScaledVector(b.nor, x.y).addScaledVector(b.rad, x.z);
  const evalC = (x) => {
    let r0 = st.r, v0, t0 = st.t, energy = null;
    if (perf && x.length() > 50) {
      const bs = simBurnComp(base, perf, st.t, x.clone().normalize(), x.length(), frameBody);
      r0 = bs.r; v0 = bs.v; t0 = bs.t; energy = bs.energy;
    } else v0 = st.v.clone().add(vec(x));
    const pr = predict(r0, v0, t0, { maxT, maxSteps: 20000, oneRev: false, noExtend: true, earthStop: -EARTH.R * 0.9, moonStop: false, marsStop: -MARS.R * 0.9 });
    let p, d;
    if (target === MARS) { p = pr.closeMars.r ? pr.closeMars.r.clone() : new THREE.Vector3(1e13, 0, 0); d = pr.closeMars.d; }
    else { const s3 = pr.earthPts, i = pr.earthPeIdx ?? 0; p = s3.length ? new THREE.Vector3(s3[i * 3], s3[i * 3 + 1], s3[i * 3 + 2]) : new THREE.Vector3(1e13, 0, 0); d = pr.earthPe.d; }
    return { p, d, f: d - goal, pr, energy };
  };
  let x = new THREE.Vector3(dv0.dot(b.pro), dv0.dot(b.nor), dv0.dot(b.rad));
  let cur = evalC(x);
  const tol = Math.max(3000, (goal - target.R) * 0.05);
  const E3 = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dlt = 0.05;
  let lam = 1e-3;
  for (let it = 0; it < 24 && Math.abs(cur.f) > tol; it++) {
    const R = cur.p.clone().sub(cur.p.clone().setLength(goal));
    const cols = E3.map((e) => evalC(x.clone().addScaledVector(e, dlt)).p.sub(evalC(x.clone().addScaledVector(e, -dlt)).p).divideScalar(2 * dlt));
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (let i = 0; i < 3; i++) { g[i] = -cols[i].dot(R); for (let j = 0; j < 3; j++) A[i][j] = cols[i].dot(cols[j]); }
    const tr = A[0][0] + A[1][1] + A[2][2];
    let ok = false;
    for (let k = 0; k < 10; k++) {
      const M = A.map((row, i) => row.map((v, j) => v + (i === j ? lam * tr + 1e-12 * tr : 0)));
      const step = solve3(M, g);
      if (!step) { lam *= 10; continue; }
      if (step.length() > 600) step.setLength(600);
      const tryX = x.clone().add(step), r = evalC(tryX);
      if (Math.abs(r.f) < Math.abs(cur.f)) { x = tryX; cur = r; lam = Math.max(1e-9, lam / 5); ok = true; break; }
      lam *= 8;
    }
    if (onProgress) onProgress(Math.min(1, (it + 1) / 10));
    await yieldFrame();
    if (!ok) break;
  }
  if (globalThis.__dbgIP) console.log('  aimPlanet', { dv: x.length().toFixed(1), peKm: ((cur.d - target.R) / 1e3).toFixed(0), goalKm: ((goal - target.R) / 1e3).toFixed(0) });
  return { dv: vec(x), d: cur.d, f: cur.f, ok: Math.abs(cur.f) < tol * 20, energy: cur.energy, tArr: target === MARS ? cur.pr.closeMars.t : cur.pr.earthPe.t };
}

// Trans-Mars injection from Earth orbit: the next good launch window, then the departure burn
export async function planMarsTransfer(ship, onProgress, opts = {}) {
  if (ship.env.body !== EARTH) return null;
  const rs = relState(ship, EARTH), el = elements(rs.r, rs.v, EARTH.mu);
  if (!(el.e < 1)) return null;
  const goal = MARS.R + (opts.alt ?? 300e3);
  const prog = (a, b) => (f) => onProgress && onProgress(a + (b - a) * f);
  const W = await findWindow(ship.t + 3600, EARTH, MARS, { rpFrom: el.a, rpTo: goal, waitWeight: opts.waitWeight ?? 0 }, prog(0, 0.35));
  if (!W) return null;
  const dep = departureBurn(ship, EARTH, W.vInfD, W.td);
  if (!dep) return null;
  const perf = vacPerf(ship);
  const bt = perf ? burnTime(ship, dep.dv.length()) : 0;
  const base = propagate(ship.r, ship.v, ship.t, Math.max(0, dep.st.t - ship.t - bt / 2 - 60));
  const ref = await aimPlanet(dep.st, EARTH, MARS, goal, dep.dv, W.ta - dep.st.t + 40 * DAY, prog(0.35, 1), opts.finite ? perf : null, base);
  if (!ref || !ref.ok) return null;
  const node = { t: dep.st.t, dv: ref.dv, body: EARTH, label: 'Trans-Mars injection', marsPe: ref.d - MARS.R, arrive: ref.tArr, window: W };
  if (ref.energy != null) node.eTarget = ref.energy;
  return node;
}

// From Mars orbit back toward Earth: the next window (or leave sooner for more fuel with opts.waitWeight)
export async function planEarthReturnFromMars(ship, onProgress, opts = {}) {
  if (ship.env.body !== MARS) return null;
  const rs = relState(ship, MARS), el = elements(rs.r, rs.v, MARS.mu);
  if (!(el.e < 1)) return null;
  const goal = EARTH.R + (opts.alt ?? 250e3);
  const prog = (a, b) => (f) => onProgress && onProgress(a + (b - a) * f);
  const W = await findWindow(ship.t + 3600, MARS, EARTH, { rpFrom: el.a, rpTo: goal, waitWeight: opts.waitWeight ?? 0, arrWeight: opts.arrWeight ?? 0.7 }, prog(0, 0.35));
  if (!W) return null;
  const dep = departureBurn(ship, MARS, W.vInfD, W.td);
  if (!dep) return null;
  const perf = vacPerf(ship);
  const bt = perf ? burnTime(ship, dep.dv.length()) : 0;
  const base = propagate(ship.r, ship.v, ship.t, Math.max(0, dep.st.t - ship.t - bt / 2 - 60));
  const ref = await aimPlanet(dep.st, MARS, EARTH, goal, dep.dv, W.ta - dep.st.t + 40 * DAY, prog(0.35, 1), opts.finite ? perf : null, base);
  if (!ref || !ref.ok) return null;
  const node = { t: dep.st.t, dv: ref.dv, body: MARS, label: 'Trans-Earth injection', earthPe: ref.d - EARTH.R, arrive: ref.tArr, window: W };
  if (ref.energy != null) node.eTarget = ref.energy;
  return node;
}

// Course correction toward a planet: the cheapest small burn (now, or days later) that puts the closest
// approach at targetAlt.
export async function planPlanetCorrection(ship, target, targetAlt, onProgress) {
  const goal = target.R + targetAlt;
  const now = predict(ship.r, ship.v, ship.t, { maxT: 500 * DAY, maxSteps: 20000, oneRev: false, noExtend: true, earthStop: -EARTH.R * 0.9, moonStop: false, marsStop: -MARS.R * 0.9 });
  const tArr = target === MARS ? now.closeMars.t : now.earthPe.t;
  if (!isFinite(tArr) || tArr <= ship.t) return null;
  const left = tArr - ship.t;
  const leads = [120, 2 * DAY, 10 * DAY, 30 * DAY].filter((l) => l === 120 || l < left * 0.5);
  let best = null;
  for (let i = 0; i < leads.length; i++) {
    const st = propagate(ship.r, ship.v, ship.t, leads[i]);
    const frame = ship.env.body;
    const r = await aimPlanet(st, frame, target, goal, new THREE.Vector3(), left - leads[i] + 20 * DAY, (f) => onProgress && onProgress((i + f) / leads.length));
    if (!r.ok || r.dv.length() < 0.05) continue;
    if (!best || r.dv.length() < best.dv.length() * 0.6) best = { t: st.t, dv: r.dv, body: frame, label: `Course correction (${target.name})`, [target === MARS ? 'marsPe' : 'earthPe']: r.d - target.R };
  }
  return best;
}

// Capture into a circular orbit at the next periapsis around Mars (or any body)
export function planOrbitCapture(ship, body = MARS) {
  const rs = relState(ship, body);
  const el = elements(rs.r, rs.v, body.mu);
  let dtTo = isFinite(el.tPe) && el.tPe > 0 ? el.tPe : 60;
  const st = propagate(ship.r, ship.v, ship.t, dtTo);
  const r = st.r.clone().sub(bodyPos(body, st.t)), v = st.v.clone().sub(bodyVelAt(body, st.t));
  const rl = r.length();
  const vc = Math.sqrt(body.mu / rl);
  const horiz = v.clone().addScaledVector(r.clone().normalize(), -v.dot(r) / rl).normalize();
  return { t: st.t, dv: horiz.multiplyScalar(vc).sub(v), body, label: `${body.name} orbit capture` };
}
