// Textbook numbers and integrator health.
export const meta = { name: 'physics-checks' };
export default async function (t) {
  const r = await t.eval(async () => {
    const { EARTH, MOON } = await import('/src/core/geo.js');
    const { moonPos } = await import('/src/core/astro.js');
    const THREE = await import('three');
    const out = {};
    out.vOrb200 = Math.sqrt(EARTH.mu / (EARTH.R + 200000));
    out.vEsc = Math.sqrt(2 * EARTH.mu / EARTH.R);
    // Moon distance over a month
    const v = new THREE.Vector3(); let lo = 1e12, hi = 0, sum = 0, n = 0;
    for (let d = 0; d < 27.32; d += 0.05) { const x = moonPos(8.4e8 + d * 86400, v).length(); lo = Math.min(lo, x); hi = Math.max(hi, x); sum += x; n++; }
    out.moonMean = sum / n; out.moonLo = lo; out.moonHi = hi;
    return out;
  });
  t.check(Math.abs(r.vOrb200 - 7784) < 15, `orbit speed at 200 km ${r.vOrb200.toFixed(0)} m/s ≈ 7.8 km/s`);
  t.check(Math.abs(r.vEsc - 11186) < 20, `escape speed ${r.vEsc.toFixed(0)} m/s ≈ 11.2 km/s`);
  t.check(Math.abs(r.moonMean / 1000 - 385000) < 2500, `Moon mean distance ${(r.moonMean / 1000).toFixed(0)} km ≈ 384,400`);
  t.check(r.moonLo / 1000 > 350000 && r.moonHi / 1000 < 410000, `Moon distance range ${(r.moonLo / 1000).toFixed(0)}–${(r.moonHi / 1000).toFixed(0)} km`);
  // one orbit on rails and ten minutes of full physics in a circular orbit: altitude must hold
  await t.eval(() => __t.start('Selene', { type: 'orbit', alt: 400000 }));
  const o0 = await t.eval(() => __t.orbit());
  await t.eval(() => { __sf.ship.warp = 1000; });
  await t.eval(() => __t.sim(5560, { dt: 0.05 }));
  const o1 = await t.eval(() => { __sf.ship.warp = 1; return __t.orbit(); });
  t.check(Math.abs(o1.ap - o0.ap) < 2 && Math.abs(o1.pe - o0.pe) < 2, `rails orbit holds: ${o0.pe.toFixed(1)}×${o0.ap.toFixed(1)} → ${o1.pe.toFixed(1)}×${o1.ap.toFixed(1)} km`);
  await t.eval(() => { __sf.ship.warp = 4; });
  await t.eval(() => __t.sim(600, { dt: 0.05 }));
  const o2 = await t.eval(() => { __sf.ship.warp = 1; return __t.orbit(); });
  t.check(Math.abs(o2.ap - o1.ap) < 2 && Math.abs(o2.pe - o1.pe) < 2, `physics orbit holds: ${o2.pe.toFixed(1)}×${o2.ap.toFixed(1)} km`);
}
