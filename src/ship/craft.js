// A craft assembled from a design: visuals plus everything physics needs, all in the body frame.
// Body frame: -Z = nose/forward, +Y = up (dorsal), +X = right.

import * as THREE from 'three';
import { PART, SIZES, variantDef } from './parts.js';
import { buildPartMesh, makeMaterials } from './meshes.js';
import { G0, clamp, smoothstep } from '../core/geo.js';

const ABLATION_HEAT = 6e6;          // J absorbed per kg of ablator burned (game value: wear shows within a few reentries)
const SIGMA = 5.670e-8;
const _t = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();
const _r2 = new THREE.Vector3();

export class Craft {
  constructor(design, opts = {}) {
    this.design = design;
    this.group = new THREE.Group();
    this.colors = design.colors || { hull: '#d9dee5', accent: '#ffb347' };
    this.parts = [];
    this.debris = [];
    this.lightParts = [];
    this.visual = opts.visual !== false;
    if (this.visual) this.mats = makeMaterials(this.colors);
    this.build();
    this.recompute();
  }

  build() {
    const D = this.design.parts;
    for (let i = 0; i < D.length; i++) {
      const d = D[i];
      const def = d.w ? variantDef(PART[d.id], d.w) : PART[d.id];
      if (!def) continue;
      const T = new THREE.Matrix4().compose(new THREE.Vector3(...d.p), new THREE.Quaternion(...d.q), new THREE.Vector3(d.mirror ? -1 : 1, 1, 1));
      const N = new THREE.Matrix3().setFromMatrix4(T);
      const P = {
        i, def, d, T, N, alive: true, parent: d.parent ?? -1, kids: [],
        temp: 288, maxT: def.maxT, dry: def.mass, res: {},
        com: new THREE.Vector3(...def.com).applyMatrix4(T),
      };
      for (const k in def.res || {}) P.res[k] = { amt: def.res[k], cap: def.res[k] };
      if (d.res) for (const k in d.res) if (P.res[k]) P.res[k].amt = Math.min(P.res[k].cap, d.res[k]);
      // geometry for aero and heat
      const L = def.len || 1, dia = def.size ? SIZES[def.size] : 0.6;
      P.axis = new THREE.Vector3(0, 1, 0).applyMatrix3(N).normalize();
      P.len = L; P.dia = dia;
      if (def.wing) {
        const w = def.wing;
        P.wing = {
          ac: new THREE.Vector3(w.ac[0], w.ac[1], 0).applyMatrix4(T),
          s: new THREE.Vector3(1, 0, 0).applyMatrix3(N).normalize(),
          c: new THREE.Vector3(0, 1, 0).applyMatrix3(N).normalize(),
          n: new THREE.Vector3(0, 0, 1).applyMatrix3(N).normalize(),
          area: w.area, ar: w.ar, ctrl: w.ctrl, tau: clamp(1.25 * Math.sqrt(w.ctrl), 0, 1), defl: 0, maxDefl: w.ctrl >= 1 ? 0.35 : 0.44,
          torq: new THREE.Vector3(),
          fmax: w.sigma * w.area, load: 0, peak: 0, over: 0, cd0: w.body ? 0.035 : 0,
          swing: w.swing || 0, k: 0, ar0: w.ar, yMac: w.ac[0], waveK: 1,
        };
        // control surfaces sit near the trailing edge (all-moving surfaces pivot near the quarter chord)
        P.wing.ctrlPt = new THREE.Vector3(w.ac[0], w.ac[1] - (w.ctrl >= 1 ? 0.1 : 0.6) * (w.mac || 1), 0).applyMatrix4(T);
        if (w.swing) { P.wing.ac0 = P.wing.ac.clone(); P.wing.ctrl0 = P.wing.ctrlPt.clone(); }
        P.Asurf = w.area * 2.1;
      } else {
        P.Asurf = Math.PI * dia * L + Math.PI * dia * dia / 2;
      }
      P.C = Math.max(4000, P.Asurf * 28000 * (def.shield ? 3 : 1));   // skin heat capacity (J/K)
      if (def.engine) {
        const e = def.engine;
        P.eng = {
          e, pos: new THREE.Vector3(...def.nozzle).applyMatrix4(T),
          dir: new THREE.Vector3(...def.thrustAxis).applyMatrix3(N).normalize(),
          thr: 0, mode: e.type === 'hybrid' ? 'air' : e.type, flame: 0, thrust: 0, active: true,
          gx: new THREE.Vector3(1, 0, 0).applyMatrix3(N).normalize(), gz: new THREE.Vector3(0, 0, 1).applyMatrix3(N).normalize(),
          g1: 0, g2: 0,
        };
      }
      if (def.gear) {
        const g = def.gear;
        P.gear = {
          g, mount: new THREE.Vector3(0, 0, 0).applyMatrix4(T),
          ext: new THREE.Vector3(1, 0, 0).applyMatrix3(N).normalize(),
          fwd: new THREE.Vector3(0, 1, 0).applyMatrix3(N).normalize(),
          comp: 0, contact: false, deployed: 1, spin: 0, load: 0,
        };
      }
      if (def.rcs) {
        P.rcs = { pos: new THREE.Vector3(0.18, 0, 0).applyMatrix4(T), dirs: [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a).applyMatrix3(N).normalize()), fire: [0, 0, 0, 0] };
      }
      if (def.dock) {
        // port face centre and outward axis (body frame)
        P.dock = { pos: new THREE.Vector3(def.dock.h, 0, 0).applyMatrix4(T), axis: new THREE.Vector3(1, 0, 0).applyMatrix3(N).normalize() };
      }
      // contact points for hull-ground collisions (body frame)
      P.contacts = this.contactPoints(def, T, N);
      if (this.visual) {
        const m = this.partMats(def);
        let mesh = buildPartMesh(def, m);
        if (def.wing && def.wing.swing) {
          // a swing wing pivots at its root: the model sits in a holder that carries the part's placement
          const holder = new THREE.Group();
          holder.add(mesh); P.swingObj = mesh; mesh = holder;
        }
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(T);
        P.mesh = mesh; P.m = m;
        mesh.traverse((o) => {
          o.userData.part = i;
          if (o.userData.ctrl) P.pivot = o;
          if (o.userData.gearStrut) P.strut = o;
          if (o.userData.glow) (P.glows ||= []).push(o);
          if (o.userData.spin) P.spin = o;
          if (o.userData.strobe) P.strobe = o;
          if (o.userData.radiator) P.radMesh = o;
        });
        this.group.add(mesh);
      }
      this.parts.push(P);
    }
    // tree
    for (const P of this.parts) if (P.parent >= 0 && this.parts[P.parent]) this.parts[P.parent].kids.push(P.i);
    // exposed stack ends: a node is covered if another part's node sits on it
    const nodes = [];
    for (const P of this.parts) for (const n of P.def.nodes || []) nodes.push({ P, p: new THREE.Vector3(...n.p).applyMatrix4(P.T), s: SIZES[n.s], top: n.n[1] > 0 });
    for (const P of this.parts) {
      const def = P.def;
      if (!def.nodes || !def.nodes.length || def.wing) continue;
      const r = (P.dia / 2);
      const front = new THREE.Vector3(0, P.len / 2, 0).applyMatrix4(P.T), back = new THREE.Vector3(0, -P.len / 2, 0).applyMatrix4(P.T);
      const cover = (pt) => { let s = 0; for (const n of nodes) if (n.P !== P && n.p.distanceTo(pt) < 0.08) s = Math.max(s, n.s); return s; };
      const hasTop = def.nodes.some((n) => n.n[1] > 0), hasBot = def.nodes.some((n) => n.n[1] < 0);
      const rTop = hasTop ? SIZES[def.nodes.find((n) => n.n[1] > 0).s] / 2 : 0;
      const rBot = hasBot ? SIZES[def.nodes.find((n) => n.n[1] < 0).s] / 2 : r;
      const ct = cover(front), cb = cover(back);
      // pointed noses (no top node) present their whole frontal area with a low drag coefficient
      P.Af = hasTop ? Math.max(0, Math.PI * (rTop * rTop - (ct / 2) ** 2)) : Math.PI * r * r;
      P.Ab = Math.max(0, Math.PI * (rBot * rBot - (cb / 2) ** 2));
      P.CdF = hasTop ? 0.75 : def.cd;
      P.CdB = def.engine ? 0.25 : 0.55;
      P.As = P.dia * P.len * 0.9;
    }
    for (const P of this.parts) {
      if (P.Af === undefined) {
        P.Af = P.wing ? 0 : 0.08 * (P.def.mass / 100) ** 0.5;
        P.Ab = P.Af; P.CdF = 0.4; P.CdB = 0.4; P.As = P.wing ? 0 : P.Af * 2;
      }
    }
    this.vertical = !!this.design.vertical;
  }

  partMats(def) {
    const m = { ...this.mats };
    m.hull = this.mats.hull.clone(); m.black = this.mats.black.clone(); m.dark = this.mats.dark.clone();
    m.glow = this.mats.glow.clone();
    m.heatList = [m.hull, m.black, m.dark];
    return m;
  }

  contactPoints(def, T, N) {
    const pts = [];
    const add = (x, y, z) => pts.push(new THREE.Vector3(x, y, z).applyMatrix4(T));
    if (def.wing) {
      const w = def.wing, t = Math.tan(w.sweep);
      add(0, w.root / 2, 0); add(0, -w.root / 2, 0);
      add(w.span, w.root / 2 - t * w.span, 0); add(w.span, w.root / 2 - t * w.span - w.tip, 0);
    } else if (def.gear) {
      add(0, 0, 0);
    } else if (def.nodes && def.nodes.length) {
      const r = (def.size ? SIZES[def.size] : 1) / 2, L = def.len;
      const hasTop = def.nodes.some((n) => n.n[1] > 0);
      for (const [x, z] of [[r, 0], [-r, 0], [0, r], [0, -r]]) { add(x, -L / 2, z); if (hasTop) add(x, L / 2, z); }
      if (!hasTop) add(0, L / 2, 0);
    } else {
      add(...def.com);
    }
    return pts;
  }

  // ---------- mass properties ----------
  recompute() {
    let M = 0; const com = new THREE.Vector3();
    for (const P of this.parts) {
      if (!P.alive) continue;
      let m = P.dry; for (const k in P.res) m += k === 'EC' ? 0 : P.res[k].amt;
      P.massNow = m;
      M += m; com.addScaledVector(P.com, m);
    }
    com.divideScalar(Math.max(1, M));
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const P of this.parts) {
      if (!P.alive) continue;
      const m = P.massNow, r = _r.copy(P.com).sub(com);
      const own = (m / 12) * (P.len * P.len + P.dia * P.dia) + (P.wing ? m * P.def.wing.span * P.def.wing.span / 12 : 0);
      const r2 = r.lengthSq();
      I[0] += m * (r2 - r.x * r.x) + own; I[4] += m * (r2 - r.y * r.y) + own; I[8] += m * (r2 - r.z * r.z) + own;
      I[1] -= m * r.x * r.y; I[2] -= m * r.x * r.z; I[5] -= m * r.y * r.z;
    }
    I[3] = I[1]; I[6] = I[2]; I[7] = I[5];
    this.mass = M; this.com = com;
    this.I = new THREE.Matrix3().set(I[0], I[1], I[2], I[3], I[4], I[5], I[6], I[7], I[8]);
    this.Iinv = this.I.clone().invert();
    this.Idiag = new THREE.Vector3(I[0], I[4], I[8]);
    // capabilities
    this.engines = this.parts.filter((P) => P.alive && P.eng);
    this.wings = this.parts.filter((P) => P.alive && P.wing);
    this.gears = this.parts.filter((P) => P.alive && P.gear);
    this.rcsList = this.parts.filter((P) => P.alive && P.rcs);
    this.docks = this.parts.filter((P) => P.alive && P.dock);
    this.wheelTorque = this.parts.reduce((s, P) => s + (P.alive && P.def.torque ? P.def.torque : 0), 0);
    this.radCap = this.parts.reduce((s, P) => s + (P.alive && P.def.radiator ? P.def.radiator : 0), 0);
    this.ecCap = this.parts.reduce((s, P) => s + (P.alive ? (P.def.ecStore || 0) + (P.def.ec || 0) : 0), 0);
    if (this.ec === undefined) this.ec = this.ecCap;
    this.ec = Math.min(this.ec, this.ecCap);
    this.solar = this.parts.reduce((s, P) => s + (P.alive && P.def.solar ? P.def.solar : 0), 0);
    this.reactors = this.parts.filter((P) => P.alive && P.def.reactor);
    this.root = this.parts[0];
    this.computeStages();
    // extents for camera framing
    const box = new THREE.Box3();
    for (const P of this.parts) if (P.alive) for (const c of P.contacts) box.expandByPoint(c);
    for (const P of this.gears) box.expandByPoint(P.gear.ext.clone().multiplyScalar(P.gear.g.len + P.gear.g.wheel).add(P.gear.mount));
    this.box = box;
    this.size = box.getSize(new THREE.Vector3()).length();
    this.lowest = this.parts.length ? box.min.clone() : new THREE.Vector3();
  }

  // ---------- resources ----------
  amount(k) { let s = 0; for (const P of this.parts) if (P.alive && P.res[k]) s += P.res[k].amt; return s; }
  capacity(k) { let s = 0; for (const P of this.parts) if (P.alive && P.res[k]) s += P.res[k].cap; return s; }
  // remove `kg` of resource k evenly from all tanks; returns amount actually drawn
  // take kg of resource k: from the tanks that will be dropped soonest first (spread evenly within a stage)
  draw(k, kg) {
    if (kg <= 0) return 0;
    const tanks = this.parts.filter((P) => P.alive && P.res[k] && P.res[k].amt > 0);
    if (!tanks.length) return 0;
    let got = 0;
    while (got < kg - 1e-9 && tanks.length) {
      const st = Math.min(...tanks.map((P) => P.stage));
      const now = tanks.filter((P) => P.stage === st);
      let total = 0; for (const P of now) total += P.res[k].amt;
      const take = Math.min(kg - got, total);
      for (const P of now) P.res[k].amt -= take * (P.res[k].amt / total);
      got += take;
      if (take >= total - 1e-9) for (const P of now) { P.res[k].amt = 0; tanks.splice(tanks.indexOf(P), 1); }
    }
    return got;
  }

  // ---------- staging ----------
  // Decouplers fire in groups: those with no other decoupler outboard of them, side (radial) ones before stack
  // ones. Each part gets P.stage = the group that drops it (1, 2, …; Infinity for the part of the ship that stays).
  computeStages() {
    const alive = (P) => P && P.alive;
    const dec = this.parts.filter((P) => alive(P) && P.def.decoupler);
    const sub = (P, out = []) => { out.push(P); for (const k of P.kids) if (alive(this.parts[k])) sub(this.parts[k], out); return out; };
    const groups = [], left = new Set(dec);
    while (left.size) {
      const leaves = [...left].filter((D) => !sub(D).some((Q) => Q !== D && left.has(Q)));
      const radial = leaves.filter((D) => D.def.decoupler.radial);
      const g = radial.length ? radial : leaves;
      groups.push(g); for (const D of g) left.delete(D);
    }
    for (const P of this.parts) P.stage = Infinity;
    groups.forEach((g, i) => { for (const D of g) for (const Q of sub(D)) if (Q.stage === Infinity) Q.stage = i + 1; });
    this.stageGroups = groups;
    this.stagesLeft = groups.length;
  }
  // drop the next stage: returns the parts that came off (empty if there's nothing to stage)
  separate() {
    const g = this.stageGroups && this.stageGroups[0];
    if (!g) return [];
    const removed = [];
    const rm = (Q) => { if (!Q.alive) return; Q.alive = false; removed.push(Q); for (const k of Q.kids) rm(this.parts[k]); };
    for (const D of g) rm(D);
    for (const Q of removed) if (Q.mesh) Q.mesh.visible = false;
    this._intake = undefined;
    this.recompute();
    return removed;
  }
  refuel() { for (const P of this.parts) for (const k in P.res) P.res[k].amt = P.res[k].cap; this.ec = this.ecCap; this.recompute(); }

  // ---------- engines ----------
  // env: {rho, p, mach, a}; returns thrust (N), isp (s) for the engine in its current mode at full throttle
  engineOutput(P, env) {
    const E = P.eng, e = E.e;
    const sig = env.rho / 1.225;
    if (E.mode === 'jet' || E.mode === 'air') {
      if (env.rho < 1e-4) return [0, 0];
      const maxM = e.maxMach, M = env.mach;
      let mf;
      if (e.type === 'hybrid') mf = (1 + 0.55 * Math.min(M, 3.6)) * (1 - smoothstep(maxM - 1.6, maxM, M)) * 0.62;
      else mf = (1 + 0.25 * M) * (1 - smoothstep(maxM - 0.7, maxM, M));
      const intake = 1 + this.intakeBonus;
      const T = e.thrust * Math.pow(sig, 0.72) * mf * intake * (1 - smoothstep(e.ceiling * 0.8, e.ceiling, env.h));
      return [Math.max(0, T), e.isp * (1 - 0.2 * Math.min(1, M / maxM))];
    }
    if (E.mode === 'scram') {
      const M = env.mach;
      const g = smoothstep(e.minMach, e.minMach + 1.5, M) * (1 - smoothstep(e.maxMach - 2.5, e.maxMach, M)) * (0.6 + 0.4 * Math.exp(-((M - e.peakMach) ** 2) / 8));
      const d = Math.min(1, Math.pow(env.rho / 0.05, 0.55)) * (1 - smoothstep(e.ceiling * 0.85, e.ceiling, env.h));
      return [e.thrust * g * d * (1 + this.intakeBonus), e.isp];
    }
    // rocket (also hybrid closed cycle)
    const r = e.type === 'hybrid' ? e.rocket : e;
    const pr = Math.min(1.2, env.p / 101325);
    const isp = r.ispVac - (r.ispVac - r.ispSL) * pr;
    return [r.thrust * isp / r.ispVac, isp];
  }
  fuelMix(P) { const e = P.eng.e; return P.eng.mode === 'rocket' && e.type === 'hybrid' ? e.rocket.fuel : e.fuel; }

  // Thrust trim: per-engine throttle factors (P.eng.bal, 0..1) so the active engines' combined thrust passes
  // through the centre of mass. Like a real flight computer splitting power between lift fans.
  balanceEngines(env) {
    const list = [];
    for (const P of this.engines) {
      if (!P.alive || !P.eng.active) { P.eng.bal = 1; continue; }
      const T = this.engineOutput(P, env)[0];
      if (T <= 0) { P.eng.bal = 1; continue; }
      const r = P.eng.pos.clone().sub(this.com);
      list.push({ P, T, tau: new THREE.Vector3().crossVectors(r, P.eng.dir.clone().multiplyScalar(T)) });
    }
    if (list.length < 2) { for (const L of list) L.P.eng.bal = 1; return; }
    const s = list.map(() => 1);
    let norm = 0; for (const L of list) norm += L.tau.lengthSq();
    const sumT = list.reduce((a, L) => a + L.T, 0);
    const tol = sumT * 0.02;               // 2 cm of lever arm is close enough
    const net = new THREE.Vector3();
    for (let it = 0; it < 60; it++) {
      net.set(0, 0, 0);
      list.forEach((L, i) => net.addScaledVector(L.tau, s[i]));
      if (net.length() < tol) break;
      list.forEach((L, i) => { s[i] = Math.min(1, Math.max(0, s[i] - 0.9 * net.dot(L.tau) / norm)); });
    }
    const mx = Math.max(...s);
    list.forEach((L, i) => { L.P.eng.bal = mx > 0.05 ? s[i] / mx : 1; });
  }

  // load factor the wings can take before the weakest one breaks (lift shared in proportion to area)
  get gLimit() {
    let A = 0, sig = Infinity;
    for (const P of this.wings) if (P.alive !== false && Math.abs(P.wing.n.y) > 0.5) { A += P.wing.area; sig = Math.min(sig, P.wing.fmax / P.wing.area); }
    return A > 0 ? (sig * A) / (this.mass * 9.80665) : Infinity;
  }

  get intakeBonus() { return this._intake ?? (this._intake = this.parts.reduce((s, P) => s + (P.alive && P.def.intake ? P.def.intake : 0), 0)); }

  // ---------- aerodynamics ----------
  // vAir: craft velocity relative to air in body frame; w: angular velocity (body); returns force & torque about COM
  aero(vAir, w, env, F, Tq) {
    F.set(0, 0, 0); Tq.set(0, 0, 0);
    if (env.rho <= 0) return;
    const M = env.mach;
    const wave = M < 0.8 ? 1 : M < 1.08 ? 1 + 1.6 * smoothstep(0.8, 1.08, M) : 2.6 - 0.9 * smoothstep(1.08, 3.5, M);
    const com = this.com;
    for (const P of this.parts) {
      if (!P.alive) continue;
      if (P.wing) { this.wingForce(P, vAir, w, env, F, Tq); continue; }
      // local velocity at part centre
      _r.copy(P.com).sub(com);
      _v.crossVectors(w, _r).add(vAir);
      const V = _v.length();
      if (V < 0.01) continue;
      const ua = _v.dot(P.axis);
      _u.copy(P.axis).multiplyScalar(ua);              // axial component
      _w.copy(_v).sub(_u);                              // cross component
      const cdaAx = (ua > 0 ? P.CdF * P.Af : P.CdB * P.Ab) * wave;
      const cdaX = (P.As || 0) * 0.9 * (M > 1 ? 1.3 : 1);
      _f.copy(_u).multiplyScalar(-0.5 * env.rho * Math.abs(ua) * cdaAx).addScaledVector(_w, -0.5 * env.rho * _w.length() * cdaX);
      // gear drag when deployed
      if (P.gear) _f.addScaledVector(_v, -0.5 * env.rho * V * 0.35 * P.gear.deployed);
      F.add(_f);
      Tq.add(_r.cross(_f));
    }
  }

  // lift and drag coefficients of a wing at angle of attack a with control deflection defl
  wingCoef(W, a, defl, M) {
    const ar = W.ar;
    let cla = (2 * Math.PI * ar) / (ar + 2);
    if (M < 0.9) cla /= Math.sqrt(1 - Math.min(0.75, M * M) * 0.9);
    else if (M > 1.2) cla = Math.min(cla, 4 / Math.sqrt(M * M - 1));
    else cla *= 1.05;
    const stall = 0.30;
    const sa = Math.sin(a), ca = Math.cos(a);
    // effective angle including control deflection on the movable part
    const ad = a + defl * W.tau;
    const lin = cla * Math.sin(ad) * Math.cos(ad);
    const plate = 1.1 * Math.sin(2 * ad);
    const k = smoothstep(stall, stall + 0.25, Math.abs(ad));
    let cl = lin * (1 - k) + plate * k;
    let cd = 0.006 + (W.cd0 || 0) + (M > 0.85 ? 0.012 * smoothstep(0.85, 1.1, M) * (W.waveK ?? 1) : 0) + (cl * cl) / (Math.PI * 0.85 * ar) * (1 - k) + 1.2 * sa * sa * k + Math.abs(defl) * 0.02;
    let dCl = cla * W.tau * (1 - k * 0.7);           // lift change per radian of control deflection
    // hypersonic flow (Newtonian impact): normal force 2·sin²(incidence) on the fixed part and on the moving
    // control surface, which sees its full deflection — flaps get stronger at high angles of attack
    const hyp = smoothstep(2.5, 5, M);
    if (hyp > 0) {
      const fC = W.ctrl > 0 ? 0.3 : 0;
      const ns = (x) => Math.sin(x) * Math.abs(Math.sin(x));
      const af = a + defl;
      const cn = 2 * ((1 - fC) * ns(a) + fC * ns(af));
      cl = cl * (1 - hyp) + cn * ca * hyp;
      cd = cd * (1 - hyp) + (0.008 + 2 * ((1 - fC) * Math.abs(ns(a)) + fC * Math.abs(ns(af))) * Math.abs(sa)) * hyp;
      dCl = dCl * (1 - hyp) + 2 * fC * Math.abs(Math.sin(2 * af)) * Math.max(0.2, ca) * hyp;
    }
    return { cl, cd, dCl, k };
  }

  wingForce(P, vAir, w, env, F, Tq) {
    const W = P.wing;
    _r.copy(W.ac).sub(this.com);
    _v.crossVectors(w, _r).add(vAir);
    const vc = _v.dot(W.c), vn = _v.dot(W.n);
    const V2 = vc * vc + vn * vn;
    if (V2 < 0.01) return;
    const V = Math.sqrt(V2);
    const alpha = Math.atan2(-vn, vc);
    const M = env.mach;
    const q = 0.5 * env.rho * V2 * W.area;
    // lift direction: perpendicular to the flow in the wing's chord-normal plane; drag along the in-plane flow
    _u.copy(W.n).multiplyScalar(vc).addScaledVector(W.c, -vn).divideScalar(V);
    _w.copy(W.c).multiplyScalar(vc).addScaledVector(W.n, vn).divideScalar(V);
    const base = this.wingCoef(W, alpha, 0, M);
    _f.copy(_u).multiplyScalar(q * base.cl).addScaledVector(_w, -q * base.cd);
    _f.addScaledVector(W.s, -0.5 * env.rho * _v.dot(W.s) * Math.abs(_v.dot(W.s)) * W.area * 0.01);
    F.add(_f);
    Tq.add(_t.copy(_r).cross(_f));
    // the control surface's extra force acts at the trailing edge, well behind the aerodynamic centre
    _r2.copy(W.ctrlPt).sub(this.com);
    let full = base;
    if (W.ctrl > 0 && W.defl !== 0) {
      full = this.wingCoef(W, alpha, W.defl, M);
      _f.copy(_u).multiplyScalar(q * (full.cl - base.cl)).addScaledVector(_w, -q * (full.cd - base.cd));
      F.add(_f);
      Tq.add(_t.copy(_r2).cross(_f));
    }
    // torque sensitivity to deflection (for control allocation), per radian, at current dynamic pressure
    // structural load: the force across the wing as a fraction of what it can carry
    W.load = Math.abs((q * full.cl) * _u.dot(W.n) - q * full.cd * _w.dot(W.n)) / W.fmax;
    if (W.load > W.peak) W.peak = W.load;
    W.torq.copy(_r2).cross(_u).multiplyScalar(q * full.dCl);
    W.stalled = full.k > 0.5;
    W.alpha = alpha;
  }

  // ---------- heating ----------
  // vAirBody: velocity relative to air (body frame); called once per frame
  heat(dt, vAirBody, env, engineHeat, heatScale, inSun) {
    const V = vAirBody.length();
    const vhat = _v.copy(vAirBody).divideScalar(Math.max(V, 1e-6));
    const Taw = env.T * (1 + 0.18 * env.mach * env.mach);
    // convective flux at a 1 m nose (Sutton–Graves), plus a low-speed convection term
    const q0 = 1.83e-4 * Math.sqrt(Math.max(env.rho, 0)) * V * V * V * heatScale;
    let worst = 0, worstP = null;
    const radFrac = engineHeat > 0 ? Math.min(1, this.radCap / engineHeat) : 1;
    const hotDestroy = [];
    for (const P of this.parts) {
      if (!P.alive) continue;
      let exp;
      if (P.wing) {
        const sn = Math.abs(vhat.dot(P.wing.n));
        exp = P.wing.area * (0.04 + sn * 0.9);
      } else {
        const ua = vhat.dot(P.axis);
        exp = (ua > 0 ? P.Af : P.Ab) * Math.abs(ua) + (P.As || 0) * 0.12 * Math.sqrt(Math.max(0, 1 - ua * ua));
        // retracted landing gear sits behind its doors
        if (P.gear) exp *= 0.08 + 0.92 * (P.gear.deployed ?? 1);
      }
      const rn = P.wing ? 0.6 : Math.max(0.3, P.dia / 2);
      let Qin = exp * q0 / Math.sqrt(rn) * Math.max(0, 1 - P.temp / Math.max(Taw, 300));
      // ambient convection (cooling or warming toward the air temperature)
      const hconv = (8 + 6 * Math.sqrt(Math.max(0, env.rho) * V)) * P.Asurf;
      Qin += hconv * ((V > 600 ? Math.min(Taw, 1500) : env.T) - P.temp) * 0.3;
      // engines and their own waste heat
      if (P.eng && engineHeat > 0) Qin += P.eng.e.heat * P.eng.thr * (1 - radFrac) * (P.eng.flame > 0 ? 1 : 0);
      if (P.res.ABL) {
        const A = P.res.ABL;
        if (A.amt > 0 && P.temp > 750 && Qin > 0) {
          const burn = Math.min(A.amt, (Qin * 0.7 * smoothstep(750, 1200, P.temp) * dt) / ABLATION_HEAT);
          A.amt -= burn; Qin -= (burn * ABLATION_HEAT) / Math.max(dt, 1e-6);
        }
        P.maxT = A.amt > 0.5 ? P.def.maxT : 1900;
      }
      // reactors make their own waste heat (radiators carry it away)
      if (P.def.reactor && P.reactorOn) Qin += P.def.reactor.heat * (1 - Math.min(1, this.radCap / Math.max(1, engineHeat + this.reactorHeat())));
      const Tenv = inSun ? 250 : 120;
      let Qout = 0.8 * SIGMA * P.Asurf * (P.temp ** 4 - Tenv ** 4);
      if (P.def.radiator) Qout += P.def.radiator * Math.min(1, engineHeat / Math.max(1, this.radCap)) * 0.15;
      P.temp += ((Qin - Qout) / P.C) * dt;
      if (P.temp < 3) P.temp = 3;
      const f = P.temp / P.maxT;
      if (f > worst) { worst = f; worstP = P; }
      if (P.temp > P.maxT) hotDestroy.push(P);
    }
    this.heatFrac = worst; this.hottest = worstP;
    return hotDestroy;
  }

  // swing wings: sweep back with Mach (0.8 → 1.05), moving their lift aft, shortening the effective span and
  // cutting the transonic drag rise; dt-limited so the wings take a few seconds to move
  sweepWings(mach, dt) {
    for (const P of this.wings) {
      const W = P.wing;
      if (!W.swing || P.alive === false) continue;
      const tgt = smoothstep(0.78, 1.05, mach);
      W.k += clamp(tgt - W.k, -dt * 0.25, dt * 0.25);
      const ang = W.swing * W.k, aft = W.yMac * Math.sin(ang);
      W.ac.copy(W.ac0).addScaledVector(W.c, -aft);
      W.ctrlPt.copy(W.ctrl0).addScaledVector(W.c, -aft);
      W.ar = W.ar0 * (1 - 0.5 * W.k);
      W.waveK = 1 - 0.65 * W.k;
    }
  }

  // waste heat of the running reactors (W)
  reactorHeat() { let h = 0; for (const P of this.reactors) if (P.alive && P.reactorOn) h += P.def.reactor.heat; return h; }
  // electric power (kW): generation in sunlight / shade and the drives' draw at full throttle
  powerBudget(inSun = true) {
    let gen = 0, draw = 0;
    for (const P of this.parts) {
      if (!P.alive) continue;
      if (P.def.reactor) gen += P.def.reactor.power;
      if (P.def.solar && inSun) gen += P.def.solar * 10;
      if (P.eng && P.eng.e.power) draw += P.eng.e.power;
    }
    return { gen, draw };
  }

  // ---------- damage ----------
  // destroy a part and everything attached beyond it; returns the list of removed parts
  destroy(P) {
    const removed = [];
    const rm = (Q) => {
      if (!Q.alive) return;
      Q.alive = false; removed.push(Q);
      for (const k of Q.kids) rm(this.parts[k]);
    };
    rm(P);
    for (const Q of removed) if (Q.mesh) Q.mesh.visible = false;
    this._intake = undefined;
    this.recompute();
    return removed;
  }

  // ---------- visuals ----------
  updateVisuals(dt, t, ctl) {
    for (const P of this.parts) {
      if (!P.alive || !P.mesh) continue;
      // heat glow
      const hot = clamp((P.temp - 700) / 1400, 0, 1);
      if (P.m && P.m.heatList) for (const m of P.m.heatList) {
        if (hot > 0.01) { m.emissive.setRGB(1.0 * hot, 0.32 * hot * hot, 0.08 * hot * hot * hot); m.emissiveIntensity = 1.4; }
        else if (m.emissive.r > 0) m.emissive.setRGB(0, 0, 0);
      }
      if (P.pivot && P.wing) P.pivot.setRotationFromAxisAngle(P.pivot.userData.hingeAxis, P.wing.defl);
      if (P.swingObj) P.swingObj.rotation.z = -P.wing.swing * P.wing.k;
      if (P.strut && P.gear) {
        P.strut.rotation.z = (1 - P.gear.deployed) * 1.45;
        P.strut.position.x = -P.gear.comp * 0.6;
        P.strut.traverse((o) => { if (o.userData.wheel) o.rotation.y += P.gear.spin * dt; });
      }
      if (P.glows && P.eng) for (const gl of P.glows) {
        const f = P.eng.flame;
        if (gl.material.color) gl.material.color.setRGB(0.25 + f * 1.0, 0.12 + f * 0.6, 0.05 + f * 0.25);
        if (gl.material.emissiveIntensity !== undefined && P.eng.e.fusion) gl.material.emissiveIntensity = 0.4 + f * 2.5;
      }
      if (P.spin && P.eng) P.spin.rotation.x += P.eng.thr * 40 * dt;
      if (P.strobe) P.strobe.visible = (t % 1.2) < 0.08;
      if (P.radMesh) { const k = clamp(this.radLoad || 0, 0, 1); P.radMesh.material.emissive.setRGB(k * 0.9, k * 0.25, k * 0.05); }
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
}
