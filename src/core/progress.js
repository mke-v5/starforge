// Milestones (logbook). Each check runs on the flight state; achieved milestones persist.
import { load, save } from './store.js';
import { EARTH, MOON } from './geo.js';
import { relState, elements } from '../ship/orbit.js';

export const MILESTONES = [
  { id: 'firstFlight', name: 'Wheels up', desc: 'Take off from an airport.' },
  { id: 'mach1', name: 'Sound barrier', desc: 'Fly faster than Mach 1 in the atmosphere.' },
  { id: 'land', name: 'Greaser', desc: 'Land on a runway and come to a stop.' },
  { id: 'otherAirport', name: 'Destination', desc: 'Land at a different airport from where you took off.' },
  { id: 'mach5', name: 'Hypersonic', desc: 'Reach Mach 5.' },
  { id: 'space', name: 'Edge of space', desc: 'Cross the Kármán line (100 km).' },
  { id: 'orbit', name: 'Orbit', desc: 'Reach a stable orbit (periapsis above 140 km).' },
  { id: 'aroundWorld', name: 'Around the world', desc: 'Travel 40,000 km in one flight.' },
  { id: 'moonSoi', name: 'Lunar approach', desc: 'Enter the Moon’s sphere of influence.' },
  { id: 'moonOrbit', name: 'Lunar orbit', desc: 'Orbit the Moon.' },
  { id: 'moonLand', name: 'Magnificent desolation', desc: 'Land on the Moon.' },
  { id: 'moonReturn', name: 'Homecoming', desc: 'Land back on Earth after visiting the Moon.' },
  { id: 'fullTrip', name: 'Hangar to the Moon and back', desc: 'Take off from an airport, land on the Moon, and land on a runway at any airport.' },
  { id: 'builder', name: 'Shipwright', desc: 'Launch a ship you designed yourself.' },
  { id: 'tranquility', name: 'The Eagle has landed', desc: 'Land within 500 m of the Apollo 11 site.' },
  { id: 'pinpoint', name: 'Stuck the landing', desc: 'Land a tail-sitting starship on its legs at an airport.' },
  { id: 'homeAgain', name: 'There and back again', desc: 'Land on the Moon, then land back at the airport you took off from.' },
  { id: 'rendezvous', name: 'Rendezvous', desc: 'Get within 1 km of Meridian Station, moving less than 5 m/s relative to it.' },
  { id: 'docked', name: 'Soft capture', desc: 'Dock with Meridian Station.' },
  { id: 'stationRun', name: 'Runway to rendezvous', desc: 'Take off from an airport and dock at Meridian Station in the same flight.' },
  { id: 'arrived', name: 'You have arrived', desc: 'Set a destination, fly there and land within 5 km of it.' },
  { id: 'ownPad', name: 'Launch complex', desc: 'Lift off from a launch pad you built.' },
  { id: 'farSide', name: 'The far side', desc: 'Fly over the side of the Moon that never faces Earth.' },
  { id: 'ionDrive', name: 'Patience', desc: 'Run an ion drive for ten minutes.' },
  { id: 'antimatter', name: 'Matter, meet antimatter', desc: 'Fire an antimatter torch.' },
  { id: 'shared', name: 'Show and tell', desc: 'Share a ship as a code or link, or import someone else’s.' },
  { id: 'staged', name: 'Staging', desc: 'Drop a spent stage in flight.' },
];

export class Progress {
  constructor(onUnlock) {
    this.done = load('milestones', {});
    this.onUnlock = onUnlock;
    this.flight = null;
  }
  has(id) { return !!this.done[id]; }
  unlock(id) {
    if (this.done[id]) return;
    this.done[id] = Date.now();
    save('milestones', this.done);
    const m = MILESTONES.find((x) => x.id === id);
    if (m && this.onUnlock) this.onUnlock(m);
  }
  startFlight(info) {
    this.flight = { from: info.airport || null, ownPad: !!info.ownPad, tookOff: false, visitedMoon: false, landedMoon: false, dist: 0, custom: !!info.custom, ionT: 0 };
    if (info.custom) this.unlock('builder');
  }
  // called a few times per second
  tick(ship, dt, airports) {
    const F = this.flight; if (!F) return;
    const E = ship.env;
    F.dist += E.vSurf * dt;
    if (F.dist > 40075000) this.unlock('aroundWorld');
    if (E.body === EARTH) {
      if (!F.tookOff && ship.contacts === 0 && E.agl > 30 && E.vSurf > 30) { F.tookOff = true; if (F.from) this.unlock('firstFlight'); if (F.ownPad) this.unlock('ownPad'); }
      if (E.mach > 1 && E.rho > 0.01) this.unlock('mach1');
      if (E.mach > 5 && E.rho > 1e-4) this.unlock('mach5');
      if (E.h > 100000) this.unlock('space');
    } else {
      F.visitedMoon = true;
      this.unlock('moonSoi');
      if (Math.abs(E.lon) > 100 && E.agl < 500000) this.unlock('farSide');
    }
    // the drives
    for (const P of ship.craft.engines) {
      if (!(P.eng.thrust > 0)) continue;
      if (P.eng.e.power) { F.ionT += dt; if (F.ionT > 600) this.unlock('ionDrive'); }
      if (P.eng.e.antimatter) this.unlock('antimatter');
    }
    // orbit milestones (checked every couple of seconds, not only while the map is open)
    F.orbT = (F.orbT || 0) + dt;
    if (F.orbT > 2) {
      F.orbT = 0;
      const rs = relState(ship, E.body);
      const el = elements(rs.r, rs.v, rs.mu);
      if (el.e < 1) this.orbitCheck(E.body, el.pe);
    }
  }
  orbitCheck(body, pe) {
    if (body === EARTH && pe - EARTH.R > 140000) this.unlock('orbit');
    if (body === MOON && pe - MOON.R > 5000 && this.flight) { this.unlock('moonOrbit'); }
  }
  docked() {
    this.unlock('docked');
    const F = this.flight;
    if (F && F.tookOff && F.from) this.unlock('stationRun');
  }
  landed(ship, airport, dest = null) {
    const F = this.flight; if (!F) return;
    if (dest && F.tookOff && ship.env.body.name === 'Earth') {
      const E = ship.env, D = Math.PI / 180;
      const c = Math.sin(E.lat * D) * Math.sin(dest.lat * D) + Math.cos(E.lat * D) * Math.cos(dest.lat * D) * Math.cos((E.lon - dest.lon) * D);
      if (Math.acos(Math.min(1, c)) * 6371000 < 5000) this.unlock('arrived');
    }
    if (ship.env.body === MOON) {
      F.landedMoon = true; this.unlock('moonLand');
      // Tranquility Base, 0.674° N 23.473° E
      const E = ship.env, D = Math.PI / 180;
      const c = Math.sin(E.lat * D) * Math.sin(0.674 * D) + Math.cos(E.lat * D) * Math.cos(0.674 * D) * Math.cos((E.lon - 23.473) * D);
      if (Math.acos(Math.min(1, c)) * MOON.R < 500) this.unlock('tranquility');
      return;
    }
    if (!F.tookOff) return;
    if (F.visitedMoon) this.unlock('moonReturn');
    if (airport) {
      this.unlock('land');
      if (F.from && airport.ident !== F.from.ident) this.unlock('otherAirport');
      if (F.landedMoon && F.from) this.unlock('fullTrip');
      if (F.landedMoon && F.from && airport.ident === F.from.ident) this.unlock('homeAgain');
      if (ship.craft.vertical) this.unlock('pinpoint');
    }
  }
}
