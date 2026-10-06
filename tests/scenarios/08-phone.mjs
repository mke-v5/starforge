// Phone portrait and landscape layouts: nothing overflows the screen, the flight HUD fits.
export const meta = { name: 'phone-layout', viewport: { width: 390, height: 844 }, context: { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } };
export default async function (t) {
  const overflow = () => t.eval(() => {
    const bad = [];
    for (const el of document.querySelectorAll('.screen.show button, .screen.show .panel, .screen.show .ro, #hud.show *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) bad.push((el.id || el.className || el.tagName) + ` ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return bad.slice(0, 8);
  });
  // the main HUD blocks must not sit on top of each other
  const overlap = () => t.eval(() => {
    const ids = ['.topbar .readouts', '.topbar .warp', '#h-info', '#h-orbit', '#h-ap', '.ctl-left', '.ctl-right', '#h-sas', '#navball-slot', '.topbar .icon-btn'];
    const boxes = [];
    for (const sel of ids) for (const el of document.querySelectorAll('#hud ' + sel)) {
      if (el.closest('[hidden]') || getComputedStyle(el).display === 'none') continue;
      const r = el.getBoundingClientRect(); if (r.width && r.height) boxes.push([sel, r]);
    }
    const bad = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, A] = boxes[i], [b, B] = boxes[j];
      if (a === b) continue;
      if (A.left < B.right - 1 && B.left < A.right - 1 && A.top < B.bottom - 1 && B.top < A.bottom - 1) bad.push(a + ' × ' + b);
    }
    return bad;
  });
  await t.shot('phone-portrait-title');
  t.check(!(await overflow()).length, `title fits portrait ${(await overflow()).join(' | ')}`);
  await t.eval(() => __t.start('Kestrel', { type: 'runway', airport: 'SFO', rw: '28R' }));
  await t.eval(() => __t.settle(3));
  await t.shot('phone-portrait-hud');
  const o = await overflow();
  t.check(!o.length, `flight HUD fits portrait ${o.join(' | ')}`);
  const ov = await overlap();
  t.check(!ov.length, `HUD blocks don't overlap in portrait ${ov.join(', ')}`);
  // in orbit, with the orbit bar and an autopilot showing
  await t.eval(async () => { await __t.start('Selene', { type: 'orbit', alt: 400000 }); const C = await import('/src/ship/control.js'); __sf.engage(C.waitAp('Test', () => false, (s) => s.t + 9999)); });
  await t.eval(() => __t.settle(2));
  await t.shot('phone-portrait-orbit');
  const ov2 = await overlap();
  t.check(!ov2.length, `HUD blocks don't overlap in orbit (portrait) ${ov2.join(', ')}`);
  await t.page.setViewportSize({ width: 844, height: 390 });
  await t.eval(() => __t.settle(1.5));
  await t.shot('phone-landscape-hud');
  const o2 = await overflow();
  t.check(!o2.length, `flight HUD fits landscape ${o2.join(' | ')}`);
  const ov3 = await overlap();
  t.check(!ov3.length, `HUD blocks don't overlap in landscape ${ov3.join(', ')}`);
}
