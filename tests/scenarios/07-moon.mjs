// Earth orbit → Moon landing → fly home to a runway, all on autopilot.
export const meta = { name: 'moon-round-trip', slow: true, timeout: 1500 };
export default async function (t) {
  await t.eval(() => __t.start('Selene', { type: 'orbit', alt: 400000 }));
  const a = await t.eval(async () => {
    const sf = __sf, O = await import('/src/ship/orbit.js'), C = await import('/src/ship/control.js');
    const tli = await O.planMoonTransfer(sf.ship, 120000);
    if (!tli) return { err: 'no transfer' };
    sf.controller.node = tli;
    sf.engage(C.nodeExec(tli));
    await __t.sim(10 * 86400, { until: (sf) => !sf.controller.ap });
    // a few hours out, fine-tune the approach to a 100 km periapsis (the map's "Fine-tune Moon approach")
    sf.engage(C.waitAp('coast', (s) => s.t > tli.t + 4 * 3600, () => tli.t + 4 * 3600 + 5));
    await __t.sim(86400, { until: (sf) => !sf.controller.ap });
    const fix = await O.planCorrection(sf.ship, (await import('/src/core/geo.js')).MOON, 100000);
    if (fix) { sf.controller.node = fix; sf.engage(C.nodeExec(fix)); await __t.sim(86400, { until: (sf) => !sf.controller.ap }); }
    // coast into the Moon's sphere of influence
    sf.engage(C.waitAp('coast', (s) => s.env.body.name === 'Moon', () => null));
    await __t.sim(6 * 86400, { until: (sf) => sf.ship.env.body.name === 'Moon' || !sf.controller.ap });
    const cap = O.planCapture(sf.ship);
    if (cap) { sf.controller.node = cap; sf.engage(C.nodeExec(cap)); await __t.sim(3 * 86400, { until: (sf) => !sf.controller.ap }); }
    const rs = O.relState(sf.ship, sf.ship.env.body), el = O.elements(rs.r, rs.v, rs.mu);
    return { body: sf.ship.env.body.name, pe: (el.pe - 1737400) / 1000, ap: (el.ap - 1737400) / 1000, e: el.e, fix: fix ? fix.dv.length() : null };
  });
  t.check(!a.err && a.body === 'Moon' && a.e < 1 && a.pe > 5, `captured into lunar orbit (pe ${a.pe?.toFixed(0)} km, ap ${a.ap?.toFixed(0)} km, correction ${a.fix?.toFixed(1)} m/s) ${a.err || ''}`);
  if (a.err) return;
  const b = await t.eval(async () => {
    const sf = __sf, C = await import('/src/ship/control.js');
    sf.engage(C.landAp());
    await __t.sim(3 * 86400, { until: (sf) => !!sf.ship.parked || !sf.controller.ap });
    return { landed: !!sf.ship.parked || sf.ship.contacts > 0, dead: sf.ship.dead, body: sf.ship.env.body.name, status: sf.controller.status };
  });
  t.check(b.landed && !b.dead && b.body === 'Moon', `landed on the Moon: ${b.status}`);
  if (!b.landed || b.dead) return;
  const c = await t.eval(async () => {
    const sf = __sf, A = sf.world.airports, ap = A.search('SFO', 1)[0];
    sf.mapView.flyHomeAll(ap);
    const res = await __t.sim(12 * 86400, { until: (sf) => !!sf.ship.parked && sf.ship.env.body.name === 'Earth' || !sf.controller.ap, wallMax: 600000 });
    if (!sf.ship.dead && sf.ship.env.body.name === 'Earth') await __t.sim(30, { until: (sf) => !!sf.ship.parked });   // rolls to a stop and parks
    const E = sf.ship.env, n = A.nearestRunway(E.lat, E.lon, 8000);
    return { body: E.body.name, parked: !!sf.ship.parked, dead: sf.ship.dead, at: n ? n.rw.ap.iata : null, status: sf.controller.status, days: res.t / 86400 };
  });
  t.check(c.body === 'Earth' && c.parked && !c.dead && c.at, `home: landed at ${c.at} after ${c.days?.toFixed(1)} days (${c.status})`);
}
