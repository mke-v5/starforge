// Flying to a chosen place across the planet: great-circle distance, bearing and ETA, a heading hold toward it, and
// a "fly me there" autopilot (take-off if needed, climb to a cruise altitude clear of the terrain, cruise on an
// autothrottle, descend in time and hand over to the runway auto-land at the destination).

import * as THREE from 'three';
import { EARTH, D2R, clamp, gcDist, gcBearing, gcDest, fmtTime } from '../core/geo.js';
import { landRunwayAp } from './control.js';
import { engineClass } from './orbit.js';

const _n = new THREE.Vector3(), _e = new THREE.Vector3();
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// local north/east at the ship and its ground track and speed
function localTrack(ship) {
  const E = ship.env, up = E.up;
  _n.set(0, 1, 0).addScaledVector(up, -up.y).normalize();
  _e.crossVectors(_n, up);
  const ve = E.vAir.dot(_e), vn = E.vAir.dot(_n);
  return { track: Math.atan2(ve, vn), gs: Math.hypot(ve, vn) };
}

// distance (m), initial bearing (rad from north), ground speed toward it (m/s) and time to get there (s)
export function navInfo(ship, dest) {
  const E = ship.env;
  if (E.body !== EARTH) return null;
  const d = gcDist(E.lat, E.lon, dest.lat, dest.lon);
  const brg = gcBearing(E.lat, E.lon, dest.lat, dest.lon);
  const { track, gs } = localTrack(ship);
  const toward = gs * Math.cos(wrap(track - brg));
  return { d, brg, track, gs, toward, eta: toward > 2 ? d / toward : Infinity };
}

// the runway to land on for a place: an airport's longest runway, or the best runway near a city
export function runwayFor(A, place, maxDist = 90000) {
  if (!A.ready) return null;
  if (place.airport && place.airport.runways.length) {
    const rw = place.airport.runways.reduce((b, r) => (!b || r.len > b.len ? r : b), null);
    return { rw, name: place.airport.iata || place.airport.ident, d: 0 };
  }
  let best = null;
  for (const { d, a } of A.nearest(place.lat, place.lon, 8, 2)) {
    if (d > maxDist) continue;
    for (const rw of a.runways) {
      if (rw.len < 1200) continue;
      const score = d - Math.min(rw.len, 3500) * 15 + (a.type === 0 ? -15000 : 0);
      if (!best || score < best.score) best = { rw, name: a.iata || a.ident, d, score };
    }
  }
  return best;
}

// hold a heading toward the place at the current height; the throttle stays with the pilot
export function headingAp(dest) {
  let hHold = null;
  return {
    name: `Heading to ${dest.code || dest.name}`, cancelOnStick: true, nav: true,
    update(ship, dt, C) {
      const E = ship.env;
      if (E.body !== EARTH || E.rho < 0.02) return { done: true, msg: 'Heading hold works in the air' };
      const n = navInfo(ship, dest);
      if (n.d < 2500) return { done: true, msg: `Overhead ${dest.name}` };
      if (hHold === null) hHold = E.h;
      C.bankHold = E.agl < 150 ? 0 : clamp(wrap(n.brg - n.track) * 1.4, -0.5, 0.5);
      C.gammaHold = clamp((hHold - E.h) / 2500, -0.15, 0.15);
      if (C.sas !== 'hold' && C.sas !== 'off') C.sas = 'hold';
      return { status: `${fmtDist(n.d)} · ${isFinite(n.eta) ? fmtTime(n.eta) : '—'}` };
    },
  };
}

// The whole flight to a place in the atmosphere.
export function flyToAp(A, dest, terrain = null) {
  const target = runwayFor(A, dest);
  const label = target ? target.name : (dest.code || dest.name);
  let sub = null, integ = 0, thrPrev = 0.6, floorT = -1e9, floorH = 0, maxH = null, hasJets = false, vRot = 60;
  const ap = {
    name: `Fly to ${dest.code || dest.name}`, cancelOnStick: true, nav: true, dest,
    update(ship, dt, C) {
      const craft = ship.craft, E = ship.env;
      if (sub) {
        const o = sub.update(ship, dt, C);
        if (o && !o.done && o.status) o.status = o.status;
        return o;
      }
      if (E.body !== EARTH) return { done: true, fail: true, msg: 'Fly-to works on Earth' };
      if (maxH === null) {
        // a cruise height the engines can hold: well under the jets' ceiling
        const jets = craft.engines.filter((P) => P.alive !== false && engineClass(P) === 'jets');
        hasJets = jets.length > 0;
        const ceil = hasJets ? Math.min(...jets.map((P) => P.eng.e.ceiling || 12000)) : 12000;
        maxH = Math.min(11000, ceil * 0.62);
        const S = craft.wings.reduce((s, P) => s + (P.alive !== false ? P.wing.area : 0), 0);
        vRot = Math.sqrt((2 * craft.mass * 9.81) / (1.225 * Math.max(5, S) * 1.1)) * 1.15;
      }
      const goal = target ? { lat: target.rw.latC, lon: target.rw.lonC } : dest;
      const n = navInfo(ship, goal);
      const V = E.vAir.length();
      const onGround = ship.contacts > 0;
      // ---- take-off from wherever we are standing ----
      if (onGround) {
        const pitchNow = Math.asin(clamp(new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q).dot(E.up), -1, 1)) / D2R;
        if (n.d < 3000 && E.vSurf < 5) return { done: true, throttle: 0, msg: `Already at ${dest.name}` };
        return { throttle: 1, gear: true, brake: 0, engines: hasJets ? 'jets' : undefined, pitchCmd: E.vSurf > vRot ? clamp((10 - pitchNow) * 0.12, -0.3, 0.6) : 0, status: E.vSurf > vRot ? 'Rotate' : 'Take-off roll' };
      }
      // ---- arrival: the runway auto-land takes over within reach, or we are simply there ----
      const hand = 55000;
      if (target && n.d < hand && E.h - (target.rw.e1 || 0) < 7000) {
        sub = landRunwayAp(A, target.rw, target.name, terrain);
        C.status = `Arriving at ${dest.name} — lining up for ${target.name}`;
        return sub.update(ship, dt, C);
      }
      if (!target && n.d < 2500) return { done: true, msg: `Overhead ${dest.name} — there is no runway here, you have control` };
      // ---- height: cruise, clear the terrain ahead, descend in time ----
      let hT = clamp(n.d * 0.035, 2500, maxH);
      if (target) {
        const elev = ((target.rw.e1 || 0) + (target.rw.e2 || 0)) / 2;
        hT = Math.min(hT, elev + 2500 + Math.max(0, n.d - hand) * 0.055);   // a 3° path down to the hand-over
      }
      if (terrain && ship.t - floorT > 3) {
        floorT = ship.t; floorH = -1e9;
        const look = clamp(V * 240, 15000, 80000);
        for (let k = 0; k <= 8; k++) {
          const p = gcDest(E.lat, E.lon, n.brg, Math.min(n.d, look * k / 8));
          floorH = Math.max(floorH, terrain(p.lat, p.lon));
        }
      }
      hT = Math.max(hT, floorH + 900);
      C.gammaHold = clamp((hT - E.h) / 3000, -0.1, E.agl < 600 ? 0.2 : 0.14);
      C.bankHold = E.agl < 300 ? 0 : clamp(wrap(n.brg - n.track) * 1.4, -0.5, 0.5);
      if (C.sas !== 'hold' && C.sas !== 'off') C.sas = 'hold';
      // ---- speed: about Mach 0.8 at height, slower low down and on the way in ----
      const a = E.a || 340;
      let Vt = clamp(a * 0.8 * clamp(0.55 + E.h / 20000, 0.55, 1), 130, 260);
      if (target && n.d < hand * 2) Vt = Math.min(Vt, 140 + (n.d - hand) / hand * 100);
      const err = Vt - V;
      integ = clamp(integ + err * dt * 0.01, -0.3, 0.5);
      let thr = clamp(0.55 + err * 0.04 + integ, 0.05, 1);
      thr = thrPrev + clamp(thr - thrPrev, -dt * 0.6, dt * 0.6);
      thrPrev = thr;
      const gear = E.agl > 60 ? false : undefined;
      return { throttle: thr, gear, brake: 0, engines: hasJets ? 'jets' : undefined, status: `${fmtDist(n.d)} to ${label} · ${isFinite(n.eta) ? fmtTime(n.eta) : '—'}` };
    },
  };
  return ap;
}

export function fmtDist(m) { return m >= 100000 ? Math.round(m / 1000).toLocaleString('en-US') + ' km' : m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
