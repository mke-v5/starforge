// Starhopper (a tail-sitter) flies home from lunar orbit and lands on its legs at SFO.
export const meta = { name: 'starhopper-home', slow: true, fixtures: true, timeout: 1500 };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Starhopper', { type: 'lunarOrbit', alt: 100000 });
    const L = []; const toast = sf.hud.toast.bind(sf.hud); sf.hud.toast = (m, k) => { L.push(m); return toast(m, k); };
    const ap = sf.world.airports.search('SFO', 1)[0];
    sf.mapView.flyHomeAll(ap);
    const res = await __t.sim(12 * 86400, { allowDead: true, wallMax: 900000, until: (sf) => (!!sf.ship.parked && sf.ship.env.body.name === 'Earth') || !sf.controller.ap || sf.ship.dead });
    await __t.sim(10, { allowDead: true });
    const E = sf.ship.env, G = await import('/src/core/geo.js'), rw = ap.runways[0];
    const lost = sf.ship.craft.parts.filter((P) => !P.alive).map((P) => P.def.id);
    return { days: res.t / 86400, body: E.body.name, dead: sf.ship.dead, contacts: sf.ship.contacts, d: G.gcDist(E.lat, E.lon, ap.lat, ap.lon), lost, L: L.filter((m) => !/★/.test(m)).slice(-8) };
  });
  for (const l of r.L) t.log('  ' + l);
  t.check(r.body === 'Earth' && !r.dead && r.contacts > 0 && !r.lost.length && r.d < 3000, `Starhopper home on its legs ${r.d.toFixed(0)} m from SFO after ${r.days.toFixed(1)} days ${r.lost.join(',')}`);
}
