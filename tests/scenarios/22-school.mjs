// Flight school, flown like a player would: throttle up, rotate, gear up, climb, level off, turn, wings level,
// look at the map, then AUTO → Land at… and watch it land. Every lesson must advance.
export const meta = { name: 'flight-school', fixtures: true, timeout: 600 };
export default async function (t) {
  await t.page.click('#t-school');
  await t.page.waitForFunction(() => __sf.state === 'hud' && __sf.tutorial && __sf.tutorial.active && __sf.ship, null, { timeout: 60000 });
  await t.eval(() => __t.settle(5, { step: false }));
  const lesson = () => t.eval(() => __sf.tutorial.i);
  const until = (fn, secs, o = {}) => t.eval(async ({ fn, secs, o }) => {
    const f = new Function('sf', 'return ' + fn);
    await __t.sim(secs, { dt: 0.05, ...o, until: (sf) => f(sf) || sf.ship.dead, allowDead: true });
    return { i: __sf.tutorial.i, dead: __sf.ship.dead };
  }, { fn, secs, o });
  const inp = (o) => t.eval((o) => Object.assign(__t.inp, o), o);
  const log = [];
  // 1 full power
  await inp({ thr: 1 });
  let r = await until('sf.tutorial.i >= 1', 10); log.push(`throttle → lesson ${r.i}`);
  // 2 take off: roll, rotate at ~75 m/s
  r = await until('sf.ship.env.vSurf > 72', 60);
  await inp({ pitch: 0.45 });
  r = await until('sf.ship.contacts === 0 && sf.ship.env.agl > 30', 20);
  await inp({ pitch: 0 });
  r = await until('sf.tutorial.i >= 2', 5); log.push(`take-off → lesson ${r.i}`);
  // 3 gear up
  await t.eval(() => __sf.action('gear'));
  r = await until('sf.tutorial.i >= 3', 5); log.push(`gear → lesson ${r.i}`);
  // 4 climb to 1,000 m on the held climb angle
  r = await until('sf.tutorial.i >= 4', 240); log.push(`climb → lesson ${r.i}`);
  // 5 level off and throttle back
  await inp({ pitch: -0.3 });
  r = await until('Math.abs(sf.ship.env.vVert) < 3', 30);
  await inp({ pitch: 0, thr: -1 });
  await until('sf.ship.ctl.throttle < 0.62', 5);
  await inp({ thr: 0 });
  r = await until('sf.tutorial.i >= 5', 30); log.push(`level → lesson ${r.i}`);
  // 6 turn 60°
  await inp({ roll: 0.6 });
  await until('false', 1.5);
  await inp({ roll: 0 });
  r = await until('sf.tutorial.i >= 6', 120); log.push(`turn → lesson ${r.i}`);
  // 7 wings level: roll back until level, then let go
  await inp({ roll: -0.6 });
  await until('Math.abs(Math.atan2(-new (sf.ship.r.constructor)(1,0,0).applyQuaternion(sf.ship.q).dot(sf.ship.env.up), new (sf.ship.r.constructor)(0,1,0).applyQuaternion(sf.ship.q).dot(sf.ship.env.up))) < 0.08', 10);
  await inp({ roll: 0 });
  r = await until('sf.tutorial.i >= 7', 20); log.push(`wings level → lesson ${r.i}`);
  // 8 the map, open and back
  await t.eval(() => { __sf.toggleMap(); });
  await until('false', 1);
  await t.eval(() => { __sf.toggleMap(); });
  r = await until('sf.tutorial.i >= 8', 5); log.push(`map → lesson ${r.i}`);
  // 9 AUTO → Land at …
  const opt = await t.eval(() => { __sf.action('auto'); const b = [...document.querySelectorAll('#d-btns button')].find((x) => /^Land at /.test(x.textContent)); if (b) b.click(); return b ? b.textContent : null; });
  r = await until('sf.tutorial.i >= 9', 5); log.push(`${opt} → lesson ${r.i}`);
  // 10 the landing
  await t.eval(() => { __sf.ship.warp = 4; });
  r = await until('sf.tutorial.i >= 10', 1500); log.push(`landed → lesson ${r.i}`);
  for (const l of log) t.log(l);
  const n = await t.eval(() => __sf.tutorial.steps.length);
  t.check(!r.dead && r.i === n - 1, `flight school completed: lesson ${r.i + 1} of ${n} (${log.join('; ')})`);
  await t.shot('flight-school');
}
