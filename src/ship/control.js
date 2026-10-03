// Flight control computer: fly-by-wire rate control, SAS pointing modes, actuator mixing and autopilots.

import * as THREE from 'three';
import { EARTH, MOON, G0, clamp, smoothstep, D2R } from '../core/geo.js';
import { elements, relState, burnTime, planCircularize } from './orbit.js';
import { moonPos, moonVel } from '../core/astro.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _err = new THREE.Vector3(), _treq = new THREE.Vector3(), _ga = new THREE.Vector3(), _gb = new THREE.Vector3(), _gc = new THREE.Vector3();
const NOSE = new THREE.Vector3(0, 0, -1), UPB = new THREE.Vector3(0, 1, 0);

export const SAS_MODES = ['off', 'hold', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'target'];

export class Controller {
  constructor(settings) {
    this.settings = settings;
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false, tx: 0, ty: 0, tz: 0 };
    this.sas = 'hold';
    this.ap = null;
    this.integ = new THREE.Vector3();
    this.holdQ = null;
    this.node = null;          // planned maneuver {t, dv, label}
    this.status = '';
    this.wd = new THREE.Vector3();
  }

  setSas(m) { this.sas = m; this.holdQ = null; this.integ.set(0, 0, 0); }
  engage(ap) { this.ap = ap; this.integ.set(0, 0, 0); this.holdQ = null; }
  cancelAp() { this.ap = null; this.holdQ = null; }

  // ----- reference directions (world) -----
  refVel(ship) {
    const E = ship.env;
    if (E.body === EARTH && E.h < 50000) return E.vAir.clone();
    if (E.body === MOON && E.agl < 20000) return E.vAir.clone();
    if (E.body === EARTH) return ship.v.clone();
    moonVel(ship.t, _a); return ship.v.clone().sub(_a);
  }
  refPos(ship) {
    if (ship.env.body === EARTH) return ship.r.clone();
    moonPos(ship.t, _a); return ship.r.clone().sub(_a);
  }
  modeDir(ship, mode) {
    const v = this.refVel(ship), r = this.refPos(ship);
    switch (mode) {
      case 'prograde': return v.normalize();
      case 'retrograde': return v.normalize().negate();
      case 'normal': return new THREE.Vector3().crossVectors(r, v).normalize();
      case 'antinormal': return new THREE.Vector3().crossVectors(v, r).normalize();
      case 'radialOut': { const n = new THREE.Vector3().crossVectors(r, v); return new THREE.Vector3().crossVectors(v, n).normalize(); }
      case 'radialIn': { const n = new THREE.Vector3().crossVectors(r, v); return new THREE.Vector3().crossVectors(n, v).normalize(); }
      case 'target': moonPos(ship.t, _a); return _a.clone().sub(ship.r).normalize();
      default: return null;
    }
  }

  // thrust axis of the craft in body coordinates (thrust-weighted)
  thrustAxis(craft) {
    const ax = new THREE.Vector3();
    for (const P of craft.engines) ax.addScaledVector(P.eng.dir, P.def.engine.thrust);
    if (ax.lengthSq() < 1e-6) return NOSE.clone();
    return ax.normalize();
  }

  // ----- main update (called from physics substeps) -----
  update(ship, dt) {
    const craft = ship.craft, ctl = ship.ctl, E = ship.env, inp = this.input;
    const assisted = this.settings.assist !== 'realistic';
    const stick = Math.abs(inp.pitch) + Math.abs(inp.roll) + Math.abs(inp.yaw) > 0.04;
    const touching = ship.contacts > 0;
    this.airTime = touching ? 0 : (this.airTime || 0) + dt;
    const onGround = touching || (this.airTime < 1.0 && E.agl < 25);
    // ground handling
    ctl.steer = clamp(inp.yaw + (onGround && assisted ? inp.roll * 0.8 : 0), -1, 1);
    // autopilot
    let apOut = null;
    if (this.ap) {
      if (stick && this.ap.cancelOnStick !== false) { this.status = this.ap.name + ' cancelled'; this.ap = null; }
      else {
        apOut = this.ap.update(ship, dt, this);
        if (apOut && apOut.done) { this.status = apOut.msg || (this.ap.name + ' complete'); this.ap = null; apOut = null; }
      }
    }
    ctl.throttle = apOut && apOut.throttle !== undefined ? apOut.throttle : inp.throttle;
    ctl.brake = inp.brake ? 1 : (assisted && onGround && ctl.throttle < 0.02 && !apOut ? 1 : 0);
    if (apOut && apOut.gear !== undefined) ctl.gear = apOut.gear;
    // -------- desired angular rates (body) --------
    const w = ship.w;
    const wd = this.wd.set(0, 0, 0);
    const atmo = E.q > 150;
    const vb = ship.dirToBody(E.vAir, _d);
    const V = vb.length();
    const alpha = V > 5 ? Math.atan2(-vb.y, -vb.z) : 0;
    const beta = V > 5 ? Math.atan2(vb.x, -vb.z) : 0;
    let pointing = false;
    // near a planet, rates and attitude hold are relative to the rotating surface, not the stars
    const local = (E.body === EARTH && E.h < 100000) || (E.body === MOON && E.agl < 30000);
    const wRef = _d.set(0, 0, 0);
    if (local) {
      if (E.body === EARTH) wRef.set(0, EARTH.omega, 0); else wRef.copy(ship.eph.mY).multiplyScalar(MOON.omega);
      ship.dirToBody(wRef, wRef);
    }
    const frameQ = local ? ship.bodyFrameQ(E.body, ship.t, new THREE.Quaternion()) : null;
    const flightLaw = assisted && atmo && !onGround && V > 30 && !(apOut && apOut.dir) && (this.sas === 'hold' || this.sas === 'off');
    if (flightLaw) {
      // fighter-style law: pitch stick commands load factor; neutral stick holds flight-path angle and bank
      const upW = E.up, vW = E.vAir;
      const rightW = _a.set(1, 0, 0).applyQuaternion(ship.q), upBW = _b.set(0, 1, 0).applyQuaternion(ship.q);
      const gamma = Math.asin(clamp(vW.dot(upW) / V, -1, 1));
      const bank = Math.atan2(-rightW.dot(upW), upBW.dot(upW));
      const g = E.body.mu / (E.body.R + E.h) ** 2;
      const bc = clamp(bank, -1.2, 1.2);
      const level = Math.cos(gamma) / Math.max(0.36, Math.cos(bc));
      let nCmd;
      if (Math.abs(inp.pitch) > 0.03) {
        this.gammaHold = null;
        nCmd = level + (inp.pitch > 0 ? inp.pitch * 6 : inp.pitch * 2.8);
      } else {
        if (this.gammaHold == null) this.gammaHold = gamma;
        nCmd = level + clamp((this.gammaHold - gamma) * V / g * 0.7, -1.5, 2);
      }
      nCmd = clamp(nCmd, -2.5, 7.5);
      let q = (nCmd - Math.cos(gamma) * Math.cos(bank)) * g / V;
      // stall / g protection
      if (alpha > 0.30 && q > 0) q *= clamp((0.42 - alpha) / 0.12, 0, 1);
      if (alpha < -0.22 && q < 0) q *= clamp((alpha + 0.34) / 0.12, 0, 1);
      // roll: rate command, or hold bank (snap to wings level when close)
      let p;
      if (Math.abs(inp.roll) > 0.03) { this.bankHold = null; p = inp.roll * Math.abs(inp.roll) * 2.2 + inp.roll * 0.25; }
      else {
        if (this.bankHold == null) this.bankHold = Math.abs(bank) < 0.12 ? 0 : clamp(bank, -1.2, 1.2);
        p = clamp((this.bankHold - bank) * 2.2, -1.2, 1.2);
      }
      // turn coordination: feed forward the turn rate and kill sideslip
      const turn = g * Math.tan(bc) / V;
      const upBody = ship.dirToBody(upW, _c);
      wd.set(q + turn * upBody.x * 0, turn * upBody.y - beta * 2.0 - inp.yaw * 0.3, -p);
      this.holdQ = null;
    } else if (stick || (!apOut && this.sas === 'off')) {
      this.gammaHold = null; this.bankHold = null;
      this.holdQ = null;
      if (assisted) {
        const mp = atmo ? 0.75 : 0.45, my = atmo ? 0.3 : 0.4, mr = atmo ? 2.2 : 0.8;
        wd.set(inp.pitch * Math.abs(inp.pitch) * mp + inp.pitch * 0.15, -inp.yaw * my, -(inp.roll * Math.abs(inp.roll) * mr + inp.roll * 0.2));
        if (atmo && V > 40 && !onGround) {
          // stall and g protection
          if (alpha > 0.30 && wd.x > 0) wd.x *= clamp((0.42 - alpha) / 0.12, 0, 1);
          if (alpha < -0.25 && wd.x < 0) wd.x *= clamp((alpha + 0.37) / 0.12, 0, 1);
          if (ship.gForce > 8.5 && wd.x > 0) wd.x *= 0.3;
          wd.y += -beta * 2.0;          // coordinate turns by killing sideslip
        }
        if (onGround) wd.z *= 0.2;
      }
    } else {
      this.gammaHold = null; this.bankHold = null;
      // pointing target
      let D = null, upRef = null, axis = NOSE;
      if (apOut && apOut.dir) { D = apOut.dir; upRef = apOut.up || null; axis = apOut.axis || NOSE; }
      else if (this.sas !== 'hold') D = this.modeDir(ship, this.sas);
      if (D) {
        pointing = true;
        this.pointRates(ship, D, axis, upRef, wd);
      } else {
        // attitude hold (captured when the stick is released), stored relative to the planet near the surface
        if (!this.holdQ || this.holdLocal !== local) { this.holdQ = local ? frameQ.clone().invert().multiply(ship.q) : ship.q.clone(); this.holdLocal = local; }
        const target = local ? frameQ.clone().multiply(this.holdQ) : this.holdQ;
        _q.copy(ship.q).invert().multiply(target);           // body-frame error rotation
        if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
        const ang = 2 * Math.acos(clamp(_q.w, -1, 1));
        const s = Math.sqrt(Math.max(1e-9, 1 - _q.w * _q.w));
        _a.set(_q.x / s, _q.y / s, _q.z / s);
        const k = atmo ? 1.6 : 1.0;
        if (ang > 1e-4) wd.copy(_a).multiplyScalar(Math.min(ang * k, 0.6));
        if (onGround) { wd.set(0, 0, 0); this.holdQ = null; }
      }
    }
    wd.add(wRef);
    // -------- rate loop -> normalized command -> torque request --------
    const err = _err.copy(wd).sub(w);
    if (!assisted && !pointing && this.sas === 'off') err.set(0, 0, 0);
    const auth = this.authority(ship);
    const I = craft.Idiag;
    const kp = atmo ? 3.5 : 2.6;
    const integrate = !onGround && (atmo || pointing || this.sas !== 'off');
    if (integrate) this.integ.addScaledVector(err, dt * (atmo ? 1.6 : 0.6)).clampScalar(-0.7, 0.7); else this.integ.multiplyScalar(0.9);
    const cx = clamp(err.x * kp * I.x / auth.x + this.integ.x, -1, 1);
    const cy = clamp(err.y * kp * I.y / auth.y + this.integ.y, -1, 1);
    const cz = clamp(err.z * kp * I.z / auth.z + this.integ.z, -1, 1);
    const tReq = _treq.set(cx * auth.x, cy * auth.y, cz * auth.z);
    if (assisted && onGround && atmo) {
      // on the ground the flight computer uses direct law for pitch, plus runway heading hold and wing levelling
      const upW = E.up;
      const fw = _a.set(0, 0, -1).applyQuaternion(ship.q);
      const rw = _b.set(1, 0, 0).applyQuaternion(ship.q);
      const ub = _d.set(0, 1, 0).applyQuaternion(ship.q);
      const bank = Math.atan2(-rw.dot(upW), ub.dot(upW));
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(upW, -upW.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, upW);
      const hdg = Math.atan2(fw.dot(east), fw.dot(north));
      const yawRate = ship.w.clone().applyQuaternion(ship.q).dot(upW) - (E.body === EARTH ? EARTH.omega * upW.y : 0);
      if (Math.abs(inp.yaw) > 0.05 || Math.abs(inp.roll) > 0.05 || E.vSurf < 3) this.gHeading = hdg;
      if (this.gHeading == null) this.gHeading = hdg;
      let he = this.gHeading - hdg; he = Math.atan2(Math.sin(he), Math.cos(he));
      const yawCmd = clamp(-inp.yaw * 0.7 + clamp(-he * 3 - yawRate * 2.5, -1, 1) * (Math.abs(inp.yaw) > 0.05 ? 0 : 1), -1, 1);
      ctl.steer = clamp(inp.yaw + inp.roll * 0.8 + (Math.abs(inp.yaw) + Math.abs(inp.roll) > 0.05 ? 0 : clamp(he * 2.5 + yawRate * 1.5, -0.6, 0.6)), -1, 1);
      tReq.set((inp.pitch + clamp(-w.x * 2, -0.3, 0.3)) * auth.x, yawCmd * auth.y, clamp(-inp.roll * 0.5 + bank * 4 + w.z * 0, -1, 1) * auth.z);
    } else this.gHeading = null;
    if (!assisted && (stick || this.sas === 'off')) {
      // direct control: stick maps to full actuator authority
      tReq.set(inp.pitch * auth.x, -inp.yaw * auth.y, -inp.roll * auth.z);
      if (this.sas !== 'off' && !stick) tReq.set(clamp(-w.x * I.x * 2, -auth.x, auth.x), clamp(-w.y * I.y * 2, -auth.y, auth.y), clamp(-w.z * I.z * 2, -auth.z, auth.z));
    }
    this.allocate(ship, tReq, dt);
  }

  // desired body rates to bring body axis onto world direction D (and optionally body up toward upRef)
  pointRates(ship, D, axis, upRef, out) {
    const craft = ship.craft;
    const db = ship.dirToBody(D, _a).normalize();
    const cross = new THREE.Vector3().crossVectors(axis, db);
    const s = cross.length(), c = axis.dot(db);
    const ang = Math.atan2(s, c);
    const auth = this.authority(ship);
    const I = craft.Idiag;
    const amax = Math.max(0.02, Math.min(auth.x / I.x, auth.y / I.y));
    const rate = Math.min(Math.sqrt(2 * amax * ang) * 0.55, ang * 2.0, 0.8);
    if (s > 1e-6) out.copy(cross).divideScalar(s).multiplyScalar(rate); else if (c < 0) out.set(rate, 0, 0); else out.set(0, 0, 0);
    // roll: align body up with the reference, or just damp roll
    if (upRef) {
      const ub = ship.dirToBody(upRef, _b);
      // remove the component along the pointing axis
      ub.addScaledVector(axis, -ub.dot(axis)).normalize();
      const ref = Math.abs(axis.y) < 0.9 ? UPB.clone() : new THREE.Vector3(0, 0, -1);
      ref.addScaledVector(axis, -ref.dot(axis)).normalize();
      const rc = new THREE.Vector3().crossVectors(ref, ub);
      const rang = Math.atan2(rc.dot(axis), ref.dot(ub));
      out.addScaledVector(axis, clamp(rang * 1.2, -0.6, 0.6));
    } else {
      // damp roll about the pointing axis
      const along = ship.w.dot(axis);
      out.addScaledVector(axis, -along * 0.0);
    }
  }

  // available torque per body axis (N·m)
  authority(ship) {
    const craft = ship.craft;
    const W = craft.ec > 0 ? craft.wheelTorque : 0;
    const a = new THREE.Vector3(W, W, W);
    for (const P of craft.wings) {
      if (P.wing.ctrl <= 0) continue;
      const t = P.wing.torq;
      a.x += Math.abs(t.x) * P.wing.maxDefl; a.y += Math.abs(t.y) * P.wing.maxDefl; a.z += Math.abs(t.z) * P.wing.maxDefl;
    }
    for (const P of craft.engines) {
      const gm = (P.eng.e.gimbal || 0) * D2R;
      if (!gm || P.eng.thrust <= 0) continue;
      _ga.copy(P.eng.pos).sub(craft.com);
      const T = P.eng.thrust * gm;
      _gb.crossVectors(_ga, _gc.copy(P.eng.gx).multiplyScalar(T)); a.x += Math.abs(_gb.x); a.y += Math.abs(_gb.y); a.z += Math.abs(_gb.z);
      _gb.crossVectors(_ga, _gc.copy(P.eng.gz).multiplyScalar(T)); a.x += Math.abs(_gb.x); a.y += Math.abs(_gb.y); a.z += Math.abs(_gb.z);
    }
    if (ship.ctl.rcs && ship.env.rho < 0.05) for (const P of craft.rcsList) {
      const l = P.rcs.pos.distanceTo(craft.com) * P.def.rcs.thrust * 2;
      a.x += l; a.y += l; a.z += l;
    }
    return a.addScalar(1);
  }

  allocate(ship, tReq, dt) {
    const craft = ship.craft;
    // 1. reaction wheels
    const W = craft.ec > 0 ? craft.wheelTorque : 0;
    const uw = _a.set(clamp(tReq.x, -W, W), clamp(tReq.y, -W, W), clamp(tReq.z, -W, W));
    ship.cmdT.set(W ? uw.x / W : 0, W ? uw.y / W : 0, W ? uw.z / W : 0);
    const rem = _b.copy(tReq).sub(uw);
    // 2. control surfaces (least squares per axis)
    let sx = 0, sy = 0, sz = 0;
    for (const P of craft.wings) if (P.wing.ctrl > 0) { const t = P.wing.torq; sx += t.x * t.x; sy += t.y * t.y; sz += t.z * t.z; }
    const got = _c.set(0, 0, 0);
    const rateLim = 3.0 * dt;
    for (const P of craft.wings) {
      const Wg = P.wing;
      if (Wg.ctrl <= 0) { Wg.defl = 0; continue; }
      const t = Wg.torq;
      let d = (sx > 1e-9 ? rem.x * t.x / sx : 0) + (sy > 1e-9 ? rem.y * t.y / sy : 0) + (sz > 1e-9 ? rem.z * t.z / sz : 0);
      d = clamp(d, -Wg.maxDefl, Wg.maxDefl);
      Wg.defl += clamp(d - Wg.defl, -rateLim, rateLim);
      got.addScaledVector(t, Wg.defl);
    }
    rem.sub(got);
    // 3. engine gimbal
    let gx = 0, gy = 0, gz = 0;
    const gl = [];
    for (const P of craft.engines) {
      const gm = (P.eng.e.gimbal || 0) * D2R;
      if (!gm || P.eng.thrust <= 0) { P.eng.g1 = P.eng.g2 = 0; continue; }
      const r = new THREE.Vector3().copy(P.eng.pos).sub(craft.com);
      const T = P.eng.thrust * gm;
      const t1 = new THREE.Vector3().crossVectors(r, P.eng.gx.clone().multiplyScalar(T));
      const t2 = new THREE.Vector3().crossVectors(r, P.eng.gz.clone().multiplyScalar(T));
      gl.push([P, t1, t2]);
      gx += t1.x * t1.x + t2.x * t2.x; gy += t1.y * t1.y + t2.y * t2.y; gz += t1.z * t1.z + t2.z * t2.z;
    }
    for (const [P, t1, t2] of gl) {
      const g1 = (gx > 1e-9 ? rem.x * t1.x / gx : 0) + (gy > 1e-9 ? rem.y * t1.y / gy : 0) + (gz > 1e-9 ? rem.z * t1.z / gz : 0);
      const g2 = (gx > 1e-9 ? rem.x * t2.x / gx : 0) + (gy > 1e-9 ? rem.y * t2.y / gy : 0) + (gz > 1e-9 ? rem.z * t2.z / gz : 0);
      P.eng.g1 = clamp(g1, -1, 1); P.eng.g2 = clamp(g2, -1, 1);
    }
    // 4. RCS gets the rest (as a direction)
    const rl = rem.length();
    ship.rcsT = ship.rcsT || new THREE.Vector3();
    if (rl > 1) ship.rcsT.copy(rem).divideScalar(Math.max(rl, craft.mass * 20)); else ship.rcsT.set(0, 0, 0);
  }

  // during time warp: snap attitude to the SAS/AP direction
  railsAttitude(ship) {
    let D = null, axis = NOSE;
    if (this.ap && this.ap.railsDir) { const o = this.ap.railsDir(ship, this); if (o) { D = o.dir; axis = o.axis || NOSE; } }
    else if (this.sas !== 'off' && this.sas !== 'hold') D = this.modeDir(ship, this.sas);
    if (!D) return;
    const cur = _a.copy(axis).applyQuaternion(ship.q);
    _q.setFromUnitVectors(cur, D.clone().normalize());
    ship.q.premultiply(_q).normalize();
    this.holdQ = null;
  }
}

// ======================= autopilots =======================

// Execute a planned burn {t, dv}
export function nodeExec(node) {
  let dvLeft = node.dv.clone();
  let started = false;
  return {
    name: 'Burn', node,
    railsDir: () => ({ dir: dvLeft.clone().normalize() }),
    update(ship, dt, C) {
      const craft = ship.craft;
      const axis = C.thrustAxis(craft);
      const dvm = dvLeft.length();
      const bt = burnTime(ship, dvm);
      const tStart = node.t - bt / 2;
      const dir = dvLeft.clone().normalize();
      const fwd = axis.clone().applyQuaternion(ship.q);
      const aligned = fwd.dot(dir);
      let thr = 0;
      if (ship.t >= tStart || started) {
        if (aligned > 0.995 || (started && aligned > 0.9)) {
          started = true;
          const acc = Math.max(0.01, ship.thrustNow / craft.mass);
          const maxAcc = maxAccel(ship);
          thr = clamp(dvm / Math.max(0.5, maxAcc * 1.2), 0.03, 1);
        }
      }
      // integrate delivered dv along the thrust axis
      if (ship.thrustNow > 0) dvLeft.addScaledVector(fwd, -(ship.thrustNow / craft.mass) * dt);
      C.node = { ...node, dvLeft: dvLeft.clone(), started, tStart };
      if (started && (dvm < 0.4 || dvLeft.dot(node.dv) < 0)) { C.node = null; return { done: true, throttle: 0, msg: 'Burn complete' }; }
      if (started && thr > 0 && craft.engines.every((P) => P.eng.flame === 0) && ship.t - tStart > 5) return { done: true, throttle: 0, msg: 'Out of fuel' };
      return { dir, axis, throttle: thr };
    },
  };
}

function maxAccel(ship) {
  const craft = ship.craft;
  let T = 0;
  for (const P of craft.engines) T += craft.engineOutput(P, ship.env)[0];
  return T / craft.mass;
}

// Powered landing / hover-down for rockets, VTOLs and lunar landers
export function landAp() {
  return {
    name: 'Auto-land',
    update(ship, dt, C) {
      const craft = ship.craft, E = ship.env;
      const up = E.up.clone();
      const axis = C.thrustAxis(craft);
      const g = E.body.mu / Math.pow(E.body.R + E.h, 2);
      const amax = Math.max(0.01, maxAccel(ship));
      const agl = Math.max(0, E.agl - Math.max(0, -craft.box.min.y) - 1);
      if (amax < g * 1.05 && E.agl < 20000) return { done: true, throttle: 0, msg: 'Not enough thrust to land' };
      const anet = Math.max(0.3, amax * 0.75 - g);
      const vzT = -clamp(Math.sqrt(2 * anet * agl) * 0.6, 1.5, 400);
      const vS = E.vAir.clone();
      const vH = vS.clone().addScaledVector(up, -vS.dot(up));
      const target = up.clone().multiplyScalar(vzT);
      const errV = target.sub(vS);
      const kH = agl > 3000 ? 0.25 : 0.6;
      const acmd = errV.clone().multiplyScalar(0.8);
      acmd.addScaledVector(vH, -(kH - 0.8) * 0);
      acmd.addScaledVector(up, g);
      // limit tilt near the ground so we land upright
      const maxTilt = agl < 300 ? 0.25 : agl < 2000 ? 0.6 : 1.4;
      const vert = acmd.dot(up);
      const hor = acmd.clone().addScaledVector(up, -vert);
      const hl = hor.length();
      if (hl > Math.tan(maxTilt) * Math.max(vert, 0.1)) hor.multiplyScalar(Math.tan(maxTilt) * Math.max(vert, 0.1) / hl);
      const dir = up.clone().multiplyScalar(Math.max(vert, 0.1)).add(hor);
      const need = dir.length();
      dir.normalize();
      const fwd = axis.clone().applyQuaternion(ship.q);
      const al = fwd.dot(dir);
      let thr = clamp(need / amax, 0, 1) * smoothstep(0.6, 0.95, al);
      if (vS.dot(up) > 2 && agl > 20) thr = 0;
      const landed = ship.parked || (ship.contacts > 0 && E.vSurf < 0.6);
      if (landed) return { done: true, throttle: 0, msg: E.body === MOON ? 'Touchdown on the Moon' : 'Touchdown' };
      return { dir, axis, up: null, throttle: thr, gear: agl < 1500 ? true : undefined };
    },
  };
}

// Ascent to orbit: works for vertical rockets and for spaceplanes with air-breathing engines.
export function ascentAp(targetAlt = 160000, heading = Math.PI / 2) {
  let phase = 'init', plane = false, circ = null;
  return {
    name: 'Ascent',
    cancelOnStick: true,
    update(ship, dt, C) {
      const craft = ship.craft, E = ship.env;
      if (E.body !== EARTH) return { done: true, msg: 'Ascent works from Earth' };
      const up = E.up.clone();
      const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();      // toward local east in I
      const north = up.clone().cross(east).normalize();
      const hdg = north.clone().multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading));
      const el = elements(ship.r, ship.v, EARTH.mu);
      const apAlt = el.ap - EARTH.R, peAlt = el.pe - EARTH.R;
      if (phase === 'init') {
        plane = craft.wings.reduce((s, P) => s + P.wing.area, 0) > craft.mass / 1500 && !craft.vertical;
        phase = 'climb';
        ship.ctl.gear = true;
      }
      const axis = C.thrustAxis(craft);
      if (phase === 'coast') {
        if (E.h > EARTH.atmoTop + 1000) {
          circ = planCircularize(ship, true);
          if (circ) { C.node = circ; C.engage(nodeExec(circ)); return { throttle: 0, dir: ship.v.clone().normalize() }; }
          return { done: true, msg: 'Coasting — plan circularization in the map' };
        }
        return { dir: C.refVel(ship).normalize(), throttle: apAlt < targetAlt - 1000 ? 0.3 : 0 };
      }
      if (plane && apAlt > targetAlt) { phase = 'coast'; return { throttle: 0, dir: C.refVel(ship).normalize() }; }
      let pitch;     // flight path pitch above horizon
      let thr = 1;
      if (!plane) {
        // vertical-velocity guidance: climb toward the target altitude while building horizontal speed
        const h = E.h;
        const r = ship.r.length();
        const vI = ship.v.clone();
        const vz = vI.dot(up);
        const vh = vI.clone().addScaledVector(up, -vz).length();
        const g = EARTH.mu / (r * r);
        const aT = Math.max(0.1, ship.thrustNow / craft.mass);
        const vzT = clamp((targetAlt - h) / 80, 0, 900);
        const aVert = g - (vh * vh) / r + (vzT - vz) / 6;
        let s = clamp(aVert / aT, -0.25, 1);
        pitch = Math.asin(s) / D2R;
        if (h < 1500 || E.vSurf < 80) pitch = 90;
        else if (h < 12000) pitch = Math.max(pitch, 90 - (h - 1500) / 10500 * 35);
        const dir = up.clone().multiplyScalar(Math.sin(pitch * D2R)).addScaledVector(hdg, Math.cos(pitch * D2R)).normalize();
        if (E.q > 35000) thr = 0.7;
        const vCirc = Math.sqrt(EARTH.mu / r);
        if (peAlt > EARTH.atmoTop + 5000) return { done: true, throttle: 0, msg: `Orbit reached: ${Math.round(apAlt / 1000)} × ${Math.round(peAlt / 1000)} km` };
        if (vh > vCirc * 0.95) thr = Math.min(thr, clamp((EARTH.atmoTop + 8000 - peAlt) / 60000, 0.06, 1));
        return { dir, axis, up: hdg.clone().negate(), throttle: thr };
      }
      // spaceplane profile
      ship.ctl.engineMode = 'auto';
      const onGround = ship.contacts > 0;
      const S = craft.wings.reduce((s, P) => s + P.wing.area, 0);
      const vRot = Math.sqrt((2 * craft.mass * 9.81) / (1.225 * S * 1.1)) * 1.15;
      const mach = E.mach, h = E.h;
      const rocket = craft.engines.some((P) => P.eng.mode === 'rocket' && P.eng.flame > 0);
      if (onGround) pitch = E.vSurf > vRot ? 10 : 0;
      else if (h < 9000 && !rocket) pitch = 14;
      else if (!rocket && mach < 4.6) pitch = h < 21000 ? 6 : h < 25000 ? 2 : 0;
      else pitch = clamp(22 - (h - 30000) / 4000, 8, 25);
      if (onGround && E.vSurf < vRot) {
        // keep the nose on the runway heading
        const f = ship.dirToBody(NOSE, _a);
        return { dir: null, throttle: 1 };
      }
      if (!onGround && E.agl > 50) ship.ctl.gear = false;
      const dir = up.clone().multiplyScalar(Math.sin(pitch * D2R)).addScaledVector(hdg, Math.cos(pitch * D2R)).normalize();
      return { dir, axis: NOSE, up, throttle: 1 };
    },
  };
}
