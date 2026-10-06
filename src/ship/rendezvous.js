// Meeting the station in orbit: two-body propagation, a Lambert solver, rendezvous burn planners, launch windows
// and the autopilots that fly the whole thing (ascent into the station's plane, transfer, braking, docking).

import * as THREE from 'three';
import { EARTH, clamp, D2R, fmtTime } from '../core/geo.js';
import { earthAngle } from '../core/astro.js';
import { elements, propagate, deltaV, burnTime } from './orbit.js';
import { planBurnAp, sequenceAp, ascentAp } from './control.js';
import { STATION } from '../world/station.js';

const MU = EARTH.mu;

// ---------------- two-body propagation (universal variables, any conic) ----------------
function stumpff(psi) {
  if (psi > 1e-6) { const s = Math.sqrt(psi); return [(1 - Math.cos(s)) / psi, (s - Math.sin(s)) / (s * s * s)]; }
  if (psi < -1e-6) { const s = Math.sqrt(-psi); return [(1 - Math.cosh(s)) / psi, (Math.sinh(s) - s) / (s * s * s)]; }
  return [0.5 - psi / 24, 1 / 6 - psi / 120];
}
export function kepler(r0, v0, dt, mu = MU) {
  const r0l = r0.length(), sq = Math.sqrt(mu), rv = r0.dot(v0);
  const alpha = 2 / r0l - v0.lengthSq() / mu;
  if (alpha > 1e-12) { const P = 2 * Math.PI / Math.sqrt(mu * alpha ** 3); dt = dt % P; }
  let x = alpha > 1e-12 ? sq * dt * alpha : sq * dt / r0l;
  if (alpha < -1e-12) {
    const a = 1 / alpha, s = Math.sign(dt) || 1;
    x = s * Math.sqrt(-a) * Math.log(Math.max(1e-12, (-2 * mu * alpha * dt) / (rv + s * Math.sqrt(-mu * a) * (1 - r0l * alpha))));
  }
  let c2 = 0.5, c3 = 1 / 6, psi = 0, r = r0l;
  for (let i = 0; i < 60; i++) {
    psi = x * x * alpha;
    [c2, c3] = stumpff(psi);
    r = x * x * c2 + (rv / sq) * x * (1 - psi * c3) + r0l * (1 - psi * c2);
    const dx = (sq * dt - x * x * x * c3 - (rv / sq) * x * x * c2 - r0l * x * (1 - psi * c3)) / r;
    x += dx;
    if (Math.abs(dx) < 1e-9) break;
  }
  psi = x * x * alpha; [c2, c3] = stumpff(psi);
  r = x * x * c2 + (rv / sq) * x * (1 - psi * c3) + r0l * (1 - psi * c2);
  const f = 1 - (x * x / r0l) * c2, g = dt - (x * x * x / sq) * c3;
  const fd = (sq / (r * r0l)) * x * (psi * c3 - 1), gd = 1 - (x * x / r) * c2;
  return {
    r: new THREE.Vector3().copy(r0).multiplyScalar(f).addScaledVector(v0, g),
    v: new THREE.Vector3().copy(r0).multiplyScalar(fd).addScaledVector(v0, gd),
  };
}

// ---------------- Lambert's problem (Izzo 2015), prograde about `n` ----------------
function hyp2F1(z) {
  let S = 1, C = 1;
  for (let j = 0; j < 200; j++) { C = C * (3 + j) * (1 + j) / (2.5 + j) * z / (j + 1); S += C; if (Math.abs(C) < 1e-11) break; }
  return S;
}
function x2tof2(x, lam, M) {
  const a = 1 / (1 - x * x);
  if (a > 0) {
    const alfa = 2 * Math.acos(x);
    let beta = 2 * Math.asin(Math.sqrt(lam * lam / a)); if (lam < 0) beta = -beta;
    return a * Math.sqrt(a) * ((alfa - Math.sin(alfa)) - (beta - Math.sin(beta)) + 2 * Math.PI * M) / 2;
  }
  const alfa = 2 * Math.acosh(x);
  let beta = 2 * Math.asinh(Math.sqrt(-lam * lam / a)); if (lam < 0) beta = -beta;
  return -a * Math.sqrt(-a) * ((beta - Math.sinh(beta)) - (alfa - Math.sinh(alfa))) / 2;
}
function x2tof(x, lam, M) {
  const dist = Math.abs(x - 1);
  if (dist < 0.2 && dist > 0.01) return x2tof2(x, lam, M);
  const K = lam * lam, E = x * x - 1, rho = Math.abs(E), z = Math.sqrt(1 + K * E);
  if (dist < 0.01) {
    const eta = z - lam * x, S1 = 0.5 * (1 - lam - x * eta);
    const Q = 4 / 3 * hyp2F1(S1);
    return (eta * eta * eta * Q + 4 * lam * eta) / 2 + M * Math.PI / Math.pow(rho, 1.5);
  }
  const y = Math.sqrt(rho), g = x * z - lam * E;
  let d;
  if (E < 0) d = M * Math.PI + Math.acos(clamp(g, -1, 1));
  else d = Math.log(y * (z - lam * x) + g);
  return (x - lam * z - d / y) / E;
}
function dTdx(x, T, lam) {
  const l2 = lam * lam, l3 = l2 * lam, umx2 = 1 - x * x;
  const y = Math.sqrt(1 - l2 * umx2), y2 = y * y, y3 = y2 * y;
  const d1 = (3 * T * x - 2 + 2 * l3 * x / y) / umx2;
  const d2 = (3 * T + 5 * x * d1 + 2 * (1 - l2) * l3 / y3) / umx2;
  const d3 = (7 * x * d2 + 8 * d1 - 6 * (1 - l2) * l2 * l3 * x / y3 / y2) / umx2;
  return [d1, d2, d3];
}
function householder(T, x0, M, lam) {
  let x = x0;
  for (let it = 0; it < 20; it++) {
    const tof = x2tof(x, lam, M);
    const [d1, d2, d3] = dTdx(x, tof, lam);
    const delta = tof - T, d12 = d1 * d1;
    const xn = x - delta * (d12 - delta * d2 / 2) / (d1 * (d12 - delta * d2) + d3 * delta * delta / 6);
    if (!isFinite(xn)) return NaN;
    if (Math.abs(xn - x) < 1e-11) { x = xn; break; }
    x = xn;
  }
  return x;
}
const _i1 = new THREE.Vector3(), _i2 = new THREE.Vector3(), _ih = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
// All solutions with up to `maxRev` full revolutions: [{ v1, v2, M, branch }]
export function lambert(r1v, r2v, tof, n, maxRev = 0, mu = MU) {
  const R1 = r1v.length(), R2 = r2v.length();
  const c = r1v.distanceTo(r2v), s = (c + R1 + R2) / 2;
  _i1.copy(r1v).divideScalar(R1); _i2.copy(r2v).divideScalar(R2);
  _ih.crossVectors(_i1, _i2);
  let lam = Math.sqrt(Math.max(0, 1 - c / s));
  if (_ih.lengthSq() < 1e-12) _ih.copy(n);           // 180° (or 0°) apart: the plane comes from n
  else { _ih.normalize(); if (_ih.dot(n) < 0) { lam = -lam; _ih.negate(); } }
  _t1.crossVectors(_ih, _i1).normalize(); _t2.crossVectors(_ih, _i2).normalize();
  const l2 = lam * lam, l3 = l2 * lam;
  const T = Math.sqrt(2 * mu / (s * s * s)) * tof;
  const xs = [];
  const T00 = Math.acos(lam) + lam * Math.sqrt(1 - l2), T1 = 2 / 3 * (1 - l3);
  let x0;
  if (T >= T00) x0 = -(T - T00) / (T - T00 + 4);
  else if (T <= T1) x0 = T1 * (T1 - T) / (2 / 5 * (1 - l2 * l3) * T) + 1;
  else x0 = Math.pow(T / T00, 0.69314718055994529 / Math.log(T1 / T00)) - 1;
  xs.push([householder(T, x0, 0, lam), 0, 0]);
  for (let M = 1; M <= maxRev; M++) {
    if (T < M * Math.PI) break;                       // too short for this many laps
    let tmp = Math.pow((M * Math.PI + Math.PI) / (8 * T), 2 / 3);
    xs.push([householder(T, (tmp - 1) / (tmp + 1), M, lam), M, -1]);
    tmp = Math.pow((8 * T) / (M * Math.PI), 2 / 3);
    xs.push([householder(T, (tmp - 1) / (tmp + 1), M, lam), M, 1]);
  }
  const gamma = Math.sqrt(mu * s / 2), rho = (R1 - R2) / c, sigma = Math.sqrt(Math.max(0, 1 - rho * rho));
  const out = [];
  for (const [x, M, branch] of xs) {
    if (!isFinite(x) || x <= -1 || (M > 0 && x >= 1)) continue;
    if (Math.abs(x2tof(x, lam, M) - T) > 1e-6 * Math.max(1, T)) continue;   // didn't converge
    const y = Math.sqrt(1 - l2 + l2 * x * x);
    const vr1 = gamma * ((lam * y - x) - rho * (lam * y + x)) / R1;
    const vr2 = -gamma * ((lam * y - x) + rho * (lam * y + x)) / R2;
    const vt = gamma * sigma * (y + lam * x);
    out.push({
      v1: _i1.clone().multiplyScalar(vr1).addScaledVector(_t1, vt / R1),
      v2: _i2.clone().multiplyScalar(vr2).addScaledVector(_t2, vt / R2),
      M, branch,
    });
  }
  return out;
}

// ---------------- geometry of the station's orbit ----------------
export function orbitNormal(r, v) { return new THREE.Vector3().crossVectors(r, v).normalize(); }
export function relInclination(ship, station) {
  return Math.acos(clamp(orbitNormal(ship.r, ship.v).dot(orbitNormal(station.r, station.v)), -1, 1));
}
// closest approach over the next `span` seconds (two-body sampling, then golden-section refinement)
export function closestApproach(ship, station, span = null) {
  const el = elements(ship.r, ship.v, MU);
  if (!(el.e < 1)) return null;
  station.advanceTo(ship.t);
  const T = el.period;
  span = span ?? T * 1.5;
  const N = 180, dt = span / N;
  const dist = (tt) => kepler(ship.r, ship.v, tt).r.distanceTo(kepler(station.r, station.v, tt).r);
  let best = 0, bd = Infinity;
  for (let i = 0; i <= N; i++) { const d = dist(i * dt); if (d < bd) { bd = d; best = i * dt; } }
  let a = Math.max(0, best - dt), b = Math.min(span, best + dt);
  const g = 0.381966;
  for (let k = 0; k < 40; k++) {
    const m1 = a + g * (b - a), m2 = b - g * (b - a);
    if (dist(m1) < dist(m2)) b = m2; else a = m1;
  }
  const tt = (a + b) / 2;
  const s1 = kepler(ship.r, ship.v, tt), s2 = kepler(station.r, station.v, tt);
  return { d: s1.r.distanceTo(s2.r), t: ship.t + tt, rShip: s1.r, rSt: s2.r, vRel: s1.v.distanceTo(s2.v) };
}

// ---------------- launch windows ----------------
// times when an Earth-fixed site passes through the station's orbital plane, with the launch heading
// (radians from north) that puts the ship into that plane going the station's way
export function launchWindows(lat, lon, t0, hT, span = 2 * 86400) {
  const pF = new THREE.Vector3(Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), -Math.cos(lat * D2R) * Math.sin(lon * D2R));
  const Y = new THREE.Vector3(0, 1, 0);
  const at = (t) => pF.clone().applyAxisAngle(Y, earthAngle(t));
  const f = (t) => at(t).dot(hT);
  const out = [];
  const step = 120;
  let tp = t0, fp = f(t0);
  for (let t = t0 + step; t <= t0 + span; t += step) {
    const ft = f(t);
    if ((fp < 0) !== (ft < 0)) {
      let a = tp, b = t;
      for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if ((f(m) < 0) === (fp < 0)) a = m; else b = m; }
      out.push({ t: (a + b) / 2 });
    }
    tp = t; fp = ft;
  }
  if (!out.length) {
    // the site is further from the equator than the orbit is tilted: launch when it comes closest to the plane
    let best = null;
    for (let t = t0; t <= t0 + span; t += step) { const v = Math.abs(f(t)); if (!best || v < best.v) best = { t, v }; }
    out.push({ t: best.t, off: true });
  }
  const R = EARTH.R + 200000, Vc = Math.sqrt(MU / R);
  for (const w of out) {
    const up = at(w.t);
    const east = new THREE.Vector3().crossVectors(Y, up).normalize(), north = new THREE.Vector3().crossVectors(up, east);
    const dir = new THREE.Vector3().crossVectors(hT, up).normalize();
    const need = dir.multiplyScalar(Vc).sub(new THREE.Vector3(EARTH.omega * up.z, 0, -EARTH.omega * up.x).multiplyScalar(EARTH.R));
    w.heading = Math.atan2(need.dot(east), need.dot(north));
  }
  return out;
}

// ---------------- burn planners (nodes { t, dv, label, body }) ----------------
// Match orbital planes: a normal burn where the ship's orbit crosses the station's plane.
export function planPlaneMatch(ship, station, minAngle = 0.0004) {
  const el = elements(ship.r, ship.v, MU);
  if (!(el.e < 1)) return null;
  station.advanceTo(ship.t);
  const hT = orbitNormal(station.r, station.v);
  const di = Math.acos(clamp(orbitNormal(ship.r, ship.v).dot(hT), -1, 1));
  if (di < minAngle) return null;
  const T = el.period, lead = 90 + Math.min(600, burnLead(ship, 2 * ship.v.length() * Math.sin(di / 2)));
  const f = (tt) => kepler(ship.r, ship.v, tt).r.dot(hT);
  const cands = [];
  const N = 120;
  let tp = lead, fp = f(tp);
  for (let i = 1; i <= N; i++) {
    const tt = lead + (i / N) * T, ft = f(tt);
    if ((fp < 0) !== (ft < 0)) {
      let a = tp, b = tt;
      for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if ((f(m) < 0) === (fp < 0)) a = m; else b = m; }
      cands.push((a + b) / 2);
    }
    tp = tt; fp = ft;
  }
  let best = null;
  for (const tt of cands) {
    const st = propagate(ship.r, ship.v, ship.t, tt);
    const rh = st.r.clone().normalize();
    const vr = st.v.dot(rh), vh = st.v.clone().addScaledVector(rh, -vr).length();
    const dir = new THREE.Vector3().crossVectors(hT, rh).normalize();
    const v2 = rh.clone().multiplyScalar(vr).addScaledVector(dir, vh);
    const dv = v2.sub(st.v);
    // the cheaper node, unless it is a lot later
    const cost = dv.length() + tt / 60 * 0.2;
    if (!best || cost < best.cost) best = { t: st.t, dv, cost };
  }
  if (!best) return null;
  return { t: best.t, dv: best.dv, body: EARTH, label: `Match planes with ${STATION.short} (${(di / D2R).toFixed(2)}°)` };
}

// seconds of lead a burn of `dv` needs (half its burn time)
function burnLead(ship, dv) {
  const craft = ship.craft;
  let T = 0, mdot = 0;
  for (const P of craft.engines) {
    if (!P.eng.active || P.alive === false) continue;
    const [t, isp] = craft.engineOutput(P, { rho: 0, p: 0, mach: 0, h: 1e6, a: 300 });
    if (t > 0) { T += t; mdot += t / (isp * 9.80665); }
  }
  if (T <= 0) return 600;
  const m0 = craft.mass, m1 = m0 / Math.exp(dv / (T / mdot));
  return (m0 - m1) / mdot / 2;
}

const OFFSET = 1200;                 // m: the transfer ends this far behind the station, on its orbit
let _lastYield = 0;
const yieldFrame = () => {
  const now = performance.now();
  if (now - _lastYield < 25) return Promise.resolve();
  return new Promise((r) => setTimeout(() => { _lastYield = performance.now(); r(); }, 0));
};

// Transfer to a point just behind the station: a porkchop search over departure time and flight time
// (up to two extra laps), then numerical shooting so the real trajectory (with the Moon's pull) arrives there.
// Returns the burn node with `rdv` = { t2, M, hT } describing the arrival.
export async function planIntercept(ship, station, onProgress, opts = {}) {
  const el = elements(ship.r, ship.v, MU);
  if (!(el.e < 1) || el.pe < EARTH.R + 120000) return null;
  station.advanceTo(ship.t);
  const sEl = elements(station.r, station.v, MU);
  const hT = orbitNormal(station.r, station.v);
  const T = Math.min(el.period, sEl.period);
  const budget = deltaV(ship.craft, false, (P) => P.eng.active) + (opts.extraDv || 0);
  const k = clamp(budget / 6000, 0.05, 1);          // m/s worth one minute of waiting (time warp makes waiting cheap)
  const span = opts.span ?? (budget > 6000 ? 6 * T : 26 * 3600);
  const t0 = 150 + Math.min(900, burnLead(ship, 150) * 2);
  const nT1 = Math.ceil(span / (T / 24)), dT1 = span / nT1;
  const offT = OFFSET / station.v.length();
  const tofs = [];
  for (let M = 0; M <= 2; M++) for (let j = M === 0 ? 3 : 0; j < 24; j++) tofs.push([(M + j / 24) * T, M]);
  let best = null;
  const evalAt = (tt1, tof, M) => {
    if (tof < 300) return null;
    const s1 = kepler(ship.r, ship.v, tt1);
    const s2 = kepler(station.r, station.v, tt1 + tof - offT);
    let out = null;
    for (const sol of lambert(s1.r, s2.r, tof, hT, M)) {
      if (sol.M !== M) continue;
      const dv1 = sol.v1.distanceTo(s1.v), dv2 = sol.v2.distanceTo(s2.v);
      if (dv1 + dv2 > budget * 0.85) continue;
      // stay out of the atmosphere on the way
      const te = elements(s1.r, sol.v1, MU);
      if (te.pe < EARTH.R + 130000 && (M > 0 || passesPeri(s1.r, sol.v1, tof, te))) continue;
      const cost = dv1 + dv2 + k * (tt1 + tof) / 60;
      if (!out || cost < out.cost) out = { cost, tt1, tof, M, branch: sol.branch, dv1, dv2 };
    }
    return out;
  };
  for (let i = 0; i <= nT1; i++) {
    const tt1 = t0 + i * dT1;
    for (const [tof, M] of tofs) {
      const r = evalAt(tt1, tof, M);
      if (r && (!best || r.cost < best.cost)) best = r;
    }
    if (onProgress && i % 8 === 0) onProgress(0.7 * i / nT1);
    if (i % 4 === 0) await yieldFrame();
  }
  if (!best) return null;
  // refine departure time and flight time (coordinate descent)
  let st1 = T / 48, st2 = T / 48;
  for (let it = 0; it < 30; it++) {
    let improved = false;
    for (const [a, b] of [[st1, 0], [-st1, 0], [0, st2], [0, -st2]]) {
      const tt1 = Math.max(t0, best.tt1 + a), tof = best.tof + b;
      const r = evalAt(tt1, tof, best.M);
      if (r && r.cost < best.cost) { best = r; improved = true; }
    }
    if (!improved) { st1 /= 2; st2 /= 2; if (st1 < 1) break; }
  }
  if (onProgress) onProgress(0.85);
  await yieldFrame();
  const t1 = ship.t + best.tt1, t2 = t1 + best.tof;
  const node = shoot(ship, station, t1, t2, best.M, best.branch, hT);
  if (!node) return null;
  if (onProgress) onProgress(1);
  node.label = `Transfer to ${STATION.short}`;
  node.rdv = { t2, M: best.M, branch: best.branch };
  node.arrive = t2;
  return node;
}
function passesPeri(r1, v1, tof, te) {
  // does the coast from r1 sweep through periapsis within tof?
  if (!isFinite(te.tPe)) return false;
  return te.tPe < tof;
}

// burn at t1 that reaches the point OFFSET behind the station at t2 on the real (Earth + Moon) trajectory
function shoot(ship, station, t1, t2, M, branch, hT) {
  const s1 = propagate(ship.r, ship.v, ship.t, t1 - ship.t);
  const aimSt = station.stateAt(t2 - OFFSET / station.v.length());
  const aim = aimSt.r.clone();
  let tgt = aim.clone(), v1 = null, miss = Infinity;
  for (let it = 0; it < 6; it++) {
    const sols = lambert(s1.r, tgt, t2 - t1, hT, M).filter((x) => x.M === M && (M === 0 || x.branch === branch));
    if (!sols.length) return null;
    v1 = sols[0].v1;
    const arr = propagate(s1.r, v1, t1, t2 - t1);
    const err = arr.r.clone().sub(aim);
    miss = err.length();
    if (miss < 3) break;
    tgt.sub(err);
  }
  if (!v1 || miss > 5000) return null;
  return { t: t1, dv: v1.clone().sub(s1.v), body: EARTH, miss };
}

// Course correction half way along the transfer (null when already on course)
export function planRdvCorrection(ship, station, rdv) {
  const left = rdv.t2 - ship.t;
  if (left < 400) return null;
  station.advanceTo(ship.t);
  const aimSt = station.stateAt(rdv.t2 - OFFSET / station.v.length());
  const coast = propagate(ship.r, ship.v, ship.t, left);
  if (coast.r.distanceTo(aimSt.r) < 120) return null;
  const tc = ship.t + Math.max(120, left * 0.5);
  const hT = orbitNormal(station.r, station.v);
  // how many full laps remain between the correction and arrival
  const el = elements(ship.r, ship.v, MU);
  const laps = Math.max(0, Math.floor((rdv.t2 - tc) / el.period));
  for (const M of [laps, Math.max(0, laps - 1), laps + 1]) {
    for (const branch of M ? [-1, 1] : [0]) {
      const n = shoot(ship, station, tc, rdv.t2, M, branch, hT);
      if (n && n.dv.length() < 200) { n.label = 'Course correction'; return n; }
    }
  }
  return null;
}

// Arrival: match the station's speed (the burn is centred on the arrival time)
export function planRdvMatch(ship, station, rdv) {
  station.advanceTo(ship.t);
  const t2 = Math.max(rdv.t2, ship.t + 60);
  const s = propagate(ship.r, ship.v, ship.t, t2 - ship.t);
  const aimSt = station.stateAt(t2 - OFFSET / station.v.length());
  const dv = aimSt.v.clone().sub(s.v);
  return { t: t2, dv, body: EARTH, label: `Match speed with ${STATION.short}` };
}

// ---------------- autopilots ----------------
const NOSE = new THREE.Vector3(0, 0, -1);
const _ax = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _qi = new THREE.Quaternion();

// acceleration the RCS can give along each body axis: { px, nx, py, ny, pz, nz } (m/s²)
export function rcsAccel(craft) {
  const out = { px: 0, nx: 0, py: 0, ny: 0, pz: 0, nz: 0 };
  for (const P of craft.rcsList) for (const d of P.rcs.dirs) {
    const F = P.def.rcs.thrust;
    out.px += Math.max(0, -d.x) * F; out.nx += Math.max(0, d.x) * F;
    out.py += Math.max(0, -d.y) * F; out.ny += Math.max(0, d.y) * F;
    out.pz += Math.max(0, -d.z) * F; out.nz += Math.max(0, d.z) * F;
  }
  for (const k in out) out[k] = out[k] / craft.mass;
  return out;
}
// velocity of a body-frame point of the ship (I)
function shipPointVel(ship, pB, out) {
  _w.copy(pB).sub(ship.craft.com);
  return out.crossVectors(ship.w, _w).applyQuaternion(ship.q).add(ship.v);
}
// the free port that faces the ship best
export function choosePort(station, pos, t) {
  let best = -1, bs = -Infinity;
  const c = station.posAt(t, new THREE.Vector3()), p = new THREE.Vector3(), ax = new THREE.Vector3();
  for (const P of station.ports) {
    if (station.occupied === P.i) continue;
    station.port(P.i, t, p, ax);
    const s = ax.dot(pos.clone().sub(c).normalize());
    if (s > bs) { bs = s; best = P.i; }
  }
  return best;
}

// Wait on the ground for the station's plane to pass over, warping time; `out.window` holds the window.
export function launchWaitAp(station, out = {}, lead = 0) {
  let wake = null;
  return {
    name: 'Launch window', cancelOnStick: true,
    get wakeAt() { return wake; },
    update(ship, dt, C) {
      const E = ship.env;
      if (!out.window) {
        station.advanceTo(ship.t);
        const hT = orbitNormal(station.r, station.v);
        const w = launchWindows(E.lat, E.lon, ship.t + 30 + lead, hT)[0];
        w.hT = hT;
        out.window = w;
        wake = w.t - lead;
      }
      const left = out.window.t - lead - ship.t;
      if (left <= 0) { wake = null; return { done: true, throttle: 0, msg: `Launch window: heading ${Math.round(((out.window.heading / D2R) + 360) % 360)}°` }; }
      return { throttle: 0, brake: 1, status: `lift-off in ${fmtTime(left)}${out.window.off ? ' (closest pass)' : ''}` };
    },
  };
}

// Close in and dock: fly to the approach corridor of the best free port (staying clear of the solar wings),
// slide down the corridor to a hold point, line up, and creep in until the ports latch. Translation on RCS,
// attitude keeps the ship's port facing the station's. Without a docking port it holds station off a port.
export function proxAp(station) {
  let portIdx = -1, phase = 'approach', aR = null, settle = 0, wasIn = false, stuck = 0, lastAlong = Infinity;
  return {
    name: 'Docking', cancelOnStick: true,
    update(ship, dt, C) {
      const craft = ship.craft, t = ship.t;
      if (ship.docked) return { done: true, throttle: 0, msg: `Docked at ${STATION.name}` };
      if (!craft.rcsList.length) return { done: true, fail: true, throttle: 0, msg: 'Docking needs RCS thrusters (add some in the hangar)' };
      if (craft.amount('GAS') + craft.amount('LF') < 0.5) return { done: true, fail: true, throttle: 0, trans: new THREE.Vector3(), msg: 'Out of RCS propellant — docking abandoned' };
      ship.ctl.rcs = true;
      if (!aR || Math.random() < 0.01) aR = rcsAccel(craft);
      const part = craft.docks.find((P) => P.alive) || null;
      const pB = part ? part.dock.pos : craft.com;
      const sp = ship.bodyToWorld(pB, new THREE.Vector3());
      if (portIdx < 0 || station.occupied === portIdx) portIdx = choosePort(station, sp, t);
      if (portIdx < 0) return { done: true, fail: true, throttle: 0, msg: 'No free docking port' };
      const pPos = new THREE.Vector3(), pAx = new THREE.Vector3(), pUp = new THREE.Vector3();
      station.port(portIdx, t, pPos, pAx, pUp);
      const c = station.posAt(t, new THREE.Vector3());
      const size = craft.size;
      const hold = 18 + size * 0.6 + (part ? 0 : 30);
      const rel = sp.clone().sub(pPos), along = rel.dot(pAx);
      const lat = rel.clone().addScaledVector(pAx, -along), latL = lat.length();
      // velocity in the station's rotating frame (relative to the station point where the ship is)
      const vrel = shipPointVel(ship, pB, new THREE.Vector3()).sub(station.pointVel(sp, t, _v));
      const aMin = Math.max(0.005, Math.min(aR.px, aR.nx, aR.py, aR.ny, aR.pz, aR.nz));
      // attitude: our port against theirs, rolled to the port's "up"
      const axis = part ? part.dock.axis : NOSE;
      const fwdW = ship.dirToWorld(axis, _ax);
      const misalign = Math.acos(clamp(-fwdW.dot(pAx), -1, 1));
      const inCorridor = wasIn = along > 0 && latL < (wasIn ? 8 : 4) + along * (wasIn ? 0.16 : 0.12);
      let vDes = new THREE.Vector3(), status;
      const dist = sp.distanceTo(pPos);
      if (phase === 'approach' || !part) {
        const H = pPos.clone().addScaledVector(pAx, hold);
        let goal = H;
        if (!inCorridor) {
          // outside the corridor: go to its entrance first, around the station if it is in the way
          const R = 62 + size * 0.5;
          const Ent = pPos.clone().addScaledVector(pAx, Math.max(hold + 10, R + 10));
          goal = Ent;
          const seg = Ent.clone().sub(sp), L2 = seg.lengthSq();
          const k = L2 > 1e-6 ? clamp(c.clone().sub(sp).dot(seg) / L2, 0, 1) : 0;
          const close = sp.clone().addScaledVector(seg, k);
          if (close.distanceTo(c) < R && sp.distanceTo(c) > R * 0.6) {
            // walk around the station on a safe sphere, a bit at a time, toward the corridor entrance
            const us = sp.clone().sub(c).normalize(), ue = Ent.clone().sub(c).normalize();
            let ax = new THREE.Vector3().crossVectors(us, ue);
            if (ax.lengthSq() < 1e-6) ax.crossVectors(us, pUp);
            if (ax.lengthSq() < 1e-6) ax.crossVectors(us, new THREE.Vector3(1, 0, 0));
            const step = Math.min(Math.acos(clamp(us.dot(ue), -1, 1)), 0.6);
            goal = c.clone().addScaledVector(us.applyAxisAngle(ax.normalize(), step), Math.max(R + 15, sp.distanceTo(c)));
          }
        }
        const to = goal.clone().sub(sp), d = to.length();
        const speed = Math.min(clamp(d / 80, 0.2, 4), Math.sqrt(2 * 0.35 * aMin * d));
        if (d > 0.05) vDes.copy(to).multiplyScalar(speed / d);
        const steady = ship.w.clone().applyQuaternion(ship.q).sub(station.w).length() < 0.01;
        settle = (H.distanceTo(sp) < 2.5 && vrel.length() < 0.2 && misalign < 2.5 * D2R && steady) ? settle + dt : 0;
        if (part && settle > 2) { phase = 'final'; settle = 0; }
        status = part ? `${STATION.short} ${station.ports[portIdx].name} port · ${dist > 1000 ? (dist / 1000).toFixed(2) + ' km' : Math.round(dist) + ' m'} · ${vrel.length().toFixed(1)} m/s` : `Holding ${Math.round(dist)} m off ${STATION.short} — add a docking port to dock`;
      } else {
        // final approach: slow down the axis, steering out lateral error
        let vc = clamp(0.03 * along + 0.05, 0.06, 0.8);
        if (along < 2) vc = 0.08;
        // close to the port, pause the closing until the lateral error is down to a few centimetres
        if (along < 5 && latL > 0.2) vc = Math.min(vc, 0.015);
        vDes.copy(pAx).multiplyScalar(-vc).addScaledVector(lat, -Math.min(0.18, 0.3 / Math.max(latL, 1e-3)));
        // no progress right at the port (something in the way, or can't line up): back out and try again
        if (along < 2) { stuck = lastAlong - along < 0.01 * dt ? stuck + dt : 0; } else stuck = 0;
        lastAlong = along;
        if (latL > Math.max(1.5, along * 0.15) || along < -0.6 || misalign > 8 * D2R || stuck > 25) { phase = 'approach'; stuck = 0; C.status = 'Docking: backing out to line up again'; }
        status = `Final approach · ${along.toFixed(1)} m · ${vrel.dot(pAx).toFixed(2)} m/s · off-axis ${latL.toFixed(2)} m`;
      }
      // translation: accelerate toward the wanted velocity, then per body axis on the thrusters there are
      const aW = vDes.sub(vrel).multiplyScalar(0.7);
      if (aW.length() < 0.0015) aW.set(0, 0, 0);
      const aB = aW.applyQuaternion(_qi.copy(ship.q).invert());
      const trans = new THREE.Vector3(
        clamp(aB.x / Math.max(1e-4, aB.x > 0 ? aR.px : aR.nx), -1, 1),
        clamp(aB.y / Math.max(1e-4, aB.y > 0 ? aR.py : aR.ny), -1, 1),
        clamp(aB.z / Math.max(1e-4, aB.z > 0 ? aR.pz : aR.nz), -1, 1));
      return { dir: pAx.clone().negate(), axis, up: pUp, throttle: 0, trans, status, rateCap: 0.06 };
    },
  };
}

// Arrival: kill the velocity relative to the station on the main engines, closed loop on the real relative
// velocity (in the station's rotating frame), starting so the burn is centred on the arrival time.
export function matchAp(station, rdv) {
  let wake = null, started = false, pred = null, predT = -1e9;
  const thrustDir = (ship, C) => C.thrustAxis(ship.craft, ship.env);
  const predict = (ship) => {
    if (pred && ship.t - predT < 20) return pred;
    const t2 = Math.max(rdv.t2, ship.t + 1);
    const s2 = propagate(ship.r, ship.v, ship.t, t2 - ship.t);
    const st2 = station.stateAt(t2);
    const w = new THREE.Vector3().crossVectors(st2.r, st2.v).divideScalar(st2.r.lengthSq());
    const dv = st2.v.clone().add(new THREE.Vector3().crossVectors(w, s2.r.clone().sub(st2.r))).sub(s2.v);
    const bt = burnTime(ship, dv.length());
    predT = ship.t;
    pred = { dv, bt: isFinite(bt) ? bt : 0, tStart: t2 - (isFinite(bt) ? bt : 0) / 2 };
    wake = pred.tStart - 45;
    return pred;
  };
  return {
    name: `Match speed with ${STATION.short}`, cancelOnStick: true,
    get wakeAt() { return started ? null : wake; },
    railsDir: (ship, C) => ({ dir: predict(ship).dv.clone().normalize(), axis: thrustDir(ship, C) }),
    update(ship, dt, C) {
      const craft = ship.craft;
      const axis = ship.thrustNow > 0 && ship.thrustB && ship.thrustB.lengthSq() > 1 ? ship.thrustB.clone().normalize() : thrustDir(ship, C);
      const engines = craft.engines.some((P) => P.alive !== false && P.eng.mode === 'rocket' && Math.abs(P.eng.dir.z) > 0.5) ? 'main' : undefined;
      if (!started) {
        const P = predict(ship);
        if (ship.t < P.tStart) return { dir: P.dv.clone().normalize(), axis, throttle: 0, engines, status: `burn in ${fmtTime(P.tStart - ship.t)} · ${P.dv.length().toFixed(0)} m/s` };
        started = true;
      }
      const vrel = station.pointVel(ship.r, ship.t, new THREE.Vector3()).sub(ship.v);
      const left = vrel.length();
      if (left < (craft.rcsList.length ? 1.0 : 0.3)) return { done: true, throttle: 0, msg: `Matched speed ${Math.round(ship.r.distanceTo(station.r))} m from ${STATION.short}` };
      const dir = vrel.divideScalar(left);
      const aligned = ship.dirToWorld(axis, new THREE.Vector3()).dot(dir);
      let T = 0; for (const P of craft.engines) if (P.eng.active) T += craft.engineOutput(P, ship.env)[0];
      const amax = Math.max(0.01, T / craft.mass);
      const thr = aligned > 0.996 ? clamp(left / (amax * 2.5), 0.01, 1) : 0;
      return { dir, axis, throttle: thr, engines, status: `${left.toFixed(1)} m/s to go` };
    },
  };
}

// After undocking: back straight off the port on RCS, then hand back control.
export function departAp(station, portIdx) {
  let aR = null, axis0 = null;
  return {
    name: 'Departure', cancelOnStick: true,
    update(ship, dt, C) {
      const craft = ship.craft, t = ship.t;
      if (!craft.rcsList.length) return { done: true, throttle: 0, msg: 'Undocked' };
      ship.ctl.rcs = true;
      if (!aR) aR = rcsAccel(craft);
      const pPos = new THREE.Vector3(), pAx = new THREE.Vector3();
      station.port(portIdx, t, pPos, pAx);
      const d = ship.r.distanceTo(pPos), clear = 25 + craft.size * 0.8;
      const vrel = ship.v.clone().sub(station.pointVel(ship.r, t, _v));
      if (d > clear) {
        if (vrel.length() > 0.05) {
          const aB = vrel.clone().multiplyScalar(-0.7).applyQuaternion(_qi.copy(ship.q).invert());
          const trans = new THREE.Vector3(clamp(aB.x / Math.max(1e-4, aB.x > 0 ? aR.px : aR.nx), -1, 1), clamp(aB.y / Math.max(1e-4, aB.y > 0 ? aR.py : aR.ny), -1, 1), clamp(aB.z / Math.max(1e-4, aB.z > 0 ? aR.pz : aR.nz), -1, 1));
          return { throttle: 0, trans, status: 'stopping' };
        }
        return { done: true, throttle: 0, trans: new THREE.Vector3(), msg: `Clear of ${STATION.short} — you have control` };
      }
      if (!axis0) axis0 = ship.q.clone();
      const vDes = pAx.clone().multiplyScalar(0.5);
      const aB = vDes.sub(vrel).multiplyScalar(0.7).applyQuaternion(_qi.copy(ship.q).invert());
      const trans = new THREE.Vector3(clamp(aB.x / Math.max(1e-4, aB.x > 0 ? aR.px : aR.nx), -1, 1), clamp(aB.y / Math.max(1e-4, aB.y > 0 ? aR.py : aR.ny), -1, 1), clamp(aB.z / Math.max(1e-4, aB.z > 0 ? aR.pz : aR.nz), -1, 1));
      return { throttle: 0, trans, status: `backing away · ${Math.round(d)} m` };
    },
  };
}

// The whole trip to the station: wait for a launch window and fly the ascent into its plane if on the ground,
// match planes, transfer, correct, brake next to it, and dock.
export function rendezvousAp(ship, station, opts = {}) {
  const steps = [];
  station.advanceTo(ship.t);
  const hT = orbitNormal(station.r, station.v);
  const E = ship.env;
  const el = elements(ship.r, ship.v, MU);
  const inOrbit = E.body === EARTH && el.e < 1 && el.pe > EARTH.R + 130000;
  const near = ship.r.distanceTo(station.r) < 4000 && ship.v.distanceTo(station.v) < 15;
  const box = {};
  let rdv = null;
  if (!near) {
    if (!inOrbit) {
      if (ship.parked || ship.contacts > 0) steps.push(() => launchWaitAp(station, box, opts.lead || 0));
      steps.push(() => ascentAp(opts.parkAlt || 220000, box.window ? box.window.heading : Math.PI / 2, { plane: hT }));
    }
    steps.push(() => planBurnAp('Match planes', (s) => planPlaneMatch(s, station), true));
    steps.push(() => planBurnAp('Match planes', (s) => planPlaneMatch(s, station, 0.0009), true));   // a trim after a big plane change
    steps.push(() => planBurnAp(`Transfer to ${STATION.short}`, async (s) => { const n = await planIntercept(s, station); if (n) rdv = n.rdv; return n; }));
    steps.push(() => planBurnAp('Course correction', (s) => (rdv ? planRdvCorrection(s, station, rdv) : null), true));
    steps.push(() => (rdv ? matchAp(station, rdv) : null));
  }
  steps.push(() => proxAp(station));
  return Object.assign(sequenceAp(`To ${STATION.short}`, steps), { rdvStation: true });
}
