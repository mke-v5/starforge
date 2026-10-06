// Preset ships, built with the same data format the hangar editor produces.
import * as THREE from 'three';
import { PART } from './parts.js';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const qa = (axis, a) => new THREE.Quaternion().setFromAxisAngle(axis, a);
export const Q_FWD = qa(X, -Math.PI / 2);                          // part +Y -> body -Z (nose), part +Z -> body +Y
export const Q_TOP = qa(Z, Math.PI / 2).multiply(Q_FWD.clone());   // surface part pointing up
export const Q_BOT = qa(Z, -Math.PI / 2).multiply(Q_FWD.clone());  // surface part pointing down
export const qRollFrom = (angle) => qa(Z, angle).multiply(Q_FWD.clone());   // surface part pointing at angle (0 = right, +90° = up)

// mirrored quaternion for a part reflected across the body X=0 plane (applied together with a local X flip)
export function mirrorQuat(q) {
  const R = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const M = new THREE.Matrix4().makeScale(-1, 1, 1);
  const R2 = new THREE.Matrix4().multiplyMatrices(M, R).multiply(M);
  return new THREE.Quaternion().setFromRotationMatrix(R2);
}

export class DesignBuilder {
  constructor(name, colors, opts = {}) {
    this.d = { name, colors, parts: [], vertical: !!opts.vertical, version: 1 };
    this.front = 0;
  }
  // stack parts nose-to-tail starting at body z = front
  chain(ids) {
    const out = [];
    let parent = this.d.parts.length ? this.lastStack : -1;
    for (const id of ids) {
      const def = PART[id];
      const zc = this.front + def.len / 2;
      out.push(this.add(id, [0, 0, zc], Q_FWD, parent));
      parent = out[out.length - 1];
      this.lastStack = parent;
      this.front = zc + def.len / 2;
    }
    return out;
  }
  add(id, p, q, parent = -1, mirror = false, sym = -1) {
    this.d.parts.push({ id, p: [...p], q: [q.x, q.y, q.z, q.w], mirror, parent, sym });
    return this.d.parts.length - 1;
  }
  pair(id, p, q, parent) {
    const a = this.add(id, p, q, parent, false);
    const mq = mirrorQuat(q);
    const b = this.add(id, [-p[0], p[1], p[2]], mq, parent, true, a);
    this.d.parts[a].sym = b;
    return [a, b];
  }
  // part index whose stack span covers body z
  at(z) {
    let best = 0;
    this.d.parts.forEach((p, i) => { const def = PART[p.id]; if (def.nodes && def.nodes.length && Math.abs(p.p[0]) < 0.01 && Math.abs(p.p[2] - z) <= def.len / 2 + 0.01) best = i; });
    return best;
  }
  done() { return this.d; }
}

function kestrel() {
  const b = new DesignBuilder('Kestrel', { hull: '#dfe4ea', accent: '#ffb347' });
  b.chain(['ck-kestrel', 'fs-s4', 'fs-s2', 'en-swift']);
  const [wr] = b.pair('wg-swept', [0.6, -0.25, 6.2], Q_FWD, b.at(6.2));
  b.pair('wg-tailplane', [0.55, 0.05, 11.9], Q_FWD, b.at(11.9));
  b.add('wg-fin', [0, 0.6, 11.2], Q_TOP, b.at(11.2));
  b.add('gr-light', [0, -0.46, 2.6], Q_BOT, b.at(2.6));
  b.pair('gr-light', [1.9, -0.3, 8.0], Q_BOT, wr);
  b.add('ut-strobe', [0, 0.62, 9.0], Q_TOP, b.at(9.0));
  return b.done();
}

function lynx() {
  const b = new DesignBuilder('Lynx VTOL', { hull: '#3d4b5c', accent: '#7fd4ff' });
  b.chain(['ck-kestrel', 'fs-s4', 'fs-s4', 'en-swift']);
  const [wr] = b.pair('wg-delta-m', [0.6, -0.2, 9.3], Q_FWD, b.at(9.3));
  b.add('wg-fin', [0, 0.6, 13.6], Q_TOP, b.at(13.6));
  b.pair('ct-canard', [0.55, 0.1, 3.4], Q_FWD, b.at(3.4));
  // lift fans balanced around the centre of mass
  b.add('en-liftfan', [0, -0.62, 5.0], Q_BOT, b.at(5.0));
  b.add('en-liftfan', [0, -0.62, 11.2], Q_BOT, b.at(11.2));
  b.add('gr-light', [0, -0.46, 2.6], Q_BOT, b.at(2.6));
  b.pair('gr-light', [1.9, -0.25, 9.8], Q_BOT, wr);
  return b.done();
}

function selene() {
  const b = new DesignBuilder('Selene', { hull: '#e8ecf0', accent: '#ffb347' });
  b.chain(['ck-horizon', 'fs-m4', 'fu-m3', 'fu-m3', 'fu-m3', 'en-helios']);
  const [wr] = b.pair('wg-delta-l', [1.2, -0.55, 11.4], Q_FWD, b.at(11.4));
  b.add('wg-fin', [0, 1.22, 20.0], Q_TOP, b.at(20.0));
  b.pair('en-pod', [1.2, 0.55, 9.0], qa(Z, 0.35).multiply(Q_FWD.clone()), b.at(9.0));
  b.pair('ut-radiator', [0.9, 0.9, 15.0], qa(Z, Math.PI / 4).multiply(Q_FWD.clone()), b.at(15.0));
  b.add('en-plasma', [0, -1.22, 7.5], Q_BOT, b.at(7.5));
  b.add('en-plasma', [0, -1.22, 16.0], Q_BOT, b.at(16.0));
  b.add('gr-heavy', [0, -1.0, 4.0], Q_BOT, b.at(4.0));
  b.pair('gr-heavy', [3.0, -0.62, 13.0], Q_BOT, wr);
  b.add('ut-strobe', [0, 1.25, 12.0], Q_TOP, b.at(12.0));
  b.add('ut-light', [0, -1.15, 3.0], Q_BOT, b.at(3.0));
  // docking: a port on the spine and RCS blocks at both ends to steer in
  b.add('ut-dock', [0, 1.25, 7.0], Q_TOP, b.at(7.0));
  for (const z of [5.8, 16.8]) for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add('ct-rcs', [Math.cos(a) * 1.25, Math.sin(a) * 1.25, z], qRollFrom(a), b.at(z));
  }
  return b.done();
}

function starhopper() {
  const b = new DesignBuilder('Starhopper', { hull: '#c9ced6', accent: '#ff7a3d' }, { vertical: true });
  b.chain(['ck-vanguard', 'fu-l4', 'en-helios-l']);
  // four landing legs splayed around the tail
  const tailZ = b.front;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const out = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const xl = out.clone().multiplyScalar(0.45).add(new THREE.Vector3(0, 0, 0.89)).normalize();   // leg direction
    const yl = new THREE.Vector3(0, 0, -1).addScaledVector(xl, xl.z).normalize();                  // roughly toward the nose
    const zl = new THREE.Vector3().crossVectors(xl, yl);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xl, yl, zl));
    const p = out.clone().multiplyScalar(1.8);
    b.add('gr-leg-l', [p.x, p.y, tailZ - 3.6], q, b.at(tailZ - 3.6));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const p = [Math.cos(a) * 1.85, Math.sin(a) * 1.85, 8.5];
    b.add('ut-radiator', p, qRollFrom(a), b.at(8.5));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add('ct-rcs', [Math.cos(a) * 1.55, Math.sin(a) * 1.55, 3.5], qRollFrom(a), b.at(3.5));
    b.add('ct-rcs', [Math.cos(a) * 1.875, Math.sin(a) * 1.875, 10.2], qRollFrom(a), b.at(10.2));   // tail ring: translate without twisting
  }
  // docking port on the nose
  const nose = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), Y.clone(), X.clone()));
  b.add('ut-dock', [0, 0, 0.8], nose, 0);
  return b.done();
}

// Swing-wing fighter: wings spread for take-off and landing, sweep back past Mach 0.8; afterburning turbojet.
function peregrine() {
  const b = new DesignBuilder('Peregrine', { hull: '#5a6470', accent: '#ff5a4f', pattern: 'chevron' });
  b.chain(['ck-kestrel', 'fs-s4', 'fs-s2', 'en-raptor']);
  const [wr] = b.pair('wg-swing', [0.6, -0.25, 7.0], Q_FWD, b.at(7.0));
  b.pair('wg-tailplane', [0.55, 0.05, 12.6], Q_FWD, b.at(12.6));
  b.add('wg-fin', [0, 0.6, 11.8], Q_TOP, b.at(11.8));
  b.add('gr-light', [0, -0.46, 2.6], Q_BOT, b.at(2.6));
  b.pair('gr-light', [1.25, -0.3, 8.4], Q_BOT, wr);          // near the wing root, where the sweep barely moves it
  b.add('ut-strobe', [0, 0.62, 9.0], Q_TOP, b.at(9.0));
  return b.done();
}

// Ion tug for space: a fusion power core feeds an ion drive; docks at the station. Start it in orbit.
function courier() {
  const b = new DesignBuilder('Courier', { hull: '#e9ecef', accent: '#7ff0e8', glow: true });
  b.chain(['ck-aurora', 'ut-fusioncore', 'fu-m3', 'cb-m4', 'ae-tail-m', 'xe-s2', 'xe-s2', 'en-ion']);
  const cbz = 3.0 + 2.4 + 3.0 + 2.0;
  b.pair('ut-radiator', [1.25, 0, cbz], qRollFrom(0), b.at(cbz));
  b.pair('ut-solar', [0.9, 0.9, cbz + 1.2], qRollFrom(Math.PI / 4), b.at(cbz + 1.2));
  for (const z of [1.6, cbz + 1.6]) for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add('ct-rcs', [Math.cos(a) * 1.27, Math.sin(a) * 1.27, z], qRollFrom(a), b.at(z));
  }
  const nose = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), Y.clone(), X.clone()));
  b.add('ut-dock', [0, 0, 0.0], nose, 0);
  return b.done();
}

// Three-stage rocket: two side boosters and the core light together on the pad; the boosters drop first, then
// the core, and the capsule's service module (vacuum engine, RCS, docking port) finishes the climb to orbit.
function vesta() {
  const b = new DesignBuilder('Vesta', { hull: '#eef0f2', accent: '#2f6fd6' }, { vertical: true });
  const [cap, sm, smEng, sep, t1, t2, core] = b.chain(['ck-aurora', 'rt-m4', 'en-lantern', 'dc-sep-m', 'rt-m8', 'rt-m8', 'en-titan']);
  // side boosters on radial decouplers, level with the lower core tank, their engines beside the core's
  const zc = b.d.parts[t2].p[2], R = PART['rt-m8'], E = PART['en-titan'], dcl = PART['dc-radial'].len;
  const x = 1.25 + dcl + 1.25;
  const right = (sgn) => {
    const mirror = sgn < 0;
    const qd = mirror ? mirrorQuat(qRollFrom(0)) : qRollFrom(0), qs = mirror ? mirrorQuat(Q_FWD) : Q_FWD;
    const d = b.add('dc-radial', [sgn * 1.25, 0, zc], qd, t2, mirror);
    const t = b.add('rt-m8', [sgn * x, 0, zc], qs, d, mirror);
    const e = b.add('en-titan', [sgn * x, 0, zc + R.len / 2 + E.len / 2], qs, t, mirror);
    return [d, t, e];
  };
  const L = right(1), Rt = right(-1);
  for (let k = 0; k < 3; k++) { b.d.parts[L[k]].sym = Rt[k]; b.d.parts[Rt[k]].sym = L[k]; }
  // service-module RCS ring and the docking port on the nose
  const smz = b.d.parts[sm].p[2];
  for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; b.add('ct-rcs', [Math.cos(a) * 1.27, Math.sin(a) * 1.27, smz], qRollFrom(a), sm); }
  const nose = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), Y.clone(), X.clone()));
  b.add('ut-dock', [0, 0, 0.0], nose, cap);
  return b.done();
}

export const PRESETS = [
  { key: 'kestrel', make: kestrel, blurb: 'Nimble jet. Perfect first flight: take off, tour cities, land at any airport.' },
  { key: 'selene', make: selene, blurb: 'Fusion spaceplane. Hangar → orbit → Moon landing → back to a runway. Docks at Meridian Station.' },
  { key: 'lynx', make: lynx, blurb: 'VTOL jet with lift fans. Hover out of the hangar and land on rooftops.' },
  { key: 'starhopper', make: starhopper, blurb: 'Vertical fusion starship. Launches from the pad, lands on its legs anywhere.' },
  { key: 'peregrine', make: peregrine, blurb: 'Swing-wing fighter with an afterburner. Wings spread to land, sweep back for Mach 2.5.' },
  { key: 'courier', make: courier, blurb: 'Ion tug for space, powered by a fusion core. Start it in orbit or docked at the station.' },
  { key: 'vesta', make: vesta, blurb: 'Classic three-stage rocket: side boosters, a core stage and a capsule. Press STAGE as each one burns out.' },
];
