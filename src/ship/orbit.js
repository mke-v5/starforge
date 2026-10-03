// Orbital mechanics helpers: elements, trajectory prediction (Earth + Moon gravity) and burn planners.

import * as THREE from 'three';
import { EARTH, MOON, clamp } from '../core/geo.js';
import { moonPos, moonVel, gravity } from '../core/astro.js';
import { rk4 } from './physics.js';

const _m = new THREE.Vector3(), _mv = new THREE.Vector3();

// Keplerian elements of (r, v) relative to a body with gravitational parameter mu
export function elements(r, v, mu) {
  const rl = r.length(), v2 = v.lengthSq();
  const h = new THREE.Vector3().crossVectors(r, v);
  const energy = v2 / 2 - mu / rl;
  const a = -mu / (2 * energy);
  const ev = new THREE.Vector3().crossVectors(v, h).divideScalar(mu).sub(r.clone().divideScalar(rl));
  const e = ev.length();
  const pe = a * (1 - e);
  const ap = e < 1 ? a * (1 + e) : Infinity;
  const inc = Math.acos(clamp(h.y / h.length(), -1, 1));
  const period = e < 1 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : Infinity;
  // true anomaly and time to apsides
  let nu = Math.acos(clamp(ev.dot(r) / (e * rl || 1), -1, 1));
  if (r.dot(v) < 0) nu = 2 * Math.PI - nu;
  let tPe = NaN, tAp = NaN;
  if (e < 1 && e > 1e-6) {
    const E = 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
    let M = E - e * Math.sin(E); if (M < 0) M += 2 * Math.PI;
    const n = 2 * Math.PI / period;
    tPe = (2 * Math.PI - M) / n;
    tAp = ((Math.PI - M) + 2 * Math.PI) % (2 * Math.PI) / n;
  } else if (e >= 1) {
    const F = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    const M = e * Math.sinh(F) - F;
    const n = Math.sqrt(mu / Math.pow(-a, 3));
    tPe = M < 0 ? -M / n : NaN;
  }
  return { a, e, pe, ap, inc, period, energy, nu, tPe, tAp, h, ev };
}

// Predict a trajectory. Returns points relative to Earth (I) and, inside the Moon's sphere of influence, relative to the Moon.
export function predict(r0, v0, t0, opts = {}) {
  const maxT = opts.maxT ?? 6 * 86400;
  const maxSteps = opts.maxSteps ?? 4000;
  const s = [r0.x, r0.y, r0.z, v0.x, v0.y, v0.z];
  let t = t0;
  const earthPts = [], moonPts = [];
  let closeMoon = { d: Infinity, t: 0, r: null, v: null }, impact = null, soiIn = null, soiOut = null, earthPe = { d: Infinity, t: 0 };
  let inSoi = null;
  const startR = Math.hypot(s[0], s[1], s[2]);
  let angle = 0, lastDir = new THREE.Vector3(s[0], s[1], s[2]).normalize();
  const dir = new THREE.Vector3();
  for (let i = 0; i < maxSteps && t - t0 < maxT; i++) {
    moonPos(t, _m);
    const dx = s[0] - _m.x, dy = s[1] - _m.y, dz = s[2] - _m.z;
    const dm = Math.hypot(dx, dy, dz);
    const de = Math.hypot(s[0], s[1], s[2]);
    const nowSoi = dm < MOON.soi;
    if (inSoi === null) inSoi = nowSoi;
    if (nowSoi && !inSoi && !soiIn) soiIn = t;
    if (!nowSoi && inSoi && soiIn && !soiOut) soiOut = t;
    inSoi = nowSoi;
    if (dm < closeMoon.d) { closeMoon = { d: dm, t, r: new THREE.Vector3(dx, dy, dz), v: null, vI: new THREE.Vector3(s[3], s[4], s[5]) }; }
    if (de < earthPe.d) earthPe = { d: de, t };
    earthPts.push(s[0], s[1], s[2]);
    if (nowSoi) moonPts.push(dx, dy, dz, t);
    if (de < EARTH.R + (opts.earthStop ?? 0)) { impact = { body: EARTH, t, r: new THREE.Vector3(s[0], s[1], s[2]) }; break; }
    if (dm < MOON.R + 200) { impact = { body: MOON, t, r: new THREE.Vector3(dx, dy, dz) }; break; }
    // stop after one full revolution around Earth when not heading for the Moon
    dir.set(s[0], s[1], s[2]).normalize();
    angle += Math.acos(clamp(dir.dot(lastDir), -1, 1));
    lastDir.copy(dir);
    if (!nowSoi && opts.oneRev !== false && angle > 2 * Math.PI + 0.05 && de < 300e6 && !soiIn) break;
    const body = nowSoi ? MOON : EARTH;
    const rr = nowSoi ? dm : de;
    const h = clamp(0.012 * Math.sqrt(rr * rr * rr / body.mu), 0.5, opts.maxStep ?? 900);
    rk4(s, t, h);
    t += h;
  }
  if (closeMoon.r) { moonVel(closeMoon.t, _mv); closeMoon.v = closeMoon.vI.clone().sub(_mv); }
  return { earthPts, moonPts, closeMoon, impact, soiIn, soiOut, earthPe, tEnd: t };
}

// velocity of the craft relative to the dominant body and its position relative to it
export function relState(ship, body) {
  if (body === EARTH) return { r: ship.r.clone(), v: ship.v.clone(), mu: EARTH.mu, R: EARTH.R };
  moonPos(ship.t, _m); moonVel(ship.t, _mv);
  return { r: ship.r.clone().sub(_m), v: ship.v.clone().sub(_mv), mu: MOON.mu, R: MOON.R };
}

// maneuver basis at a state: prograde, normal, radial (unit vectors)
export function basis(r, v) {
  const pro = v.clone().normalize();
  const nor = new THREE.Vector3().crossVectors(r, v).normalize();
  const rad = new THREE.Vector3().crossVectors(nor, pro).normalize();
  return { pro, nor, rad };
}

// propagate state forward by dt (gravity only)
export function propagate(r, v, t, dt) {
  const s = [r.x, r.y, r.z, v.x, v.y, v.z];
  let left = dt, tt = t;
  while (left > 1e-6) {
    const de = Math.hypot(s[0], s[1], s[2]);
    moonPos(tt, _m);
    const dm = Math.hypot(s[0] - _m.x, s[1] - _m.y, s[2] - _m.z);
    const body = dm < MOON.soi ? MOON : EARTH, rr = body === MOON ? dm : de;
    const h = Math.min(left, clamp(0.01 * Math.sqrt(rr ** 3 / body.mu), 0.5, 300));
    rk4(s, tt, h); tt += h; left -= h;
  }
  return { r: new THREE.Vector3(s[0], s[1], s[2]), v: new THREE.Vector3(s[3], s[4], s[5]), t: tt };
}

// ---------- planners: each returns a node {t, dv: Vector3 (I frame), label} or null ----------

export function planCircularize(ship, atApo = true) {
  const body = ship.env.body;
  const rs = relState(ship, body);
  const el = elements(rs.r, rs.v, rs.mu);
  if (el.e >= 1) return null;
  const dtTo = atApo ? el.tAp : el.tPe;
  if (!isFinite(dtTo)) return null;
  const st = propagate(ship.r, ship.v, ship.t, dtTo);
  const rel = body === EARTH ? { r: st.r, v: st.v } : (() => { moonPos(st.t, _m); moonVel(st.t, _mv); return { r: st.r.clone().sub(_m), v: st.v.clone().sub(_mv) }; })();
  const rl = rel.r.length();
  const vc = Math.sqrt(rs.mu / rl);
  const { pro, rad } = basis(rel.r, rel.v);
  // target velocity: horizontal, circular speed
  const horiz = rel.v.clone().addScaledVector(rel.r.clone().normalize(), -rel.v.dot(rel.r) / rl).normalize();
  const dv = horiz.multiplyScalar(vc).sub(rel.v);
  return { t: st.t, dv, label: atApo ? 'Circularize at apoapsis' : 'Circularize at periapsis' };
}

// change periapsis (Earth or Moon) with a burn at apoapsis or now
export function planPeriapsis(ship, targetAlt, now = false) {
  const body = ship.env.body;
  const rs = relState(ship, body);
  const el = elements(rs.r, rs.v, rs.mu);
  const dtTo = now || el.e >= 1 || !isFinite(el.tAp) ? 30 : el.tAp;
  const st = propagate(ship.r, ship.v, ship.t, dtTo);
  let r, v;
  if (body === EARTH) { r = st.r; v = st.v; } else { moonPos(st.t, _m); moonVel(st.t, _mv); r = st.r.clone().sub(_m); v = st.v.clone().sub(_mv); }
  const { pro } = basis(r, v);
  // binary search the prograde/retrograde dv that gives the requested periapsis
  const target = rs.R + targetAlt;
  let lo = -v.length(), hi = v.length() * 0.5;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const e2 = elements(r, v.clone().addScaledVector(pro, mid), rs.mu);
    const pe = e2.pe;
    if (pe > target) hi = mid; else lo = mid;
  }
  return { t: st.t, dv: pro.clone().multiplyScalar((lo + hi) / 2), label: `Set periapsis ${Math.round(targetAlt / 1000)} km` };
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

// Trans-lunar injection from Earth orbit: search burn time and prograde dv for a lunar periapsis near targetAlt.
export async function planMoonTransfer(ship, targetAlt = 120000, onProgress) {
  if (ship.env.body !== EARTH) return null;
  const el = elements(ship.r, ship.v, EARTH.mu);
  if (el.e >= 1) return null;
  const period = el.period;
  const rp = ship.r.length();
  const vNow = ship.v.length();
  // Hohmann estimate to lunar distance
  const aT = (rp + 384400e3) / 2;
  const vT = Math.sqrt(EARTH.mu * (2 / rp - 1 / aT));
  const dv0 = clamp(vT - vNow, 2800, 3400);
  const tryNode = (tOff, dv) => {
    const st = propagate(ship.r, ship.v, ship.t, tOff);
    const { pro } = basis(st.r, st.v);
    const v2 = st.v.clone().addScaledVector(pro, dv);
    const pr = predict(st.r, v2, st.t, { maxT: 7 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800 });
    return { st, pro, pr, d: pr.closeMoon.d, tHit: pr.closeMoon.t };
  };
  let best = null;
  const N = 36;
  for (let i = 0; i < N; i++) {
    const tOff = 60 + (period * i) / N;
    for (const dv of [dv0 - 40, dv0, dv0 + 40]) {
      const r = tryNode(tOff, dv);
      const score = Math.abs(r.d - (MOON.R + targetAlt));
      if (!best || score < best.score) best = { ...r, score, tOff, dv };
    }
    if (onProgress) onProgress(i / N * 0.6);
    if (i % 3 === 0) await yieldFrame();
  }
  if (!best) return null;
  // refine with coordinate descent
  let { tOff, dv } = best;
  let stepT = period / N / 2, stepV = 20;
  for (let it = 0; it < 24; it++) {
    let improved = false;
    for (const [dt, ddv] of [[stepT, 0], [-stepT, 0], [0, stepV], [0, -stepV]]) {
      const t2 = Math.max(30, tOff + dt), v2 = dv + ddv;
      const r = tryNode(t2, v2);
      const score = Math.abs(r.d - (MOON.R + targetAlt));
      if (score < best.score) { best = { ...r, score, tOff: t2, dv: v2 }; tOff = t2; dv = v2; improved = true; }
    }
    if (!improved) { stepT /= 2; stepV /= 2; }
    if (onProgress) onProgress(0.6 + (it / 24) * 0.4);
    await yieldFrame();
  }
  if (best.d > MOON.soi) return null;
  return { t: best.st.t, dv: best.pro.clone().multiplyScalar(best.dv), label: 'Trans-lunar injection', arrive: best.tHit, moonPe: best.d - MOON.R };
}

// From lunar orbit (or flyby) back to Earth: target an Earth periapsis of ~45 km for aerobraking reentry.
export async function planReturn(ship, targetAlt = 45000, onProgress) {
  const body = ship.env.body;
  if (body !== MOON) return null;
  const rs = relState(ship, MOON);
  const el = elements(rs.r, rs.v, MOON.mu);
  const period = el.e < 1 ? el.period : 4 * 3600;
  const tryNode = (tOff, dv) => {
    const st = propagate(ship.r, ship.v, ship.t, tOff);
    moonVel(st.t, _mv); moonPos(st.t, _m);
    const rel = st.v.clone().sub(_mv);
    const pro = rel.clone().normalize();
    const v2 = st.v.clone().addScaledVector(pro, dv);
    const pr = predict(st.r, v2, st.t, { maxT: 6 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800, earthStop: 0 });
    let d = pr.earthPe.d;
    if (pr.impact && pr.impact.body === MOON) d = 1e12;
    return { st, pro, pr, d };
  };
  let best = null;
  const N = 36;
  for (let i = 0; i < N; i++) {
    const tOff = 30 + (period * i) / N;
    for (const dv of [800, 900, 1000, 1150]) {
      const r = tryNode(tOff, dv);
      const score = Math.abs(r.d - (EARTH.R + targetAlt));
      if (!best || score < best.score) best = { ...r, score, tOff, dv };
    }
    if (onProgress) onProgress(i / N * 0.6);
    if (i % 2 === 0) await yieldFrame();
  }
  let { tOff, dv } = best;
  let stepT = period / N / 2, stepV = 40;
  for (let it = 0; it < 26; it++) {
    let improved = false;
    for (const [dt, ddv] of [[stepT, 0], [-stepT, 0], [0, stepV], [0, -stepV]]) {
      const t2 = Math.max(20, tOff + dt), v2 = Math.max(100, dv + ddv);
      const r = tryNode(t2, v2);
      const score = Math.abs(r.d - (EARTH.R + targetAlt));
      if (score < best.score) { best = { ...r, score, tOff: t2, dv: v2 }; tOff = t2; dv = v2; improved = true; }
    }
    if (!improved) { stepT /= 2; stepV /= 2; }
    if (onProgress) onProgress(0.6 + (it / 26) * 0.4);
    await yieldFrame();
  }
  if (best.score > 400000) return null;
  return { t: best.st.t, dv: best.pro.clone().multiplyScalar(best.dv), label: 'Return to Earth', earthPe: best.d - EARTH.R };
}

// Capture into lunar orbit at the next periapsis
export function planCapture(ship, targetAlt) {
  const rs = relState(ship, MOON);
  const el = elements(rs.r, rs.v, MOON.mu);
  const dtTo = isFinite(el.tPe) && el.tPe > 0 ? el.tPe : 60;
  const st = propagate(ship.r, ship.v, ship.t, dtTo);
  moonPos(st.t, _m); moonVel(st.t, _mv);
  const r = st.r.clone().sub(_m), v = st.v.clone().sub(_mv);
  const rl = r.length();
  const vc = Math.sqrt(MOON.mu / rl);
  const horiz = v.clone().addScaledVector(r.clone().normalize(), -v.dot(r) / rl).normalize();
  const dv = horiz.multiplyScalar(vc).sub(v);
  return { t: st.t, dv, label: 'Lunar orbit capture' };
}

export function burnTime(ship, dv) {
  const craft = ship.craft;
  let T = 0, mdot = 0;
  for (const P of craft.engines) {
    const [t, isp] = craft.engineOutput(P, { ...ship.env, rho: 0, p: 0, mach: 0, h: 1e6 });
    if (t > 0) { T += t; mdot += t / (isp * 9.80665); }
  }
  if (T <= 0) return Infinity;
  const ve = T / mdot, m0 = craft.mass;
  const m1 = m0 / Math.exp(dv / ve);
  return (m0 - m1) / mdot;
}

// delta-v available (vacuum) from current propellant
// engine classes: 'lift' (thrust across the nose axis), 'jets' (air-breathing), 'main' (rockets and fusion)
export function engineClass(P) {
  const e = P.eng.e;
  if (e.lift || Math.abs(P.eng.dir.z) < 0.5) return 'lift';
  if (e.type === 'jet' || e.type === 'scram') return 'jets';
  return 'main';
}

export function deltaV(craft, atm = false, filter = null) {
  let T = 0, mdot = 0;
  const env = atm ? { rho: 1.225, p: 101325, mach: 0, h: 0, a: 340 } : { rho: 0, p: 0, mach: 0, h: 1e6, a: 300 };
  const use = {};
  // by default use the main engines in vacuum and the air-breathers in air (falling back to whatever exists)
  if (!filter) {
    const cls = craft.engines.map(engineClass);
    const want = atm ? (cls.includes('jets') || craft.engines.some((P) => P.eng.e.type === 'hybrid') ? ['jets', 'main'] : ['main']) : ['main'];
    filter = cls.some((c) => want.includes(c)) ? (P) => want.includes(engineClass(P)) : () => true;
  }
  for (const P of craft.engines) {
    if (!P.alive || !filter(P)) continue;
    const saveMode = P.eng.mode;
    if (P.eng.e.type === 'hybrid' && !atm) P.eng.mode = 'rocket';
    const [t, isp] = craft.engineOutput(P, env);
    if (t > 0) {
      T += t; mdot += t / (isp * 9.80665);
      const mix = craft.fuelMix(P);
      for (const k in mix) use[k] = (use[k] || 0) + mix[k] * t / (isp * 9.80665);
    }
    P.eng.mode = saveMode;
  }
  if (mdot <= 0) return 0;
  const ve = T / mdot;
  // burn until the first resource runs out
  let tMax = Infinity;
  for (const k in use) tMax = Math.min(tMax, craft.amount(k) / use[k]);
  if (!isFinite(tMax)) return 0;
  const m0 = craft.mass, m1 = m0 - mdot * tMax;
  return ve * Math.log(m0 / Math.max(1, m1));
}
