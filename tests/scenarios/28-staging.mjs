// Staging: Vesta's boosters drain first and drop, then the core; each dropped stage falls away in one piece
// while the ship carries on without a jump; the ascent autopilot stages by itself on the way to orbit.
export const meta = { name: 'staging', fixtures: true, timeout: 900 };
export default async function (t) {
  const h = await t.eval(async () => {
    const sf = __sf, { Craft } = await import('/src/ship/craft.js'), O = await import('/src/ship/orbit.js'), V = await import('/src/builder/verdict.js');
    const d = sf.shipList().find((x) => x.name === 'Vesta');
    const c = new Craft(d);
    const dv = O.deltaV(c);
    const m = V.missionCheck(c, d);
    const T = c.engines.reduce((a, P) => a + c.engineOutput(P, { rho: 1.225, p: 101325, mach: 0, h: 0, a: 340 })[0], 0);
    c.dispose && c.dispose();
    return { groups: c.stageGroups.map((g) => g.map((P) => P.def.id)), dv, per: c.stageDv, twr: T / (c.mass * 9.81), mass: c.mass, orbit: m && m.list.find((x) => /orbit/.test(x.label)) };
  });
  t.log(JSON.stringify(h));
  t.check(h.groups.length === 2 && h.groups[0].every((id) => id === 'dc-radial') && h.groups[0].length === 2 && h.groups[1][0] === 'dc-sep-m', `stage order: boosters, then core (${h.groups.map((g) => g.join('+')).join(' → ')})`);
  t.check(h.per && h.per.length === 3 && h.per.every((x) => x > 300) && h.dv > 9000, `staged Δv ${Math.round(h.dv)} m/s (${h.per && h.per.map(Math.round).join(' + ')})`);
  t.check(h.twr > 1.3 && h.orbit && h.orbit.ok, `lifts off at TWR ${h.twr.toFixed(2)}, mission check says it reaches orbit`);

  // by hand: full throttle off the pad, the boosters' tanks drain first; STAGE drops them
  const f = await t.eval(async () => {
    const sf = __sf;
    await __t.start('Vesta', { type: 'pad', airport: 'SFO', rw: '28R' });
    await __t.sim(1, { dt: 0.02 });
    sf.controller.setSas('hold');
    sf.controller.input.throttle = 1;
    await __t.sim(25, { dt: 0.02 });
    const c = sf.craft, fuel = (pred) => c.parts.filter((P) => P.alive && pred(P)).reduce((a, P) => a + (P.res.LF ? P.res.LF.amt + P.res.OX.amt : 0), 0);
    const cap = (pred) => c.parts.filter((P) => P.alive && pred(P)).reduce((a, P) => a + (P.res.LF ? P.res.LF.cap + P.res.OX.cap : 0), 0);
    const boost = fuel((P) => P.stage === 1) / cap((P) => P.stage === 1), core = fuel((P) => P.stage === 2) / cap((P) => P.stage === 2);
    const n0 = c.parts.filter((P) => P.alive).length, m0 = c.mass, h0 = sf.ship.env.agl;
    // a frame either side of staging: the ship moves on smoothly
    const r0 = sf.ship.r.clone(), v0 = sf.ship.v.clone();
    sf.stageNow();
    const jump = sf.ship.r.distanceTo(r0), dvSep = sf.ship.v.distanceTo(v0);
    await __t.sim(0.1, { dt: 0.02 });
    const n1 = c.parts.filter((P) => P.alive).length, m1 = c.mass, drops = sf.dropped.length;
    await __t.sim(8, { dt: 0.02 });
    const D = sf.dropped[0], gap = D ? D.p.distanceTo(sf.ship.r) : 0;
    return { boost, core, n0, n1, m0, m1, drops, jump, dvSep, h0, gap, left: c.stagesLeft, dead: sf.ship.dead, toast: document.getElementById('toast') ? document.getElementById('toast').textContent : '' };
  });
  t.log(JSON.stringify(f));
  t.check(!f.dead && f.h0 > 500, `off the pad (${f.h0.toFixed(0)} m after 25 s)`);
  t.check(f.boost < 0.75 && f.core > 0.97, `boosters burn first: boosters ${(f.boost * 100).toFixed(0)} %, core ${(f.core * 100).toFixed(1)} % full`);
  t.check(f.n1 === f.n0 - 6 && f.m1 < f.m0 * 0.75 && f.drops === 1 && f.left === 1, `STAGE drops both boosters as one falling stage (${f.n0} → ${f.n1} parts, ${(f.m0 / 1000).toFixed(0)} → ${(f.m1 / 1000).toFixed(0)} t)`);
  t.check(f.jump < 3 && f.dvSep < 3, `the ship carries on without a jump (${f.jump.toFixed(2)} m, ${f.dvSep.toFixed(2)} m/s)`);
  t.check(f.gap > 30, `the spent boosters fall away (${f.gap.toFixed(0)} m behind after 8 s)`);
  await t.eval(() => __t.settle(1, { step: false }));
  await t.shot('staging-boosters');

  // the ascent autopilot stages by itself and reaches orbit
  const a = await t.eval(async () => {
    const sf = __sf, C = await import('/src/ship/control.js');
    await __t.start('Vesta', { type: 'pad', airport: 'SFO', rw: '28R' });
    await __t.sim(1, { dt: 0.02 });
    sf.engage(C.ascentAp());
    const staged = [];
    const res = await __t.sim(3000, { every: 10, log: (sf) => { const s = sf.ship; if (staged[staged.length - 1] !== sf.craft.stagesLeft) staged.push(sf.craft.stagesLeft); if (s.warp < 4 && s.env.agl > 300 && !/circ/i.test(sf.controller.status || '')) s.warp = 4; }, until: (sf) => !sf.controller.ap || sf.ship.dead, allowDead: true });
    return { ...__t.orbit(), staged, left: sf.craft.stagesLeft, dead: sf.ship.dead, status: sf.controller.status, res, dv: sf.hud ? null : null };
  });
  t.log(JSON.stringify(a));
  t.check(!a.dead && a.left === 0 && a.staged.includes(1), `autopilot staged on the way up (stages left: ${a.staged.join(' → ')})`);
  t.check(!a.dead && a.pe > 140, `Vesta in orbit: ${a.status} (${a.pe.toFixed(0)}×${a.ap.toFixed(0)} km)`);
}
