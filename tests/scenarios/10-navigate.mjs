// "Fly here": place search, the HUD's distance/ETA and marker, tapping the map, and a whole flight SFO → LAX.
export const meta = { name: 'navigate', timeout: 900, fixtures: true };
export default async function (t) {
  const s = await t.eval(async () => {
    const sf = __sf; await sf.places.ready;
    const sp = sf.places.search('Sao Paulo', 5).map((p) => p.name);
    const su = sf.places.search('Suzhou', 6).filter((p) => p.kind === 'city').map((p) => p.name + ' · ' + p.sub);
    const lax = sf.places.search('LAX', 3)[0];
    return { sp, su, lax: lax && lax.code, near: sf.places.near(48.85, 2.35).name, nearAp: sf.places.near(37.6213, -122.379).code };
  });
  t.check(s.sp.some((n) => /São Paulo/.test(n)), `accent-insensitive search: ${s.sp.join(', ')}`);
  t.check(new Set(s.su).size === s.su.length && s.su.length >= 2, `same-name cities are told apart: ${s.su.join(' | ')}`);
  t.check(s.lax === 'LAX', 'airport code search');
  t.check(s.near === 'Paris', `a tap on central Paris picks the city: ${s.near}`);
  t.check(s.nearAp === 'SFO', `a tap on an airfield picks the airport: ${s.nearAp}`);
  // take off from SFO and fly to LAX on autopilot
  await t.eval(() => __t.start('Kestrel', { type: 'runway', airport: 'SFO', rw: '28R' }));
  await t.eval(() => __t.settle(6, { step: false }));
  const r1 = await t.eval(async () => {
    const sf = __sf, dest = sf.places.search('LAX', 1)[0];
    sf.flyTo(dest);
    await __t.sim(240, { every: 20, log: (sf) => { if (sf.ship.warp < 4 && sf.ship.env.agl > 300) sf.ship.warp = 4; } });
    sf.hudExtras(1); sf.hud.update(1, sf.ship, sf.controller, sf.extra);
    return { ap: sf.controller.ap && sf.controller.ap.name, status: sf.controller.apStatus, h: sf.ship.env.h, nav: document.getElementById('h-orbit').innerText, navOn: document.querySelector('#h-toggles button.on') !== null };
  });
  t.check(/Fly to LAX/.test(r1.ap || '') && r1.h > 500, `climbing out on autopilot: ${r1.ap} · ${r1.status} · ${Math.round(r1.h)} m`);
  t.check(/LAX/.test(r1.nav) && /km/.test(r1.nav), `HUD shows the destination: ${r1.nav.replace(/\n/g, ' / ')}`);
  await t.eval(() => __t.settle(1.5));
  const mark = await t.eval(() => { const el = document.getElementById('h-dest'); return { hidden: el.hidden, text: el.innerText }; });
  t.check(!mark.hidden && /LAX/.test(mark.text), `destination marker: ${mark.text}`);
  await t.shot('nav-climb');
  const r2 = await t.eval(async () => {
    const sf = __sf;
    const res = await __t.sim(3 * 3600, { every: 20, log: (sf) => { const s = sf.ship; if (s.warp < 4 && s.env.agl > 300 && !/Final|Flare|Rollout/.test(sf.controller.apStatus || '')) s.warp = 4; if (/Final|Flare/.test(sf.controller.apStatus || '')) s.warp = 1; }, until: (sf) => !!sf.ship.parked || !sf.controller.ap });
    const E = sf.ship.env, n = sf.world.airports.nearestRunway(E.lat, E.lon, 5000);
    return { parked: !!sf.ship.parked, dead: sf.ship.dead, at: n ? n.rw.ap.iata : null, v: E.vSurf, status: sf.controller.status, min: res.t / 60 };
  });
  t.check(!r2.dead && r2.at === 'LAX' && (r2.parked || r2.v < 2), `landed at ${r2.at} after ${r2.min.toFixed(0)} min (${r2.status})`);
  // tap the map: the tapped spot becomes the destination
  const r3 = await t.eval(async () => {
    const sf = __sf; sf.setDest(null, true);
    sf.toggleMap(); sf.mapView.setFocus('earth');
    await __t.settle(1);
    sf.mapView.tapAt(innerWidth / 2, innerHeight / 2);
    const d = sf.dest; sf.toggleMap();
    return d ? d.name + ' · ' + d.sub : null;
  });
  t.check(!!r3, `tapping the globe sets a destination: ${r3}`);
}
