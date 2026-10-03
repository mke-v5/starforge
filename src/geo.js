import * as THREE from 'three';

export const R = 6371;            // Earth radius, km
export const D2R = Math.PI / 180;

// Web Mercator tile edges
export function tileLon(x, z) { return x / 2 ** z * 360 - 180; }
export function tileLat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z;
  return Math.atan(Math.sinh(n)) / D2R;
}

// Globe axes: +Y north pole, +X at (0 N, 0 E), east at lon 0 is -Z.
export function llh(lat, lon, h, out) {
  const p = lat * D2R, l = lon * D2R, r = R + h, c = Math.cos(p);
  return out.set(r * c * Math.cos(l), r * Math.sin(p), -r * c * Math.sin(l));
}

export function toLatLon(v) {
  const r = v.length();
  return { lat: Math.asin(v.y / r) / D2R, lon: Math.atan2(-v.z, v.x) / D2R, h: r - R };
}

// Local frame at a position: up, east, north
export function frameAt(pos, up, east, north) {
  up.copy(pos).normalize();
  const lon = Math.atan2(-pos.z, pos.x);
  east.set(-Math.sin(lon), 0, -Math.cos(lon));
  north.crossVectors(up, east).normalize();
}

export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const s = Math.sin(lat * D2R);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

export { THREE };
