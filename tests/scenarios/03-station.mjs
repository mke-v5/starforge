// Dock at Meridian from beside it, refuel, save/resume docked, undock.
export const meta = { name: 'station-dock' };
export default async function (t) {
  await t.eval(() => __t.start('Selene', { type: 'stationNear' }));
  await t.eval(() => __t.settle(2));
  await t.shot('station-near');
  const r = await t.eval(async () => {
    const sf = __sf;
    sf.dockAction();
    const res = await __t.sim(1500, { until: (sf) => sf.ship.docked || !sf.controller.ap });
    return { docked: !!sf.ship.docked, status: sf.controller.status, t: res.t };
  });
  t.check(r.docked, `docks from beside the station (${r.t.toFixed(0)} s) ${r.status}`);
  const f = await t.eval(() => { const sf = __sf; sf.craft.draw('FU', 500); sf.refuel(); const fu = sf.craft.amount('FU'); sf.saveFlight(); return { fu, cap: sf.craft.capacity('FU'), saved: JSON.parse(localStorage.getItem('starforge.flight')).where }; });
  t.check(f.fu === f.cap, 'refuel fills the tanks');
  t.check(/docked/.test(f.saved), `save says ${f.saved}`);
  const r2 = await t.eval(async () => { const sf = __sf; const s = JSON.parse(localStorage.getItem('starforge.flight')); sf.toTitle(); await sf.resumeFlight(s); return { docked: !!sf.ship.docked }; });
  t.check(r2.docked, 'resumes docked');
  const r3 = await t.eval(async () => { const sf = __sf; sf.dockAction(); await __t.sim(300, { until: (sf) => !sf.controller.ap }); return { docked: !!sf.ship.docked, d: sf.ship.r.distanceTo(sf.station.r), status: sf.controller.status }; });
  t.check(!r3.docked && r3.d > 40, `undocks and backs away to ${r3.d.toFixed(0)} m (${r3.status})`);
  await t.eval(() => __t.settle(1.5));
  await t.shot('station-undocked');
}
