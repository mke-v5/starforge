// Low clouds: a cumulus field around the plane that follows the globe's weather, a white-out flying through
// one, off on low quality and with the clouds setting.
export const meta = { name: 'clouds', fixtures: true, timeout: 300 };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf, C = sf.world.clouds;
    await __t.start('Kestrel', { type: 'air', lat: 48.0, lon: 0.0, alt: 1200, hdg: 90, speed: 200 });
    await __t.settle(2);
    const n = C.mesh.geometry.instanceCount;
    // time a rebuild
    let t0 = performance.now(); C.last = null; C.coverCache = null; C.update(sf.world._camE, sf.world.camLL, true, 0); const msCold = performance.now() - t0;
    t0 = performance.now(); C.last = null; C.update(sf.world._camE, sf.world.camLL, true, 0); const ms = performance.now() - t0;
    // fly into the nearest puff: put the ship at its centre
    const p = C.puffs[C.puffs.length - 1];
    const G = await import('/src/core/geo.js');
    const r = Math.hypot(p.x, p.y, p.z), lat = Math.asin(p.y / r) / G.D2R, lon = Math.atan2(-p.z, p.x) / G.D2R;
    await __t.start('Kestrel', { type: 'air', lat, lon, alt: r - G.EARTH.R, hdg: 90, speed: 150 });
    await __t.settle(1.5);
    sf._xt = 0; sf.hudExtras(1); sf.hud.update(1, sf.ship, sf.controller, sf.extra);
    const inside = { fog: C.fog, css: +document.getElementById('cloudfog').style.opacity };
    // quality low: none; setting off: hidden
    sf.settings.quality = 'low'; sf.applySettings();
    const low = C.mesh ? C.mesh.geometry.instanceCount : 0;
    sf.settings.quality = 'medium'; sf.applySettings();
    sf.settings.clouds = '0'; await __t.settle(0.5);
    const off = C.mesh.visible;
    sf.settings.clouds = '1';
    return { n, ms, msCold, inside, low, off };
  });
  t.check(r.n > 100, `cumulus field around the plane (${r.n} puffs, rebuilt in ${r.msCold.toFixed(1)} ms, ${r.ms.toFixed(1)} ms with the weather cached)`);
  t.check(r.inside.fog > 0.3 && r.inside.css > 0.25, `flying into a cloud whites out the view (${r.inside.fog.toFixed(2)})`);
  t.check(r.low === 0 && r.off === false, 'off on low quality and with the clouds setting');
}
