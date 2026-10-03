// Flight school: a short guided first flight. Each step advances when the player has actually done it.
import * as THREE from 'three';
import { clamp, R2D } from '../core/geo.js';

const touch = () => matchMedia('(pointer:coarse)').matches;
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();

function attitude(ship) {
  const E = ship.env, up = E.up;
  const fw = _f.set(0, 0, -1).applyQuaternion(ship.q), rt = _r.set(1, 0, 0).applyQuaternion(ship.q), ub = _u.set(0, 1, 0).applyQuaternion(ship.q);
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
  const east = new THREE.Vector3().crossVectors(north, up);
  return { hdg: Math.atan2(fw.dot(east), fw.dot(north)) * R2D, bank: Math.atan2(-rt.dot(up), ub.dot(up)) * R2D };
}
const angDiff = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

export function flightSchool() {
  const T = touch();
  let mem = {};
  return [
    { title: 'Full power', text: T ? 'Slide the throttle on the right all the way up.' : 'Press <kbd>Z</kbd> for full throttle (or hold <kbd>Shift</kbd>).',
      check: (g) => g.ship.ctl.throttle > 0.9 },
    { title: 'Take off', text: T ? 'Roll straight down the runway. When SRF (speed) reads about 75 m/s, pull the stick down gently to lift off.' : 'Roll straight down the runway. When SRF (speed) reads about 75 m/s, hold <kbd>S</kbd> gently to lift off.',
      check: (g) => g.ship.contacts === 0 && g.ship.env.agl > 25 },
    { title: 'Gear up', text: T ? 'Raise the landing gear: tap GEAR.' : 'Raise the landing gear: press <kbd>G</kbd> (or tap GEAR).',
      check: (g) => !g.ship.ctl.gear },
    { title: 'Climb', text: 'Climb to 1,000 m — watch RAD at the top. Let go of the stick: the fly-by-wire holds your climb angle for you.',
      check: (g) => g.ship.env.agl > 1000 },
    { title: 'Level off', text: T ? 'Push the stick up a little until V/S reads about 0, then let go. Bring the throttle back to about 60%.' : 'Tap <kbd>W</kbd> until V/S reads about 0, then let go. Ease the throttle to about 60% (<kbd>Ctrl</kbd>).',
      check: (g, dt) => { mem.lvl = Math.abs(g.ship.env.vVert) < 4 ? (mem.lvl || 0) + dt : 0; return mem.lvl > 3; } },
    { title: 'Turn', text: T ? 'Move the stick left or right to bank, then let go — the bank holds and the turn is coordinated. Turn about 90° (watch HDG).' : 'Hold <kbd>A</kbd> or <kbd>D</kbd> to bank, then let go — the bank holds and the turn is coordinated. Turn about 90° (watch HDG).',
      start: (g) => { mem.h0 = attitude(g.ship).hdg; },
      check: (g) => Math.abs(angDiff(attitude(g.ship).hdg, mem.h0)) > 80 },
    { title: 'Wings level', text: T ? 'Roll back the other way until the wings are level, then let go.' : 'Roll back with the opposite key until the wings are level, then let go.',
      check: (g, dt) => { mem.wl = Math.abs(attitude(g.ship).bank) < 6 ? (mem.wl || 0) + dt : 0; return mem.wl > 2; } },
    { title: 'The map', text: T ? 'Tap the globe button at the top left to see where you are on the planet, then tap ✈ to come back.' : 'Press <kbd>M</kbd> (or the globe button) to see where you are on the planet, then press it again to come back.',
      check: (g) => { if (g.mapOpen) mem.mapped = true; return mem.mapped && !g.mapOpen; } },
    { title: 'Autopilot', text: 'Time to land. Tap AUTO and choose “Land at …”. The autopilot flies the approach — move the stick any time to take over.',
      check: (g) => g.controller.ap && g.controller.ap.name === 'Auto-land' },
    { title: 'Landing', text: 'Watch it line up with the runway, lower the gear, flare and brake. (Use the warp arrows top-right to speed things up.)',
      check: (g) => !!g.ship.parked || (g.ship.contacts > 0 && g.ship.env.vSurf < 2) },
    { title: 'You’re a pilot!', text: 'Next: pick <b>Selene</b>, take off, and try AUTO → Ascend to orbit. In orbit, open the map and tap Go to the Moon. Have fun!',
      final: true, check: () => false },
  ];
}

export class Tutorial {
  constructor(game) {
    this.game = game;
    this.el = document.getElementById('tut');
    this.steps = null; this.i = 0; this.wait = 0;
  }
  get active() { return !!this.steps; }
  start(steps) { this.steps = steps; this.i = 0; this.wait = 0; this.enter(); }
  stop() { this.steps = null; this.el.hidden = true; }
  enter() {
    const st = this.steps[this.i];
    if (st.start) st.start(this.game);
    const n = this.steps.length;
    this.el.innerHTML = `<div class="tut-k">Flight school · ${Math.min(this.i + 1, n)}/${n}</div><div class="tut-h">${st.title}</div><div class="tut-t">${st.text}</div><div class="tut-b"><button id="tut-x">${st.final ? 'Finish' : 'Skip lesson'}</button></div>`;
    this.el.hidden = false;
    document.getElementById('tut-x').onclick = () => { this.game.audio.click(); this.stop(); };
    this.el.classList.remove('done');
  }
  update(dt) {
    if (!this.steps || !this.game.ship) return;
    if (this.game.ship.dead) { this.el.querySelector('.tut-t').innerHTML = 'Ouch! Tap Restart to try again.'; return; }
    if (this.wait > 0) { this.wait -= dt; if (this.wait <= 0) { this.i++; this.enter(); } return; }
    const st = this.steps[this.i];
    if (st.check(this.game, dt)) {
      this.el.classList.add('done');
      this.game.audio.click();
      this.wait = 1.2;
    }
  }
}
