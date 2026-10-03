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
  let closeMoon = { d: Infinity, t: 0, r: null, v: null }, impact = null, soiIn = null, soiOut = null, earthPe = { d: Infinity, t: 0, hx: 0, hy: 0, hz: 0 };
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
    if (de < earthPe.d) {
      // closest point to Earth, with the orbit's angular momentum there (its plane and direction)
      earthPe.d = de; earthPe.t = t; earthPeIdx = earthPts.length / 3;
      earthPe.hx = s[1] * s[5] - s[2] * s[4]; earthPe.hy = s[2] * s[3] - s[0] * s[5]; earthPe.hz = s[0] * s[4] - s[1] * s[3];
    }
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

// Time until the apsis (periapsis or apoapsis about `body`) nearest the two-body estimate dt0, found on the
// real Earth–Moon trajectory: far from a circular orbit the other body's pull can move it by many minutes.
export function refineApsis(ship, body, dt0, peri = true) {
  const rv = (st) => {
    if (body !== MOON) return st.r.dot(st.v);
    moonPos(st.t, _m); moonVel(st.t, _mv);
    return st.r.clone().sub(_m).dot(st.v.clone().sub(_mv));
  };
  const W = clamp(dt0 * 0.25, 600, 6 * 3600), N = 48;
  const t0 = Math.max(1, dt0 - W), step = (dt0 + W - t0) / N;
  let st = propagate(ship.r, ship.v, ship.t, t0), f = rv(st), best = null;
  for (let i = 0; i < N; i++) {
    const nx = propagate(st.r, st.v, st.t, step), fn = rv(nx);
    if (peri ? f < 0 && fn >= 0 : f > 0 && fn <= 0) {
      let a = st, b = nx;
      for (let k = 0; k < 30 && b.t - a.t > 0.05; k++) {
        const m = propagate(a.r, a.v, a.t, (b.t - a.t) / 2);
        if ((rv(m) < 0) === peri) a = m; else b = m;
      }
      const tt = (a.t + b.t) / 2 - ship.t;
      if (best === null || Math.abs(tt - dt0) < Math.abs(best - dt0)) best = tt;
    }
    st = nx; f = fn;
  }
  return best ?? dt0;
}

export function planCircularize(ship, atApo = true) {
  const body = ship.env.body;
  const rs = relState(ship, body);
  const el = elements(rs.r, rs.v, rs.mu);
  if (el.e >= 1) return null;
  let dtTo = atApo ? el.tAp : el.tPe;
  if (!isFinite(dtTo)) return null;
  if (el.e > 0.02 && dtTo > 300) dtTo = refineApsis(ship, body, dtTo, !atApo);
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
  let dtTo = now || el.e >= 1 || !isFinite(el.tAp) ? 30 : el.tAp;
  if (dtTo > 300 && el.e > 0.02 && el.e < 1) dtTo = refineApsis(ship, body, dtTo, false);
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
// ---- coming home from the Moon ----
// Velocity at position r on the two-body hyperbola (about mu) whose outgoing asymptote is vInf.
function hyperbolaVel(r, vInf, mu) {
  const rl = r.length(), vi = vInf.length();
  const rh = r.clone().divideScalar(rl), u = vInf.clone().divideScalar(vi);
  const cphi = clamp(rh.dot(u), -1, 1);
  const w = u.clone().addScaledVector(rh, -cphi);
  if (w.lengthSq() < 1e-8) return null;
  w.normalize();
  const sphi = Math.sqrt(1 - cphi * cphi);
  const k = rl * vi * vi / mu;
  const s = (k * sphi + Math.sqrt(k * k * sphi * sphi + 4 * k * (1 - cphi))) / 2;   // sqrt(e² − 1)
  const e = Math.sqrt(1 + s * s), h = Math.sqrt(mu * mu * s * s / (vi * vi));
  const thR = Math.acos(-1 / e) - Math.acos(cphi);
  return rh.multiplyScalar((mu / h) * e * Math.sin(thR)).addScaledVector(w, h / rl);
}
// Rotate an orbit-plane normal about the axis `rh` by the smallest angle that gives an inclination of at least iMin.
function tiltPlane(n0, rh, iMin) {
  const n = n0.clone().addScaledVector(rh, -n0.dot(rh)).normalize();
  const a = new THREE.Vector3().crossVectors(rh, n);
  const inc = (p) => Math.acos(clamp(Math.cos(p) * n.y + Math.sin(p) * a.y, -1, 1));
  const ok = (i) => i >= iMin && i <= Math.PI - iMin;
  if (!iMin || ok(inc(0))) return { n, psi: 0, inc: inc(0) };
  for (let d = 0.25; d <= 90; d += 0.25) for (const sg of [1, -1]) {
    const p = sg * d * Math.PI / 180;
    if (ok(inc(p))) return { n: n.clone().multiplyScalar(Math.cos(p)).addScaledVector(a, Math.sin(p)), psi: p, inc: inc(p) };
  }
  const p = inc(Math.PI / 2) > inc(-Math.PI / 2) ? Math.PI / 2 : -Math.PI / 2;
  return { n: n.clone().multiplyScalar(Math.cos(p)).addScaledVector(a, Math.sin(p)), psi: p, inc: inc(p) };
}
// Earth-relative departure from the Moon's distance that falls back to a periapsis at `goal`: falling inward at
// vr, in the plane through the Earth–Moon line tilted by psi from the Moon's own orbital plane. Returned as the
// excess velocity relative to the Moon, with the arrival orbit's plane normal and inclination.
function returnAim(t, goal, psi, vr) {
  moonPos(t, _m); moonVel(t, _mv);
  const R = _m.length(), rh = _m.clone().normalize();
  const t0 = _mv.clone().addScaledVector(rh, -_mv.dot(rh)).normalize();
  const side = new THREE.Vector3().crossVectors(rh, t0);
  let Vt = 190;
  for (let k = 0; k < 5; k++) { const eps = (vr * vr + Vt * Vt) / 2 - EARTH.mu / R; Vt = goal * Math.sqrt(2 * (eps + EARTH.mu / goal)) / R; }
  const n = side.multiplyScalar(Math.cos(psi)).addScaledVector(t0, -Math.sin(psi));
  const tv = new THREE.Vector3().crossVectors(n, rh);
  const V = rh.clone().multiplyScalar(vr).addScaledVector(tv, Vt);
  return { vInf: V.sub(_mv), n, inc: Math.acos(clamp(n.y, -1, 1)) };
}

// Simulate a finite burn whose direction is held fixed in the orbital frame (prograde/normal/radial
// components `comp`) relative to `body`, centred on tNode — the way the burn executor flies it.
function simBurnComp(base, perf, tNode, comp, dv, body) {
  const ve = perf.T / perf.mdot;
  const bt = (perf.m0 - perf.m0 / Math.exp(Math.abs(dv) / ve)) / perf.mdot;
  const st0 = propagate(base.r, base.v, base.t, Math.max(0, tNode - bt / 2 - base.t));
  const s = [st0.r.x, st0.r.y, st0.r.z, st0.v.x, st0.v.y, st0.v.z];
  let t = st0.t, m = perf.m0;
  const n = Math.max(4, Math.ceil(bt / 2)), h = bt / n;
  const r = new THREE.Vector3(), v = new THREE.Vector3(), nor = new THREE.Vector3(), rad = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    rk4(s, t, h);
    t += h;
    r.set(s[0], s[1], s[2]); v.set(s[3], s[4], s[5]);
    if (body === MOON) { r.sub(moonPos(t, _m)); v.sub(moonVel(t, _mv)); }
    nor.crossVectors(r, v).normalize(); v.normalize(); rad.crossVectors(nor, v);
    d.copy(v).multiplyScalar(comp.x).addScaledVector(nor, comp.y).addScaledVector(rad, comp.z).normalize().multiplyScalar(perf.T / m * h);
    s[3] += d.x; s[4] += d.y; s[5] += d.z;
    m -= perf.mdot * h;
  }
  const R = new THREE.Vector3(s[0], s[1], s[2]), V = new THREE.Vector3(s[3], s[4], s[5]);
  const rr = body === MOON ? R.clone().sub(moonPos(t, _m)) : R, vv = body === MOON ? V.clone().sub(moonVel(t, _mv)) : V;
  return { r: R, v: V, t, energy: vv.lengthSq() / 2 - body.mu / rr.length(), bt };
}

// Aim a burn at state `st` (burn frame relative to `frameBody`) so the craft arrives at Earth with its
// periapsis at radius `goal` and, if iT is given, an orbital inclination of iT. Levenberg–Marquardt on the
// arrival orbit's angular momentum (its size sets the periapsis, its tilt the inclination), which unlike the
// periapsis height stays smooth even through a head-on approach. With `perf` the burn is simulated as the
// finite burn the executor will fly.
async function aimEarth(st, frameBody, goal, iT, dv0, onProgress, perf = null, base = null) {
  const m = moonPos(st.t, new THREE.Vector3()), mv = moonVel(st.t, new THREE.Vector3());
  const rel = frameBody === MOON;
  const b = basis(rel ? st.r.clone().sub(m) : st.r, rel ? st.v.clone().sub(mv) : st.v);
  const vec = (c) => b.pro.clone().multiplyScalar(c.x).addScaledVector(b.nor, c.y).addScaledVector(b.rad, c.z);
  const cosT = iT == null ? 0 : Math.cos(iT);
  const evalC = (c) => {
    let r0 = st.r, v0, t0 = st.t, energy = null;
    if (perf && c.length() > 5 && Math.abs(c.x) > 0.8 * c.length()) {
      const bs = simBurnComp(base, perf, st.t, c.clone().normalize(), c.length(), frameBody);
      r0 = bs.r; v0 = bs.v; t0 = bs.t; energy = bs.energy;
    } else v0 = st.v.clone().add(vec(c));
    const pr = predict(r0, v0, t0, { maxT: 7 * 86400, maxSteps: 3000, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9, moonStop: false });
    const pe = pr.earthPe, d = Math.max(1, pe.d);
    const h = new THREE.Vector3(pe.hx, pe.hy, pe.hz), hl = Math.max(1, h.length());
    const vp = hl / d;
    const hG = goal * Math.sqrt(Math.max(0, vp * vp + 2 * EARTH.mu / goal - 2 * EARTH.mu / d));
    const ok = pe.t < pr.tEnd - 600 && !(pr.impact && pr.impact.body === MOON);
    const res = new THREE.Vector3(hl - hG, iT == null ? 0 : h.y - hl * cosT, 0);
    return { res, d, h, ok, energy, inc: Math.acos(clamp(h.y / hl, -1, 1)) };
  };
  const incOk = (r) => iT == null || Math.abs(r.inc - iT) < 0.0035;
  const done = (r) => r.ok && Math.abs(r.d - goal) < Math.max(2000, (goal - EARTH.R) * 0.01) && incOk(r);
  let x = new THREE.Vector3(dv0.dot(b.pro), dv0.dot(b.nor), dv0.dot(b.rad));
  let cur = evalC(x);
  const E3 = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const dlt = 0.3;
  let lam = 1e-3;
  for (let it = 0; it < 20 && !done(cur); it++) {
    const cols = E3.map((e) => evalC(x.clone().addScaledVector(e, dlt)).res.sub(evalC(x.clone().addScaledVector(e, -dlt)).res).divideScalar(2 * dlt));
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], g = [0, 0, 0];
    for (let i = 0; i < 3; i++) { g[i] = -cols[i].dot(cur.res); for (let j = 0; j < 3; j++) A[i][j] = cols[i].dot(cols[j]); }
    const tr = A[0][0] + A[1][1] + A[2][2];
    let ok = false;
    for (let k = 0; k < 10; k++) {
      const M = A.map((row, i) => row.map((v, j) => v + (i === j ? lam * tr + 1e-9 * tr : 0)));
      const step = solve3(M, g);
      if (!step) { lam *= 10; continue; }
      if (step.length() > 300) step.setLength(300);
      const tryX = x.clone().add(step), r = evalC(tryX);
      if (r.res.length() < cur.res.length()) { x = tryX; cur = r; lam = Math.max(1e-9, lam / 5); ok = true; break; }
      lam *= 8;
    }
    if (onProgress) onProgress(Math.min(1, (it + 1) / 8));
    await yieldFrame();
    if (!ok) break;
  }
  if (globalThis.__dbgRet) console.log('  aimEarth', { dv: x.length().toFixed(1), peKm: ((cur.d - EARTH.R) / 1e3).toFixed(1), incDeg: (cur.inc * 180 / Math.PI).toFixed(2), iT: iT == null ? '-' : (iT * 180 / Math.PI).toFixed(2), ok: cur.ok });
  if (!cur.ok || Math.abs(cur.d - goal) > 40000 || (iT != null && Math.abs(cur.inc - iT) > 0.02)) return null;
  return { dv: vec(x), d: cur.d, inc: cur.inc, energy: cur.energy };
}

// Trans-Earth injection from lunar orbit: a burn that brings the craft back to a periapsis at targetAlt, in
// an orbit tilted at least opts.iMin (radians) so it passes over the home airport's latitude.
export async function planReturn(ship, targetAlt = 45000, onProgress, opts = {}) {
  if (ship.env.body !== MOON) return null;
  const rs = relState(ship, MOON);
  const el = elements(rs.r, rs.v, MOON.mu);
  if (!(el.e < 1)) return null;
  const goal = EARTH.R + targetAlt, iMin = opts.iMin || 0;
  const perf = vacPerf(ship);
  const lead = Math.max(120, (perf ? burnTime(ship, 900) / 2 : 0) + 90);
  // 1) patched conics: over the next day, the cheapest point in the orbit to leave from and the way to leave
  // (how fast to fall back, how to tilt the arrival orbit), keeping the tilt that reaches the home latitude
  const okInc = (i) => i >= iMin && i <= Math.PI - iMin;
  const PSI = [], VR = [-750, -550, -400, -250];
  for (let d = -90; d <= 90; d += 6) PSI.push(d * Math.PI / 180);
  const K = 72, span = Math.min(24 * 3600, Math.max(el.period, 12 * el.period));
  const nPts = Math.ceil(span / (el.period / K));
  let best = null;
  const opts2 = [];
  let st = propagate(ship.r, ship.v, ship.t, lead);
  const r = new THREE.Vector3(), v = new THREE.Vector3();
  for (let k = 0; k < nPts; k++) {
    if (k) st = propagate(st.r, st.v, st.t, el.period / K);
    moonPos(st.t, _m); moonVel(st.t, _mv);
    r.copy(st.r).sub(_m); v.copy(st.v).sub(_mv);
    let bk = null;
    for (const psi of PSI) for (const vr of VR) {
      const aim = returnAim(st.t + 8 * 3600, goal, psi, vr);
      if (!okInc(aim.inc)) continue;
      const vb = hyperbolaVel(r, aim.vInf, MOON.mu);
      if (!vb) continue;
      // a slight preference for the Moon's own plane, and a strong one for coming home the same way Earth
      // turns (a retrograde orbit meets the atmosphere almost 1 km/s faster)
      const dv = vb.sub(v), cost = dv.length() + Math.abs(psi) * 20 + (aim.inc > Math.PI / 2 ? 250 : 0);
      if (!bk || cost < bk.cost) bk = { cost, st, dv, aim, tOff: st.t - ship.t, psi, vr };
    }
    if (bk) opts2.push(bk);
    if (k % 8 === 0) { await yieldFrame(); if (onProgress) onProgress((k / nPts) * 0.3); }
  }
  for (const o of opts2) if (!best || o.cost < best.cost) best = o;
  // an earlier departure that costs little more beats waiting
  if (best) best = opts2.find((o) => o.cost < best.cost + Math.max(40, best.cost * 0.04)) || best;
  if (!best) return null;
  if (globalThis.__dbgRet) console.log('  patched', { cost: best.cost.toFixed(0), dv: best.dv.length().toFixed(0), waitH: (best.tOff / 3600).toFixed(1), psi: (best.psi * 180 / Math.PI).toFixed(0), vr: best.vr, inc: (best.aim.inc * 180 / Math.PI).toFixed(1), minCost: Math.min(...opts2.map((o) => o.cost)).toFixed(0), n: opts2.length });
  // 2) refine on the real Earth–Moon dynamics
  const base = propagate(ship.r, ship.v, ship.t, Math.max(0, best.tOff - (perf ? burnTime(ship, best.cost) : 0) / 2 - 30));
  const iT = iMin ? clamp(best.aim.inc, iMin + 0.005, Math.PI - iMin - 0.005) : null;
  const ref = await aimEarth(best.st, MOON, goal, iT, best.dv, (f) => onProgress && onProgress(0.3 + 0.7 * f), perf, base);
  if (!ref) return null;
  const node = { t: best.st.t, dv: ref.dv, body: MOON, label: 'Return to Earth', earthPe: ref.d - EARTH.R, inc: ref.inc };
  if (ref.energy != null) node.eTarget = ref.energy;
  return node;
}

// Mid-course correction: the cheapest small burn that puts the closest approach to `target` at `targetAlt`.
// Tries a few burn times (now, and later in a long coast, where sideways corrections are cheaper).
export async function planCorrection(ship, target, targetAlt, onProgress, opts = {}) {
  const goal = (target === MOON ? MOON.R : EARTH.R) + targetAlt;
  const now = predict(ship.r, ship.v, ship.t, { maxT: 7 * 86400, maxSteps: 3000, oneRev: false, maxStep: 1800, earthStop: -EARTH.R * 0.9, moonStop: false });
  if (target === EARTH && opts.iMin) {
    // also tilt the arrival orbit to pass over the home latitude (keeping whatever tilt already does)
    const h = new THREE.Vector3(now.earthPe.hx, now.earthPe.hy, now.earthPe.hz);
    const inc = Math.acos(clamp(h.y / Math.max(1, h.length()), -1, 1));
    const iT = clamp(inc, opts.iMin + 0.005, Math.PI - opts.iMin - 0.005);
    const tArr = now.earthPe.t - ship.t;
    const leads = [120, 3 * 3600, 8 * 3600, 16 * 3600, 30 * 3600].filter((l) => l === 120 || l < tArr * 0.6);
    let best = null;
    for (let i = 0; i < leads.length; i++) {
      const st = propagate(ship.r, ship.v, ship.t, leads[i]);
      moonPos(st.t, _m);
      const frame = st.r.distanceTo(_m) < MOON.soi ? MOON : EARTH;
      const r = await aimEarth(st, frame, goal, iT, new THREE.Vector3(), (f) => onProgress && onProgress((i + f) / leads.length));
      if (r && r.dv.length() > 0.05 && (!best || r.dv.length() < best.dv.length() * 0.6)) best = { t: st.t, dv: r.dv, body: frame, label: 'Course correction (Earth)', earthPe: r.d - EARTH.R, inc: r.inc };
    }
    return best;
  }
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
  let dtTo = isFinite(el.tPe) && el.tPe > 0 ? el.tPe : 60;
  // far out, Earth's pull makes the two-body periapsis time drift by minutes: find the real closest approach
  if (dtTo > 600) {
    const pr = predict(ship.r, ship.v, ship.t, { maxT: dtTo * 1.5 + 3600, maxSteps: 3000, oneRev: false, maxStep: 600, earthStop: -EARTH.R * 0.9, moonStop: false });
    if (pr.closeMoon.r) dtTo = pr.closeMoon.t - ship.t;
    const radial = (st) => { moonPos(st.t, _m); moonVel(st.t, _mv); return st.r.clone().sub(_m).dot(st.v.clone().sub(_mv)); };
    const a = Math.max(1, dtTo - 1200), base = propagate(ship.r, ship.v, ship.t, a);
    if (radial(base) < 0 && radial(propagate(base.r, base.v, base.t, 2400)) > 0) {
      let lo = 0, hi = 2400;
      for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (radial(propagate(base.r, base.v, base.t, mid)) < 0) lo = mid; else hi = mid; }
      dtTo = a + (lo + hi) / 2;
    }
  }
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
