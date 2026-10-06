// On the Moon with real elevation (the bundled LOLA map, decoded in a worker): stand at Tranquility Base, hop
// up on the lift thrusters and let the auto-land put the ship back down on the uneven ground.
export const meta = { name: 'moon-surface', fixtures: true, timeout: 400 };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Selene', { type: 'moon', lat: 0.674, lon: 23.47 });
    await __t.sim(3, { dt: 0.02 });
    const s = sf.ship, E = s.env, L = sf.world.loader;
    return { z: sf.world.moon.heightAt(E.lat, E.lon).z, ground: sf.world.groundAt(E.body, E.lat, E.lon), workers: L.decoders.length, contacts: s.contacts, dead: s.dead, vs: E.vSurf };
  });
  t.check(r.z >= 6 && r.ground < -500 && r.workers === 2, `lunar terrain at Tranquility Base: ${r.ground.toFixed(0)} m (level ${r.z}, decoded in ${r.workers} workers)`);
  t.check(!r.dead && r.contacts > 0 && r.vs < 0.5, 'standing on the Moon');
  const hop = await t.eval(async () => {
    const sf = __sf, C = await import('/src/ship/control.js');
    // straight up on the lift thrusters for a few seconds, drifting sideways
    sf.controller.setEngineGroup(sf.ship.craft, 'lift');
    sf.controller.input.throttle = 0.9;
    await __t.sim(9, { dt: 0.02 });
    const peak = sf.ship.env.agl;
    sf.controller.input.throttle = 0;
    sf.engage(C.landAp());
    await __t.sim(300, { dt: 0.02, until: (sf) => !sf.controller.ap || sf.ship.dead, allowDead: true });
    await __t.sim(3, { dt: 0.02, allowDead: true });
    return { peak, dead: sf.ship.dead, status: sf.controller.status, contacts: sf.ship.contacts, vs: sf.ship.env.vSurf };
  });
  t.check(hop.peak > 30 && !hop.dead && hop.contacts > 0 && hop.vs < 1, `hop to ${hop.peak.toFixed(0)} m and auto-land: ${hop.status}`);
  // the map knows the ship is on the ground: where it is, take-off options, no orbit through the Moon
  const map = await t.eval(async () => {
    const sf = __sf;
    sf.toggleMap();
    sf.mapView.predT = 0;
    await __t.sim(1, { dt: 0.05 });
    const info = document.getElementById('m-info').innerText, plan = [...document.querySelectorAll('#m-plan button')].map((b) => b.textContent);
    const labels = [...document.querySelectorAll('.maplabel')].map((d) => d.textContent);
    const lines = sf.mapView.lineMoon.visible || sf.mapView.lineEarth.visible;
    sf.toggleMap();
    return { info, plan, labels, lines, g: sf.ship.gForce };
  });
  t.log(JSON.stringify(map));
  t.check(/on the ground/.test(map.info) && /Tranquility/.test(map.info) && !/Apoapsis|impact/.test(map.info), `map: ${map.info.replace(/\s+/g, ' ')}`);
  t.check(map.plan.some((b) => /take off/i.test(b)) && !map.plan.some((b) => /land on the Moon|Circularize/i.test(b)) && !map.lines && !map.labels.some((l) => /impact|^Ap |Pe /.test(l)), 'map offers take-off, no landing or orbit lines while parked');
  t.check(Math.abs(map.g - 0.165) < 0.02, `standing on the Moon reads ${map.g.toFixed(2)} g`);
}
