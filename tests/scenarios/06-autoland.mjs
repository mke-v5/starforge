// The Kestrel from the air over San Francisco auto-lands on the nearest big runway.
export const meta = { name: 'autoland', fixtures: true };
export default async function (t) {
  await t.eval(() => __t.start('Kestrel', { type: 'air', lat: 37.78, lon: -122.48, alt: 3000, hdg: 90, speed: 200 }));
  await t.eval(() => __t.settle(6, { step: false }));
  const r = await t.eval(async () => {
    const sf = __sf, C = await import('/src/ship/control.js');
    const rw = sf.landingRunway();
    if (!rw) return { err: 'no runway' };
    sf.engage(C.landRunwayAp(sf.world.airports, rw.rw, rw.name, sf.terrainFn()));
    const res = await __t.sim(1800, { until: (sf) => !!sf.ship.parked || (!sf.controller.ap && sf.ship.contacts > 0 && sf.ship.env.vSurf < 2) });
    const E = sf.ship.env, n = sf.world.airports.nearestRunway(E.lat, E.lon, 5000);
    return { name: rw.name, parked: !!sf.ship.parked, dead: sf.ship.dead, onRunway: !!n, v: E.vSurf, status: sf.controller.status, t: res.t };
  });
  t.check(!r.err, r.err || 'found a runway');
  t.check(!r.dead && (r.parked || r.v < 2) && r.onRunway, `auto-land at ${r.name}: parked=${r.parked} on runway=${r.onRunway} (${r.t?.toFixed(0)} s)`);
  await t.eval(() => __t.settle(1.5));
  await t.shot('autoland');
}
