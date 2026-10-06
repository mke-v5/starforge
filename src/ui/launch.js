// Launch-site picker: ship choice, city/airport search, runway/hangar/pad selection, space and Moon starts.
import { gcDist, D2R } from '../core/geo.js';

const $ = (id) => document.getElementById(id);

export const SPECIAL = [
  { id: 'leo', name: 'Low Earth orbit', sub: '400 km circular orbit above the equator', type: 'orbit', alt: 400000 },
  { id: 'stDock', name: 'Docked at Meridian Station', sub: '420 km up, tanks full — undock and fly anywhere (needs a docking port)', type: 'docked' },
  { id: 'stNear', name: 'Beside Meridian Station', sub: 'Holding off its aft port — practise docking (Y)', type: 'stationNear' },
  { id: 'llo', name: 'Lunar orbit', sub: '100 km circular orbit around the Moon', type: 'lunarOrbit', alt: 100000 },
  { id: 'tranq', name: 'Tranquility Base', sub: 'Apollo 11 landing site, the Moon', type: 'moon', lat: 0.674, lon: 23.473 },
  { id: 'shackleton', name: 'Shackleton rim', sub: 'Lunar south pole', type: 'moon', lat: -89.4, lon: 129.8 },
  { id: 'tycho', name: 'Tycho crater', sub: 'Bright young crater, southern highlands', type: 'moon', lat: -43.3, lon: -11.2 },
  { id: 'airSF', name: 'Above the Golden Gate', sub: '3 km over San Francisco at 200 m/s', type: 'air', lat: 37.78, lon: -122.48, alt: 3000, hdg: 90, speed: 200 },
  { id: 'airHim', name: 'Over the Himalaya', sub: '10 km above Everest at 250 m/s', type: 'air', lat: 27.99, lon: 86.92, alt: 10000, hdg: 270, speed: 250 },
];

export class LaunchScreen {
  constructor(game) {
    this.game = game;
    this.mode = 'runway';
    this.selected = null;
    this.cities = [];
    this.anchor = null;      // chosen city/airport to list airports around
    $('l-q').addEventListener('input', () => this.search());
    for (const b of document.querySelectorAll('#l-tabs .tab')) b.addEventListener('click', () => { this.mode = b.dataset.mode; for (const x of document.querySelectorAll('#l-tabs .tab')) x.classList.toggle('on', x === b); this.render(); });
    $('l-go').addEventListener('click', () => { if (this.selected) game.launch(this.selected); });
    $('l-destb').addEventListener('click', () => { game.audio.click(); game.pickDest(); });
  }

  open() {
    this.renderShips();
    this.renderDest();
    const last = this.game.lastSite;
    if (!this.anchor) this.anchor = last && last.anchor ? last.anchor : { name: 'San Francisco', lat: 37.62, lon: -122.38 };
    this.render();
  }

  renderShips() {
    const el = $('l-ships');
    el.innerHTML = '';
    for (const d of this.game.shipList()) {
      const b = document.createElement('button');
      b.textContent = d.name;
      b.classList.toggle('on', d.name === this.game.design.name);
      b.addEventListener('click', () => { this.game.setDesign(d); this.renderShips(); this.render(); });
      el.appendChild(b);
    }
  }

  renderDest() {
    const d = this.game.dest;
    $('l-dest').textContent = d ? `Destination: ${d.name} (${d.sub})` : 'No destination — set one to see its distance and fly there on autopilot';
    $('l-destb').textContent = d ? 'Change' : 'Set destination';
  }

  search() {
    const q = $('l-q').value.trim();
    if (!q) { this.render(); return; }
    const el = $('l-list'); el.innerHTML = '';
    for (const p of this.game.places.search(q, 12)) {
      const b = document.createElement('button'); b.className = 'it';
      b.innerHTML = `<span><span class="nm">${esc(p.name)}</span><span class="sub">${esc(p.sub)}</span></span><span class="r">${p.kind}</span>`;
      b.addEventListener('click', () => {
        this.anchor = p.airport ? { name: p.name, lat: p.lat, lon: p.lon, ap: p.airport } : { name: p.name, lat: p.lat, lon: p.lon };
        $('l-q').value = '';
        this.render();
      });
      el.appendChild(b);
    }
  }

  render() {
    const el = $('l-list'); el.innerHTML = '';
    this.selected = null; $('l-go').disabled = true;
    const vertical = this.game.design.vertical;
    if (this.mode === 'special') {
      for (const s of SPECIAL) {
        const b = document.createElement('button'); b.className = 'it';
        b.innerHTML = `<span><span class="nm">${s.name}</span><span class="sub">${s.sub}</span></span>`;
        b.addEventListener('click', () => this.pick(b, { ...s }));
        el.appendChild(b);
      }
      $('l-sel').textContent = 'Start in space, on the Moon, or already flying.';
      return;
    }
    const A = this.game.world.airports;
    if (!A.ready) { $('l-sel').textContent = 'Loading airports…'; setTimeout(() => this.render(), 400); return; }
    const anchor = this.anchor;
    const list = anchor.ap ? [{ d: 0, a: anchor.ap }, ...A.nearest(anchor.lat, anchor.lon, 10, 1).filter((x) => x.a !== anchor.ap)] : A.nearest(anchor.lat, anchor.lon, 10, 1);
    $('l-sel').textContent = `Airports near ${anchor.name}` + (vertical && this.mode === 'runway' ? ' — vertical ships start on the launch pad.' : '');
    for (const { d, a } of list) {
      for (const rw of a.runways.slice(0, 3)) {
        for (const fromLe of [true, false]) {
          const id = fromLe ? rw.le : rw.he;
          const b = document.createElement('button'); b.className = 'it';
          const len = Math.round(rw.len);
          const label = this.mode === 'runway' ? `Runway ${id}` : this.mode === 'hangar' ? `Hangar · runway ${id}` : `Launch pad · runway ${id}`;
          b.innerHTML = `<span><span class="nm">${a.name}</span><span class="sub">${label} · ${len.toLocaleString('en-US')} m${a.iata ? ' · ' + a.iata : ''}</span></span><span class="r">${d > 0 ? Math.round(d / 1000) + ' km' : ''}</span>`;
          b.addEventListener('click', () => this.pick(b, { type: vertical && this.mode === 'runway' ? 'pad' : this.mode, rw, fromLe, airport: a, anchor }));
          el.appendChild(b);
          if (this.mode !== 'runway') break;
        }
      }
    }
  }

  pick(btn, site) {
    for (const x of document.querySelectorAll('#l-list .it')) x.classList.toggle('on', x === btn);
    this.selected = site;
    $('l-go').disabled = false;
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
