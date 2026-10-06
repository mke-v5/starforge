// Places to fly to: airports and ~16,000 cities, searched together (accents ignored), plus reverse lookup of the
// nearest named place to a point. Cities with the same name in the same country are told apart by population.

import { gcDist } from '../core/geo.js';

export const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class Places {
  constructor(airports) {
    this.A = airports;
    this.cities = [];
    this.ready = fetch('./data/cities.json').then((r) => r.json()).then((rows) => {
      this.cities = rows.map((r) => ({ n: r[0], c: r[1], lat: r[2], lon: r[3], p: r[4], l: fold(r[0]) }));
      // names that repeat within a country get their population as a tie-breaker in labels
      const seen = new Map();
      for (const c of this.cities) { const k = c.l + '|' + c.c; seen.set(k, (seen.get(k) || 0) + 1); }
      for (const c of this.cities) c.dup = seen.get(c.l + '|' + c.c) > 1;
    }).catch((e) => console.warn('cities', e));
  }

  // a place record the rest of the game uses: { kind, name, code?, sub, lat, lon, airport? }
  fromAirport(a) { return { kind: 'airport', name: a.name, code: a.iata || a.ident, sub: `${a.iata || a.ident} · ${a.city ? a.city + ', ' : ''}${a.cc}`, lat: a.lat, lon: a.lon, airport: a }; }
  fromCity(c) { return { kind: 'city', name: c.n, sub: `${c.c}${c.dup ? ' · pop. ' + fmtPop(c.p) : ''}`, lat: c.lat, lon: c.lon, pop: c.p }; }

  search(q, n = 8) {
    q = (q || '').trim();
    if (!q) return [];
    const f = fold(q);
    const out = [];
    for (const a of this.A.search(q, Math.ceil(n / 2) + 1)) out.push(this.fromAirport(a));
    let k = 0;
    const take = (pred) => { for (const c of this.cities) { if (k >= n) break; if (pred(c)) { out.push(this.fromCity(c)); k++; } } };
    take((c) => c.l.startsWith(f));
    if (k < n) take((c) => !c.l.startsWith(f) && c.l.includes(f));
    // a city named exactly like the query comes before airports that merely mention it
    out.sort((x, y) => rank(y, f) - rank(x, f));
    return out.slice(0, n);
  }

  // nearest named place to a point: a tap on an airfield picks the airport, otherwise the city it falls in (the
  // biggest nearby one), an airport that is closer than any city, or failing all that the coordinates
  near(lat, lon) {
    let ap = null;
    if (this.A.ready) {
      const n = this.A.nearest(lat, lon, 1, 2)[0];
      if (n && n.d < 30000) ap = { ...this.fromAirport(n.a), d: n.d };
    }
    if (ap && ap.d < 4000) return ap;
    let best = null, bs = Infinity;
    for (const c of this.cities) {
      if (Math.abs(c.lat - lat) > 2) continue;
      const d = gcDist(lat, lon, c.lat, c.lon);
      if (d > 120000) continue;
      const s = d / Math.pow(Math.max(c.p, 1000), 0.25);    // bigger cities win from a little further away
      if (s < bs) { bs = s; best = { ...this.fromCity(c), d }; }
    }
    if (ap && (!best || ap.d < best.d)) return ap;
    if (best) return best;
    return { kind: 'point', name: `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`, sub: 'map point', lat, lon };
  }
}

function rank(p, f) {
  if (p.kind === 'airport' && p.code && p.code.toLowerCase() === f) return 3;
  if (p.kind === 'city' && fold(p.name) === f) return 2 + Math.min(0.9, Math.log10(Math.max(p.pop || 1, 1)) / 10);
  return p.kind === 'airport' ? 1 : 0.5;
}
function fmtPop(p) { return p >= 1e6 ? (p / 1e6).toFixed(1) + 'M' : Math.round(p / 1000) + 'k'; }
