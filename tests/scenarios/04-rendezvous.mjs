// From an equatorial orbit to docked at Meridian, all on autopilot.
export const meta = { name: 'rendezvous-leo', slow: true };
export default async function (t) {
  await t.eval(() => __t.start('Selene', { type: 'orbit', alt: 400000 }));
  const r = await t.eval(async () => {
    const sf = __sf, R = await import('/src/ship/rendezvous.js');
    sf.engage(R.rendezvousAp(sf.ship, sf.station));
    const res = await __t.sim(3 * 86400, { until: (sf) => sf.ship.docked || !sf.controller.ap, wallMax: 400000 });
    return { docked: !!sf.ship.docked, status: sf.controller.status, h: res.t / 3600 };
  });
  t.check(r.docked, `docked after ${r.h.toFixed(1)} h of game time ${r.status}`);
}
