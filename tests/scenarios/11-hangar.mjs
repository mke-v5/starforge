// Hangar mission check (what each preset can do) and share codes: round trip, bad codes, a shared link.
export const meta = { name: 'hangar-share' };
export default async function (t) {
  const p = t.page;
  await p.click('#t-hangar');
  await p.waitForFunction(() => __sf.builder && __sf.state === 'hangar', null, { timeout: 30000 });
  const verdicts = await t.eval(() => {
    const out = {};
    for (const d of __sf.shipList()) {
      __sf.builder.setDesign(JSON.parse(JSON.stringify(d)));
      const m = __sf.builder.stats.mission;
      out[d.name] = Object.fromEntries(m.list.map((x) => [x.label, x.ok]));
      out[d.name]._html = document.querySelectorAll('#hb-stats .mc-row').length;
    }
    return out;
  });
  const v = (ship, label) => verdicts[ship] && verdicts[ship][label];
  t.check(v('Kestrel', 'Takes off from a runway') && v('Kestrel', 'Reaches orbit') === false, 'Kestrel: flies, can’t reach orbit');
  t.check(v('Lynx VTOL', 'Takes off vertically') && v('Lynx VTOL', 'Reaches orbit') === false, 'Lynx: takes off vertically, can’t reach orbit');
  t.check(v('Selene', 'Reaches orbit') && v('Selene', 'Docks at Meridian Station') && v('Selene', 'Lands on the Moon and comes home'), 'Selene: orbit, station, Moon and back');
  t.check(v('Starhopper', 'Lifts off its pad') && v('Starhopper', 'Reaches orbit') && v('Starhopper', 'Docks at Meridian Station') && v('Starhopper', 'Lands on the Moon and comes home'), 'Starhopper: orbit, station, Moon and back');
  t.check(verdicts.Selene._html >= 5, `mission check is shown (${verdicts.Selene._html} rows)`);
  t.log(JSON.stringify(verdicts));

  // share code round trip
  const rt = await t.eval(async () => {
    const S = await import('/src/core/share.js');
    const d = __sf.shipList().find((x) => x.name === 'Selene');
    const code = await S.encodeDesign(d);
    const back = await S.decodeDesign(code);
    const same = back.parts.length === d.parts.length && back.parts.every((q, i) => q.id === d.parts[i].id && q.p.every((v, k) => Math.abs(v - d.parts[i].p[k]) < 2e-3) && q.sym === d.parts[i].sym && q.parent === d.parts[i].parent);
    const fromLink = await S.decodeDesign(S.shareLink(code));
    const bad = [];
    for (const c of ['hello', 'SF1.AAAA', 'SF0.' + btoa(JSON.stringify({ n: 'x', p: [['no-such-part', 0, 0, 0, 0, 0, 0, 1, 0, -1, -1]] })), 'SF0.' + btoa('{"p":[]}')]) {
      try { await S.decodeDesign(c); bad.push('accepted: ' + c.slice(0, 12)); } catch (e) { /* expected */ }
    }
    return { len: code.length, same, link: fromLink.parts.length === d.parts.length, bad, code };
  });
  t.check(rt.same && rt.link, `share code round trip (${rt.len} chars)`);
  t.check(rt.len < 2500, `share code is short enough to paste (${rt.len} chars)`);
  t.check(!rt.bad.length, `bad codes are rejected ${rt.bad.join(', ')}`);

  // import through the dialog flow
  const imp = await t.eval(async (code) => {
    const ok = await __sf.builder.importCode(code);
    return { ok, name: __sf.builder.design.name, saved: __sf.designs.some((d) => d.name === __sf.builder.design.name), parts: __sf.builder.craft.parts.length };
  }, rt.code);
  t.check(imp.ok && imp.name === 'Selene (2)' && imp.saved && imp.parts > 20, `imported as “${imp.name}” and saved`);

  // open a shared link in a fresh page
  const page2 = await t.ctx.newPage();
  page2.on('pageerror', (e) => t.errors.push(`[pageerror] ${e.message}`));
  await page2.goto(t.base + '/index.html#ship=' + rt.code);
  await page2.waitForFunction(() => window.__sf && __sf.state === 'hangar' && __sf.builder && __sf.builder.craft && __sf.builder.craft.parts.length > 20, null, { timeout: 90000 });
  const l = await page2.evaluate(() => ({ name: __sf.builder.design.name, hash: location.hash }));
  t.check(/^Selene \(\d\)$/.test(l.name) && !l.hash, `a shared link opens the hangar with the ship (${l.name})`);
  await page2.close();
  await t.shot('hangar-mission');
}
