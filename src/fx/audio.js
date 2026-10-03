// Synthesised sound: engines (per type), wind, reentry roar, UI clicks, warnings, explosions. No audio files.
export class Audio {
  constructor() {
    this.ctx = null;
    this.on = true;
    this.ready = false;
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.on ? 0.7 : 0; this.master.connect(c.destination);
    // shared noise buffer
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
    this.noiseBuf = buf;
    const noise = (freq, q, type = 'lowpass') => {
      const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = c.createGain(); g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master); src.start();
      return { f, g };
    };
    this.rumble = noise(180, 0.7);           // rockets / fusion body
    this.roar = noise(900, 0.5, 'bandpass'); // rocket crackle / jet roar
    this.wind = noise(500, 0.6, 'bandpass');
    this.plasma = noise(1600, 0.4, 'bandpass');
    const osc = (type, freq) => { const o = c.createOscillator(); o.type = type; o.frequency.value = freq; const g = c.createGain(); g.gain.value = 0; o.connect(g); g.connect(this.master); o.start(); return { o, g }; };
    this.whine = osc('sawtooth', 400);       // turbine whine
    this.whineF = c.createBiquadFilter(); this.whineF.type = 'lowpass'; this.whineF.frequency.value = 2500;
    this.whine.g.disconnect(); this.whine.g.connect(this.whineF); this.whineF.connect(this.master);
    this.hum = osc('sine', 55);              // fusion hum
    this.beepG = c.createGain(); this.beepG.gain.value = 0; this.beepG.connect(this.master);
    this.ready = true;
  }
  setOn(v) { this.on = v; if (this.master) this.master.gain.value = v ? 0.7 : 0; }
  // state: {jet, rocket, fusion (0..1 throttle-weighted), q (dynamic pressure), heat, vac (0..1), paused}
  update(s) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, k = 0.08;
    const air = 1 - s.vac;
    const set = (param, v) => param.setTargetAtTime(v, t, k);
    set(this.rumble.g.gain, (s.rocket * 0.9 + s.fusion * 0.5 + s.jet * 0.25) * (0.25 + 0.75 * air) * (s.paused ? 0 : 1));
    set(this.rumble.f.frequency, 120 + s.rocket * 200 + s.jet * 120);
    set(this.roar.g.gain, (s.rocket * 0.5 + s.jet * 0.35) * air * (s.paused ? 0 : 1));
    set(this.roar.f.frequency, 500 + s.jet * 900);
    set(this.whine.g.gain, s.jet * 0.05 * (0.4 + 0.6 * air) * (s.paused ? 0 : 1));
    set(this.whine.o.frequency, 300 + s.jetSpool * 900);
    set(this.hum.g.gain, s.fusion * 0.18 * (s.paused ? 0 : 1));
    set(this.hum.o.frequency, 48 + s.fusion * 20);
    const w = Math.min(1, Math.sqrt(s.q) / 180);
    set(this.wind.g.gain, w * 0.6 * (s.paused ? 0 : 1));
    set(this.wind.f.frequency, 300 + w * 900);
    set(this.plasma.g.gain, Math.min(1, s.heat) * 0.6 * (s.paused ? 0 : 1));
  }
  click() { this.tone(900, 0.04, 0.05, 'square'); }
  beep() { this.tone(1200, 0.12, 0.08, 'sine'); }
  chime() { this.tone(660, 0.18, 0.1, 'sine'); setTimeout(() => this.tone(990, 0.25, 0.1, 'sine'), 140); }
  tone(f, dur, vol, type) {
    if (!this.ready) return;
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = f; g.gain.value = vol;
    g.gain.setTargetAtTime(0, c.currentTime + dur * 0.6, dur * 0.3);
    o.connect(g); g.connect(this.master); o.start(); o.stop(c.currentTime + dur * 2);
  }
  thump(v = 0.5) {
    if (!this.ready) return;
    const c = this.ctx, src = c.createBufferSource(); src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 160;
    const g = c.createGain(); g.gain.value = v; g.gain.setTargetAtTime(0, c.currentTime + 0.05, 0.08);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(); src.stop(c.currentTime + 0.6);
  }
  boom(size = 1) {
    if (!this.ready) return;
    const c = this.ctx, src = c.createBufferSource(); src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.frequency.setTargetAtTime(80, c.currentTime, 0.4);
    const g = c.createGain(); g.gain.value = Math.min(1.5, 0.8 * size); g.gain.setTargetAtTime(0, c.currentTime + 0.2, 0.6);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(); src.stop(c.currentTime + 3);
  }
}
