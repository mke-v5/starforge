// Web worker: fetch an elevation PNG and decode it to heights off the main thread.
//   kind 'terrarium': Mapzen Terrarium (R*256 + G + B/256 - 32768 metres) -> Float32Array w*w
//   kind 'moonh':     lunar chunk (R high byte, G low byte of value>>3, 0.5 m units offset 20000) -> Float32Array w*h

let ctx = null;
function pixels(bmp) {
  const w = bmp.width, h = bmp.height;
  if (!ctx || ctx.canvas.width !== w || ctx.canvas.height !== h) ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  bmp.close();
  return d;
}

self.onmessage = async (ev) => {
  const { id, url, kind } = ev.data;
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) { self.postMessage({ id, ok: false, status: r.status }); return; }
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const w = bmp.width, h = bmp.height;
    const d = pixels(bmp);
    const out = new Float32Array(w * h);
    if (kind === 'terrarium') for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    else for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (((d[j] << 8) | d[j + 1]) * 8 - 20000) * 0.5;
    self.postMessage({ id, ok: true, data: out, w, h, bytes: blob.size }, [out.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, err: String(e) });
  }
};
