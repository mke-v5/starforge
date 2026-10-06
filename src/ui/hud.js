// Flight HUD: readouts, navball, SAS buttons, toggles, resources, warnings and toasts.
import * as THREE from 'three';
import { EARTH, MOON, R2D, D2R, clamp, fmtTime, llh, gcBearing } from '../core/geo.js';
import { RES } from '../ship/parts.js';
import { elements, relState, deltaV } from '../ship/orbit.js';
import { moonPos } from '../core/astro.js';
import { STATION } from '../world/station.js';
const STATION_SHORT = STATION.short, STATION_NAME = STATION.name;

const $ = (id) => document.getElementById(id);

export function fmtNum(v, d = 0) { return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }

export class Units {
  constructor(settings) { this.s = settings; }
  get imp() { return this.s.units === 'imperial'; }
  speed(ms) {
    if (this.imp) { const kt = ms * 1.94384; return kt < 10000 ? [fmtNum(kt), 'kt'] : [fmtNum(ms * 2.23694), 'mph']; }
    return Math.abs(ms) < 10000 ? [fmtNum(ms), 'm/s'] : [(ms / 1000).toFixed(2), 'km/s'];
  }
  alt(m) {
    if (this.imp) { const ft = m * 3.28084; return Math.abs(ft) < 100000 ? [fmtNum(ft), 'ft'] : [fmtNum(m / 1852, 0), 'nmi']; }
    if (Math.abs(m) < 10000) return [fmtNum(m), 'm'];
    if (Math.abs(m) < 1e6) return [(m / 1000).toFixed(1), 'km'];
    return [fmtNum(m / 1000), 'km'];
  }
  dist(m) { const [a, u] = this.alt(m); return `${a} ${u}`; }
  vs(ms) { return this.imp ? fmtNum(ms * 196.85) : (Math.abs(ms) < 100 ? ms.toFixed(1) : fmtNum(ms)); }
}

export class Hud {
  constructor(game) {
    this.game = game;
    this.units = new Units(game.settings);
    this.toastEl = $('toasts');
    this.warnEl = $('h-warn');
    this.lastWarn = '';
    this.buildToggles();
    this.buildSas();
    this.buildNavball();
    this.infoCollapsed = false;
    // tap toggles the details: big screens start open ('collapsed' hides them), phones start compact ('open' shows them)
    $('h-info').addEventListener('click', () => { this.infoCollapsed = !this.infoCollapsed; $('h-info').classList.toggle('collapsed', this.infoCollapsed); $('h-info').classList.toggle('open', this.infoCollapsed); });
    this.t = 0;
  }

  // ---------- controls ----------
  buildToggles() {
    const el = $('h-toggles');
    const defs = [
      ['gear', 'Gear', 'G'], ['brake', 'Brake', 'B'],
      ['rcs', 'RCS', 'R'], ['lights', 'Lights', 'U'],
      ['engines', 'Eng: all', 'E'], ['mode', 'Auto', 'X'],
      ['auto', 'Auto', 'P'], ['info', 'Info', 'O'],
      ['dock', 'Dock', 'Y'], ['refuel', 'Refuel', ''], ['nav', 'Nav', '9'],
    ];
    this.toggles = {};
    for (const [id, label, key] of defs) {
      const b = document.createElement('button');
      b.textContent = label; b.title = key ? `${label} (${key})` : label;
      b.addEventListener('click', () => this.game.action(id));
      el.appendChild(b);
      this.toggles[id] = b;
    }
  }
  buildSas() {
    const el = $('h-sas');
    const modes = [['off', 'Off'], ['hold', 'Hold'], ['prograde', 'Pro'], ['retrograde', 'Retro'], ['normal', 'Nrm'], ['antinormal', 'Anrm'], ['radialOut', 'Rad+'], ['radialIn', 'Rad−'], ['target', 'Moon'], ['station', 'Stn'], ['tgtPro', 'T+'], ['tgtRetro', 'T−']];
    this.sasBtns = {};
    for (const [m, label] of modes) {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => this.game.setSas(m));
      el.appendChild(b);
      this.sasBtns[m] = b;
    }
  }

  // ---------- navball ----------
  buildNavball() {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, 256); sky.addColorStop(0, '#163a68'); sky.addColorStop(1, '#3d7ec4');
    g.fillStyle = sky; g.fillRect(0, 0, 1024, 256);
    const gr = g.createLinearGradient(0, 256, 0, 512); gr.addColorStop(0, '#8a5a2b'); gr.addColorStop(1, '#3b2614');
    g.fillStyle = gr; g.fillRect(0, 256, 1024, 256);
    g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, 256); g.lineTo(1024, 256); g.stroke();
    g.font = 'bold 18px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    // pitch lines
    for (let p = -80; p <= 80; p += 10) {
      if (p === 0) continue;
      const y = 256 - (p / 90) * 256;
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = p % 30 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(0, y); g.lineTo(1024, y); g.stroke();
    }
    // heading meridians (u = (h + 270)/360)
    for (let h = 0; h < 360; h += 15) {
      const u = ((h + 270) % 360) / 360 * 1024;
      g.strokeStyle = h % 90 === 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.3)'; g.lineWidth = h % 90 === 0 ? 2 : 1;
      g.beginPath(); g.moveTo(u, 30); g.lineTo(u, 482); g.stroke();
      const lab = h % 90 === 0 ? 'NESW'[h / 90] : (h % 45 === 0 ? String(h) : '');
      if (lab) for (const y of [236, 276]) { g.fillStyle = h % 90 === 0 ? '#ffd28f' : '#fff'; g.fillText(lab, u, y); }
    }
    for (const p of [-60, -30, 30, 60]) {
      const y = 256 - (p / 90) * 256;
      for (let h = 45; h < 360; h += 90) { const u = ((h + 270) % 360) / 360 * 1024; g.fillStyle = '#fff'; g.fillText(String(p), u, y - 10); }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.nbScene = new THREE.Scene();
    this.nbCam = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, 0.1, 10);
    this.nbCam.position.set(0, 0, 5);
    this.nbBall = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    this.nbBall.matrixAutoUpdate = false;
    this.nbScene.add(this.nbBall);
    // rim + crosshair
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 64), new THREE.MeshBasicMaterial({ color: 0x1a2232 }));
    ring.position.z = 2; this.nbScene.add(ring);
    const cross = new THREE.Group();
    const cm = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    for (const [w, h, x, y] of [[0.42, 0.05, -0.33, 0], [0.42, 0.05, 0.33, 0], [0.05, 0.14, 0, -0.07]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), cm); m.position.set(x, y, 2.1); cross.add(m); }
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 12), cm); dot.position.z = 2.1; cross.add(dot);
    this.nbScene.add(cross);
    // markers
    const mk = (draw) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const x = cv.getContext('2d'); x.lineWidth = 5; draw(x);
      const t = new THREE.CanvasTexture(cv);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
      s.scale.set(0.3, 0.3, 1); s.renderOrder = 5; this.nbScene.add(s); return s;
    };
    const circle = (col, cross) => (x) => { x.strokeStyle = col; x.beginPath(); x.arc(32, 32, 14, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.moveTo(32, 4); x.lineTo(32, 18); x.moveTo(6, 32); x.lineTo(18, 32); x.moveTo(46, 32); x.lineTo(58, 32); x.stroke(); if (cross) { x.beginPath(); x.moveTo(22, 22); x.lineTo(42, 42); x.moveTo(42, 22); x.lineTo(22, 42); x.stroke(); } else { x.fillStyle = col; x.beginPath(); x.arc(32, 32, 4, 0, Math.PI * 2); x.fill(); } };
    const tri = (col) => (x) => { x.strokeStyle = col; x.beginPath(); x.moveTo(32, 10); x.lineTo(54, 50); x.lineTo(10, 50); x.closePath(); x.stroke(); x.fillStyle = col; x.beginPath(); x.arc(32, 36, 4, 0, Math.PI * 2); x.fill(); };
    const sq = (col) => (x) => { x.strokeStyle = col; x.strokeRect(14, 14, 36, 36); x.fillStyle = col; x.beginPath(); x.arc(32, 32, 4, 0, Math.PI * 2); x.fill(); };
    this.markers = {
      pro: mk(circle('#e8e04a', false)), retro: mk(circle('#e8e04a', true)),
      nrm: mk(tri('#d86cff')), anrm: mk(tri('#d86cff')), radOut: mk(sq('#5fd3ff')), radIn: mk(sq('#5fd3ff')),
      tgt: mk((x) => { x.strokeStyle = '#ff6ad5'; x.beginPath(); x.arc(32, 32, 16, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.arc(32, 32, 6, 0, Math.PI * 2); x.stroke(); }),
      node: mk((x) => { x.strokeStyle = '#3c8dff'; x.beginPath(); x.arc(32, 32, 18, 0, Math.PI * 2); x.stroke(); x.fillStyle = '#3c8dff'; x.beginPath(); x.arc(32, 32, 7, 0, Math.PI * 2); x.fill(); }),
      // the station and the velocity relative to it (green)
      stn: mk((x) => { x.strokeStyle = '#73e2a7'; x.strokeRect(12, 12, 40, 40); x.beginPath(); x.moveTo(32, 4); x.lineTo(32, 20); x.moveTo(32, 44); x.lineTo(32, 60); x.moveTo(4, 32); x.lineTo(20, 32); x.moveTo(44, 32); x.lineTo(60, 32); x.stroke(); }),
      tpro: mk(circle('#73e2a7', false)), tretro: mk(circle('#73e2a7', true)),
      // heading bug toward the destination (amber flag on the horizon)
      dst: mk((x) => { x.fillStyle = '#ffb347'; x.beginPath(); x.moveTo(32, 8); x.lineTo(48, 30); x.lineTo(38, 30); x.lineTo(38, 56); x.lineTo(26, 56); x.lineTo(26, 30); x.lineTo(16, 30); x.closePath(); x.fill(); }),
    };
  }

  renderNavball(renderer, ship, ctl, dest = null) {
    const slot = $('navball-slot');
    if (!slot || slot.offsetParent === null) return;
    const r = slot.getBoundingClientRect();
    if (r.width < 10) return;
    const up = ship.env.up;
    const north = new THREE.Vector3(0, 1, 0);
    if (ship.env.body === MOON) north.copy(ship.eph.mY);
    north.addScaledVector(up, -north.dot(up)).normalize();
    const east = new THREE.Vector3().crossVectors(north, up).normalize();
    const south = north.clone().negate();
    const B = new THREE.Matrix4().makeBasis(east, up, south);
    const Rinv = new THREE.Matrix4().makeRotationFromQuaternion(ship.q.clone().invert());
    const S = new THREE.Matrix4().makeScale(1, 1, -1);
    this.nbBall.matrix.copy(S).multiply(Rinv).multiply(B);
    const qi = ship.q.clone().invert();
    const place = (m, dirW) => {
      if (!dirW || dirW.lengthSq() < 1e-9) { m.visible = false; return; }
      const d = dirW.clone().normalize().applyQuaternion(qi);
      d.z = -d.z;
      m.visible = d.z > 0.02;
      m.position.set(d.x, d.y, 3);
    };
    const v = ctl.refVel(ship), rr = ctl.refPos(ship);
    if (v.length() > 0.5) {
      place(this.markers.pro, v); place(this.markers.retro, v.clone().negate());
      const n = new THREE.Vector3().crossVectors(rr, v);
      const showOrb = ship.env.vSurf > 200 || ship.env.agl > 20000;
      if (showOrb) { place(this.markers.nrm, n); place(this.markers.anrm, n.clone().negate()); const ro = new THREE.Vector3().crossVectors(v, n); place(this.markers.radOut, ro); place(this.markers.radIn, ro.clone().negate()); }
      else for (const k of ['nrm', 'anrm', 'radOut', 'radIn']) this.markers[k].visible = false;
    } else for (const k of ['pro', 'retro', 'nrm', 'anrm', 'radOut', 'radIn']) this.markers[k].visible = false;
    moonPos(ship.t, this._m || (this._m = new THREE.Vector3()));
    const st = ship.station, nearSt = st && ship.env.body === EARTH && ship.r.distanceTo(st.r) < 1.5e6 && !ship.docked;
    place(this.markers.tgt, nearSt && ship.r.distanceTo(st.r) < 2e5 ? null : this._m.clone().sub(ship.r));
    if (nearSt) {
      place(this.markers.stn, st.r.clone().sub(ship.r));
      const rv = ship.v.clone().sub(st.v);
      if (rv.length() > 0.05) { place(this.markers.tpro, rv); place(this.markers.tretro, rv.clone().negate()); }
      else { this.markers.tpro.visible = false; this.markers.tretro.visible = false; }
    } else for (const k of ['stn', 'tpro', 'tretro']) this.markers[k].visible = false;
    const node = ctl.node;
    place(this.markers.node, node ? (node.dvLeft || node.dv) : null);
    if (dest && ship.env.body === EARTH) {
      const b = gcBearing(ship.env.lat, ship.env.lon, dest.lat, dest.lon);
      place(this.markers.dst, north.clone().multiplyScalar(Math.cos(b)).addScaledVector(east, Math.sin(b)));
    } else this.markers.dst.visible = false;
    // render into the slot
    const dpr = renderer.getPixelRatio();
    const H = renderer.domElement.height / dpr;
    renderer.setScissorTest(true);
    renderer.setViewport(r.left, H - r.bottom, r.width, r.height);
    renderer.setScissor(r.left, H - r.bottom, r.width, r.height);
    renderer.clearDepth();
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.render(this.nbScene, this.nbCam);
    renderer.autoClear = ac;
    renderer.setScissorTest(false);
    const W = renderer.domElement.width / dpr;
    renderer.setViewport(0, 0, W, H);
  }

  // ---------- target bracket over the station (every frame) ----------
  updateTarget(camera, camI, ship) {
    const el = this.tgtEl || (this.tgtEl = $('h-tgt'));
    const st = ship && ship.station;
    if (!st || ship.docked || ship.env.body !== EARTH) { el.hidden = true; return; }
    const d = ship.r.distanceTo(st.r);
    if (d > 1.5e6 || d < 25) { el.hidden = true; return; }
    const p = st.r.clone().sub(camI).project(camera);
    if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) { el.hidden = true; return; }
    el.hidden = false;
    el.style.transform = `translate(${((p.x * 0.5 + 0.5) * innerWidth).toFixed(1)}px,${((-p.y * 0.5 + 0.5) * innerHeight).toFixed(1)}px)`;
    const txt = `${STATION_SHORT.toUpperCase()} · ${this.units.dist(d)}`;
    if (el._t !== txt) { el._t = txt; el.lastChild.textContent = txt; }
  }

  // ---------- destination marker: on the spot when in view, an arrow at the screen edge when not ----------
  updateDest(camera, camI, ship, dest, eph) {
    const el = this.dstEl || (this.dstEl = $('h-dest'));
    if (!dest || !ship || ship.env.body !== EARTH || ship.docked) { el.hidden = true; return; }
    const pF = llh(dest.lat, dest.lon, 0, EARTH.R, this._dp || (this._dp = new THREE.Vector3()));
    const rel = pF.applyQuaternion(eph.earthQ).sub(camI);
    const d = ship.r.distanceTo(rel.clone().add(camI));
    if (d < 400) { el.hidden = true; return; }
    const v = rel.clone().applyMatrix4(camera.matrixWorldInverse);       // camera space: -z forward
    const W = innerWidth, H = innerHeight, m = 46;
    let x, y, edge = false;
    if (v.z < 0) {
      const p = rel.clone().project(camera);
      x = (p.x * 0.5 + 0.5) * W; y = (-p.y * 0.5 + 0.5) * H;
      if (x < m || x > W - m || y < m || y > H - m) edge = true;
    } else edge = true;
    let ang = 0;
    if (edge) {
      // direction on screen toward the spot (behind us: the way to turn)
      let dx = v.x, dy = -v.y;
      if (v.z >= 0 && Math.hypot(dx, dy) < 1e-6) dy = 1;
      const k = Math.min((W / 2 - m) / Math.max(1e-6, Math.abs(dx)), (H / 2 - m) / Math.max(1e-6, Math.abs(dy)));
      x = W / 2 + dx * k; y = H / 2 + dy * k;
      ang = Math.atan2(dy, dx);
    }
    el.hidden = false;
    el.classList.toggle('edge', edge);
    el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
    el.firstChild.style.transform = edge ? `rotate(${ang.toFixed(3)}rad)` : '';
    const txt = `${dest.code || dest.name} · ${this.units.dist(d)}`;
    if (el._t !== txt) { el._t = txt; el.lastChild.textContent = txt; }
  }

  // ---------- messages ----------
  toast(msg, kind = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + kind; d.textContent = msg;
    this.toastEl.appendChild(d);
    while (this.toastEl.children.length > 4) this.toastEl.firstChild.remove();
    setTimeout(() => d.remove(), 4200);
  }

  // ---------- per-frame ----------
  update(dt, ship, ctl, extra) {
    this.t += dt;
    if (this.t < 0.12) return;
    this.t = 0;
    const E = ship.env, U = this.units, craft = ship.craft;
    const orbital = E.agl > 60000 || (E.body === MOON && E.agl > 15000);
    let spd = E.vSurf, spdK = 'SRF';
    if (orbital) { spd = ctl.refVel(ship).length(); spdK = 'ORB'; }
    const stx = extra.station;
    if (stx && !stx.docked && stx.d < 5000) { spd = stx.vrel; spdK = 'TGT'; }
    const [s, su] = U.speed(spd);
    $('h-spd').textContent = s; $('h-spdu').textContent = su; $('h-spdk').textContent = spdK;
    const radar = E.agl < 3000;
    const [a, au] = U.alt(radar ? E.agl : E.h);
    $('h-alt').textContent = a; $('h-altu').textContent = au; $('h-altk').textContent = radar ? 'RAD' : (E.body === MOON ? 'ALT·MOON' : 'ALT');
    $('h-vs').textContent = U.vs(E.vVert);
    // heading of the nose
    const up = E.up;
    const north = new THREE.Vector3(0, 1, 0); if (E.body === MOON) north.copy(ship.eph.mY);
    north.addScaledVector(up, -north.dot(up)).normalize();
    const east = new THREE.Vector3().crossVectors(north, up);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
    let hdg = Math.atan2(fwd.dot(east), fwd.dot(north)) * R2D; if (hdg < 0) hdg += 360;
    $('h-hdg').textContent = String(Math.round(hdg) % 360).padStart(3, '0');
    if (E.rho > 1e-4) { $('h-mk').textContent = 'MACH'; $('h-mach').textContent = E.mach.toFixed(2); }
    else { $('h-mk').textContent = 'G'; $('h-mach').textContent = ship.gForce.toFixed(1); }
    // warp
    $('h-wv').textContent = fmtWarp(ship.warp);
    // throttle
    const thr = ctl.ap && ctl.ap.throttleOwned ? ship.ctl.throttle : ctl.input.throttle;
    $('thrfill').style.height = (ship.ctl.throttle * 100).toFixed(0) + '%';
    $('thrtxt').textContent = Math.round(ship.ctl.throttle * 100) + '%';
    // toggles
    const T = this.toggles;
    T.gear.classList.toggle('on', ship.ctl.gear);
    T.brake.classList.toggle('on', ship.ctl.brake > 0.5);
    T.rcs.classList.toggle('on', ship.ctl.rcs);
    T.lights.classList.toggle('on', !!extra.lights);
    T.engines.textContent = extra.engGroup === 'all' ? 'Engines' : extra.engGroup;
    T.engines.hidden = !extra.multiGroup;
    const hasHybrid = craft.engines.some((P) => P.eng.e.type === 'hybrid');
    T.mode.hidden = !hasHybrid;
    if (hasHybrid) { const m = ship.ctl.engineMode; T.mode.textContent = m === 'auto' ? 'Mode: auto' : m === 'air' ? 'Mode: air' : 'Mode: rocket'; T.mode.classList.toggle('alt', m !== 'auto'); }
    T.auto.classList.toggle('on', !!ctl.ap);
    T.auto.textContent = ctl.ap ? ctl.ap.name : 'Auto';
    T.dock.hidden = !(stx && (stx.docked || (stx.d < 8000 && craft.docks.length)));
    T.dock.textContent = stx && stx.docked ? 'Undock' : 'Dock';
    T.dock.classList.toggle('on', !!(stx && stx.docked));
    T.refuel.hidden = !(stx && stx.docked);
    const space = E.rho < 0.01 || E.h > 30000;
    const stNear = stx && !stx.docked && stx.d < 100000;
    for (const m in this.sasBtns) {
      this.sasBtns[m].classList.toggle('on', ctl.sas === m);
      let hide = !space && !['off', 'hold', 'prograde', 'retrograde'].includes(m);
      if (['station', 'tgtPro', 'tgtRetro'].includes(m)) hide = !stNear;
      if (m === 'target' && stNear) hide = true;
      this.sasBtns[m].hidden = hide && ctl.sas !== m;
    }
    // AP bar
    const apb = $('h-ap');
    if (ctl.ap || extra.apMsg) {
      apb.hidden = false;
      const txt = ctl.ap ? ctl.ap.name + (extra.apMsg ? ' · ' + extra.apMsg : '') : extra.apMsg;
      // rebuild only when it changes, so a tap on Stop isn't lost to a re-created button
      if (apb._has !== !!ctl.ap) {
        apb._has = !!ctl.ap;
        apb.innerHTML = '<span></span>' + (ctl.ap ? '<button id="ap-x">Stop</button>' : '');
        const x = $('ap-x'); if (x) x.onclick = () => { ctl.cancelAp(); ship.ctl.throttle = 0; ctl.input.throttle = 0; };
        apb._txt = null;
      }
      if (apb._txt !== txt) { apb._txt = txt; apb.firstChild.textContent = txt; }
    } else { apb.hidden = true; apb._has = undefined; }
    // info panel
    this.updateInfo(ship, ctl, extra);
    // orbit bar
    const ob = $('h-orbit');
    let obh = '';
    if (stx && stx.docked) obh = `<div style="color:var(--green)">DOCKED · ${STATION_NAME}</div><div class="dim">Refuel, then undock (Y) when ready</div>`;
    else if ((E.h > 25000 || E.body === MOON) && !(ship.parked || (ship.contacts > 0 && E.vSurf < 5))) {
      const rs = relState(ship, E.body);
      const el = elements(rs.r, rs.v, rs.mu);
      const R = E.body.R;
      const ap = isFinite(el.ap) ? U.dist(el.ap - R) : 'escape';
      const sub = el.pe < R;
      const pe = sub ? 'suborbital' : U.dist(el.pe - R);
      let html = `<div><span class="dim">${E.body.name.toUpperCase()}</span> Ap <b>${ap}</b> · Pe <b>${pe}</b></div>`;
      if (el.e < 1 && !sub) html += `<div class="dim">Ap in ${fmtTime(el.tAp)} · Pe in ${fmtTime(el.tPe)} · ${fmtTime(el.period)} orbit</div>`;
      else if (el.e < 1 && el.tAp < el.period / 2) html += `<div class="dim">Ap in ${fmtTime(el.tAp)}</div>`;
      if (extra.encounter) html += `<div style="color:var(--violet)">${extra.encounter}</div>`;
      if (stx && !stx.docked && stx.d < 3e6) html += `<div style="color:var(--green)">${STATION_SHORT} ${U.dist(stx.d)}${stx.d < 2e5 ? ` · ${stx.closing >= 0 ? 'closing' : 'opening'} ${Math.abs(stx.closing) < 10 ? Math.abs(stx.closing).toFixed(1) : Math.round(Math.abs(stx.closing))} m/s` : ''}</div>`;
      obh = html;
    }
    const nv = extra.nav;
    if (nv && extra.dest) {
      const d = extra.dest;
      obh += `<div class="navl"><span style="color:var(--amber)">▸ ${esc(d.code || d.name)}</span> ${U.dist(nv.d)}${ship.contacts === 0 && nv.toward > 20 ? ` · ${fmtTime(nv.eta)}` : ''}${nv.short ? ' <span style="color:var(--red)">· not enough fuel</span>' : ''}</div>`;
    }
    if (obh) { if (ob._h !== obh) { ob._h = obh; ob.innerHTML = obh; } ob.hidden = false; } else { ob.hidden = true; ob._h = ''; }
    T.nav.classList.toggle('on', !!extra.dest);
    T.nav.hidden = E.body !== EARTH && !extra.dest;
    // warnings
    const w = [];
    if (extra.stall) w.push(['STALL', '']);
    if (extra.pullUp) w.push(['PULL UP', '']);
    if (craft.heatFrac > 0.85) w.push(['OVERHEAT', '']); else if (craft.heatFrac > 0.7) w.push(['HOT', 'caut']);
    if (extra.lowFuel) w.push(['LOW FUEL', 'caut']);
    if (extra.stress > 0.85) w.push(['OVERSTRESS', '']);
    else if (ship.gForce > 9) w.push(['G LIMIT', '']);
    if (extra.gearUp) w.push(['GEAR UP', 'caut']);
    if (extra.flameout) w.push(['FLAMEOUT', 'caut']);
    if (craft.engines.some((P) => P.eng.starved && P.eng.thr > 0.05)) w.push(['NO POWER', 'caut']);
    if (craft.engines.some((P) => P.eng.ab > 0.05)) w.push(['AFTERBURNER', 'caut']);
    const key = w.map((x) => x[0]).join(',');
    if (key !== this.lastWarn) { this.lastWarn = key; this.warnEl.innerHTML = w.map(([t, c]) => `<span class="${c}">${t}</span>`).join(''); }
  }

  updateInfo(ship, ctl, extra) {
    const craft = ship.craft, U = this.units;
    let html = '';
    for (const k of ['LF', 'OX', 'FU', 'XE', 'GAS', 'ABL']) {
      const cap = craft.capacity(k);
      if (cap <= 0) continue;
      const amt = craft.amount(k);
      html += `<div class="ln"><span>${RES[k].name}</span><span>${fmtNum(amt)} kg</span></div><div class="bar"><i style="width:${(amt / cap * 100).toFixed(1)}%;background:${RES[k].color}"></i></div>`;
    }
    const heat = clamp(craft.heatFrac || 0, 0, 1.2);
    const hc = heat > 0.85 ? 'var(--red)' : heat > 0.7 ? 'var(--amber)' : 'var(--green)';
    html += `<div class="ln"><span>Heat</span><span>${craft.hottest ? Math.round(craft.hottest.temp) + ' K' : '—'}</span></div><div class="bar"><i style="width:${Math.min(100, heat * 100).toFixed(0)}%;background:${hc}"></i></div>`;
    html += `<div class="more">`;
    // air-breathing flight is about how long the fuel lasts; rocket flight is about delta-v
    const jetsOnly = !craft.engines.some((P) => P.alive !== false && (P.eng.mode === 'rocket' || P.eng.e.type === 'hybrid'));
    const jetsBurning = craft.engines.some((P) => P.eng.flame > 0 && (P.eng.mode === 'jet' || P.eng.mode === 'air'));
    if (ship.env.rho > 0.05 && isFinite(extra.endurance) && jetsBurning) html += `<div class="ln"><span>Fuel time</span><span>${fmtTime(extra.endurance)}</span></div>`;
    else if (jetsOnly) html += `<div class="ln"><span>Fuel time</span><span>${isFinite(extra.endurance) ? fmtTime(extra.endurance) : 'engines idle'}</span></div>`;
    else html += `<div class="ln"><span>Δv</span><span>${fmtNum(extra.dv)} m/s</span></div>`;
    html += `<div class="ln"><span>TWR</span><span>${extra.twr.toFixed(2)}</span></div>`;
    html += `<div class="ln"><span>Mass</span><span>${(craft.mass / 1000).toFixed(1)} t</span></div>`;
    if (craft.ecCap > 0) html += `<div class="ln"><span>Charge</span><span>${Math.round(craft.ec / craft.ecCap * 100)}%</span></div>`;
    if (craft.reactors.length) html += `<div class="ln"><span>Reactor</span><span>${craft.reactors.some((P) => P.reactorOn) ? 'charging' : craft.ec >= craft.ecCap - 1 ? 'standby' : 'no fuel'}</span></div>`;
    html += `<div class="ln"><span>Lat/Lon</span><span>${ship.env.lat.toFixed(2)}, ${ship.env.lon.toFixed(2)}</span></div>`;
    if (extra.nearest) html += `<div class="ln"><span>${extra.nearest.name}</span><span>${U.dist(extra.nearest.d)}</span></div>`;
    html += `</div>`;
    $('h-info').innerHTML = html;
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function fmtWarp(w) { return w >= 1000 ? (w / 1000) + 'k×' : w + '×'; }
