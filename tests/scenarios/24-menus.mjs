// Clicking through the flight menus: plan a Moon transfer in the map and hand it to the autopilot, restart from
// the pause menu, crash and try again.
export const meta = { name: 'menus', fixtures: true, timeout: 400 };
export default async function (t) {
  const p = t.page;
  await t.eval(() => __t.start('Selene', { type: 'orbit', alt: 400000 }));
  await t.eval(() => { __t.resumeLoop(); });
  // the map: Go to the Moon → a planned burn → Autopilot
  await p.click('#h-map');
  await p.waitForSelector('#mapui.show');
  await p.click('#m-plan button:has-text("Go to the Moon")');
  await p.waitForFunction(() => !!__sf.controller.node, null, { timeout: 60000 });
  const node = await t.eval(() => ({ label: __sf.controller.node.label, dv: __sf.controller.node.dv.length(), panel: document.getElementById('m-node').innerText }));
  t.check(/Trans-lunar/.test(node.label) && node.dv > 2500 && node.dv < 3600 && /Δv/.test(node.panel), `map plans the transfer: ${node.label}, ${node.dv.toFixed(0)} m/s`);
  await p.click('#m-node button:has-text("Autopilot")');
  const ap = await t.eval(() => __sf.controller.ap && __sf.controller.ap.name);
  t.check(ap === 'Burn', `the burn is handed to the autopilot (${ap})`);
  await p.click('#m-back');
  await p.waitForSelector('#hud.show');
  // pause → restart flight
  await p.click('#h-menu');
  await p.waitForSelector('#pause.show');
  await p.click('#p-restart');
  await p.waitForFunction(() => __sf.state === 'hud' && __sf.ship && !__sf.controller.ap && !__sf.controller.node, null, { timeout: 60000 });
  const re = await t.eval(() => ({ h: __sf.ship.env.h, paused: __sf.paused }));
  t.check(!re.paused && Math.abs(re.h - 400000) < 20000, `restarted in orbit at ${(re.h / 1000).toFixed(0)} km`);
  // crash a jet into the sea and try again
  await t.eval(() => { __t.stopLoop(); });
  await t.eval(async () => {
    await __t.start('Kestrel', { type: 'air', lat: 37.0, lon: -123.5, alt: 1500, hdg: 90, speed: 200 });
    __t.inp.pitch = -1;
    await __t.sim(60, { allowDead: true, until: (sf) => sf.ship.dead });
    __t.inp.pitch = 0;
    __t.resumeLoop();
  });
  await p.waitForSelector('#crash.show', { timeout: 15000 });
  const why = await t.eval(() => document.getElementById('c-why').textContent);
  t.check(/water|ground/i.test(why), `crash screen: ${why}`);
  await p.click('#c-restart');
  await p.waitForFunction(() => __sf.state === 'hud' && __sf.ship && !__sf.ship.dead, null, { timeout: 60000 });
  const again = await t.eval(() => ({ h: __sf.ship.env.h, dead: __sf.ship.dead, crash: document.getElementById('crash').classList.contains('show') }));
  t.check(!again.dead && !again.crash && again.h > 500, `try again starts a fresh flight (${again.h.toFixed(0)} m)`);
}
