// Tile fetching with a small priority queue, de-duplication and an LRU cache.

export const SOURCES = {
  imagery: {
    maxZ: 13,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/${z}/${y}/${x}.jpg`,
    fallback: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-08/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
    fallbackMaxZ: 8,
  },
  terrain: {
    maxZ: 12,
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  },
};

const MAX_CONCURRENT = 10;

export class TileLoader {
  constructor() {
    this.queue = [];
    this.active = 0;
    this.pending = new Map();   // key -> promise
    this.cache = new Map();     // key -> value (insertion order = LRU order)
    this.cacheLimit = 500;
    this.failures = 0;
    this.stats = { requested: 0, ok: 0, failed: 0 };
  }

  get queued() { return this.queue.length + this.active; }

  // kind: 'imagery' | 'terrain'. Resolves to ImageBitmap (imagery) or Float32Array(256*256) metres (terrain), or null.
  get(kind, z, x, y, priority = 0) {
    const key = `${kind}/${z}/${x}/${y}`;
    if (this.cache.has(key)) {
      const v = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, v);
      return Promise.resolve(v);
    }
    if (this.pending.has(key)) {
      const p = this.pending.get(key);
      if (priority < p.priority) { p.priority = priority; this.queue.sort((a, b) => a.priority - b.priority); }
      return p.promise;
    }
    const entry = { key, kind, z, x, y, priority };
    entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
    this.pending.set(key, entry);
    this.queue.push(entry);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
    return entry.promise;
  }

  peek(kind, z, x, y) { return this.cache.get(`${kind}/${z}/${x}/${y}`) || null; }

  pump() {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const e = this.queue.shift();
      this.active++;
      this.stats.requested++;
      this.load(e).then((v) => {
        this.active--;
        this.pending.delete(e.key);
        if (v) {
          this.stats.ok++;
          this.cache.set(e.key, v);
          if (this.cache.size > this.cacheLimit) {
            const first = this.cache.keys().next().value;
            this.cache.delete(first);
          }
        } else this.stats.failed++;
        e.resolve(v);
        this.pump();
      });
    }
  }

  async load(e) {
    const src = SOURCES[e.kind];
    try {
      if (e.kind === 'imagery') {
        let bmp = await this.fetchBitmap(src.url(e.z, e.x, e.y));
        if (!bmp && e.z <= src.fallbackMaxZ) bmp = await this.fetchBitmap(src.fallback(e.z, e.x, e.y));
        return bmp;
      }
      const bmp = await this.fetchBitmap(src.url(e.z, e.x, e.y));
      if (!bmp) return null;
      return this.decodeTerrain(bmp);
    } catch (err) {
      return null;
    }
  }

  async fetchBitmap(url) {
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) return null;
      const blob = await r.blob();
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (e) { return null; }
  }

  decodeTerrain(bmp) {
    const w = bmp.width, h = bmp.height;
    let ctx;
    if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    else { const c = document.createElement('canvas'); c.width = w; c.height = h; ctx = c.getContext('2d', { willReadFrequently: true }); }
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    out.size = w;
    bmp.close();
    return out;
  }
}
