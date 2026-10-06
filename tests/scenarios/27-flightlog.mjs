// The flight log: a short jet flight and a crash are written to the logbook with their peaks and outcome, and the
// map draws the track flown.
export const meta = { name: 'flight-log', fixtures: true, timeout: 300 };
export default async function (t) {
  const r = await t.eval(async () => {
    const sf = __sf;
    localStorage.removeItem('starforge.flights');
    await __t.start('Kestrel', { type: 'air', lat: 37.6, lon: -122.6, alt: 2000, hdg: 90, speed: 180 });
    sf.controller.input.throttle = 0.8;
    await __t.sim(120, { dt: 0.05 });
    // the map shows where it has been
    sf.toggleMap();
    await __t.sim(1, { dt: 0.05 });
    const track = { pts: sf.rec.track.length, vis: sf.mapView.lineTrack.visible, n: sf.mapView.lineTrack.geometry.drawRange.count };
    sf.toggleMap();
    sf.toTitle();
    const a = JSON.parse(localStorage.getItem('starforge.flights') || '[]');
    // a crash into the sea
    await __t.start('Kestrel', { type: 'air', lat: 37.0, lon: -123.5, alt: 1500, hdg: 90, speed: 200 });
    __t.inp.pitch = -1;
    await __t.sim(60, { allowDead: true, until: (s) => s.ship.dead });
    __t.inp.pitch = 0;
    await __t.sim(20, { allowDead: true });
    sf.toTitle();
    // too short to log
    await __t.start('Kestrel', { type: 'air', lat: 37.0, lon: -123.5, alt: 1500, hdg: 90, speed: 200 });
    await __t.sim(3, { dt: 0.05 });
    sf.toTitle();
    const b = JSON.parse(localStorage.getItem('starforge.flights') || '[]');
    sf.openLog();
    const rows = [...document.querySelectorAll('#logbook .ach.flight')].map((d) => d.innerText.replace(/\s+/g, ' '));
    return { track, a, b, rows };
  });
  t.log(JSON.stringify(r.a[0]));
  t.log(r.rows.join(' | '));
  const f = r.a[0];
  t.check(r.a.length === 1 && f && f.design === 'Kestrel' && f.outcome === 'Still flying', `a flight is logged when it ends (${f && f.outcome})`);
  t.check(f && f.dur >= 115 && f.dur <= 130 && f.dist >= 18 && f.dist <= 40 && f.maxMach > 0.4 && f.maxAlt >= 1, `with its time, distance and peaks (${f && f.dur} s, ${f && f.dist} km, Mach ${f && f.maxMach})`);
  t.check(r.track.pts > 10 && r.track.vis && r.track.n > 10, `the map draws the track (${r.track.pts} points)`);
  t.check(r.b.length === 2 && r.b[0].outcome === 'Crashed', `a crash is logged, a 3-second hop isn’t (${r.b.map((x) => x.outcome).join(', ')})`);
  t.check(r.rows.length === 2 && /Crashed/.test(r.rows[0]) && /Kestrel/.test(r.rows[1]) && /km/.test(r.rows[1]), `the logbook lists recent flights (${r.rows.length})`);
  await t.shot('flight-log');
}
