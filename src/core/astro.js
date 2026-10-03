// Sun and Moon positions (low-precision analytic ephemeris, good to a fraction of a degree)
// and the orientation of the Earth and Moon at a given simulation time.
//
// Simulation time t = seconds since J2000.0 (2000-01-01 12:00 TT, treated as UTC).
// Frame I: geocentric, +Y = Earth's north pole, +X = vernal equinox, RA increases toward -Z.

import * as THREE from 'three';
import { D2R, EARTH, MOON } from './geo.js';

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
export const nowSimTime = () => (Date.now() - J2000_MS) / 1000;
export const simTimeToDate = (t) => new Date(J2000_MS + t * 1000);

const sinD = (x) => Math.sin(x * D2R), cosD = (x) => Math.cos(x * D2R);

// equatorial (x toward equinox, y toward RA 90, z north) -> frame I
function eqToI(x, y, z, out) { return out.set(x, z, -y); }

function eclToI(lonDeg, latDeg, dist, epsDeg, out) {
  const cb = cosD(latDeg);
  const x = cb * cosD(lonDeg), y = cb * sinD(lonDeg), z = sinD(latDeg);
  const ce = cosD(epsDeg), se = sinD(epsDeg);
  return eqToI(x * dist, (y * ce - z * se) * dist, (y * se + z * ce) * dist, out);
}

export function obliquity(t) { return 23.439 - 0.00000036 * (t / 86400); }

// Greenwich mean sidereal time as an angle (rad) — the Earth rotation angle about +Y.
export function earthAngle(t) {
  const d = t / 86400;
  const g = (280.46061837 + 360.98564736629 * d) % 360;
  return g * D2R;
}

// unit vector toward the Sun in frame I (and distance in m)
export function sunDir(t, out) {
  const d = t / 86400;
  const g = 357.529 + 0.98560028 * d;
  const q = 280.459 + 0.98564736 * d;
  const L = q + 1.915 * sinD(g) + 0.020 * sinD(2 * g);
  eclToI(L, 0, 1, obliquity(t), out);
  return out.normalize();
}

// Moon centre in frame I (metres)
export function moonPos(t, out) {
  const d = t / 86400;
  const Lp = 218.316 + 13.176396 * d;
  const M = 134.963 + 13.064993 * d;
  const F = 93.272 + 13.229350 * d;
  const D = 297.850 + 12.190749 * d;
  const Ms = 357.529 + 0.98560028 * d;
  const lon = Lp + 6.289 * sinD(M) + 1.274 * sinD(2 * D - M) + 0.658 * sinD(2 * D) + 0.214 * sinD(2 * M)
    - 0.186 * sinD(Ms) - 0.114 * sinD(2 * F);
  const lat = 5.128 * sinD(F) + 0.281 * sinD(M + F) + 0.278 * sinD(M - F) + 0.173 * sinD(2 * D - F);
  const km = 385001 - 20905 * cosD(M) - 3699 * cosD(2 * D - M) - 2956 * cosD(2 * D) - 570 * cosD(2 * M);
  return eclToI(lon, lat, km * 1000, obliquity(t), out);
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();
export function moonVel(t, out) {
  moonPos(t + 5, _a); moonPos(t - 5, _b);
  return out.subVectors(_a, _b).multiplyScalar(0.1);
}

// Orientation of the Moon's body-fixed frame in I: columns X (sub-Earth meridian), Y (north), Z.
// Tidally locked: lon 0 faces the Earth.
export function moonBasis(t, mpos, outX, outY, outZ) {
  const e = obliquity(t) * D2R;
  outY.set(0, Math.cos(e), Math.sin(e));                        // ecliptic north (pole tilt ~1.5° ignored)
  outX.copy(mpos).multiplyScalar(-1).normalize();
  outX.addScaledVector(outY, -outX.dot(outY)).normalize();
  outZ.crossVectors(outX, outY).normalize();
}

// A snapshot of all bodies at time t, reused by physics and rendering.
export class Ephemeris {
  constructor() {
    this.t = 0;
    this.earthAngle = 0;
    this.earthQ = new THREE.Quaternion();          // ECEF -> I
    this.earthQInv = new THREE.Quaternion();
    this.sun = new THREE.Vector3(1, 0, 0);
    this.moon = new THREE.Vector3();
    this.moonV = new THREE.Vector3();
    this.mX = new THREE.Vector3(); this.mY = new THREE.Vector3(); this.mZ = new THREE.Vector3();
    this.moonQ = new THREE.Quaternion();           // moon-fixed -> I
    this.moonQInv = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }
  update(t) {
    this.t = t;
    this.earthAngle = earthAngle(t);
    this.earthQ.setFromAxisAngle(_Y, this.earthAngle);
    this.earthQInv.copy(this.earthQ).invert();
    sunDir(t, this.sun);
    moonPos(t, this.moon);
    moonVel(t, this.moonV);
    moonBasis(t, this.moon, this.mX, this.mY, this.mZ);
    this._m.makeBasis(this.mX, this.mY, this.mZ);
    this.moonQ.setFromRotationMatrix(this._m);
    this.moonQInv.copy(this.moonQ).invert();
    return this;
  }
  // body-fixed -> I and back. body: EARTH or MOON
  toI(body, vFixed, out) {
    if (body === EARTH) return out.copy(vFixed).applyQuaternion(this.earthQ);
    return out.copy(vFixed).applyQuaternion(this.moonQ).add(this.moon);
  }
  toFixed(body, vI, out) {
    if (body === EARTH) return out.copy(vI).applyQuaternion(this.earthQInv);
    return out.copy(vI).sub(this.moon).applyQuaternion(this.moonQInv);
  }
  // velocity of the body's surface (or co-rotating air) at I-frame position p
  surfaceVel(body, pI, out) {
    if (body === EARTH) return out.set(EARTH.omega * pI.z, 0, -EARTH.omega * pI.x);   // ω×r with ω=(0,ω,0)
    _a.copy(pI).sub(this.moon);
    out.crossVectors(this.mY, _a).multiplyScalar(MOON.omega);
    return out.add(this.moonV);
  }
  bodyCenter(body, out) { return body === EARTH ? out.set(0, 0, 0) : out.copy(this.moon); }
}
const _Y = new THREE.Vector3(0, 1, 0);

// Gravity acceleration at I-frame position p (geocentric frame, includes the indirect term for the Moon).
export function gravity(p, moon, out) {
  const r2 = p.x * p.x + p.y * p.y + p.z * p.z, r = Math.sqrt(r2), k = -EARTH.mu / (r2 * r);
  let ax = p.x * k, ay = p.y * k, az = p.z * k;
  const dx = p.x - moon.x, dy = p.y - moon.y, dz = p.z - moon.z;
  const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2), km = -MOON.mu / (d2 * d);
  const m2 = moon.x * moon.x + moon.y * moon.y + moon.z * moon.z, mr = Math.sqrt(m2), ki = -MOON.mu / (m2 * mr);
  ax += dx * km + moon.x * ki; ay += dy * km + moon.y * ki; az += dz * km + moon.z * ki;
  return out.set(ax, ay, az);
}
