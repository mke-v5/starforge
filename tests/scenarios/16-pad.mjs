// A launch pad built anywhere: Starhopper stands on a new pad in Denver (1,600 m up), level, and lifts off.
export const meta = { name: 'pad-anywhere', fixtures: true, timeout: 400 };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf;
    const den = sf.places.search('Denver', 3).find((p) => p.kind === 'city');
    await __t.start('Starhopper', { type: 'padAt', lat: den.lat, lon: den.lon, label: 'Pad at Denver' });
    await __t.sim(4, { dt: 0.02 });
    const s = sf.ship, E = s.env;
    const nose = new (s.r.constructor)(0, 0, -1).applyQuaternion(s.q);
    const tilt = Math.acos(Math.min(1, nose.dot(E.up))) * 57.3;
    const pad = sf.world.airports.extra[0];
    return { site: sf.site.label, elev: sf.site.elev, ground: sf.world.groundAt(E.body, E.lat, E.lon), agl: E.agl, contacts: s.contacts, vs: E.vSurf, tilt, dead: s.dead, pad: !!pad && Math.abs(pad.e1 - sf.site.elev) < 0.01, mesh: !!sf.world.hangar };
  });
  t.log(JSON.stringify(r));
  t.check(r.pad && r.mesh && r.elev > 1400 && r.elev < 1800, `pad built at ${r.elev?.toFixed(0)} m in Denver`);
  t.check(!r.dead && r.contacts > 0 && r.vs < 0.5 && r.tilt < 3 && Math.abs(r.ground - r.elev) < 1.5, `standing on it, level (tilt ${r.tilt.toFixed(1)}°, ground ${r.ground.toFixed(1)} m)`);
  await t.eval(() => __t.settle(3, { step: false }));
  await t.shot('pad-denver');
  const up = await t.eval(async () => {
    const sf = __sf, C = await import('/src/ship/control.js');
    sf.engage(C.ascentAp());
    await __t.sim(40, { dt: 0.02 });
    return { h: sf.ship.env.agl, dead: sf.ship.dead, ap: sf.controller.ap && sf.controller.ap.name };
  });
  t.check(!up.dead && up.h > 1000, `lifts off the new pad (${up.h.toFixed(0)} m after 40 s, ${up.ap})`);
}
