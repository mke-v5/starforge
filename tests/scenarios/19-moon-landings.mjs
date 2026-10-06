// Auto-land on the Moon over real terrain from a low lunar orbit, at eight different spots (plains and
// highlands up to 6 km): every one sets down intact.
export const meta = { name: 'moon-landings', slow: true, fixtures: true, timeout: 1500 };
export default async function (t) {
  const bad = [];
  for (const wait of [0, 1500, 3000, 4500, 6000, 7500, 9000, 10500]) {
    const r = await t.eval(async (wait) => {
      const sf = __sf, C = await import('/src/ship/control.js');
      await __t.start('Selene', { type: 'lunarOrbit', alt: 80000 });
      await __t.sim(wait, { dt: 0.5 });
      sf.engage(C.landAp());
      await __t.sim(3 * 86400, { allowDead: true, until: (sf) => !!sf.ship.parked || !sf.controller.ap || sf.ship.dead });
      await __t.sim(4, { allowDead: true });
      const E = sf.ship.env, lost = sf.ship.craft.parts.filter((P) => !P.alive).length;
      return { wait, dead: sf.ship.dead, lost, v: E.vSurf, ground: sf.world.groundAt(E.body, E.lat, E.lon) };
    }, wait);
    t.log(`spot ${r.wait / 1500 + 1}: ground ${r.ground.toFixed(0)} m, ${r.lost} parts lost, ${r.v.toFixed(1)} m/s`);
    if (r.dead || r.lost || r.v > 1) bad.push(`spot ${r.wait / 1500 + 1} (${r.ground.toFixed(0)} m)`);
  }
  t.check(!bad.length, `all eight landings intact ${bad.join(', ')}`);
}
