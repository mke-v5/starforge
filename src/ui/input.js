// Unified input: keyboard, touch (virtual stick, rudder, throttle, camera drag/pinch) and gamepad.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = [];             // one-shot actions this frame
    this.stick = { x: 0, y: 0, active: false };
    this.rudder = 0;
    this.throttleTouch = null;     // absolute throttle from the slider, consumed by game
    this.cam = { dx: 0, dy: 0, zoom: 0 };
    this.enabled = true;
    this.pointers = new Map();
    this.invertPitch = false;
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (!this.keys.has(k)) this.pressed.push(k);
      this.keys.add(k);
      if ([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.key)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; this.keys.delete(k); });
    window.addEventListener('blur', () => this.keys.clear());
    // camera: drag on the 3D view, wheel / pinch to zoom
    canvas.addEventListener('pointerdown', (e) => { this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) { this.cam.dx += e.clientX - p.x; this.cam.dy += e.clientY - p.y; }
      else if (this.pointers.size === 2) {
        const others = [...this.pointers.entries()].filter(([id]) => id !== e.pointerId)[0][1];
        const d0 = Math.hypot(p.x - others.x, p.y - others.y), d1 = Math.hypot(e.clientX - others.x, e.clientY - others.y);
        this.cam.zoom += (d0 - d1) * 0.01;
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e) => this.pointers.delete(e.pointerId);
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', (e) => { this.cam.zoom += Math.sign(e.deltaY) * 0.35; e.preventDefault(); }, { passive: false });
  }

  // wire the on-screen controls (elements created by the HUD)
  bindTouch(stickEl, knobEl, rudderEl, rudderKnob, thrEl, onThrottle) {
    let sid = null;
    const move = (e) => {
      const r = stickEl.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      this.stick.x = dx; this.stick.y = dy; this.stick.active = true;
      knobEl.style.transform = `translate(${dx * 38}px, ${dy * 38}px)`;
    };
    stickEl.addEventListener('pointerdown', (e) => { sid = e.pointerId; stickEl.setPointerCapture(sid); move(e); e.stopPropagation(); });
    stickEl.addEventListener('pointermove', (e) => { if (e.pointerId === sid) move(e); });
    const end = (e) => { if (e.pointerId !== sid) return; sid = null; this.stick.x = 0; this.stick.y = 0; this.stick.active = false; knobEl.style.transform = 'translate(0,0)'; };
    stickEl.addEventListener('pointerup', end); stickEl.addEventListener('pointercancel', end);
    let rid = null;
    const rmove = (e) => {
      const r = rudderEl.getBoundingClientRect();
      let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
      dx = Math.max(-1, Math.min(1, dx));
      this.rudder = Math.abs(dx) < 0.12 ? 0 : dx;
      rudderKnob.style.transform = `translateX(${dx * (r.width / 2 - 14)}px)`;
    };
    rudderEl.addEventListener('pointerdown', (e) => { rid = e.pointerId; rudderEl.setPointerCapture(rid); rmove(e); });
    rudderEl.addEventListener('pointermove', (e) => { if (e.pointerId === rid) rmove(e); });
    const rend = (e) => { if (e.pointerId !== rid) return; rid = null; this.rudder = 0; rudderKnob.style.transform = 'translateX(0)'; };
    rudderEl.addEventListener('pointerup', rend); rudderEl.addEventListener('pointercancel', rend);
    let tid = null;
    const tset = (e) => {
      const r = thrEl.getBoundingClientRect();
      let v = 1 - (e.clientY - r.top) / r.height;
      v = Math.max(0, Math.min(1, v));
      if (v < 0.03) v = 0;
      if (v > 0.97) v = 1;
      onThrottle(v);
    };
    thrEl.addEventListener('pointerdown', (e) => { tid = e.pointerId; thrEl.setPointerCapture(tid); tset(e); });
    thrEl.addEventListener('pointermove', (e) => { if (e.pointerId === tid) tset(e); });
    thrEl.addEventListener('pointerup', (e) => { if (e.pointerId === tid) tid = null; });
  }

  // returns the continuous flight inputs for this frame
  poll() {
    const k = this.keys;
    const kb = (a, b) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
    // keys are on/off, so ease them in like a real stick: a tap gives a gentle input, holding builds to
    // full deflection in about a second; letting go centres quickly
    const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - (this._kt || now)) / 1000));
    this._kt = now;
    const S = this._ks || (this._ks = { p: 0, r: 0, y: 0 });
    const ease = (cur, tgt) => (tgt === 0 || Math.sign(tgt) !== Math.sign(cur) && cur !== 0 ? cur + (tgt - cur) * Math.min(1, dt * 14) : cur + (tgt - cur) * Math.min(1, dt * 2.2));
    S.p = ease(S.p, Math.max(-1, Math.min(1, kb('s', 'w') + kb('ArrowDown', 'ArrowUp'))));
    S.r = ease(S.r, Math.max(-1, Math.min(1, kb('d', 'a') + kb('ArrowRight', 'ArrowLeft'))));
    S.y = ease(S.y, kb('e', 'q'));
    const snap = (v) => (Math.abs(v) < 0.02 ? 0 : v);
    let pitch = snap(S.p), roll = snap(S.r), yaw = snap(S.y);
    let thr = (k.has('Shift') ? 1 : 0) - (k.has('Control') ? 1 : 0);
    let trX = kb('l', 'j'), trY = kb('i', 'k'), trZ = kb('h', 'n');
    // touch stick: pull down = nose up, like a real control stick
    if (this.stick.active) {
      pitch += this.stick.y * (this.invertPitch ? -1 : 1);
      roll += this.stick.x;
    }
    yaw += this.rudder;
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp) continue;
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
      roll += dz(gp.axes[0] || 0);
      pitch += dz(gp.axes[1] || 0) * (this.invertPitch ? -1 : 1);
      this.cam.dx += dz(gp.axes[2] || 0) * 8; this.cam.dy += dz(gp.axes[3] || 0) * 8;
      const b = (i) => gp.buttons[i] && gp.buttons[i].pressed;
      const val = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
      yaw += (b(5) ? 1 : 0) - (b(4) ? 1 : 0);
      thr += val(7) - val(6);
      this.padEdge = this.padEdge || {};
      const edge = (i, act) => { if (b(i) && !this.padEdge[i]) this.pressed.push(act); this.padEdge[i] = b(i); };
      edge(0, 'g'); edge(1, 'b'); edge(2, 't'); edge(3, 'm'); edge(9, 'Escape'); edge(8, 'c'); edge(12, '.'); edge(13, ',');
      break;
    }
    const c = (v) => Math.max(-1, Math.min(1, v));
    return { pitch: c(pitch), roll: c(roll), yaw: c(yaw), thr, trX, trY, trZ, brake: k.has('b') };
  }
  take() { const p = this.pressed; this.pressed = []; return p; }
  takeCam() { const c = { ...this.cam }; this.cam.dx = 0; this.cam.dy = 0; this.cam.zoom = 0; return c; }
}
