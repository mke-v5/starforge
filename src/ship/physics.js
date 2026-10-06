// Rigid-body flight physics in the geocentric inertial frame I (doubles throughout).

import * as THREE from 'three';
import { EARTH, MOON, G0, clamp, toLLH, llh, enu, D2R } from '../core/geo.js';
import { atmosphere } from '../core/atmo.js';
import { gravity, moonPos, earthAngle } from '../core/astro.js';

const Y = new THREE.Vector3(0, 1, 0);
const _rF = new THREE.Vector3(), _rT = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _F = new THREE.Vector3(), _T = new THREE.Vector3(), _Fa = new THREE.Vector3(), _Ta = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _p = new THREE.Vector3(), _vp = new THREE.Vector3(), _vg = new THREE.Vector3(), _n = new THREE.Vector3(), _fx = new THREE.Vector3();
const _e = new THREE.Vector3(), _no = new THREE.Vector3(), _up = new THREE.Vector3();
const _gq = new THREE.Quaternion();
const _cf = new THREE.Vector3();
const _qShipInv = new THREE.Quaternion();

export class Ship {
  constructor(craft, world, eph, settings) {
    this.craft = craft;
    this.world = world;
    this.eph = eph;
    this.settings = settings;
    this.r = new THREE.Vector3();      // COM position (I)
    this.v = new THREE.Vector3();      // velocity (I)
    this.q = new THREE.Quaternion();   // body -> I
    this.w = new THREE.Vector3();      // angular velocity (body)
    this.t = eph.t;
    this.ctl = { pitch: 0, yaw: 0, roll: 0, throttle: 0, brake: 1, gear: true, rcs: true, tx: 0, ty: 0, tz: 0, engineMode: 'auto', steer: 0 };
    this.cmdT = new THREE.Vector3();   // normalized torque command per body axis (set by the controller)
    this.parked = null;
    this.parkTimer = 0;
    this.docked = null;                // { port, part, qRel, pRel } while attached to the station
    this.station = null;               // set by the game: the station to collide with and dock at
    this.nearStation = false;
    this.warp = 1;
    this.events = [];                  // {type, ...} consumed by the game
    this.dead = false;
    this.env = { body: EARTH, h: 0, agl: 0, rho: 0, p: 0, T: 288, a: 340, mach: 0, lat: 0, lon: 0, vAir: new THREE.Vector3(), vSurf: 0, vVert: 0, ground: 0, q: 0, inSun: true, water: false };
    this.contacts = 0;
    this.gForce = 1;
    this.lastV = new THREE.Vector3();
    this.lastT = 0;
    this.thrustNow = 0;
    this.heatOn = true;
    this.maxQ = 0;
  }

  // --------- frames ---------
  bodyFrameQ(body, t, out) {
    if (body === EARTH) return out.setFromAxisAngle(Y, earthAngle(t));
    return out.copy(this.eph.moonQ);   // the Moon turns slowly; frame-level accuracy is enough
  }
  bodyCenter(body, t, out) {
    if (body === EARTH) return out.set(0, 0, 0);
    return out.copy(this.eph.moon).addScaledVector(this.eph.moonV, t - this.eph.t);
  }
  toFixed(body, pI, t, out) {
    this.bodyCenter(body, t, _a);
    this.bodyFrameQ(body, t, _q);
    return out.copy(pI).sub(_a).applyQuaternion(_qi.copy(_q).invert());
  }
  toI(body, pF, t, out) {
    this.bodyCenter(body, t, _a);
    this.bodyFrameQ(body, t, _q);
    return out.copy(pF).applyQuaternion(_q).add(_a);
  }
  surfaceVel(body, pI, t, out) {
    if (body === EARTH) return out.set(EARTH.omega * pI.z, 0, -EARTH.omega * pI.x);
    this.bodyCenter(body, t, _a);
    _b.copy(pI).sub(_a);
    out.crossVectors(this.eph.mY, _b).multiplyScalar(MOON.omega);
    return out.add(this.eph.moonV);
  }
  dominant(pI, t) {
    this.bodyCenter(MOON, t, _c);
    return pI.distanceTo(_c) < MOON.soi ? MOON : EARTH;
  }

  // place the ship at rest on a body: lat/lon/height of the COM, heading (rad from north), pitch (rad)
  placeAt(body, lat, lon, hCom, heading, pitch = 0, roll = 0) {
    const pF = llh(lat, lon, hCom, body.R, new THREE.Vector3());
    const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3();
    enu(pF, up, east, north);
    const fwd = north.clone().multiplyScalar(Math.cos(heading)).add(east.clone().multiplyScalar(Math.sin(heading)));
    // body basis in the fixed frame: -Z = fwd, +Y = up
    const zB = fwd.clone().negate();
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(up, zB).normalize(), up, zB);
    const qF = new THREE.Quaternion().setFromRotationMatrix(m);
    if (pitch) qF.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
    if (roll) qF.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), roll));
    this.bodyFrameQ(body, this.t, _q);
    this.q.copy(_q).multiply(qF);
    this.toI(body, pF, this.t, this.r);
    this.surfaceVel(body, this.r, this.t, this.v);
    this.w.set(0, 0, 0);
    this.parked = { body, pF: pF.clone(), qF: qF.clone() };
    this.parkTimer = 0;
  }

  bodyToWorld(b, out) { return out.copy(b).sub(this.craft.com).applyQuaternion(this.q).add(this.r); }
  dirToWorld(b, out) { return out.copy(b).applyQuaternion(this.q); }
  dirToBody(w, out) { return out.copy(w).applyQuaternion(_qi.copy(this.q).invert()); }

  // --------- environment ---------
  updateEnv(t) {
    const E = this.env;
    const body = this.dominant(this.r, t);
    E.body = body;
    this.toFixed(body, this.r, t, _fx);
    const ll = toLLH(_fx, body.R);
    E.lat = ll.lat; E.lon = ll.lon; E.h = ll.h;
    E.ground = this.world.groundAt(body, ll.lat, ll.lon);
    E.agl = E.h - E.ground;
    E.water = body === EARTH && E.ground <= 0.3 && this.world.isWater(ll.lat, ll.lon);
    // air (Earth only)
    let atm;
    if (body === EARTH && E.h < EARTH.atmoTop) atm = atmosphere(E.h); else atm = atmosphere(1e9);
    E.rho = atm.rho; E.p = atm.p; E.T = atm.T; E.a = atm.a;
    this.surfaceVel(body, this.r, t, _vg);
    E.vAir.copy(this.v).sub(_vg);
    const vs = E.vAir.length();
    E.vSurf = vs; E.mach = vs / atm.a;
    E.q = 0.5 * E.rho * vs * vs;
    _up.copy(this.r).sub(this.bodyCenter(body, t, _a)).normalize();
    E.vVert = E.vAir.dot(_up);
    E.up = _up.clone();
    // sunlight (simple shadow cylinder for Earth and Moon)
    const sun = this.eph.sun;
    E.inSun = !shadowed(this.r, sun, _a.set(0, 0, 0), EARTH.R) && !shadowed(this.r, sun, this.bodyCenter(MOON, t, _b), MOON.R);
    return E;
  }

  // --------- main step ---------
  step(dtFrame, controller) {
    if (this.dead) return;
    const craft = this.craft;
    const warp = this.warp;
    const rails = warp > 4;
    if (this.docked) { this.stepDocked(dtFrame * warp, controller); return; }
    if (this.parked) { this.stepParked(dtFrame * warp, controller); return; }
    if (rails) { this.stepRails(dtFrame * warp, controller); return; }
    const total = dtFrame * warp;
    const contactish = this.contacts > 0 || this.env.agl < 50;
    const h = contactish ? 1 / 240 : 1 / 120;
    const n = Math.min(64, Math.max(1, Math.ceil(total / h)));
    const dt = total / n;
    this.lastV.copy(this.v);
    craft.balanceEngines(this.env);
    craft.sweepWings(this.env.mach || 0, total);
    for (let i = 0; i < n; i++) {
      this.updateEnv(this.t);
      if (controller && i % 2 === 0) controller.update(this, dt * 2);
      this.substep(dt);
      this.t += dt;
      if (this.dead) break;
    }
    craft.recompute();
    // heating (per frame)
    if (this.heatOn) {
      const vb = this.dirToBody(this.env.vAir, _d);
      let engHeat = 0; for (const P of craft.engines) engHeat += P.eng.e.heat * P.eng.thr * (P.eng.flame > 0 ? 1 : 0);
      craft.radLoad = craft.radCap ? (engHeat + craft.reactorHeat()) / craft.radCap : 0;
      const hot = craft.heat(total, vb, this.env, engHeat, this.settings.heatScale, this.env.inSun);
      for (const P of hot) this.breakPart(P, 'overheat');
    }
    // airframe stress: a wing pushed past its limit for long, or far past it at once, breaks off
    if (this.settings.stress !== '0') for (const P of craft.wings) {
      if (!P.alive) continue;
      const W = P.wing, L = W.peak;
      W.peak = 0;
      W.over = L > 1 ? W.over + total * (L - 1) * 4 : Math.max(0, W.over - total);
      if (L > 1.5 || W.over > 1) this.breakPart(P, 'overstress', this.env.vSurf);
    }
    // g-force from the change in velocity minus gravity
    gravity(this.r, this.bodyCenter(MOON, this.t, _b), _a);
    const acc = _c.copy(this.v).sub(this.lastV).divideScalar(Math.max(1e-6, total)).sub(_a);
    this.gForce = this.gForce * 0.85 + (acc.length() / G0) * 0.15;
    this.maxQ = Math.max(this.maxQ, this.env.q);
    this.checkBuildings();
    this.checkPark(total);
    // electricity
    if (craft.solar && this.env.inSun) craft.ec = Math.min(craft.ecCap, craft.ec + craft.solar * total / 3600 * 10);
    if (this.thrustNow > 0) craft.ec = Math.min(craft.ecCap, craft.ec + total / 3600 * 50);
    this.upkeep(total);
  }

  // things that go on all the time, flying or warping: reactors charge the batteries, liquid hydrogen boils off,
  // antimatter traps draw their power — and let go if it fails
  upkeep(dt) {
    const craft = this.craft;
    this.runReactors(dt);
    for (const P of craft.parts) {
      if (!P.alive) continue;
      if (P.res.LH2 && P.res.LH2.amt > 0) P.res.LH2.amt *= Math.exp(-0.005 * dt / 86400);
      if (P.def.contain && P.res.AM && P.res.AM.amt > 0.001) {
        const need = P.def.contain * dt / 3600;
        if (craft.ec >= need) craft.ec -= need;
        else { craft.ec = 0; this.breakPart(P, 'containment', 0); this.events.push({ type: 'antimatter', part: P }); }
      }
    }
  }

  // reactors keep the batteries topped up (a fusion core burns a trickle of pellets while it works)
  runReactors(dt) {
    const craft = this.craft;
    for (const P of craft.reactors) {
      const R = P.def.reactor;
      P.reactorOn = false;
      if (!P.alive || craft.ec >= craft.ecCap - 1e-6) continue;
      let f = Math.min(1, (craft.ecCap - craft.ec) / (R.power * dt / 3600));
      if (R.fuel) for (const k in R.fuel) { const want = R.fuel[k] * f * dt / 3600; if (want > 0) f *= craft.draw(k, want) / want; }
      if (f <= 0) continue;
      craft.ec = Math.min(craft.ecCap, craft.ec + R.power * f * dt / 3600);
      P.reactorOn = true;
    }
  }

  substep(dt) {
    const craft = this.craft, ctl = this.ctl, E = this.env;
    const com = craft.com;
    _F.set(0, 0, 0); _T.set(0, 0, 0);
    // ---- engines ----
    let thrustTotal = 0;
    for (const P of craft.engines) {
      const eng = P.eng, e = eng.e;
      // hybrid mode switching
      if (e.type === 'hybrid') {
        if (ctl.engineMode === 'air') eng.mode = 'air';
        else if (ctl.engineMode === 'rocket') eng.mode = 'rocket';
        else {
          eng.mode = 'air';
          const air = craft.engineOutput(P, E)[0];
          const hasOx = craft.amount('OX') > 1;
          eng.mode = hasOx && air < e.rocket.thrust * 0.45 ? 'rocket' : 'air';
        }
      }
      const cmd = eng.active ? ctl.throttle : 0;
      eng.ab = 0;
      const rate = 1 / Math.max(0.05, e.spool);
      eng.thr += clamp(cmd - eng.thr, -rate * dt, rate * dt);
      if (eng.thr < 1e-4) { eng.flame = 0; eng.thrust = 0; continue; }
      let [Tmax, isp] = craft.engineOutput(P, E);
      // afterburner: the last tenth of the throttle lights it — much more thrust, far thirstier
      if (e.ab && (eng.mode === 'jet' || eng.mode === 'air') && eng.thr > 0.9) {
        eng.ab = (eng.thr - 0.9) / 0.1;
        Tmax *= 1 + (e.ab.thrust - 1) * eng.ab; isp *= 1 - (1 - e.ab.isp) * eng.ab;
      }
      let T = Tmax * eng.thr * (eng.bal ?? 1);
      if (T <= 0 || isp <= 0) { eng.flame = 0; eng.thrust = 0; continue; }
      const mdot = T / (isp * G0);
      const mix = craft.fuelMix(P);
      let frac = 1, pf = 1;
      // electric drives run on charge as well as propellant
      if (e.power) {
        const need = e.power * eng.thr * (eng.bal ?? 1) * dt / 3600;
        const got = Math.min(need, Math.max(0, craft.ec));
        craft.ec -= got;
        pf = need > 0 ? got / need : 1;
        eng.starved = pf < 0.5;
      }
      for (const k in mix) {
        const want = mdot * mix[k] * dt * pf;
        const got = craft.draw(k, want);
        if (want > 0) frac = Math.min(frac, got / want);
      }
      T *= frac * pf;
      eng.thrust = T;
      eng.flame = T / Math.max(1, (e.type === 'hybrid' && eng.mode === 'rocket' ? e.rocket.thrust : e.thrust));
      if (T <= 0) continue;
      thrustTotal += T;
      // gimbal
      const gm = (e.gimbal || 0) * D2R;
      _a.copy(eng.dir);
      if (gm > 0) _a.addScaledVector(eng.gx, eng.g1 * gm).addScaledVector(eng.gz, eng.g2 * gm).normalize();
      _a.multiplyScalar(T);
      _F.add(_a);
      _b.copy(eng.pos).sub(com);
      _T.add(_c.crossVectors(_b, _a));
    }
    this.thrustNow = thrustTotal;
    (this.thrustB || (this.thrustB = new THREE.Vector3())).copy(_F);   // net engine force, body frame
    if (this.dbg) this.dbg.eng.copy(_T);
    // ---- aerodynamics (body frame) ----
    if (this.aeroB) this.aeroB.set(0, 0, 0);
    if (E.rho > 0) {
      const vb = this.dirToBody(E.vAir, _d);
      craft.aero(vb, this.w, E, _Fa, _Ta);
      _F.add(_Fa); _T.add(_Ta);
      (this.aeroB || (this.aeroB = new THREE.Vector3())).copy(_Fa);   // aerodynamic force, body frame
      if (this.dbg) this.dbg.aero.copy(_Ta);
    }
    // ---- reaction wheels and RCS ----
    if (craft.wheelTorque > 0 && craft.ec > 0) {
      _a.copy(this.cmdT).multiplyScalar(craft.wheelTorque);
      _T.add(_a);
      craft.ec = Math.max(0, craft.ec - (Math.abs(this.cmdT.x) + Math.abs(this.cmdT.y) + Math.abs(this.cmdT.z)) * craft.wheelTorque * dt / 3.6e9);
    }
    if (ctl.rcs && craft.rcsList.length && E.rho < 0.05) this.rcs(dt, _F, _T);
    else for (const P of craft.rcsList) P.rcs.fire.fill(0);
    // forces so far are in the body frame -> world
    const Fw = _F.applyQuaternion(this.q);
    // ---- contacts (world frame forces, body torques) ----
    if (this.dbg) this.dbg.pre.copy(_T);
    this.contactForces(dt, Fw, _T);
    if (this.nearStation && this.station) this.station.contactForces(this, Fw, _T, _qShipInv.copy(this.q).invert());
    if (this.dbg) this.dbg.contact.copy(_T).sub(this.dbg.pre);
    // ---- integrate ----
    gravity(this.r, this.bodyCenter(MOON, this.t, _b), _a);
    const m = craft.mass;
    this.v.addScaledVector(Fw, dt / m).addScaledVector(_a, dt);
    this.r.addScaledVector(this.v, dt);
    // rotation: w' = I^-1 (T - w x Iw)
    const Iw = _b.copy(this.w).applyMatrix3(craft.I);
    _c.crossVectors(this.w, Iw);
    _T.sub(_c);
    _T.applyMatrix3(craft.Iinv);
    this.w.addScaledVector(_T, dt);
    const wl = this.w.length();
    if (wl > 12) this.w.multiplyScalar(12 / wl);
    if (wl > 1e-9) {
      _gq.setFromAxisAngle(_a.copy(this.w).divideScalar(wl), wl * dt);
      this.q.multiply(_gq).normalize();
    }
  }

  rcs(dt, F, T) {
    const craft = this.craft, com = craft.com, ctl = this.ctl;
    const trans = _e.set(ctl.tx, ctl.ty, ctl.tz);
    const cmd = this.rcsT || this.cmdT;
    let fuel = 0;
    _rF.set(0, 0, 0); _rT.set(0, 0, 0);
    for (const P of craft.rcsList) {
      const R = P.rcs;
      _b.copy(R.pos).sub(com);
      for (let i = 0; i < 4; i++) {
        const d = R.dirs[i];
        // thrust pushes opposite the nozzle direction
        _a.copy(d).multiplyScalar(-1);
        _c.crossVectors(_b, _a);
        const cl = _c.length();
        let fr = 0;
        if (cl > 1e-3) fr = Math.max(0, _c.dot(cmd) / cl);
        const ft = Math.max(0, _a.dot(trans));
        const f = Math.min(1, fr + ft);
        R.fire[i] = f;
        if (f < 0.02) continue;
        const thrust = P.def.rcs.thrust * f;
        // turning fires thrusters in opposed pairs (a pure couple); only translation pushes the craft along
        _rF.addScaledVector(_a, P.def.rcs.thrust * Math.min(ft, f));
        _rT.add(_c.multiplyScalar(thrust));
        fuel += thrust / (P.def.rcs.isp * G0) * dt;
      }
    }
    // thrusters only push while there is propellant for them
    if (fuel > 0) {
      const gas = craft.draw('GAS', fuel);
      const got = (gas + (gas < fuel ? craft.draw('LF', fuel - gas) : 0)) / fuel;
      if (got < 0.999) for (const P of craft.rcsList) for (let i = 0; i < 4; i++) P.rcs.fire[i] *= got;
      F.addScaledVector(_rF, got); T.addScaledVector(_rT, got);
    }
  }

  contactForces(dt, Fw, Tb) {
    const craft = this.craft, E = this.env, com = craft.com, ctl = this.ctl;
    const body = E.body;
    // gear doors: deploy / retract over three seconds (anywhere, so drag and heating see it)
    for (const P of craft.gears) { const G = P.gear; G.deployed += clamp((ctl.gear ? 1 : 0) - G.deployed, -dt / 3, dt / 3); }
    if (E.agl > craft.size + 30 && !this.world.nearBuildings) { this.contacts = 0; for (const P of craft.gears) { P.gear.contact = false; P.gear.comp = 0; } return; }
    let contacts = 0;
    const m = craft.mass;
    const qInv = _qShipInv.copy(this.q).invert();
    // gear
    for (const P of craft.gears) {
      const G = P.gear, g = G.g;
      if (G.deployed < 0.95) { G.contact = false; G.comp = 0; continue; }
      _p.copy(G.ext).multiplyScalar(g.len + g.wheel).add(G.mount);       // wheel bottom (body)
      const res = this.probe(_p, body);
      if (!res) { G.contact = false; G.comp = 0; G.spin *= 0.99; continue; }
      const { depth, n, vrel, pw } = res;
      const stroke = g.stroke || g.len * 0.3;
      const vn = vrel.dot(n);
      if (!G.contact && -vn > (P.def.crash || 8) * (this.settings.crashScale || 1)) { this.breakPart(P, 'impact', -vn); continue; }
      G.contact = true;
      contacts++;
      G.comp = Math.min(depth, stroke);
      let Fn = g.k * Math.min(depth, stroke) - g.c * vn;
      if (depth > stroke) Fn += g.k * 10 * (depth - stroke) - g.c * 2 * vn;
      Fn = Math.max(0, Math.min(Fn, g.load * G0 * 6));
      G.load = Fn;
      // friction
      const fwdW = _a.copy(G.fwd).applyQuaternion(this.q);
      fwdW.addScaledVector(n, -fwdW.dot(n)).normalize();
      if (g.steer && P.com.z < com.z - 0.5) {
        // nose wheel steering
        const steer = clamp(-ctl.steer, -1, 1) * 0.6 * clamp(1 - E.vSurf / 60, 0.08, 1);
        fwdW.applyAxisAngle(n, steer);
      }
      const latW = _b.crossVectors(n, fwdW).normalize();
      const vlong = vrel.dot(fwdW), vlat = vrel.dot(latW);
      G.spin = vlong / Math.max(0.1, g.wheel || 0.3);
      const muL = g.leg ? 0.9 : 0.02 + 0.75 * ctl.brake;
      const muS = g.leg ? 0.9 : 0.9;
      const fl = -clamp(vlong * Fn * 3, -muL * Fn, muL * Fn);
      const fs = -clamp(vlat * Fn * 4, -muS * Fn, muS * Fn);
      _cf.copy(n).multiplyScalar(Fn).addScaledVector(fwdW, fl).addScaledVector(latW, fs);
      this.applyWorld(_cf, pw, Fw, Tb, qInv);
    }
    // hull points
    let deep = 0;
    for (const P of craft.parts) {
      if (!P.alive || P.gear) continue;
      for (const cp of P.contacts) {
        const res = this.probe(cp, body);
        if (!res) continue;
        const { depth, n, vrel, pw, water } = res;
        const vn = vrel.dot(n);
        contacts++;
        const tol = (P.def.crash || 8) * (this.settings.crashScale || 1) * (water ? 2 : 1);
        if (-vn > tol) { this.breakPart(P, water ? 'splash' : 'impact', -vn); break; }
        if (!water) deep = Math.max(deep, depth);
        const k = m * (water ? 30 : 600) / Math.max(1, craft.parts.length * 0.4);
        const c = 2 * Math.sqrt(k * m / Math.max(1, craft.parts.length)) * 0.8;
        // the spring only answers the first 60 cm; deeper than that the ship is lifted out below
        let Fn = Math.max(0, k * Math.min(depth, 0.6) - c * vn);
        const vt = _c.copy(vrel).addScaledVector(n, -vn);
        const vts = vt.length();
        const mu = water ? 0.15 : 0.55;
        const ff = Math.min(mu * Fn, vts * Fn * 3);
        _cf.copy(n).multiplyScalar(Fn);
        if (vts > 1e-3) _cf.addScaledVector(vt, -ff / vts);
        if (water) _cf.addScaledVector(vrel, -m * 0.08);
        // scraping heats the hull
        if (!water && vts > 5) P.temp += (ff * vts * dt) / P.C * 0.5;
        this.applyWorld(_cf, pw, Fw, Tb, qInv);
      }
    }
    // embedded in the ground without having hit it (spawned low, or finer terrain streamed in under a landed
    // ship): step straight up out of it and stop sinking, rather than being catapulted by a squashed spring
    if (deep > 1.2) {
      const up = _d.copy(this.r).sub(this.bodyCenter(body, this.t, _b)).normalize();
      this.r.addScaledVector(up, deep - 0.6);
      const vr = E.vAir.dot(up);
      if (vr < 0) this.v.addScaledVector(up, -vr);
    }
    this.contacts = contacts;
  }

  // ground probe for a body-frame point: returns depth below ground, normal, relative velocity, world point
  probe(bp, body) {
    const pw = this.bodyToWorld(bp, new THREE.Vector3());
    this.toFixed(body, pw, this.t, _fx);
    const r = _fx.length();
    const lat = Math.asin(clamp(_fx.y / r, -1, 1)) / D2R, lon = Math.atan2(-_fx.z, _fx.x) / D2R;
    const g = this.world.groundAt(body, lat, lon);
    const hgt = r - body.R;
    let depth = g - hgt;
    let water = false;
    if (body === EARTH && g <= 0.3 && this.world.isWater(lat, lon)) { water = true; depth = -hgt; }
    if (depth <= 0) return null;
    // normal from neighbouring heights (fixed frame) -> world
    const dl = 3 / (body.R * D2R);
    const hN = this.world.groundAt(body, lat + dl, lon), hE = this.world.groundAt(body, lat, lon + dl / Math.max(0.05, Math.cos(lat * D2R)));
    enu(_fx, _up, _e, _no);
    const n = new THREE.Vector3().copy(_up).addScaledVector(_no, -(hN - g) / 3).addScaledVector(_e, -(hE - g) / 3).normalize();
    if (water) n.copy(_up);
    this.bodyFrameQ(body, this.t, _q);
    n.applyQuaternion(_q);
    // velocity of the point relative to the ground
    const rb = _b.copy(bp).sub(this.craft.com);
    const vp = _vp.crossVectors(this.w, rb).applyQuaternion(this.q).add(this.v);
    this.surfaceVel(body, pw, this.t, _vg);
    const vrel = vp.sub(_vg).clone();
    return { depth: depth * Math.max(0.2, n.dot(_up.applyQuaternion(_q))), n, vrel, pw, water };
  }

  applyWorld(F, pw, Fw, Tb, qInv) {
    Fw.add(F);
    _b.copy(pw).sub(this.r).applyQuaternion(qInv);         // lever arm (body)
    _c.copy(F).applyQuaternion(qInv);                       // force (body)
    Tb.add(_a.crossVectors(_b, _c));
  }

  breakPart(P, why, speed = 0) {
    if (!P.alive) return;
    const removed = this.craft.destroy(P);
    this.events.push({ type: 'break', part: P, removed, why, speed });
    if (!this.craft.root.alive || this.craft.mass < 1) {
      this.dead = true;
      this.events.push({ type: 'destroyed', why, part: P });
    }
  }

  checkBuildings() {
    const E = this.env;
    if (E.body !== EARTH || E.agl > 700) { this.world.nearBuildings = false; return; }
    const craft = this.craft;
    for (const b of [craft.com, craft.box.min, craft.box.max]) {
      const pw = this.bodyToWorld(b, _p);
      this.toFixed(EARTH, pw, this.t, _fx);
      const ll = toLLH(_fx, EARTH.R);
      const top = this.world.buildingTop(ll.lat, ll.lon, ll.h);
      if (top !== null) {
        this.events.push({ type: 'building' });
        this.breakPart(craft.root, 'building', this.env.vSurf);
        return;
      }
    }
  }

  // ---- parking: lock to the surface when stopped so we can sit still on a rotating planet ----
  checkPark(dt) {
    const E = this.env;
    const still = this.contacts > 0 && E.vSurf < 0.25 && this.w.length() < 0.03 && this.ctl.throttle < 0.01 && this.thrustNow < 1 && (this.ctl.brake > 0.5 || this.craft.gears.length === 0 || this.craft.gears.some((P) => P.def.gear.leg));
    this.parkTimer = still ? this.parkTimer + dt : 0;
    if (this.parkTimer > 1.0) {
      const body = E.body;
      const pF = this.toFixed(body, this.r, this.t, new THREE.Vector3());
      this.bodyFrameQ(body, this.t, _q);
      const qF = _qi.copy(_q).invert().multiply(this.q).clone();
      this.parked = { body, pF, qF };
      this.parkTimer = 0;
      this.events.push({ type: 'landed', body });
    }
  }
  stepParked(dt, controller) {
    const P = this.parked;
    this.t += dt;
    this.toI(P.body, P.pF, this.t, this.r);
    this.bodyFrameQ(P.body, this.t, _q);
    this.q.copy(_q).multiply(P.qF);
    this.surfaceVel(P.body, this.r, this.t, this.v);
    this.w.set(0, 0, 0);
    this.updateEnv(this.t);
    if (controller) controller.update(this, dt);
    this.contacts = Math.max(1, this.contacts);
    for (const G of this.craft.gears) { G.gear.contact = true; G.gear.deployed = 1; }
    this.gForce = 1;
    this.craft.recompute();
    this.upkeep(dt);
    // wake up on throttle, stick input or brake release on wheels
    const c = this.ctl;
    const wheels = this.craft.gears.length && !this.craft.gears.every((Q) => Q.def.gear.leg);
    if (c.throttle > 0.01 || Math.abs(c.pitch) + Math.abs(c.roll) + Math.abs(c.yaw) > 0.15 || (wheels && c.brake < 0.5 && this.warp <= 1)) {
      this.parked = null;
      this.warp = 1;
    }
  }

  // ---- docked: carried along by the station ----
  stepDocked(dt, controller) {
    const D = this.docked, st = this.station;
    this.t += dt;
    st.advanceTo(this.t);
    this.q.copy(st.q).multiply(D.qRel);
    st.toWorld(D.pRel, this.t, this.r);
    st.pointVel(this.r, this.t, this.v);
    this.w.copy(st.w).applyQuaternion(_qi.copy(this.q).invert());
    this.updateEnv(this.t);
    for (const P of this.craft.engines) { P.eng.thr = 0; P.eng.flame = 0; P.eng.thrust = 0; }
    for (const P of this.craft.rcsList) P.rcs.fire.fill(0);
    this.thrustNow = 0;
    if (controller) controller.update(this, dt);
    this.contacts = 0;
    this.gForce = 0;
    this.craft.recompute();
    if (this.heatOn) this.craft.heat(Math.min(dt, 60), _d.set(0, 0, 0), this.env, 0, this.settings.heatScale, this.env.inSun);
    if (this.craft.solar && this.env.inSun) this.craft.ec = Math.min(this.craft.ecCap, this.craft.ec + this.craft.solar * dt / 3600 * 10);
    this.craft.ec = Math.min(this.craft.ecCap, this.craft.ec + dt / 3600 * 20);   // station power
    this.upkeep(dt);
  }

  // ---- time-warp "on rails": gravity only, RK4 ----
  stepRails(total, controller) {
    let t = this.t, left = total;
    const s = [this.r.x, this.r.y, this.r.z, this.v.x, this.v.y, this.v.z];
    while (left > 0) {
      const body = this.dominant(this.r, t);
      const c = this.bodyCenter(body, t, _c);
      const rr = Math.hypot(s[0] - c.x, s[1] - c.y, s[2] - c.z);
      const hmax = clamp(0.01 * Math.sqrt(rr * rr * rr / body.mu), 0.5, 300);
      const h = Math.min(left, hmax);
      rk4(s, t, h);
      t += h; left -= h;
      this.r.set(s[0], s[1], s[2]); this.v.set(s[3], s[4], s[5]);
      // stop warping before hitting air or ground
      const alt = rr - body.R;
      if ((body === EARTH && alt < EARTH.atmoTop + 2000) || alt < 3000 + (body === MOON ? 8000 : 0)) {
        this.warp = 1;
        this.events.push({ type: 'warpStop', why: body === EARTH && alt < EARTH.atmoTop + 2000 ? 'atmosphere' : 'surface' });
        break;
      }
    }
    // rotate with the attitude hold (orientation stays fixed in space unless the controller points somewhere)
    const dt = t - this.t;
    this.t = t;
    this.w.set(0, 0, 0);
    this.updateEnv(t);
    if (controller) controller.railsAttitude(this);
    for (const P of this.craft.engines) { P.eng.thr = 0; P.eng.flame = 0; }
    this.thrustNow = 0;
    if (this.heatOn) {
      const vb = this.dirToBody(this.env.vAir, _d);
      this.craft.heat(Math.min(dt, 60), vb, this.env, 0, this.settings.heatScale, this.env.inSun);
    }
    if (this.craft.solar && this.env.inSun) this.craft.ec = Math.min(this.craft.ecCap, this.craft.ec + this.craft.solar * dt / 3600 * 10);
    this.upkeep(dt);
  }
}

function shadowed(p, sun, c, R) {
  const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
  const along = dx * sun.x + dy * sun.y + dz * sun.z;
  if (along > 0) return false;
  const d2 = dx * dx + dy * dy + dz * dz - along * along;
  return d2 < R * R;
}

// ---- gravity-only RK4 on [x,y,z,vx,vy,vz] with the analytic Moon ----
const _m1 = new THREE.Vector3(), _pp = new THREE.Vector3(), _acc = new THREE.Vector3();
function deriv(s, t, out) {
  moonPos(t, _m1);
  _pp.set(s[0], s[1], s[2]);
  gravity(_pp, _m1, _acc);
  out[0] = s[3]; out[1] = s[4]; out[2] = s[5]; out[3] = _acc.x; out[4] = _acc.y; out[5] = _acc.z;
}
const k1 = new Array(6), k2 = new Array(6), k3 = new Array(6), k4 = new Array(6), tmp = new Array(6);
export function rk4(s, t, h) {
  deriv(s, t, k1);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + k1[i] * h / 2;
  deriv(tmp, t + h / 2, k2);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + k2[i] * h / 2;
  deriv(tmp, t + h / 2, k3);
  for (let i = 0; i < 6; i++) tmp[i] = s[i] + k3[i] * h;
  deriv(tmp, t + h, k4);
  for (let i = 0; i < 6; i++) s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
}
