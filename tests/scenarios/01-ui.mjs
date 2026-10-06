// Every menu screen opens without errors; the hangar builds the presets.
export const meta = { name: 'ui-screens' };
export default async function (t) {
  const p = t.page;
  await t.shot('ui-title');
  await p.click('#t-fly');
  await p.waitForTimeout(500);
  for (const mode of ['runway', 'hangar', 'pad', 'special']) {
    await p.click(`#l-tabs .tab[data-mode="${mode}"]`);
    await p.waitForTimeout(300);
    const n = await p.evaluate(() => document.querySelectorAll('#l-list .it').length);
    t.check(n > 0, `launch tab ${mode} lists sites (${n})`);
  }
  await p.fill('#l-q', 'Tokyo');
  await p.waitForTimeout(300);
  t.check(await p.evaluate(() => /Tokyo/i.test(document.getElementById('l-list').innerText)), 'search finds Tokyo');
  await t.eval(() => __sf.toTitle());
  await p.click('#t-log');
  t.check(await p.evaluate(() => document.querySelectorAll('#lb-list .ach').length) >= 20, 'logbook lists milestones');
  await t.eval(() => __sf.modal('logbook', false));
  await p.click('#t-settings');
  t.check(await p.evaluate(() => document.querySelectorAll('#settings .seg button.on').length) >= 8, 'settings show current values');
  await t.eval(() => __sf.modal('settings', false));
  await p.click('#t-help');
  t.check(await p.evaluate(() => document.getElementById('help-body').innerText.length) > 2000, 'help text');
  await t.eval(() => __sf.modal('help', false));
  await p.click('#t-hangar');
  await p.waitForFunction(() => __sf.builder && __sf.state === 'hangar', null, { timeout: 30000 });
  for (const name of ['Kestrel', 'Selene', 'Lynx VTOL', 'Starhopper']) {
    const r = await t.eval((name) => { const d = __sf.shipList().find((x) => x.name === name); __sf.builder.setDesign(d); return { parts: __sf.builder.craft.parts.length, stats: document.getElementById('hb-stats').innerText }; }, name);
    t.check(r.parts > 5 && /Mass/.test(r.stats), `hangar builds ${name} (${r.parts} parts)`);
  }
  await t.shot('ui-hangar');
}
