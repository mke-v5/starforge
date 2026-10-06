// Build a plane from an empty hangar with real taps — cockpit, fuselage, engine, mirrored wings, tail fin,
// landing gear — check the stats agree it can fly, save it, launch it from SFO and let the autopilot take off.
export const meta = { name: 'build-a-plane', fixtures: true, timeout: 600 };
export default async function (t) {
  const p = t.page;
  await p.click('#t-hangar');
  await p.waitForFunction(() => __sf.builder && __sf.state === 'hangar', null, { timeout: 30000 });
  await p.click('#hb-new');
  await p.click('#d-btns button:has-text("Empty")');
  await t.eval(() => __t.settle(0.3));
  // screen position of a point in the ship's body frame
  await t.eval(async () => {
    const THREE = await import('three');
    window.__scr = (b) => {
      const B = __sf.builder, v = new THREE.Vector3(...b).applyMatrix4(B.shipRoot.matrixWorld).project(B.camera);
      const r = __sf.canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    };
  });
  const tapAt = async (b) => { await t.eval(() => __t.settle(0.25)); const s = await t.eval((b) => __scr(b), b); await p.mouse.click(s.x, s.y); await t.eval(() => __t.settle(0.15)); };
  const pickPart = async (cat, name) => {
    await p.click(`#hb-cats button[data-cat="${cat}"]`);
    await p.click(`#hb-parts .pcard:has(.pn:text-is("${name}"))`);
  };
  const count = () => t.eval(() => __sf.builder.design.parts.length);
  // the cockpit goes down first, anywhere
  await p.mouse.click(640, 360);
  t.check(await count() === 1, 'cockpit placed');
  await pickPart('fuselage', 'S fuselage 4 m');
  await tapAt([0, 0.5, 1.95]);                 // near the cockpit's tail node
  t.check(await count() === 2, 'fuselage stacked behind the cockpit');
  await pickPart('engine', 'Swift turbofan');
  await tapAt([0, 0.5, 5.95]);
  t.check(await count() === 3, 'engine on the tail');
  await pickPart('wing', 'Swept wing');
  await tapAt([-0.62, 0.05, 3.6]);             // left side of the fuselage; symmetry adds the right one
  t.check(await count() === 5, 'wings, mirrored');
  await pickPart('wing', 'Tail fin');
  await tapAt([0, 0.62, 5.3]);
  t.check(await count() === 6, 'tail fin on top');
  await pickPart('wing', 'Tailplane');
  await tapAt([-0.6, 0.05, 5.6]);
  t.check(await count() === 8, 'tailplanes, mirrored');
  // look from below for the landing gear
  await t.eval(() => { __sf.builder.orbit.pitch = -0.15; });
  await pickPart('gear', 'Light landing gear');
  await tapAt([0, -0.5, 1.3]);                 // nose wheel
  await tapAt([-0.42, -0.45, 4.9]);            // main wheels (mirrored), behind the centre of mass
  const gears = await t.eval(() => __sf.builder.design.parts.filter((q) => q.id.startsWith('gr-')).map((q) => q.p.map((v) => v.toFixed(2)).join(',') + (q.sym >= 0 ? ' (mirrored)' : '')));
  t.check(await count() === 11, `landing gear: ${await count()} parts — wheels at ${gears.join(' | ')}`);
  const st = await t.eval(() => {
    const B = __sf.builder;
    return { stats: document.getElementById('hb-stats').innerText, ok: Object.fromEntries(B.stats.mission.list.map((x) => [x.label, x.ok])), margin: B.stats.margin };
  });
  t.log(st.stats.replace(/\n/g, ' | '));
  t.check(st.ok['Takes off from a runway'] && st.ok['Reaches orbit'] === false, 'mission check: flies, not to orbit');
  t.check(st.margin > 0 && !/Unstable/.test(st.stats) && !/Gear must/.test(st.stats), `stable (margin ${st.margin?.toFixed(2)}) with gear both sides of the centre of mass`);
  await t.shot('build-a-plane');
  // name it, save it, fly it
  await p.fill('#hb-name', 'Test Hawk');
  await p.dispatchEvent('#hb-name', 'change');
  await p.click('#hb-save');
  const saved = await t.eval(() => __sf.designs.some((d) => d.name === 'Test Hawk'));
  t.check(saved, 'saved as Test Hawk');
  const fly = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Test Hawk', { type: 'runway', airport: 'SFO', rw: '28R' });
    await __t.settle(4, { step: false });
    sf.flyTo(sf.places.search('LAX', 1)[0]);
    await __t.sim(150, { dt: 0.05, allowDead: true });
    return { h: sf.ship.env.agl, dead: sf.ship.dead, v: sf.ship.env.vSurf, ap: sf.controller.apStatus };
  });
  t.check(!fly.dead && fly.h > 300, `Test Hawk takes off on autopilot: ${fly.h.toFixed(0)} m, ${fly.v.toFixed(0)} m/s (${fly.ap})`);
  await t.eval(() => { __sf.designs = __sf.designs.filter((d) => d.name !== 'Test Hawk'); });
}
