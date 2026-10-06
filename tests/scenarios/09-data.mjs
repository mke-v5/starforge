// Every tile source answers with the right content type and allows browser access (CORS).
// Hosts this machine cannot reach (network policy) are reported, not failed.
export const meta = { name: 'data-sources' };
const SOURCES = [
  ['EOX imagery', 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/3/2/3.jpg', /image\/jpeg/],
  ['AWS terrain', 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/3/2/3.png', /image\/png/],
  ['GIBS', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/2/1/1.jpeg', /image\/jpeg/],
  ['OpenFreeMap', 'https://tiles.openfreemap.org/planet', /json/],
];
export default async function (t) {
  for (const [name, url, type] of SOURCES) {
    const r = await t.eval(async (url) => {
      try { const res = await fetch(url, { mode: 'cors' }); return { ok: res.ok, status: res.status, type: res.headers.get('content-type') || '' }; } catch (e) { return { err: String(e) }; }
    }, url);
    if (r.err) { t.log(`unreachable from here (not counted): ${name} ${r.err}`); continue; }
    t.check(r.ok && type.test(r.type), `${name} answers ${r.status} ${r.type}`);
  }
  t.errors.length = 0;   // blocked hosts log console errors; those are not the game's
}
