// Spaceplane and rocket ascents from SFO reach a real orbit.
export const meta = { name: 'ascent', slow: true };
export default async function (t) {
  for (const [design, type, rw] of [['Selene', 'runway', '28R'], ['Starhopper', 'pad', '28R']]) {
    await t.eval(({ design, type, rw }) => __t.start(design, { type, airport: 'SFO', rw }), { design, type, rw });
    await t.eval(() => __t.settle(8, { step: false }));     // let the airport's terrain stream in
    const r = await t.eval(async () => {
      const sf = __sf, C = await import('/src/ship/control.js');
      sf.engage(C.ascentAp());
      const res = await __t.sim(4000, { every: 20, log: (sf) => { const s = sf.ship; if (s.warp < 4 && s.env.agl > 300 && !/circ/.test(sf.controller.apStatus || '')) s.warp = 4; }, until: (sf) => !sf.controller.ap });
      return { ...__t.orbit(), dead: sf.ship.dead, status: sf.controller.status, res };
    });
    t.check(!r.dead && r.pe > 140, `${design} from ${type}: ${r.status} (${r.pe.toFixed(0)}×${r.ap.toFixed(0)} km)`);
  }
}
