// Airframe limits: assisted flight keeps a hard pull inside the wings' limit; in realistic mode a hard pull at
// high speed snaps them off; with the setting off they hold.
export const meta = { name: 'airframe-stress' };
export default async function (t) {
  const fly = (assist, stress) => t.eval(async ({ assist, stress }) => {
    const sf = __sf;
    sf.settings.assist = assist; sf.settings.stress = stress;
    await __t.start('Kestrel', { type: 'air', lat: 37.0, lon: -123.5, alt: 4000, hdg: 90, speed: 300 });
    const lim = sf.ship.craft.gLimit;
    __t.inp.pitch = 1; __t.inp.thr = 1; sf.controller.input.throttle = 1;
    let gMax = 0, lost = 0;
    await __t.sim(6, { dt: 0.02, every: 1, log: (sf) => { gMax = Math.max(gMax, sf.ship.gForce); }, allowDead: true });
    lost = sf.ship.craft.wings.filter((P) => P.alive === false).length + (sf.ship.craft.parts.length - sf.ship.craft.parts.filter((P) => P.alive).length > 0 ? 0 : 0);
    const broke = sf.ship.craft.parts.some((P) => P.wing && !P.alive);
    __t.inp.pitch = 0;
    sf.settings.assist = 'assisted'; sf.settings.stress = '1';
    return { lim, gMax, broke, dead: sf.ship.dead };
  }, { assist, stress });
  const a = await fly('assisted', '1');
  t.check(isFinite(a.lim) && a.lim > 6 && a.lim < 14, `Kestrel's wings break at ${a.lim.toFixed(1)} g`);
  t.check(!a.broke && a.gMax < a.lim, `assisted: a full pull holds ${a.gMax.toFixed(1)} g, wings intact`);
  const r = await fly('realistic', '1');
  t.check(r.broke, `realistic: a full pull at 300 m/s overstresses the wings (${r.gMax.toFixed(1)} g)`);
  const o = await fly('realistic', '0');
  t.check(!o.broke, `with airframe limits off the wings hold (${o.gMax.toFixed(1)} g)`);
  // the hangar shows the limit
  const h = await t.eval(async () => { await __sf.openHangar(); __sf.builder.setDesign(JSON.parse(JSON.stringify(__sf.shipList().find((d) => d.name === 'Kestrel')))); return document.getElementById('hb-stats').innerText; });
  t.check(/Wings break at\s+[\d.]+ g/.test(h), 'hangar shows the wing limit');
}
