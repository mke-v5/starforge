// Sun and Moon positions (low-precision analytic ephemeris, good to a fraction of a degree)
// and the orientation of the Earth and Moon at a given simulation time.
//
// Simulation time t = seconds since J2000.0 (2000-01-01 12:00 TT, treated as UTC).
// Frame I: geocentric, +Y = Earth's north pole, +X = vernal equinox, RA increases toward -Z.

import * as THREE from 'three';
import { D2R, EARTH, MOON, MARS, SUN, AU } from './geo.js';

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

// ---- planets: JPL approximate Keplerian elements (Standish, valid 1800–2050) ----
// [a au, e, I°, L°, ϖ°, Ω°] at J2000 and their rates per Julian century
const ELEMENTS = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  earth: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
export const PLANET_KEYS = Object.keys(ELEMENTS);
const EPS0 = 23.43928 * D2R, CE = Math.cos(EPS0), SE = Math.sin(EPS0);
// J2000 ecliptic coordinates -> frame I (mean equator and equinox of date, like the Moon and the Earth's spin):
// precess in longitude, then tilt by the obliquity of date
function eclJ2000ToI(xe, ye, ze, T, out) {
  const pA = 1.396971 * T * D2R, cp = Math.cos(pA), sp = Math.sin(pA);
  const x = xe * cp - ye * sp, y = xe * sp + ye * cp;
  const eps = (23.43928 - 0.0130042 * T) * D2R, ce = Math.cos(eps), se = Math.sin(eps);
  return eqToI(x, y * ce - ze * se, y * se + ze * ce, out);
}
// J2000 equatorial direction -> frame I
function eqJ2000ToI(x, y, z, T, out) { return eclJ2000ToI(x, y * CE + z * SE, -y * SE + z * CE, T, out); }
// heliocentric position (m) of a planet ('earth' = Earth–Moon barycentre) in frame I axes
export function helio(key, t, out) {
  const [e0, r] = ELEMENTS[key];
  const T = t / (86400 * 36525);
  const a = (e0[0] + r[0] * T) * AU, e = e0[1] + r[1] * T, I = (e0[2] + r[2] * T) * D2R;
  const L = e0[3] + r[3] * T, w = e0[4] + r[4] * T, W = (e0[5] + r[5] * T) * D2R;
  const om = w * D2R - W;
  let M = ((L - w) % 360) * D2R;
  if (M > Math.PI) M -= 2 * Math.PI; else if (M < -Math.PI) M += 2 * Math.PI;
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 12; k++) { const dE = (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E)); E += dE; if (Math.abs(dE) < 1e-15) break; }
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const co = Math.cos(om), so = Math.sin(om), cW = Math.cos(W), sW = Math.sin(W), cI = Math.cos(I), sI = Math.sin(I);
  const xe = (co * cW - so * sW * cI) * xp + (-so * cW - co * sW * cI) * yp;
  const ye = (co * sW + so * cW * cI) * xp + (-so * sW + co * cW * cI) * yp;
  const ze = (so * sI) * xp + (co * sI) * yp;
  return eclJ2000ToI(xe, ye, ze, T, out);
}
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3();
// the Sun's centre and Mars' centre in frame I (geocentric)
export function sunPos(t, out) { return helio('earth', t, out).negate(); }
export function marsPos(t, out) { helio('mars', t, out); return out.sub(helio('earth', t, _h1)); }
export function marsVel(t, out) { marsPos(t + 30, _h1); marsPos(t - 30, _h2); return out.subVectors(_h1, _h2).divideScalar(60); }
export function sunVel(t, out) { sunPos(t + 30, _h1); sunPos(t - 30, _h2); return out.subVectors(_h1, _h2).divideScalar(60); }
// any planet relative to the Earth, in frame I
export function planetPos(key, t, out) { helio(key, t, out); return out.sub(helio('earth', t, _h1)); }

// Orientation of Mars' body-fixed frame in I (IAU 2015 pole and prime meridian): columns X (lon 0), Y (north), Z.
export function marsBasis(t, outX, outY, outZ) {
  const d = t / 86400, T = d / 36525;
  const ra = (317.68143 - 0.1061 * T) * D2R, dec = (52.88650 - 0.0609 * T) * D2R;
  const Wm = ((176.630 + 350.89198226 * d) % 360) * D2R;
  const cd = Math.cos(dec);
  eqJ2000ToI(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec), T, outY);
  eqJ2000ToI(-Math.sin(ra), Math.cos(ra), 0, T, _h1);       // node of Mars' equator on the Earth's (J2000)
  _h2.crossVectors(outY, _h1);                            // 90° east of the node
  outX.copy(_h1).multiplyScalar(Math.cos(Wm)).addScaledVector(_h2, Math.sin(Wm)).normalize();
  outZ.crossVectors(outX, outY).normalize();
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
    this.sunP = new THREE.Vector3();               // the Sun's centre (I)
    this.sunV = new THREE.Vector3();
    this.mars = new THREE.Vector3();
    this.marsV = new THREE.Vector3();
    this.aX = new THREE.Vector3(); this.aY = new THREE.Vector3(); this.aZ = new THREE.Vector3();
    this.marsQ = new THREE.Quaternion();           // mars-fixed -> I
    this.marsQInv = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
  }
  update(t) {
    this.t = t;
    this.earthAngle = earthAngle(t);
    this.earthQ.setFromAxisAngle(_Y, this.earthAngle);
    this.earthQInv.copy(this.earthQ).invert();
    sunPos(t, this.sunP); sunVel(t, this.sunV);
    this.sun.copy(this.sunP).normalize();
    marsPos(t, this.mars); marsVel(t, this.marsV);
    marsBasis(t, this.aX, this.aY, this.aZ);
    this._m.makeBasis(this.aX, this.aY, this.aZ);
    this.marsQ.setFromRotationMatrix(this._m);
    this.marsQInv.copy(this.marsQ).invert();
    moonPos(t, this.moon);
    moonVel(t, this.moonV);
    moonBasis(t, this.moon, this.mX, this.mY, this.mZ);
    this._m.makeBasis(this.mX, this.mY, this.mZ);
    this.moonQ.setFromRotationMatrix(this._m);
    this.moonQInv.copy(this.moonQ).invert();
    return this;
  }
  // body-fixed -> I and back. body: EARTH, MOON, MARS or SUN
  quat(body) { return body === EARTH ? this.earthQ : body === MARS ? this.marsQ : body === SUN ? _QI : this.moonQ; }
  quatInv(body) { return body === EARTH ? this.earthQInv : body === MARS ? this.marsQInv : body === SUN ? _QI : this.moonQInv; }
  toI(body, vFixed, out) {
    if (body === EARTH) return out.copy(vFixed).applyQuaternion(this.earthQ);
    return out.copy(vFixed).applyQuaternion(this.quat(body)).add(this.bodyCenter(body, _b));
  }
  toFixed(body, vI, out) {
    if (body === EARTH) return out.copy(vI).applyQuaternion(this.earthQInv);
    return out.copy(vI).sub(this.bodyCenter(body, _b)).applyQuaternion(this.quatInv(body));
  }
  // velocity of the body's surface (or co-rotating air) at I-frame position p
  surfaceVel(body, pI, out) {
    if (body === EARTH) return out.set(EARTH.omega * pI.z, 0, -EARTH.omega * pI.x);   // ω×r with ω=(0,ω,0)
    if (body === SUN) return out.copy(this.sunV);
    const m = body === MARS;
    _a.copy(pI).sub(m ? this.mars : this.moon);
    out.crossVectors(m ? this.aY : this.mY, _a).multiplyScalar(body.omega);
    return out.add(m ? this.marsV : this.moonV);
  }
  bodyCenter(body, out) { return body === EARTH ? out.set(0, 0, 0) : body === MARS ? out.copy(this.mars) : body === SUN ? out.copy(this.sunP) : out.copy(this.moon); }
  bodyVel(body, out) { return body === EARTH ? out.set(0, 0, 0) : body === MARS ? out.copy(this.marsV) : body === SUN ? out.copy(this.sunV) : out.copy(this.moonV); }
  // spin axis (unit, I) of a body
  axis(body) { return body === EARTH ? _Y : body === MARS ? this.aY : body === SUN ? _Y : this.mY; }
}
const _QI = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

// Positions of the Moon, Sun and Mars (frame I) at time t, cached for the last few times asked
// (RK4 asks for the same instants several times).
const _cache = [];
export function bodiesAt(t) {
  for (const c of _cache) if (c.t === t) return c;
  const c = _cache.length < 6 ? { t, moon: new THREE.Vector3(), sun: new THREE.Vector3(), mars: new THREE.Vector3() } : _cache.shift();
  c.t = t; moonPos(t, c.moon); sunPos(t, c.sun); marsPos(t, c.mars);
  _cache.push(c);
  return c;
}
// third body pull on p minus its pull on the Earth (the frame's origin accelerates with the Earth)
function tidal(p, c, mu, o) {
  const dx = c.x - p.x, dy = c.y - p.y, dz = c.z - p.z;
  const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2), k = mu / (d2 * d);
  const c2 = c.x * c.x + c.y * c.y + c.z * c.z, cr = Math.sqrt(c2), kc = mu / (c2 * cr);
  o.x += dx * k - c.x * kc; o.y += dy * k - c.y * kc; o.z += dz * k - c.z * kc;
}
const _ga = { x: 0, y: 0, z: 0 };
// Gravity acceleration at I-frame position p and time t: the Earth, plus the Moon, Sun and Mars with their
// indirect terms (frame I is centred on the Earth).
export function gravity(p, t, out) {
  const B = bodiesAt(t);
  const r2 = p.x * p.x + p.y * p.y + p.z * p.z, r = Math.sqrt(r2), k = -EARTH.mu / (r2 * r);
  _ga.x = p.x * k; _ga.y = p.y * k; _ga.z = p.z * k;
  tidal(p, B.moon, MOON.mu, _ga);
  if (!globalThis.__noSun) tidal(p, B.sun, SUN.mu, _ga);
  tidal(p, B.mars, MARS.mu, _ga);
  return out.set(_ga.x, _ga.y, _ga.z);
}
