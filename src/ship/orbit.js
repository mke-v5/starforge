// Orbital mechanics helpers: elements, trajectory prediction (Earth + Moon gravity) and burn planners.

import * as THREE from 'three';
import { EARTH, MOON, clamp, llh, toLLH, gcDist } from '../core/geo.js';
import { moonPos, moonVel, gravity, earthAngle } from '../core/astro.js';
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
  let inSoi = null, soiInIdx = -1, soiOutIdx = -1, startInSoi = false, earthPeIdx = 0;
  const startR = Math.hypot(s[0], s[1], s[2]);
  let angle = 0, lastDir = new THREE.Vector3(s[0], s[1], s[2]).normalize();
  const dir = new THREE.Vector3();
  for (let i = 0; i < maxSteps && t - t0 < maxT; i++) {
    moonPos(t, _m);
    const dx = s[0] - _m.x, dy = s[1] - _m.y, dz = s[2] - _m.z;
    const dm = Math.hypot(dx, dy, dz);
    const de = Math.hypot(s[0], s[1], s[2]);
    const nowSoi = dm < MOON.soi;
    if (inSoi === null) { inSoi = nowSoi; startInSoi = nowSoi; }
    if (nowSoi && !inSoi && !soiIn) { soiIn = t; soiInIdx = earthPts.length / 3; }
    if (!nowSoi && inSoi && (soiIn || startInSoi) && !soiOut) { soiOut = t; soiOutIdx = earthPts.length / 3; }
    inSoi = nowSoi;
    if (dm < closeMoon.d) { closeMoon = { d: dm, t, r: new THREE.Vector3(dx, dy, dz), v: null, vI: new THREE.Vector3(s[3], s[4], s[5]) }; }
    if (de < earthPe.d) { earthPe = { d: de, t }; earthPeIdx = earthPts.length / 3; }
    earthPts.push(s[0], s[1], s[2]);
    if (nowSoi) moonPts.push(dx, dy, dz, t);
    if (de < EARTH.R + (opts.earthStop ?? 0)) { impact = { body: EARTH, t, r: new THREE.Vector3(s[0], s[1], s[2]) }; break; }
    if (opts.moonStop !== false && dm < MOON.R + 200) { impact = { body: MOON, t, r: new THREE.Vector3(dx, dy, dz) }; break; }
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
  return { earthPts, moonPts, closeMoon, impact, soiIn, soiOut, soiInIdx, soiOutIdx, startInSoi, earthPe, earthPeIdx, tEnd: t };
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
  return { t: st.t, dv, body, label: atApo ? 'Circularize at apoapsis' : 'Circularize at periapsis' };
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
  return { t: st.t, dv: pro.clone().multiplyScalar((lo + hi) / 2), body, label: `Set periapsis ${Math.round(targetAlt / 1000)} km` };
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

// thrust and mass flow of the active engines in vacuum (with thrust trim)
function vacPerf(ship) {
  const craft = ship.craft;
  let T = 0, mdot = 0;
  for (const P of craft.engines) {
    if (!P.eng.active) continue;
    const [t, isp] = craft.engineOutput(P, { rho: 0, p: 0, mach: 0, h: 1e6, a: 300 });
    const tb = t * (P.eng.bal ?? 1);
    if (tb > 0) { T += tb; mdot += tb / (isp * 9.80665); }
  }
  return T > 0 ? { T, mdot, m0: craft.mass } : null;
}

// Simulate a finite burn that follows prograde (sign +1) or retrograde (-1) relative to `body`, centred on
// tNode and lasting long enough for an impulsive-equivalent dv. Returns the state after the burn and its
// specific orbital energy relative to `body` (what the burn executor cuts off on).
function simBurn(ship, perf, tNode, dv, body, sign = 1) {
  const ve = perf.T / perf.mdot;
  const bt = (perf.m0 - perf.m0 / Math.exp(Math.abs(dv) / ve)) / perf.mdot;
  const t0 = tNode - bt / 2;
  const st0 = t0 > ship.t ? propagate(ship.r, ship.v, ship.t, t0 - ship.t) : { r: ship.r.clone(), v: ship.v.clone(), t: ship.t };
  const s = [st0.r.x, st0.r.y, st0.r.z, st0.v.x, st0.v.y, st0.v.z];
  let t = st0.t, m = perf.m0;
  const n = Math.max(4, Math.ceil(bt / 2));
  const h = bt / n;
  const vr = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    rk4(s, t, h);
    t += h;
    vr.set(s[3], s[4], s[5]);
    if (body === MOON) vr.sub(moonVel(t, _mv));
    vr.normalize().multiplyScalar(sign * perf.T / m * h);
    s[3] += vr.x; s[4] += vr.y; s[5] += vr.z;
    m -= perf.mdot * h;
  }
  const r = new THREE.Vector3(s[0], s[1], s[2]), v = new THREE.Vector3(s[3], s[4], s[5]);
  const rr = body === MOON ? r.clone().sub(moonPos(t, _m)) : r, vv = body === MOON ? v.clone().sub(moonVel(t, _mv)) : v;
  const energy = vv.lengthSq() / 2 - body.mu / rr.length();
  return { r, v, t, energy, bt };
}

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
  const perf = vacPerf(ship);
  const tryNode = (tOff, dv) => {
    const st = propagate(ship.r, ship.v, ship.t, tOff);
    const { pro } = basis(st.r, st.v);
    let pr, eTarget = null;
    if (perf) {
      // model the real (minutes-long) burn so the executed trajectory matches the plan
      const b = simBurn(ship, perf, st.t, dv, EARTH, 1);
      pr = predict(b.r, b.v, b.t, { maxT: 7 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800 });
      eTarget = b.energy;
    } else pr = predict(st.r, st.v.clone().addScaledVector(pro, dv), st.t, { maxT: 7 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800 });
    return { st, pro, pr, d: pr.closeMoon.d, tHit: pr.closeMoon.t, eTarget };
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
  return { t: best.st.t, dv: best.pro.clone().multiplyScalar(best.dv), body: EARTH, eTarget: best.eTarget, label: 'Trans-lunar injection', arrive: best.tHit, moonPe: best.d - MOON.R };
}

// From lunar orbit (or flyby) back to Earth: target an Earth periapsis of ~45 km for aerobraking reentry.
export async function planReturn(ship, targetAlt = 45000, onProgress) {
  const body = ship.env.body;
  if (body !== MOON) return null;
  const rs = relState(ship, MOON);
  const el = elements(rs.r, rs.v, MOON.mu);
  const period = el.e < 1 ? el.period : 4 * 3600;
  const perf = vacPerf(ship);
  const tryNode = (tOff, dv) => {
    const st = propagate(ship.r, ship.v, ship.t, tOff);
    moonVel(st.t, _mv); moonPos(st.t, _m);
    const rel = st.v.clone().sub(_mv);
    const pro = rel.clone().normalize();
    let pr, eTarget = null;
    if (perf) {
      const b = simBurn(ship, perf, st.t, dv, MOON, 1);
      pr = predict(b.r, b.v, b.t, { maxT: 6 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9 });
      eTarget = b.energy;
    } else pr = predict(st.r, st.v.clone().addScaledVector(pro, dv), st.t, { maxT: 6 * 86400, maxSteps: 2500, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9 });
    let d = pr.earthPe.d;
    if (pr.impact && pr.impact.body === MOON) d = 1e12;
    return { st, pro, pr, d, eTarget };
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
  return { t: best.st.t, dv: best.pro.clone().multiplyScalar(best.dv), body: MOON, eTarget: best.eTarget, label: 'Return to Earth', earthPe: best.d - EARTH.R };
}

// Mid-course correction: the cheapest small burn that puts the closest approach to `target` at `targetAlt`.
// Tries a few burn times (now, and later in a long coast, where sideways corrections are cheaper).
export async function planCorrection(ship, target, targetAlt, onProgress) {
  const goal = (target === MOON ? MOON.R : EARTH.R) + targetAlt;
  const now = predict(ship.r, ship.v, ship.t, { maxT: 7 * 86400, maxSteps: 3000, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9, moonStop: false });
  const tArr = (target === MOON ? now.closeMoon.t : now.earthPe.t) - ship.t;
  const leads = [120, 3 * 3600, 8 * 3600, 16 * 3600, 30 * 3600].filter((l) => l === 120 || l < tArr * 0.6);
  let best = null;
  for (let i = 0; i < leads.length; i++) {
    const r = await solveCorrection(ship, leads[i], target, goal, targetAlt, (f) => onProgress && onProgress((i + f) / leads.length));
    if (globalThis.__dbgMCC) console.log('  lead h', (leads[i] / 3600).toFixed(1), r && r.dv.length().toFixed(2));
    // a later burn has to be clearly cheaper to be worth the wait
    if (r && (!best || r.dv.length() < best.dv.length() * 0.6)) best = r;
  }
  return best;
}

async function solveCorrection(ship, lead, target, goal, targetAlt, onProgress) {
  const st = propagate(ship.r, ship.v, ship.t, lead);
  const body = ship.env.body;   // reference frame for the burn direction (prograde/normal/radial)
  const m = moonPos(st.t, new THREE.Vector3()), mv = moonVel(st.t, new THREE.Vector3());
  const inMoon = st.r.distanceTo(m) < MOON.soi;
  const b = basis(inMoon ? st.r.clone().sub(m) : st.r, inMoon ? st.v.clone().sub(mv) : st.v);
  const vec = (c) => b.pro.clone().multiplyScalar(c.x).addScaledVector(b.nor, c.y).addScaledVector(b.rad, c.z);
  const evalC = (c) => {
    const pr = predict(st.r, st.v.clone().add(vec(c)), st.t, { maxT: 7 * 86400, maxSteps: 3000, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9, moonStop: false });
    let p;
    if (target === MOON) p = pr.closeMoon.r ? pr.closeMoon.r.clone() : new THREE.Vector3(1e12, 0, 0);
    else { const s3 = pr.earthPts, i = pr.earthPeIdx ?? 0; p = new THREE.Vector3(s3[i * 3], s3[i * 3 + 1], s3[i * 3 + 2]); }
    const d = target === MOON ? p.length() : pr.earthPe.d;
    return { p, d, f: d - goal, pr };
  };
  let x = new THREE.Vector3();
  let cur = evalC(x);
  const f0 = Math.abs(cur.f);
  const tol = Math.max(500, targetAlt * 0.02);
  const E3 = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dlt = 0.25;
  let lam = 1e-3;
  for (let it = 0; it < 14 && Math.abs(cur.f) > tol; it++) {
    let ok = false;
    if (target === EARTH) {
      // only the height of the periapsis matters: scalar Newton with a minimum-norm step
      const J = new THREE.Vector3();
      for (let k = 0; k < 3; k++) J.setComponent(k, (evalC(x.clone().addScaledVector(E3[k], dlt)).f - evalC(x.clone().addScaledVector(E3[k], -dlt)).f) / (2 * dlt));
      const jj = J.lengthSq();
      if (jj < 1e-9) break;
      const step = J.clone().multiplyScalar(-cur.f / jj);
      if (step.length() > 400) step.setLength(400);
      for (let k = 0; k < 6; k++) {
        const tryX = x.clone().add(step), r = evalC(tryX);
        if (Math.abs(r.f) < Math.abs(cur.f)) { x = tryX; cur = r; ok = true; break; }
        step.multiplyScalar(0.4);
      }
    } else {
      // Moon: the miss is a 2-D aim point; Levenberg-Marquardt on the closest-approach position,
      // aimed at the goal radius along the current miss direction
      const R = cur.p.clone().sub(cur.p.clone().setLength(goal));
      const cols = E3.map((e) => evalC(x.clone().addScaledVector(e, dlt)).p.sub(evalC(x.clone().addScaledVector(e, -dlt)).p).divideScalar(2 * dlt));
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
      for (let i = 0; i < 3; i++) { g[i] = -cols[i].dot(R); for (let j = 0; j < 3; j++) A[i][j] = cols[i].dot(cols[j]); }
      const tr = A[0][0] + A[1][1] + A[2][2];
      for (let k = 0; k < 8; k++) {
        const M = A.map((row, i) => row.map((v, j) => v + (i === j ? lam * tr : 0)));
        const step = solve3(M, g);
        if (!step) { lam *= 10; continue; }
        if (step.length() > 400) step.setLength(400);
        const tryX = x.clone().add(step), r = evalC(tryX);
        if (Math.abs(r.f) < Math.abs(cur.f)) { x = tryX; cur = r; lam = Math.max(1e-7, lam / 5); ok = true; break; }
        lam *= 8;
      }
    }
    if (onProgress) onProgress(Math.min(1, (it + 1) / 6));
    await yieldFrame();
    if (!ok) break;
  }
  if (Math.abs(cur.f) > Math.max(tol * 40, 30000) && Math.abs(cur.f) >= f0 * 0.5) return null;
  if (Math.abs(cur.f) > tol * 10) return null;
  if (x.length() < 0.05) return null;
  const node = { t: st.t, dv: vec(x), body: inMoon ? MOON : EARTH, label: target === MOON ? 'Course correction (Moon)' : 'Course correction (Earth)' };
  if (target === MOON) node.moonPe = cur.d - MOON.R; else node.earthPe = cur.d - EARTH.R;
  return node;
}

function solve3(M, g) {
  const [a, b, c] = M;
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (!isFinite(det) || Math.abs(det) < 1e-30) return null;
  const inv = (r0, r1, r2) => r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) - r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) + r0[2] * (r1[0] * r2[1] - r1[1] * r2[0]);
  const col = (k) => M.map((row, i) => row.map((v, j) => (j === k ? g[i] : v)));
  return new THREE.Vector3(inv(...col(0)) / det, inv(...col(1)) / det, inv(...col(2)) / det);
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
  return { t: st.t, dv, body: MOON, label: 'Lunar orbit capture' };
}

// ---- returning to a place on Earth ----
const _Y = new THREE.Vector3(0, 1, 0);
// Earth-fixed position and surface-relative velocity of an inertial state
export function groundState(r, v, t) {
  const a = -earthAngle(t);
  const vs = v.clone().sub(new THREE.Vector3(0, EARTH.omega, 0).cross(r));
  return { p: r.clone().applyAxisAngle(_Y, a), v: vs.applyAxisAngle(_Y, a) };
}
// Remaining ground range of the belly-first glide once it has slowed below orbital speed (km/s -> km),
// measured from the reentry autopilot's nominal profile; above ~7 km/s the craft is still on its near-
// ballistic descent, which is predicted by following the orbit down to 55 km.
const GLIDE_TABLE = [[0.95, 15], [1.12, 50], [1.26, 86], [1.38, 125], [1.5, 168], [1.64, 215], [1.81, 266], [2.04, 323], [2.35, 384], [2.76, 451], [3.34, 521], [4.13, 597], [4.94, 681], [5.7, 776], [6.4, 887], [6.97, 1016]];
export const ENTRY_GLIDE = 1016e3;
export function glideRange(V) {
  const v = V / 1000, T = GLIDE_TABLE;
  if (v <= T[0][0]) return T[0][1] * 1000;
  for (let i = 1; i < T.length; i++) if (v <= T[i][0]) { const f = (v - T[i - 1][0]) / (T[i][0] - T[i - 1][0]); return (T[i - 1][1] + f * (T[i][1] - T[i - 1][1])) * 1000; }
  return T[T.length - 1][1] * 1000;
}
// Ground point (unit vector, Earth-fixed), track direction and ground distance travelled while coasting
// (no drag) from state (r, v, t) down to `alt`.
export function coastGround(r, v, t, alt) {
  let c = { r: r.clone(), v: v.clone(), t };
  let g0 = groundState(c.r, c.v, c.t).p.normalize(), last = g0.clone(), arc = 0;
  for (let k = 0; k < 2000 && c.r.length() - EARTH.R > alt; k++) {
    const step = clamp((c.r.length() - EARTH.R - alt) / Math.max(50, -c.v.dot(c.r) / c.r.length()) * 0.5, 2, 30);
    c = propagate(c.r, c.v, c.t, step);
    const p = groundState(c.r, c.v, c.t).p.normalize();
    arc += Math.acos(clamp(p.dot(last), -1, 1)) * EARTH.R;
    last = p;
  }
  const g = groundState(c.r, c.v, c.t);
  const p = g.p.normalize();
  const d = g.v.addScaledVector(p, -g.v.dot(p)).normalize();
  return { p, d, arc, state: c };
}

// Retrograde deorbit burn from orbit that brings periapsis to `peAlt`, timed so that after the reentry glide
// the craft arrives close to (lat, lon). Searches the next `hours` for the best pass.
export async function planDeorbitTo(ship, lat, lon, name = '', onProgress, peAlt = 40000, hours = 24) {
  if (ship.env.body !== EARTH) return null;
  const el = elements(ship.r, ship.v, EARTH.mu);
  if (el.e >= 1 || el.pe - EARTH.R < 125000) return null;
  const tgt = llh(lat, lon, 0, 1, new THREE.Vector3());
  const evalAt = (tOff, from) => {
    const st = from ? propagate(from.r, from.v, from.t, tOff - (from.t - ship.t)) : propagate(ship.r, ship.v, ship.t, tOff);
    const pro = st.v.clone().normalize();
    let lo = 0, hi = 800;
    for (let i = 0; i < 26; i++) {
      const m = (lo + hi) / 2;
      const e2 = elements(st.r, st.v.clone().addScaledVector(pro, -m), EARTH.mu);
      if (e2.pe - EARTH.R > peAlt) lo = m; else hi = m;
    }
    const dv = (lo + hi) / 2;
    // coast to 120 km quickly, then follow the near-ballistic descent to 55 km; the glide covers the rest
    let c = { r: st.r, v: st.v.clone().addScaledVector(pro, -dv), t: st.t };
    for (let k = 0; k < 400 && c.r.length() - EARTH.R > 125000; k++) {
      const next = propagate(c.r, c.v, c.t, 30);
      if (next.r.length() - EARTH.R < 125000) break;
      c = next;
    }
    const cg = coastGround(c.r, c.v, c.t, 55000);
    const th = ENTRY_GLIDE / EARTH.R;
    const end = cg.p.clone().multiplyScalar(Math.cos(th)).addScaledVector(cg.d, Math.sin(th));
    const miss = Math.acos(clamp(end.dot(tgt), -1, 1)) * EARTH.R;
    return { tOff, dv, pro, st, miss, end, entryP: cg.p.clone(), entryT: cg.state.t };
  };
  const span = hours * 3600;
  let best = null;
  const N = Math.ceil(span / 60);
  let cur = { r: ship.r.clone(), v: ship.v.clone(), t: ship.t };
  for (let i = 0; i < N; i++) {
    const tOff = 120 + i * 60;
    const prev = cur;
    const r = evalAt(tOff, cur);          // steps the running orbit state forward instead of starting over
    cur = r.st;
    if (!best || r.miss < best.miss) { best = r; best.prev = prev; }
    if (i % 25 === 0) { if (onProgress) onProgress(i / N * 0.9); await yieldFrame(); }
  }
  for (let step = 20; step >= 2; step /= 2) {
    for (const dt of [-step, step]) { const r = evalAt(Math.max(60, best.tOff + dt), best.prev); if (r.miss < best.miss) { r.prev = best.prev; best = r; } }
  }
  if (onProgress) onProgress(1);
  const endLL = toLLH(best.end, 1);
  if (globalThis.__dbgDeorbit) { const g = toLLH(best.entryP, 1); console.log('  planner entry120', g.lat.toFixed(2), g.lon.toFixed(2), 't', best.entryT.toFixed(0)); }
  return { t: best.st.t, dv: best.pro.clone().multiplyScalar(-best.dv), body: EARTH, label: `Deorbit to ${name || 'target'}`,
    target: { lat, lon, name }, miss: best.miss, endLat: endLL.lat, endLon: endLL.lon };
}

export function burnTime(ship, dv) {
  const craft = ship.craft;
  let T = 0, mdot = 0;
  for (const P of craft.engines) {
    if (!P.eng.active) continue;
    const [t, isp] = craft.engineOutput(P, ship.env.rho > 1e-4 ? ship.env : { ...ship.env, rho: 0, p: 0, mach: 0, h: 1e6 });
    const tb = t * (P.eng.bal ?? 1);
    if (tb > 0) { T += tb; mdot += tb / (isp * 9.80665); }
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
