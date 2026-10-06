// Network loader for map tiles: priority queue, de-duplication, staleness, LRU cache.

export const SRC = {
  img: {
    maxZ: 14,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/${z}/${y}/${x}.jpg`,
    fallbackMaxZ: 8,
    fallback: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-08/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
  },
  dem: { maxZ: 12, url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png` },
  night: { maxZ: 8, url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/2012-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg` },
  moon: { maxZ: 8, url: (z, x, y) => `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${y}/${x}.jpg` },
};

const MAX_CONCURRENT = 16;

export class Loader {
  constructor() {
    this.queue = [];
    this.active = 0;
    this.pending = new Map();
    this.cache = new Map();
    this.cacheLimit = 600;
    this.stats = { requested: 0, ok: 0, failed: 0, bytes: 0 };
    this.frame = 0;
    this.online = true;
    this._sortNeeded = false;
    // elevation tiles are fetched and decoded in workers when the browser allows (keeps frames smooth while
    // the ground streams in); otherwise on the main thread
    this.decoders = [];
    this.decodeJobs = new Map(); this.decodeId = 0;
    if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
      try {
        for (let i = 0; i < 2; i++) {
          const w = new Worker(new URL('./dworker.js', import.meta.url), { type: 'module' });
          w.onmessage = (e) => { const j = this.decodeJobs.get(e.data.id); if (j) { this.decodeJobs.delete(e.data.id); j(e.data); } };
          w.onerror = () => { this.decoders = []; };
          this.decoders.push(w);
        }
      } catch (e) { this.decoders = []; }
    }
  }

  // fetch + decode an elevation PNG in a worker: resolves to { data, w, h } or null
  decodeRemote(url, kind) {
    if (!this.decoders.length) return undefined;
    const id = ++this.decodeId, w = this.decoders[id % this.decoders.length];
    return new Promise((res) => {
      this.decodeJobs.set(id, (m) => { if (m.ok) this.stats.bytes += m.bytes || 0; res(m.ok ? m : null); });
      w.postMessage({ id, url, kind });
    });
  }
  get busy() { return this.queue.length + this.active; }

  tick() {
    this.frame++;
    if (this._sortNeeded) { this.queue.sort((a, b) => a.priority - b.priority); this._sortNeeded = false; }
    // drop requests nobody asked for recently
    if (this.frame % 30 === 0 && this.queue.length) {
      const keep = [];
      for (const e of this.queue) {
        if (this.frame - e.want > 90) { this.pending.delete(e.key); e.resolve(undefined); } else keep.push(e);
      }
      this.queue = keep;
    }
    this.pump();
  }

  // kind: img | dem | night | moon | raw:<url> (ArrayBuffer) | moonh:<j_i>
  get(kind, z, x, y, priority = 0) {
    const key = `${kind}/${z}/${x}/${y}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve(hit); }
    let e = this.pending.get(key);
    if (e) {
      e.want = this.frame;
      if (priority < e.priority) { e.priority = priority; this._sortNeeded = true; }
      return e.promise;
    }
    e = { key, kind, z, x, y, priority, want: this.frame };
    e.promise = new Promise((res) => { e.resolve = res; });
    this.pending.set(key, e);
    this.queue.push(e);
    this._sortNeeded = true;
    return e.promise;
  }
  peek(kind, z, x, y) { return this.cache.get(`${kind}/${z}/${x}/${y}`); }

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
          while (this.cache.size > this.cacheLimit) {
            // textures built from cached bitmaps own them; dropping our reference is enough
            this.cache.delete(this.cache.keys().next().value);
          }
        } else this.stats.failed++;
        e.resolve(v || null);
        this.pump();
      });
    }
  }

  async load(e) {
    try {
      if (e.kind === 'img') {
        let b = await this.bitmap(SRC.img.url(e.z, e.x, e.y));
        if (!b && e.z <= SRC.img.fallbackMaxZ) b = await this.bitmap(SRC.img.fallback(e.z, e.x, e.y));
        return b;
      }
      if (e.kind === 'night') return await this.bitmap(SRC.night.url(e.z, e.x, e.y));
      if (e.kind === 'moon') return await this.bitmap(SRC.moon.url(e.z, e.x, e.y));
      if (e.kind === 'dem') {
        const url = SRC.dem.url(e.z, e.x, e.y);
        const m = this.decodeRemote(url, 'terrarium');
        if (m !== undefined) { const r = await m; if (!r) return null; r.data.size = r.w; return r.data; }
        const b = await this.bitmap(url);
        return b ? decodeTerrarium(b) : null;
      }
      if (e.kind === 'moonh') {
        const url = new URL(`../../data/moon/${e.x}.png`, import.meta.url).href;
        const m = this.decodeRemote(url, 'moonh');
        if (m !== undefined) { const r = await m; if (!r) return null; r.data.w = r.w; r.data.h = r.h; return r.data; }
        const b = await this.bitmap(url);
        return b ? decodeMoonHeight(b) : null;
      }
      if (e.kind === 'raw') {
        const r = await fetch(e.x);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        this.stats.bytes += buf.byteLength;
        return buf;
      }
    } catch (err) { /* network errors are expected offline */ }
    return null;
  }

  async bitmap(url) {
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) return null;
      const blob = await r.blob();
      this.stats.bytes += blob.size;
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (e) { return null; }
  }
}

let _ctx = null;
function pixels(bmp) {
  const w = bmp.width, h = bmp.height;
  if (!_ctx || _ctx.canvas.width !== w || _ctx.canvas.height !== h) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    _ctx = c.getContext('2d', { willReadFrequently: true });
  }
  _ctx.clearRect(0, 0, w, h);
  _ctx.drawImage(bmp, 0, 0);
  const d = _ctx.getImageData(0, 0, w, h).data;
  bmp.close && bmp.close();
  return d;
}

// Terrarium PNG -> Float32Array of metres (w*w), with .size
function decodeTerrarium(bmp) {
  const w = bmp.width;
  const d = pixels(bmp);
  const out = new Float32Array(w * w);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
  out.size = w;
  return out;
}

// Lunar chunk PNG (R = high byte, G = low byte of value>>3 of NASA LDEM uint, 0.5 m units offset 20000)
function decodeMoonHeight(bmp) {
  const w = bmp.width, h = bmp.height;
  const d = pixels(bmp);
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (((d[j] << 8) | d[j + 1]) * 8 - 20000) * 0.5;
  out.w = w; out.h = h;
  return out;
}
