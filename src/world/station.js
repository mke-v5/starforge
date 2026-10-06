// Meridian Station: a crewed outpost in low Earth orbit to rendezvous and dock with (and refuel at).
//
// The station flies on the same gravity model as the ship (Earth + Moon, RK4), so close to it their relative
// motion is exact. Each flight seeds it from fixed orbital elements; saved flights store its state.
// Station frame (like a ship's body frame): -Z = forward along the velocity, +Y = zenith, +X = right.

import * as THREE from 'three';
import { EARTH, D2R, clamp } from '../core/geo.js';
import { rk4 } from '../ship/physics.js';
import { makeMaterials } from '../ship/meshes.js';

export const STATION = {
  name: 'Meridian Station', short: 'Meridian',
  alt: 420000, inc: 51.64 * D2R,
  raan0: 1.1, u0: 0.4,                         // node and position at J2000
  raanRate: -5.0 * D2R / 86400,                // the plane drifts a few degrees a day between flights
  keepOut: 60,                                 // m: autopilots stay outside this sphere except on a port's approach axis
};

// docking ports in the station frame: face centre, outward axis, and the "up" the visitor rolls to
export const PORTS = [
  { name: 'forward', p: [0, 0, -12.4], n: [0, 0, -1], up: [0, 1, 0] },
  { name: 'aft', p: [0, 0, 17.6], n: [0, 0, 1], up: [0, 1, 0] },
  { name: 'nadir', p: [0, -4.3, -9], n: [0, -1, 0], up: [0, 0, 1] },
].map((P, i) => ({ ...P, i, p: new THREE.Vector3(...P.p), n: new THREE.Vector3(...P.n), up: new THREE.Vector3(...P.up) }));

const SOLAR_X = 34, SOLAR_HALF = [16, 10.5], TRUSS_Y = 4.2, TRUSS_Z = 5;

// circular orbit from the fixed elements (frame I: +Y north, +X equinox, RA toward -Z)
export function stationKepler(t, r = new THREE.Vector3(), v = new THREE.Vector3()) {
  const R = EARTH.R + STATION.alt, n = Math.sqrt(EARTH.mu / (R * R * R)), V = Math.sqrt(EARTH.mu / R);
  const O = STATION.raan0 + STATION.raanRate * t, i = STATION.inc, u = STATION.u0 + n * t;
  const N = new THREE.Vector3(Math.cos(O), 0, -Math.sin(O));
  const h = new THREE.Vector3(Math.sin(i) * Math.sin(O), Math.cos(i), Math.sin(i) * Math.cos(O));
  const M = new THREE.Vector3().crossVectors(h, N);
  r.copy(N).multiplyScalar(R * Math.cos(u)).addScaledVector(M, R * Math.sin(u));
  v.copy(N).multiplyScalar(-V * Math.sin(u)).addScaledVector(M, V * Math.cos(u));
  return { r, v };
}

// local-vertical / local-horizontal attitude for a state: quaternion station -> I
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
export function lvlhQ(r, v, out = new THREE.Quaternion()) {
  _y.copy(r).normalize();
  _z.copy(v).addScaledVector(_y, -v.dot(_y)).normalize().negate();      // -Z = forward
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

const _c = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const _qi = new THREE.Quaternion();
// private scratch for the frame helpers (never handed out)
const _sq = new THREE.Quaternion(), _sw = new THREE.Vector3(), _tq = new THREE.Quaternion(), _tp = new THREE.Vector3();
const _pp = new THREE.Vector3(), _pr = new THREE.Vector3(), _pv = new THREE.Vector3();

export class Station {
  constructor(scene) {
    this.scene = scene;
    this.r = new THREE.Vector3(); this.v = new THREE.Vector3(); this.t = 0;
    this.s = [0, 0, 0, 0, 0, 0];
    this.q = new THREE.Quaternion();
    this.w = new THREE.Vector3();        // angular velocity (I)
    this.sunAngle = 0;
    this.ports = PORTS;
    this.occupied = -1;                  // port index the player is docked at
    this.prims = buildPrims();
    this.group = buildModel(this);
    this.group.visible = false;
    scene.add(this.group);
    // far away it's a bright moving star
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,250,235,0.6)'); gr.addColorStop(1, 'rgba(255,240,220,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.glint = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, sizeAttenuation: false }));
    this.glint.renderOrder = 15; this.glint.visible = false;
    scene.add(this.glint);
  }

  seed(t) { const k = stationKepler(t); this.setState(k.r, k.v, t); return this; }
  setState(r, v, t) {
    this.r.copy(r); this.v.copy(v); this.t = t;
    this.s = [r.x, r.y, r.z, v.x, v.y, v.z];
    this.sync();
  }
  sync() {
    lvlhQ(this.r, this.v, this.q);
    this.w.crossVectors(this.r, this.v).divideScalar(this.r.lengthSq());
  }
  // integrate forward to time t (same gravity and integrator as the ship's time warp)
  advanceTo(t) {
    if (!(t > this.t + 1e-9)) return this;
    const s = this.s;
    while (this.t < t - 1e-9) {
      const h = Math.min(t - this.t, 5);
      rk4(s, this.t, h);
      this.t += h;
    }
    this.r.set(s[0], s[1], s[2]); this.v.set(s[3], s[4], s[5]);
    this.sync();
    return this;
  }
  // state at a later time without moving the station (for planners)
  stateAt(t) {
    const s = [...this.s];
    let tt = this.t;
    while (tt < t - 1e-9) { const h = Math.min(t - tt, 20); rk4(s, tt, h); tt += h; }
    return { r: new THREE.Vector3(s[0], s[1], s[2]), v: new THREE.Vector3(s[3], s[4], s[5]), t: tt };
  }
  // quick extrapolation inside a frame (fractions of a second): good to well under a millimetre
  posAt(t, out) {
    const dt = t - this.t, rl = this.r.length(), k = -EARTH.mu / (rl * rl * rl);
    return out.copy(this.r).addScaledVector(this.v, dt).addScaledVector(this.r, 0.5 * k * dt * dt);
  }
  velAt(t, out) {
    const dt = t - this.t, rl = this.r.length(), k = -EARTH.mu / (rl * rl * rl);
    return out.copy(this.v).addScaledVector(this.r, k * dt);
  }
  qAt(t, out) {
    out.copy(this.q);
    if (Math.abs(t - this.t) < 1e-6) return out;
    return out.premultiply(_sq.setFromAxisAngle(_sw.copy(this.w).normalize(), this.w.length() * (t - this.t)));
  }
  // station-frame point / direction -> I at time t (out may be the input vector)
  toWorld(pL, t, out) { this.qAt(t, _tq); return out.copy(pL).applyQuaternion(_tq).add(this.posAt(t, _tp)); }
  dirToWorld(dL, t, out) { this.qAt(t, _tq); return out.copy(dL).applyQuaternion(_tq); }
  toLocal(pW, t, out) { this.qAt(t, _tq).invert(); return out.copy(pW).sub(this.posAt(t, _tp)).applyQuaternion(_tq); }
  dirToLocal(dW, t, out) { this.qAt(t, _tq).invert(); return out.copy(dW).applyQuaternion(_tq); }
  // velocity of a station point (I)
  pointVel(pW, t, out) {
    this.posAt(t, _pp);
    _pr.copy(pW).sub(_pp);
    this.velAt(t, _pv);
    return out.crossVectors(this.w, _pr).add(_pv);
  }
  port(i, t, pos, axis, up) {
    const P = this.ports[i];
    if (pos) this.toWorld(P.p, t, pos);
    if (axis) this.dirToWorld(P.n, t, axis);
    if (up) this.dirToWorld(P.up, t, up);
    return P;
  }

  // ---- collisions: penetration of a station-frame point into the structure ----
  penetrate(pL) {
    let best = null;
    for (const pr of this.prims) {
      const h = pr.hit(pL, this);
      if (h && (!best || h.depth > best.depth)) best = h;
    }
    return best;
  }
  // push the ship out of the structure (spring-damper, like hull contact with the ground); hard hits break parts
  contactForces(ship, Fw, Tb, qInv) {
    const craft = ship.craft, t = ship.t;
    const m = craft.mass;
    let n = 0;
    for (const P of craft.parts) {
      if (!P.alive || P.dock) continue;
      for (const cp of P.contacts) {
        const pw = ship.bodyToWorld(cp, new THREE.Vector3());
        const pl = this.toLocal(pw, t, new THREE.Vector3());
        if (pl.lengthSq() > 70 * 70) continue;
        const h = this.penetrate(pl);
        if (!h) continue;
        const nW = this.dirToWorld(h.n, t, new THREE.Vector3());
        // relative velocity of the hull point against the station
        const rb = _c.copy(cp).sub(craft.com);
        const vp = new THREE.Vector3().crossVectors(ship.w, rb).applyQuaternion(ship.q).add(ship.v);
        const vrel = vp.sub(this.pointVel(pw, t, new THREE.Vector3()));
        const vn = vrel.dot(nW);
        if (-vn > Math.max(2, (P.def.crash || 8) * 0.4)) { ship.breakPart(P, 'collision', -vn); break; }
        const k = m * 400 / Math.max(1, craft.parts.length * 0.4);
        const c = 2 * Math.sqrt(k * m / Math.max(1, craft.parts.length)) * 0.8;
        const Fn = Math.max(0, k * h.depth - c * vn);
        const vt = vrel.clone().addScaledVector(nW, -vn);
        const F = nW.clone().multiplyScalar(Fn);
        if (vt.lengthSq() > 1e-6) F.addScaledVector(vt.normalize(), -Math.min(0.3 * Fn, m * 0.5));
        ship.applyWorld(F, pw, Fw, Tb, qInv);
        n++;
      }
    }
    return n;
  }

  // ---- docking ----
  // ports of the ship in I: [{ P, pos, axis }]
  shipPorts(ship) {
    return ship.craft.docks.map((P) => ({ P, pos: ship.bodyToWorld(P.dock.pos, new THREE.Vector3()), axis: ship.dirToWorld(P.dock.axis, new THREE.Vector3()) }));
  }
  // soft capture: a ship port within 40 cm of a free station port, lined up within 10° and slower than 0.8 m/s
  checkCapture(ship) {
    if (ship.docked || ship.dead || !ship.craft.docks.length) return null;
    const t = ship.t;
    const sps = this.shipPorts(ship);
    let closest = Infinity;
    const pos = new THREE.Vector3(), axis = new THREE.Vector3();
    for (const sp of sps) for (const P of this.ports) {
      if (this.occupied === P.i) continue;
      this.port(P.i, t, pos, axis);
      const d = sp.pos.distanceTo(pos);
      closest = Math.min(closest, d);
      if (d > 0.4 || !ship.dockArmed) continue;
      const ang = Math.acos(clamp(-sp.axis.dot(axis), -1, 1));
      const rb = _c.copy(sp.P.dock.pos).sub(ship.craft.com);
      const vp = new THREE.Vector3().crossVectors(ship.w, rb).applyQuaternion(ship.q).add(ship.v);
      const vrel = vp.sub(this.pointVel(pos, t, _d)).length();
      if (ang > 10 * D2R || vrel > 0.8) return { fail: true, ang, vrel };
      this.dock(ship, sp.P, P.i);
      return { port: P, vrel };
    }
    // after undocking, the ports have to separate before they can latch again
    if (!ship.dockArmed && closest > 1.5) ship.dockArmed = true;
    return null;
  }
  dock(ship, part, portIdx) {
    const t = ship.t, P = this.ports[portIdx];
    const pos = this.toWorld(P.p, t, new THREE.Vector3()), axis = this.dirToWorld(P.n, t, new THREE.Vector3());
    // hard dock: turn the ship so the ports face exactly, then slide it so they meet
    const a = ship.dirToWorld(part.dock.axis, new THREE.Vector3());
    ship.q.premultiply(new THREE.Quaternion().setFromUnitVectors(a, axis.clone().negate())).normalize();
    const sp = ship.bodyToWorld(part.dock.pos, new THREE.Vector3());
    ship.r.add(pos.sub(sp));
    const qs = this.qAt(t, new THREE.Quaternion());
    ship.docked = { port: portIdx, part: part.i, qRel: qs.clone().invert().multiply(ship.q), pRel: this.toLocal(ship.r, t, new THREE.Vector3()) };
    this.pointVel(ship.r, t, ship.v);
    ship.w.copy(this.w).applyQuaternion(qs.copy(ship.q).invert());
    this.occupied = portIdx;
    ship.events.push({ type: 'docked', port: P.name });
  }
  undock(ship, push = 0.25) {
    const D = ship.docked;
    if (!D) return;
    const axis = this.dirToWorld(this.ports[D.port].n, ship.t, new THREE.Vector3());
    ship.docked = null;
    this.occupied = -1;
    ship.dockArmed = false;
    ship.v.addScaledVector(axis, push);
    ship.events.push({ type: 'undocked' });
  }

  // ---- per-frame visuals (floating origin camI) ----
  update(camI, eph, flightTime) {
    const d = this.r.distanceTo(camI);
    const near = d < 300000;
    this.group.visible = near;
    if (near) {
      this.group.position.copy(this.r).sub(camI);
      this.group.quaternion.copy(this.q);
      // arrays track the sun about the truss (station X axis)
      const sL = _e.copy(eph.sun).applyQuaternion(_qi.copy(this.q).invert());
      this.sunAngle = Math.atan2(sL.z, sL.y);
      for (const w of this.model.wings) w.rotation.x = this.sunAngle;
      const blink = (flightTime % 1.5) < 0.1;
      this.model.strobe.visible = blink;
    }
    // glint: sunlit and too small to see as a model
    const lit = !shadowed(this.r, eph.sun);
    this.glint.visible = lit && d > 400 && d < 2.5e6;
    if (this.glint.visible) {
      this.glint.position.copy(this.r).sub(camI);
      const k = clamp(1 - Math.log10(d / 400) / 4.2, 0.25, 1);
      this.glint.scale.set(0.022 * k, 0.022 * k, 1);
      this.glint.material.opacity = clamp((d - 400) / 1500, 0, 1) * 0.95;
    }
  }
  hide() { this.group.visible = false; this.glint.visible = false; }
}

function shadowed(p, sun) {
  const along = p.dot(sun);
  if (along > 0) return false;
  return p.lengthSq() - along * along < EARTH.R * EARTH.R;
}

// ---------------- collision primitives (station frame) ----------------
function sphere(c, r) {
  c = new THREE.Vector3(...c);
  return { hit(p) { const d = p.distanceTo(c); if (d >= r) return null; return { depth: r - d, n: p.clone().sub(c).divideScalar(Math.max(d, 1e-6)) }; } };
}
function capsule(a, b, r) {
  a = new THREE.Vector3(...a); b = new THREE.Vector3(...b);
  const ab = b.clone().sub(a), L2 = ab.lengthSq();
  return { hit(p) {
    const t = clamp(p.clone().sub(a).dot(ab) / L2, 0, 1);
    const q = a.clone().addScaledVector(ab, t);
    const d = p.distanceTo(q); if (d >= r) return null;
    return { depth: r - d, n: p.clone().sub(q).divideScalar(Math.max(d, 1e-6)) };
  } };
}
// box with half extents h, centre c, optionally rotated about X by a function of the station (solar wings)
function box(c, h, rotX = null) {
  c = new THREE.Vector3(...c);
  return { hit(p, st) {
    const l = p.clone().sub(c);
    if (rotX) l.applyAxisAngle(new THREE.Vector3(1, 0, 0), -rotX(st));
    const dx = h[0] - Math.abs(l.x), dy = h[1] - Math.abs(l.y), dz = h[2] - Math.abs(l.z);
    if (dx <= 0 || dy <= 0 || dz <= 0) return null;
    const n = new THREE.Vector3();
    let depth;
    if (dx <= dy && dx <= dz) { depth = dx; n.set(Math.sign(l.x) || 1, 0, 0); }
    else if (dy <= dz) { depth = dy; n.set(0, Math.sign(l.y) || 1, 0); }
    else { depth = dz; n.set(0, 0, Math.sign(l.z) || 1); }
    if (rotX) n.applyAxisAngle(new THREE.Vector3(1, 0, 0), rotX(st));
    return { depth, n };
  } };
}
function buildPrims() {
  const sun = (st) => st.sunAngle;
  return [
    sphere([0, 0, -9], 2.4), sphere([0, 0, 5], 2.4),
    // (the modules are flat-ended cylinders: keep the capsules' round ends inside them, clear of the ports)
    capsule([0, 0, -5], [0, 0, 1], 2.1), capsule([0, 0, 9], [0, 0, 14], 2.1),
    // port tunnels stop short of the faces so ports can meet
    capsule([0, 0, -10.6], [0, 0, -11.2], 0.95), capsule([0, 0, 15.8], [0, 0, 16.4], 0.95), capsule([0, -2.2, -9], [0, -3.1, -9], 0.95),
    capsule([-50, TRUSS_Y, TRUSS_Z], [50, TRUSS_Y, TRUSS_Z], 0.8), capsule([0, 2.2, TRUSS_Z], [0, TRUSS_Y, TRUSS_Z], 0.5),
    box([11.5, 9.6, TRUSS_Z], [3.5, 4.6, 0.12]), box([-11.5, 9.6, TRUSS_Z], [3.5, 4.6, 0.12]),
    box([SOLAR_X, TRUSS_Y, TRUSS_Z], [SOLAR_HALF[0], 0.15, SOLAR_HALF[1]], sun), box([-SOLAR_X, TRUSS_Y, TRUSS_Z], [SOLAR_HALF[0], 0.15, SOLAR_HALF[1]], sun),
    sphere([0, -2.6, 5], 1.2),
  ];
}

// ---------------- procedural model ----------------
function cellTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#16255a'; g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 8; j++) {
    g.fillStyle = (i + j) % 2 ? '#1c2f6e' : '#192a64';
    g.fillRect(i * 16 + 1, j * 16 + 1, 14, 14);
  }
  g.strokeStyle = '#8a7a4a'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 128); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function targetTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#111'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 6; g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 8; g.beginPath(); g.moveTo(64, 20); g.lineTo(64, 108); g.moveTo(20, 64); g.lineTo(108, 64); g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildModel(st) {
  const M = makeMaterials({ hull: '#eef1f4', accent: '#d6a23e' });
  const root = new THREE.Group();
  const add = (mesh, x = 0, y = 0, z = 0) => { mesh.position.set(x, y, z); root.add(mesh); return mesh; };
  const cylZ = (r, len, mat, seg = 40) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat); m.rotation.x = Math.PI / 2; return m; };
  const ringZ = (r, w, mat) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 40, 1, true), mat); m.rotation.x = Math.PI / 2; return m; };
  const uvTube = (m, len, r) => { const uv = m.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (Math.PI * 2 * r) / 3.2, uv.getY(i) * len / 3.2); uv.needsUpdate = true; };
  // pressurised modules
  const lab = add(cylZ(2.1, 10, M.hull), 0, 0, -2); uvTube(lab, 10, 2.1);
  const hab = add(cylZ(2.1, 9, M.hull), 0, 0, 11.5); uvTube(hab, 9, 2.1);
  for (const z of [-6.6, -2, 2.6, 7.4, 11.5, 15.6]) add(ringZ(2.13, 0.3, z === -2 || z === 11.5 ? M.accent : M.dark), 0, 0, z);
  const nodeMat = M.hull;
  add(new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 20), nodeMat), 0, 0, -9);
  add(new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 20), nodeMat), 0, 0, 5);
  // gold insulation blankets on the hab
  const mli = new THREE.Mesh(new THREE.CylinderGeometry(2.16, 2.16, 3.2, 40, 1, true, 0, Math.PI), M.accent); mli.rotation.x = Math.PI / 2; add(mli, 0, 0, 9.2);
  // cupola on the nadir side of node B
  const cup = add(new THREE.Mesh(new THREE.SphereGeometry(1.2, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.glass), 0, -2.3, 5); cup.rotation.x = Math.PI;
  add(new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.08, 8, 24), M.dark), 0, -2.3, 5).rotation.x = Math.PI / 2;
  // docking ports: tunnel, collar, guide petals, lights and a target beside each
  const tgtMat = new THREE.MeshBasicMaterial({ map: targetTexture() });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
  for (const P of PORTS) {
    const g = new THREE.Group();
    const tun = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 1.5, 32), M.metal); tun.position.y = -0.85; g.add(tun);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.08, 0.22, 32), M.dark); collar.position.y = -0.2; g.add(collar);
    const face = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.98, 32), M.accent); face.rotation.x = -Math.PI / 2; face.position.y = -0.08; g.add(face);
    const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), M.black); hatch.rotation.x = -Math.PI / 2; hatch.position.y = -0.1; g.add(hatch);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const pet = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.06), M.hull);
      pet.position.set(Math.cos(a) * 0.82, 0.12, Math.sin(a) * 0.82); pet.rotation.y = -a + Math.PI / 2; pet.rotateX(-0.25); g.add(pet);
    }
    const tg = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24), tgtMat); tg.rotation.x = -Math.PI / 2; tg.position.set(1.9, -0.6, 0); g.add(tg);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6), M.metal); post.position.set(1.9, -0.9, 0); g.add(post);
    for (const s of [-1, 1]) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), lampMat); l.position.set(0, -0.25, s * 1.15); g.add(l); }
    // orient: group +Y = port axis
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), P.n);
    g.position.copy(P.p);
    root.add(g);
  }
  // truss and pylon
  const trussMat = M.metal;
  add(new THREE.Mesh(new THREE.BoxGeometry(100, 1.2, 1.2), trussMat), 0, TRUSS_Y, TRUSS_Z);
  for (let x = -48; x <= 48; x += 4) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 1.5), M.dark); b.position.set(x, TRUSS_Y, TRUSS_Z); root.add(b);
  }
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 2.2, 16), M.hull), 0, 3.2, TRUSS_Z);
  // radiators standing up from the truss
  const radMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(2.2, 9.2, 0.08), radMat); r.position.set(s * (9.2 + k * 2.3), 9.6, TRUSS_Z); root.add(r);
    }
  }
  // solar wings: two blankets either side of a mast, turning about the truss to face the sun
  const cellMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: cellTexture(), metalness: 0.5, roughness: 0.32, emissive: 0x050a1c, side: THREE.DoubleSide });
  cellMat.map.repeat.set(4, 1);
  const wings = [];
  for (const s of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(s * SOLAR_X, TRUSS_Y, TRUSS_Z);
    const gim = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 1.4, 16), M.dark); gim.rotation.z = Math.PI / 2; gim.position.x = -s * (SOLAR_HALF[0] + 0.4); wing.add(gim);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(SOLAR_HALF[0] * 2, 0.25, 0.4), M.metal); wing.add(mast);
    for (const side of [-1, 1]) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(SOLAR_HALF[0] * 2 - 0.6, 0.05, SOLAR_HALF[1] - 0.6), cellMat);
      bl.position.z = side * (SOLAR_HALF[1] / 2 + 0.25); wing.add(bl);
    }
    root.add(wing); wings.push(wing);
  }
  // lights: red to port (left), green to starboard, a white strobe on top
  const red = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3b3b }));
  const green = new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8), new THREE.MeshBasicMaterial({ color: 0x3bff6a }));
  add(red, -50.4, TRUSS_Y, TRUSS_Z); add(green, 50.4, TRUSS_Y, TRUSS_Z);
  const strobe = add(new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })), 0, 14.4, TRUSS_Z);
  // name band
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g2 = c.getContext('2d'); g2.fillStyle = '#eef1f4'; g2.fillRect(0, 0, 512, 64);
  g2.fillStyle = '#1b2433'; g2.font = 'bold 40px Arial'; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText('MERIDIAN', 256, 34);
  const nameTex = new THREE.CanvasTexture(c); nameTex.colorSpace = THREE.SRGBColorSpace;
  const name = new THREE.Mesh(new THREE.CylinderGeometry(2.14, 2.14, 1.0, 40, 1, true, -0.9, 1.8), new THREE.MeshStandardMaterial({ map: nameTex, metalness: 0.2, roughness: 0.5 }));
  name.rotation.x = Math.PI / 2; name.rotation.y = Math.PI; add(name, 0, 0, -4.4);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  st.model = { wings, strobe };
  return root;
}
