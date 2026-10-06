// Close to the ground (with offline map fixtures standing in for blocked hosts): terrain imagery and the
// close-up detail shader compile and draw, and the vector tiles give roads, a lake and buildings.
export const meta = { name: 'ground-detail', fixtures: true, timeout: 400 };
export default async function (t) {
  await t.eval(() => __t.start('Kestrel', { type: 'air', lat: 37.40, lon: -121.95, alt: 450, hdg: 300, speed: 120 }));
  await t.eval(() => { __sf.ship.parked = null; });
  // let the terrain, imagery and tiles stream in (flying slowly)
  await t.eval(() => __t.settle(14));
  const r = await t.eval(() => {
    const W = __sf.world, B = W.buildings;
    let ready = 0, z14 = 0;
    for (const tl of W.earth.tiles.values()) { if (tl.state === 'ready') { ready++; if (tl.z >= 14) z14++; } }
    return { ready, z14, bTiles: B.count, extra: B.roadCount, imgMaxZ: W.earth.imgMaxZ, agl: __sf.ship.env.agl };
  });
  t.log(JSON.stringify(r));
  t.check(r.ready > 20 && r.z14 > 0, `terrain tiles ready (${r.ready}, ${r.z14} at z14 with imagery level ${r.imgMaxZ})`);
  t.check(r.bTiles > 0, `buildings built (${r.bTiles} tiles)`);
  t.check(r.extra > 0, `roads and water built (${r.extra} meshes)`);
  await t.shot('ground-low');
  // fly-by camera: stands still while the ship passes, then moves on
  const fb = await t.eval(async () => {
    const sf = __sf;
    sf.camMode = 'cockpit'; sf.cycleCam(); sf.cycleCam();
    const mode = sf.camMode;
    await __t.sim(0.2, { dt: 0.05 });
    const F0 = sf.flyby, p0 = F0 && F0.p.clone();
    const d0 = sf.camI.distanceTo(sf.ship.r);
    await __t.sim(1.5, { dt: 0.05 });
    const same = sf.flyby === F0 && sf.flyby.p.distanceTo(p0) < 0.01;
    const d1 = sf.camI.distanceTo(sf.ship.r);
    await __t.sim(15, { dt: 0.05 });
    const moved = sf.flyby !== F0;
    await __t.settle(0.5, { step: false });
    return { mode, same, d0, d1, moved, dNow: sf.camI.distanceTo(sf.ship.r) };
  });
  t.check(fb.mode === 'flyby' && fb.same && fb.moved && fb.dNow < 4000, `fly-by camera holds still (${fb.d0.toFixed(0)} → ${fb.d1.toFixed(0)} m) then moves ahead`);
  await t.shot('ground-flyby');
  await t.eval(() => { __sf.camMode = 'chase'; });
}
