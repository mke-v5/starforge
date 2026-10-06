// Flying by hand: coasting up out of the air on a path that falls back in, the HUD suggests circularizing;
// one tap plans and flies the burn into a proper orbit. Graphics quality changes apply live.
export const meta = { name: 'assist' };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Selene', { type: 'orbit', alt: 85000 });
    const s = sf.ship, up = s.r.clone().normalize();
    s.v.multiplyScalar(0.985).addScaledVector(up, 350);       // climbing toward ~150 km, periapsis deep in the air
    sf.controller.setSas('prograde');
    sf.controller.input.throttle = 0;
    await __t.sim(2, { dt: 0.05 });
    sf._xt = 0; sf.hudExtras(1); sf.hud.update(1, s, sf.controller, sf.extra);
    const btn = document.getElementById('ap-assist');
    const label = btn ? btn.textContent : null;
    if (btn) btn.click();
    const ap = sf.controller.ap && sf.controller.ap.name;
    await __t.sim(4000, { until: (sf) => !sf.controller.ap });
    const o = __t.orbit();
    return { label, ap, pe: o.pe, apo: o.ap, status: sf.controller.status };
  });
  t.check(/Circularize at apoapsis · \d+ m\/s/.test(r.label || ''), `suggestion shown: ${r.label}`);
  t.check(!!r.ap, `one tap engages the burn (${r.ap})`);
  t.check(r.pe > 120 && Math.abs(r.apo - r.pe) < 40, `in orbit: ${r.pe.toFixed(0)} × ${r.apo.toFixed(0)} km (${r.status})`);
  // graphics quality applies without a restart
  const q = await t.eval(() => {
    const sf = __sf, before = sf.world.earth.splitRatio;
    sf.settings.quality = 'high'; sf.applySettings();
    const hi = { split: sf.world.earth.splitRatio, radius: sf.world.buildings.radius, oct: sf.world.shared.uCloudOct.value };
    sf.settings.quality = 'low'; sf.applySettings();
    const lo = { split: sf.world.earth.splitRatio, detail: sf.world.shared.uDetail.value };
    sf.settings.quality = 'medium'; sf.applySettings();
    return { before, hi, lo };
  });
  t.check(q.hi.split < q.before && q.hi.radius === 2 && q.hi.oct === 11 && q.lo.split > q.before && q.lo.detail === 0, `quality applies live: ${JSON.stringify(q)}`);
}
