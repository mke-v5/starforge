// Phone touch controls in the real game loop: drag the throttle slider up, pull the stick back and the jet
// rotates and climbs; let go and the stick re-centres.
export const meta = { name: 'touch-controls', viewport: { width: 844, height: 390 }, context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, fixtures: true, timeout: 300 };
export default async function (t) {
  const p = t.page;
  await t.eval(() => __t.start('Kestrel', { type: 'runway', airport: 'SFO', rw: '28R' }));
  await t.eval(() => { __t.resumeLoop(); });
  const box = async (sel) => p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }, sel);
  // throttle: drag from the bottom of the slider to the top
  const th = await box('#thr');
  await p.mouse.move(th.x + th.w / 2, th.y + th.h - 4);
  await p.mouse.down();
  await p.mouse.move(th.x + th.w / 2, th.y + th.h * 0.5, { steps: 5 });
  await p.mouse.move(th.x + th.w / 2, th.y + 2, { steps: 5 });
  await p.mouse.up();
  const thr = await t.eval(() => __sf.controller.input.throttle);
  t.check(thr > 0.95, `throttle slider to full: ${thr.toFixed(2)}`);
  // the take-off roll, fast-forwarded (in real time it crawls on a busy machine), then back to the live loop
  await t.eval(async () => { await __t.sim(90, { dt: 0.05, until: (sf) => sf.ship.env.vSurf > 75 || sf.ship.dead, allowDead: true }); __t.resumeLoop(); });
  await p.waitForFunction(() => __sf.ship.env.vSurf > 75 || __sf.ship.dead, null, { timeout: 120000 });
  // pull the stick back (down on the screen) and hold
  const st = await box('#stick');
  await p.mouse.move(st.x + st.w / 2, st.y + st.h / 2);
  await p.mouse.down();
  await p.mouse.move(st.x + st.w / 2, st.y + st.h * 0.85, { steps: 4 });
  const held = await t.eval(() => ({ pitch: __sf.controller.input.pitch, knob: document.getElementById('knob').style.transform }));
  await p.waitForFunction(() => (__sf.ship.contacts === 0 && __sf.ship.env.agl > 20) || __sf.ship.dead, null, { timeout: 30000 });
  await p.mouse.up();
  await p.waitForFunction(() => Math.abs(__sf.controller.input.pitch) < 0.05, null, { timeout: 10000 }).catch(() => {});
  const after = await t.eval(() => ({ pitch: __sf.controller.input.pitch, knob: document.getElementById('knob').style.transform, agl: __sf.ship.env.agl, dead: __sf.ship.dead }));
  t.check(held.pitch > 0.3 && /translate\(0px, \d/.test(held.knob), `stick pulled back: pitch ${held.pitch.toFixed(2)} (${held.knob})`);
  t.check(!after.dead && after.agl > 20, `lifted off (${after.agl.toFixed(0)} m)`);
  t.check(Math.abs(after.pitch) < 0.05 && /translate\(0(px)?, ?0(px)?\)/.test(after.knob), `stick re-centres on release (${after.knob}, pitch ${after.pitch.toFixed(3)})`);
  await t.shot('touch-takeoff');
}
