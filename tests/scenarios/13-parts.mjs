// New parts: every part builds a model; the ion drive runs on xenon and reactor power (and stalls without it);
// the afterburner adds thrust; a lifting body lifts; a heat shield's ablator burns away on reentry.
export const meta = { name: 'parts', timeout: 600 };
export default async function (t) {
  const all = await t.eval(async () => {
    const P = await import('/src/ship/parts.js'), M = await import('/src/ship/meshes.js');
    const mats = M.makeMaterials({ hull: '#dddddd', accent: '#ffb347' });
    const bad = [];
    for (const def of P.PARTS) { try { const g = M.buildPartMesh(def, mats); let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); if (!n) bad.push(def.id + ': empty'); } catch (e) { bad.push(def.id + ': ' + e.message); } }
    const ids = ['ck-bastion', 'xe-s2', 'lb-m6', 'en-raptor', 'en-ion', 'gr-skid', 'ae-needle-s', 'ae-blunt-m', 'ut-reactor', 'ut-fusioncore'];
    return { bad, missing: ids.filter((id) => !P.PART[id]), n: P.PARTS.length };
  });
  t.check(!all.bad.length && !all.missing.length, `all ${all.n} parts build models ${all.bad.join('; ')} ${all.missing.join(',')}`);

  // register test designs
  await t.eval(async () => {
    const D = await import('/src/ship/designs.js');
    const mk = (name, ids, vertical, extra) => { const b = new D.DesignBuilder(name, { hull: '#d0d4da', accent: '#7fd4ff' }, { vertical }); b.chain(ids); if (extra) extra(b); return b.done(); };
    const rad = (b) => b.pair('ut-radiator', [0.7, 0.6, 5], D.Q_FWD, 1);
    __sf.designs.push(
      mk('T-ion', ['ck-bastion', 'ut-fusioncore', 'fu-m3', 'xe-s2', 'en-ion'], true, rad),
      mk('T-ion-batt', ['ck-aurora', 'xe-s2', 'en-ion'], true),
      mk('T-capsule', ['ck-aurora', 'ut-shield-m'], true),
      mk('T-body', ['ck-horizon', 'lb-m6', 'en-comet'], false),
    );
    const k = JSON.parse(JSON.stringify(__sf.shipList().find((d) => d.name === 'Kestrel')));
    k.name = 'T-raptor'; for (const p of k.parts) if (p.id === 'en-swift') p.id = 'en-raptor';
    __sf.designs.push(k);
  });

  // ion drive on a fusion core
  const ion = await t.eval(async () => {
    const sf = __sf;
    await __t.start('T-ion', { type: 'orbit', alt: 400000 });
    sf.controller.setSas('prograde');
    const v0 = sf.ship.v.length(), xe0 = sf.ship.craft.amount('XE'), fu0 = sf.ship.craft.amount('FU');
    __t.inp.thr = 0; sf.controller.input.throttle = 1;
    await __t.sim(60, { dt: 0.05 });
    const c = sf.ship.craft, P = c.engines[0];
    const r = { dv: sf.ship.v.length() - v0, xe: xe0 - c.amount('XE'), fu: fu0 - c.amount('FU'), ec: c.ec / c.ecCap, thrust: P.eng.thrust, starved: !!P.eng.starved };
    __t.inp.thr = 0; sf.controller.input.throttle = 0;
    return r;
  });
  t.check(ion.thrust > 10000 && ion.dv > 30 && ion.xe > 0.5 && !ion.starved, `ion drive on reactor power: +${ion.dv.toFixed(1)} m/s in 60 s, ${ion.xe.toFixed(1)} kg xenon, thrust ${(ion.thrust / 1000).toFixed(1)} kN, charge ${(ion.ec * 100).toFixed(0)}%`);
  t.check(ion.fu > 0 && ion.fu < 1, `the fusion core burns a trickle of pellets (${ion.fu.toFixed(3)} kg)`);

  const batt = await t.eval(async () => {
    const sf = __sf;
    await __t.start('T-ion-batt', { type: 'orbit', alt: 400000 });
    __t.inp.thr = 0; sf.controller.input.throttle = 1;
    await __t.sim(240, { dt: 0.05 });
    const c = sf.ship.craft, P = c.engines[0];
    sf.hudExtras(1); sf.hud.update(1, sf.ship, sf.controller, sf.extra);
    const r = { ec: c.ec, thrust: P.eng.thrust, starved: !!P.eng.starved, warn: document.getElementById('h-warn') ? document.getElementById('h-warn').innerText : '' };
    __t.inp.thr = 0; sf.controller.input.throttle = 0;
    return r;
  });
  t.check(batt.starved && batt.thrust < 2000, `on batteries alone the ion drive stalls when they run flat (thrust ${batt.thrust.toFixed(0)} N, charge ${batt.ec.toFixed(1)} kWh)`);
  t.log('warnings:', batt.warn);

  // afterburner
  const ab = await t.eval(async () => {
    const sf = __sf;
    await __t.start('T-raptor', { type: 'air', lat: 37.0, lon: -123.5, alt: 4000, hdg: 90, speed: 250 });
    const P = sf.ship.craft.engines[0];
    __t.inp.thr = 0; sf.controller.input.throttle = 0.85;
    await __t.sim(4, { dt: 0.02 });
    const dry = P.eng.thrust, thrDry = [sf.ship.ctl.throttle, P.eng.thr, P.eng.ab];
    __t.inp.thr = 0; sf.controller.input.throttle = 1;
    await __t.sim(4, { dt: 0.02 });
    const r = { dry, wet: P.eng.thrust, ab: P.eng.ab, thr: sf.ship.ctl.throttle, thrDry };
    sf.controller.input.throttle = 0.5;
    return r;
  });
  t.log(JSON.stringify(ab));
  t.check(ab.ab > 0.9 && ab.wet > ab.dry * 1.6, `afterburner: ${(ab.dry / 1000).toFixed(0)} kN at 85 % → ${(ab.wet / 1000).toFixed(0)} kN lit`);

  // lifting body
  const lb = await t.eval(async () => {
    const { Craft } = await import('/src/ship/craft.js'), THREE = await import('three');
    const d = __sf.shipList().find((x) => x.name === 'T-body');
    const c = new Craft(d, { visual: false });
    const env = { rho: 0.7, p: 50000, mach: 0.6, T: 260, a: 320, h: 5000 };
    const a = 8 * Math.PI / 180, V = 200;
    const vb = new THREE.Vector3(0, -Math.sin(a) * V, -Math.cos(a) * V);     // flow from ahead and below (body: -Z nose, +Y up)
    const F = new THREE.Vector3(), T = new THREE.Vector3();
    c.aero(vb, new THREE.Vector3(), env, F, T);
    return { lift: F.y, drag: F.z, wings: c.wings.length, gLimit: c.gLimit, mass: c.mass };
  });
  t.check(lb.wings === 1 && lb.lift > 0 && lb.lift / lb.drag > 2, `a wingless lifting body lifts: L/D ${(lb.lift / lb.drag).toFixed(1)} at 8° (${(lb.lift / 1000).toFixed(0)} kN)`);

  // ablator wear on reentry
  const ab2 = await t.eval(async () => {
    const sf = __sf, THREE = await import('three');
    await __t.start('T-capsule', { type: 'orbit', alt: 140000 });
    const s = sf.ship;
    s.v.multiplyScalar(0.985);                         // periapsis well inside the air
    sf.controller.setSas('retrograde');
    const shield = s.craft.parts.find((P) => P.def.id === 'ut-shield-m');
    const a0 = shield.res.ABL.amt;
    let peakT = 0;
    await __t.sim(1500, { dt: 0.05, every: 10, log: (sf) => { peakT = Math.max(peakT, shield.temp); }, until: (sf) => sf.ship.env.h < 25000 || sf.ship.dead, allowDead: true });
    return { a0, a1: shield.res.ABL.amt, peakT, dead: s.dead, alive: shield.alive, h: s.env.h, v: s.env.vSurf };
  });
  t.check(!ab2.dead && ab2.alive && ab2.a1 < ab2.a0 - 1, `reentry burns ablator: ${ab2.a0.toFixed(0)} → ${ab2.a1.toFixed(0)} kg (shield peak ${ab2.peakT.toFixed(0)} K, now ${(ab2.h / 1000).toFixed(0)} km at ${ab2.v.toFixed(0)} m/s)`);

  // swing wing: straight when slow, swept back at speed (lift moves aft, transonic drag drops)
  const sw = await t.eval(async () => {
    const sf = __sf, D = await import('/src/ship/designs.js');
    const k = JSON.parse(JSON.stringify(__sf.shipList().find((d) => d.name === 'Kestrel')));
    k.name = 'T-swing'; for (const p of k.parts) if (p.id === 'wg-swept') { p.id = 'wg-swing'; delete p.w; }
    sf.designs.push(k);
    await __t.start('T-swing', { type: 'air', lat: 37.0, lon: -123.5, alt: 9000, hdg: 90, speed: 340 });
    const W = sf.ship.craft.wings.find((P) => P.def.id === 'wg-swing').wing;
    const slow = { k: W.k, ar: W.ar };
    sf.controller.input.throttle = 1;
    await __t.sim(12, { dt: 0.05 });
    const P = sf.ship.craft.wings.find((P) => P.def.id === 'wg-swing');
    return { slow, fast: { k: P.wing.k, ar: P.wing.ar, mach: sf.ship.env.mach, rot: P.swingObj.rotation.z } };
  });
  t.check(sw.slow.k < 0.05 && sw.fast.k > 0.8 && sw.fast.ar < sw.slow.ar && sw.fast.rot < -0.5, `swing wing sweeps back at Mach ${sw.fast.mach.toFixed(2)} (k ${sw.fast.k.toFixed(2)}, model turned ${(-sw.fast.rot * 57.3).toFixed(0)}°)`);

  // cryo hydrogen boils off; an antimatter cell without power lets go; with a reactor it holds; the torch pushes
  const am = await t.eval(async () => {
    const sf = __sf, D = await import('/src/ship/designs.js');
    const mk = (name, ids, extra) => { const b = new D.DesignBuilder(name, { hull: '#d0d4da', accent: '#ff5fd8' }, { vertical: true }); b.chain(ids); if (extra) extra(b); return b.done(); };
    const rads = (b) => { for (const z of [4, 8]) b.pair('ut-radiator', [0.7, 0.6, z], D.Q_FWD, 1); };
    sf.designs.push(mk('T-am-batt', ['ck-aurora', 'am-cell', 'cr-m6', 'en-hydra']), mk('T-am', ['ck-bastion', 'ut-fusioncore', 'fu-m3', 'am-cell', 'cr-m6', 'en-ember'], rads));
    await __t.start('T-am-batt', { type: 'orbit', alt: 400000 });
    const lh0 = sf.ship.craft.amount('LH2'), tA = sf.ship.t;
    sf.ship.warp = 1000;
    await __t.sim(86400, { dt: 0.05, allowDead: true, until: (sf) => sf.ship.dead });
    const r1 = { dead: sf.ship.dead, t: sf.ship.t - tA, lh: lh0 - sf.ship.craft.amount('LH2'), cell: sf.ship.craft.parts.find((P) => P.def.id === 'am-cell').alive };
    await __t.start('T-am', { type: 'orbit', alt: 400000 });
    const lh1 = sf.ship.craft.amount('LH2');
    sf.ship.warp = 1000;
    await __t.sim(86400, { dt: 0.05, allowDead: true, until: (sf) => sf.ship.dead });
    const r2 = { dead: sf.ship.dead, boil: (lh1 - sf.ship.craft.amount('LH2')) / lh1 };
    sf.ship.warp = 1; sf.controller.setSas('prograde');
    const v0 = sf.ship.v.length(), am0 = sf.ship.craft.amount('AM');
    sf.controller.input.throttle = 1;
    await __t.sim(20, { dt: 0.05, allowDead: true });
    const E = sf.ship.craft.engines.find((P) => P.def.id === 'en-ember');
    const r3 = { thrust: E.eng.thrust, dv: sf.ship.v.length() - v0, am: am0 - sf.ship.craft.amount('AM'), dead: sf.ship.dead };
    sf.controller.input.throttle = 0;
    return { r1, r2, r3 };
  });
  t.check(am.r1.dead && !am.r1.cell, `an antimatter cell on batteries alone fails after ${(am.r1.t / 60).toFixed(0)} min`);
  t.check(!am.r2.dead && am.r2.boil > 0.003 && am.r2.boil < 0.008, `with a fusion core it holds for a day; ${(am.r2.boil * 100).toFixed(2)} % of the hydrogen boiled off`);
  t.check(!am.r3.dead && am.r3.thrust > 400000 && am.r3.dv > 100 && am.r3.am > 0 && am.r3.am < 0.1, `the Ember torch: ${(am.r3.thrust / 1000).toFixed(0)} kN, +${am.r3.dv.toFixed(0)} m/s in 20 s on ${(am.r3.am * 1000).toFixed(1)} g of antimatter`);

  // paint: decals and glow trim survive a share code
  const pc = await t.eval(async () => {
    const S = await import('/src/core/share.js');
    const d = JSON.parse(JSON.stringify(__sf.shipList().find((x) => x.name === 'Selene')));
    d.colors.pattern = 'hazard'; d.colors.glow = true;
    const back = await S.decodeDesign(await S.encodeDesign(d));
    return back.colors;
  });
  t.check(pc.pattern === 'hazard' && pc.glow === true, `decals and glow trim travel in share codes (${JSON.stringify(pc)})`);

  await t.eval(() => { __sf.designs = __sf.designs.filter((d) => !/^T-/.test(d.name)); });
}
