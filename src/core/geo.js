// Shared constants and coordinate helpers. All distances are metres, angles radians unless noted.
//
// Body-fixed axes (Earth and Moon use the same convention):
//   +Y = north pole, +X = (lat 0, lon 0), east at lon 0 = -Z.
// The physics frame "I" is geocentric and inertial with the same +Y axis; Earth rotates about +Y.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const G0 = 9.80665;

export const EARTH = {
  id: 'earth', name: 'Earth', R: 6371000, mu: 3.986004418e14, omega: 7.2921159e-5,
  atmoTop: 140000, soi: 9.245e8,
};
export const MOON = {
  id: 'moon', name: 'Moon', R: 1737400, mu: 4.9048695e12, omega: 2 * Math.PI / (27.321661 * 86400),
  atmoTop: 0, soi: 66100000,
};
// Mars: mean radius, sidereal day 24 h 37 min 22.7 s, thin CO2 air up to ~125 km
export const MARS = {
  id: 'mars', name: 'Mars', R: 3389500, mu: 4.282837e13, omega: 2 * Math.PI / 88642.663,
  atmoTop: 125000, soi: 5.77e8,
};
export const SUN = {
  id: 'sun', name: 'Sun', R: 6.957e8, mu: 1.32712440018e20, omega: 2 * Math.PI / (25.38 * 86400),
  atmoTop: 0, soi: Infinity,
};
export const AU = 1.495978707e11;
export const BODIES = { earth: EARTH, moon: MOON, mars: MARS, sun: SUN };

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- Web Mercator tiles ----
export function tileLon(x, z) { return x / 2 ** z * 360 - 180; }
export function tileLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return Math.atan(Math.sinh(n)) * R2D;
}
export function mercY(lat) {           // fractional mercator y in [0,1] (0 = north edge)
  const s = Math.sin(clamp(lat, -85.0511, 85.0511) * D2R);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor(mercY(lat) * n);
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

// ---- body-fixed positions ----
// out is any object with set(x,y,z) (THREE.Vector3) — values are doubles.
export function llh(lat, lon, h, R, out) {
  const p = lat * D2R, l = lon * D2R, r = R + h, c = Math.cos(p);
  return out.set(r * c * Math.cos(l), r * Math.sin(p), -r * c * Math.sin(l));
}
export function toLLH(v, R) {
  const r = Math.hypot(v.x, v.y, v.z);
  return { lat: Math.asin(clamp(v.y / r, -1, 1)) * R2D, lon: Math.atan2(-v.z, v.x) * R2D, h: r - R };
}
// local east/north/up unit vectors at a body-fixed position
export function enu(pos, up, east, north) {
  up.copy(pos).normalize();
  const lon = Math.atan2(-pos.z, pos.x);
  east.set(-Math.sin(lon), 0, -Math.cos(lon));
  north.crossVectors(up, east).normalize();
}

// great-circle distance (m) and initial bearing (rad) between two lat/lon points
export function gcDist(lat1, lon1, lat2, lon2, R = EARTH.R) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function gcBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
}
// destination point from start, bearing (rad), distance (m)
export function gcDest(lat, lon, brg, d, R = EARTH.R) {
  const p1 = lat * D2R, l1 = lon * D2R, a = d / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

export function fmtDist(m) {
  const a = Math.abs(m);
  if (a < 1000) return Math.round(m) + ' m';
  if (a < 100000) return (m / 1000).toFixed(1) + ' km';
  return Math.round(m / 1000).toLocaleString('en-US') + ' km';
}
export function fmtSpeed(v) {
  const a = Math.abs(v);
  if (a < 1000) return Math.round(v) + ' m/s';
  return (v / 1000).toFixed(2) + ' km/s';
}
export function fmtTime(s) {
  if (!isFinite(s)) return '—';
  s = Math.max(0, s);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s = Math.floor(s - m * 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
