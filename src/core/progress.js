// Milestones (logbook). Each check runs on the flight state; achieved milestones persist.
import { load, save } from './store.js';
import { EARTH, MOON } from './geo.js';

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
    this.flight = { from: info.airport || null, tookOff: false, visitedMoon: false, landedMoon: false, dist: 0, custom: !!info.custom };
    if (info.custom) this.unlock('builder');
  }
  // called a few times per second
  tick(ship, dt, airports) {
    const F = this.flight; if (!F) return;
    const E = ship.env;
    F.dist += E.vSurf * dt;
    if (F.dist > 40075000) this.unlock('aroundWorld');
    if (E.body === EARTH) {
      if (!F.tookOff && ship.contacts === 0 && E.agl > 30 && E.vSurf > 30) { F.tookOff = true; if (F.from) this.unlock('firstFlight'); }
      if (E.mach > 1 && E.rho > 0.01) this.unlock('mach1');
      if (E.mach > 5 && E.rho > 1e-4) this.unlock('mach5');
      if (E.h > 100000) this.unlock('space');
    } else {
      F.visitedMoon = true;
      this.unlock('moonSoi');
    }
  }
  orbitCheck(body, pe) {
    if (body === EARTH && pe - EARTH.R > 140000) this.unlock('orbit');
    if (body === MOON && pe - MOON.R > 5000 && this.flight) { this.unlock('moonOrbit'); }
  }
  landed(ship, airport) {
    const F = this.flight; if (!F) return;
    if (ship.env.body === MOON) { F.landedMoon = true; this.unlock('moonLand'); return; }
    if (!F.tookOff) return;
    if (F.visitedMoon) this.unlock('moonReturn');
    if (airport) {
      this.unlock('land');
      if (F.from && airport.ident !== F.from.ident) this.unlock('otherAirport');
      if (F.landedMoon && F.from) this.unlock('fullTrip');
    }
  }
}
