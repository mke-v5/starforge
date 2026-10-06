// "Fly me to the Moon": one tap from low Earth orbit — transfer, correction, capture, descent and a landing on
// Tranquility Base — then saved and resumed mid-way the trip carries on.
export const meta = { name: 'moon-auto', slow: true, fixtures: true, timeout: 1500 };
export default async function (t) {
  await t.eval(() => __t.start('Selene', { type: 'orbit', alt: 400000 }));
  // the AUTO menu offers it
  const menu = await t.eval(() => { __sf.autopilotMenu ? __sf.autopilotMenu() : document.getElementById('h-auto') && document.getElementById('h-auto').click(); return [...document.querySelectorAll('#d-btns button')].map((b) => b.textContent); });
  t.check(menu.some((m) => /Fly me to the Moon/.test(m)), `AUTO offers the trip (${menu.length} options)`);
  await t.eval(() => __sf.modal('dialog', false));
  // start, coast a day, save, resume
  const mid = await t.eval(async () => {
    const sf = __sf, site = (await import('/src/ui/mapview.js')).MOON_SITES[0];
    sf.flyToMoon(site);
    await __t.sim(86400, { wallMax: 400000 });
    const snap = sf.snapshot();
    return { snap, ap: sf.controller.ap && sf.controller.ap.name, status: sf.controller.apStatus, h: sf.ship.env.h };
  });
  t.check(/To the Moon/.test(mid.ap || '') && mid.snap.moonTo === 'Tranquility Base', `a day out: ${mid.status} (${(mid.h / 1e6).toFixed(0)},000 km); saved with the trip`);
  const end = await t.eval(async (snap) => {
    const sf = __sf;
    await sf.resumeFlight(snap);
    await __t.sim(3, {});
    await new Promise((r) => setTimeout(r, 1700));
    await __t.sim(1, {});
    const resumed = sf.controller.ap && sf.controller.ap.name;
    await __t.sim(20 * 86400, { until: (sf) => !sf.controller.ap || sf.ship.dead, wallMax: 900000, allowDead: true });
    await __t.sim(5, { allowDead: true });
    const E = sf.ship.env, G = await import('/src/core/geo.js');
    const site = (await import('/src/ui/mapview.js')).MOON_SITES[0];
    return { resumed, body: E.body.name, dead: sf.ship.dead, contacts: sf.ship.contacts, status: sf.controller.status, miss: G.gcDist(E.lat, E.lon, site.lat, site.lon) * G.MOON.R / G.EARTH.R };
  }, mid.snap);
  t.check(/To the Moon/.test(end.resumed || ''), `resumed the trip after a reload (${end.resumed})`);
  t.check(end.body === 'Moon' && !end.dead && end.contacts > 0 && end.miss < 3000, `landed at Tranquility Base, ${end.miss.toFixed(0)} m from the spot (${end.status}${end.dead ? " CRASHED" : ""}, contacts ${end.contacts})`);
}
