// The newer presets in the air and in space: Peregrine takes off on autopilot and goes supersonic on its
// afterburner with the wings swept; Courier starts docked, undocks and pushes off on its ion drive.
export const meta = { name: 'presets-fly', fixtures: true, timeout: 400 };
export default async function (t) {
  const pe = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Peregrine', { type: 'runway', airport: 'SFO', rw: '28R' });
    await __t.settle(4, { step: false });
    sf.flyTo(sf.places.search('LAX', 1)[0]);
    await __t.sim(100, { dt: 0.05, allowDead: true });
    const off = { agl: sf.ship.env.agl, dead: sf.ship.dead };
    await __t.start('Peregrine', { type: 'air', lat: 37.0, lon: -123.5, alt: 9000, hdg: 90, speed: 250 });
    sf.controller.input.throttle = 1;
    await __t.sim(90, { dt: 0.05, allowDead: true });
    const W = sf.ship.craft.wings.find((P) => P.def.id === 'wg-swing').wing;
    return { off, mach: sf.ship.env.mach, k: W.k, ab: sf.ship.craft.engines[0].eng.ab, dead: sf.ship.dead };
  });
  t.check(!pe.off.dead && pe.off.agl > 300, `Peregrine takes off on autopilot (${pe.off.agl.toFixed(0)} m)`);
  t.check(!pe.dead && pe.mach > 1.5 && pe.k > 0.8 && pe.ab > 0.9, `Peregrine on afterburner: Mach ${pe.mach.toFixed(2)}, wings swept ${Math.round(pe.k * 100)} %`);
  const co = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Courier', { type: 'docked' });
    const docked = !!sf.ship.docked;
    sf.dockAction();
    await __t.sim(60, { dt: 0.05 });
    const away = sf.ship.r.distanceTo(sf.station.posAt(sf.ship.t, sf.ship.r.clone()));
    sf.controller.setSas('prograde');
    await __t.sim(30, { dt: 0.05 });
    const v0 = sf.ship.v.length();
    sf.controller.input.throttle = 1;
    await __t.sim(60, { dt: 0.05 });
    const E = sf.ship.craft.engines[0];
    return { docked, away, dv: sf.ship.v.length() - v0, thrust: E.eng.thrust, starved: !!E.eng.starved, undocked: !sf.ship.docked };
  });
  t.check(co.docked && co.undocked && co.away > 10, `Courier starts docked, undocks and backs away (${co.away.toFixed(0)} m)`);
  t.check(co.thrust > 11000 && !co.starved && co.dv > 40, `Courier's ion drive on the fusion core: ${(co.thrust / 1000).toFixed(1)} kN, +${co.dv.toFixed(0)} m/s in a minute`);
}
