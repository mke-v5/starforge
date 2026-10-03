// Map view: orbit camera around Earth/Moon/ship, predicted trajectories, apsis labels and burn planning.
import * as THREE from 'three';
import { EARTH, MOON, clamp, fmtTime } from '../core/geo.js';
import { moonPos, moonVel } from '../core/astro.js';
import { predict, elements, relState, propagate, planCircularize, planMoonTransfer, planReturn, planCapture, planPeriapsis, burnTime, deltaV } from '../ship/orbit.js';
import { nodeExec, landAp, ascentAp } from '../ship/control.js';

const $ = (id) => document.getElementById(id);

export class MapView {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.visible = false;
    game.scene.add(this.group);
    const mk = (color, opacity = 1, dashed = false) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 6000), 3));
      g.setDrawRange(0, 0);
      const m = dashed ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 1, transparent: true, opacity, depthTest: true })
        : new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true });
      const l = new THREE.Line(g, m); l.frustumCulled = false; l.renderOrder = 40; this.group.add(l); return l;
    };
    this.lineEarth = mk(0xffb347);
    this.lineMoon = mk(0xc58bff);
    this.lineNode = mk(0x5aa8ff, 0.9);
    this.lineNodeMoon = mk(0x5aa8ff, 0.9);
    this.lineMoonOrbit = mk(0xffffff, 0.25);
    // ship marker
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'); x.fillStyle = '#7fd4ff'; x.beginPath(); x.moveTo(32, 6); x.lineTo(54, 56); x.lineTo(32, 44); x.lineTo(10, 56); x.closePath(); x.fill();
    this.shipMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
    this.shipMark.scale.set(0.035, 0.035, 1); this.shipMark.renderOrder = 60; this.group.add(this.shipMark);
    this.labels = [];
    this.focus = 'ship';
    this.yaw = 0.6; this.pitch = 0.5; this.dist = 2e7;
    this.pred = null; this.predNode = null; this.predT = 0;
    this.busy = null;
    this.camI = new THREE.Vector3();
    this.moonOrbit = null;
    $('m-back').addEventListener('click', () => game.toggleMap());
    $('m-wd').addEventListener('click', () => game.warpStep(-1));
    $('m-wu').addEventListener('click', () => game.warpStep(1));
    const foc = $('m-focus');
    for (const [k, n] of [['ship', 'Ship'], ['earth', 'Earth'], ['moon', 'Moon']]) {
      const b = document.createElement('button'); b.textContent = n; b.dataset.k = k;
      b.addEventListener('click', () => this.setFocus(k));
      foc.appendChild(b);
    }
  }

  open() {
    this.group.visible = true;
    const E = this.game.ship.env;
    this.setFocus(E.body === MOON ? 'moon' : 'earth', true);
    this.pred = null; this.predT = 0;
    this.renderPlan();
  }
  close() { this.group.visible = false; for (const l of this.labels) l.remove(); this.labels = []; }

  setFocus(k, reset = true) {
    this.focus = k;
    for (const b of $('m-focus').children) b.classList.toggle('on', b.dataset.k === k);
    if (reset) this.dist = k === 'earth' ? 4.2 * EARTH.R : k === 'moon' ? 6 * MOON.R : 3 * EARTH.R;
    if (k === 'ship') this.dist = Math.max(2e5, Math.min(this.dist, 2e7));
  }

  focusPos(out) {
    const ship = this.game.ship;
    if (this.focus === 'earth') return out.set(0, 0, 0);
    if (this.focus === 'moon') return moonPos(ship.t, out);
    return out.copy(ship.r);
  }

  // camera and drawing; returns the camera position in frame I
  update(dt, cam, camera) {
    const ship = this.game.ship;
    this.yaw -= cam.dx * 0.005; this.pitch = clamp(this.pitch + cam.dy * 0.005, -1.5, 1.5);
    this.dist *= Math.exp(cam.zoom * 0.15);
    const minD = this.focus === 'moon' ? MOON.R * 1.3 : this.focus === 'earth' ? EARTH.R * 1.3 : 5e4;
    this.dist = clamp(this.dist, minD, 2e9);
    const f = this.focusPos(new THREE.Vector3());
    const dir = new THREE.Vector3(Math.cos(this.pitch) * Math.sin(this.yaw), Math.sin(this.pitch), Math.cos(this.pitch) * Math.cos(this.yaw));
    this.camI.copy(f).addScaledVector(dir, this.dist);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.lookAt(f.clone().sub(this.camI));
    camera.near = Math.max(1, this.dist * 0.001); camera.far = 5e10; camera.updateProjectionMatrix();
    // trajectory prediction
    this.predT -= dt;
    if (this.predT <= 0 && !this.busy) {
      this.predT = ship.thrustNow > 0 ? 0.25 : 0.8;
      this.pred = predict(ship.r, ship.v, ship.t, { maxT: 8 * 86400, maxSteps: 3500 });
      const node = this.game.controller.node;
      if (node) {
        const st = propagate(ship.r, ship.v, ship.t, Math.max(0, node.t - ship.t));
        const v2 = st.v.clone().add(node.dvLeft || node.dv);
        this.predNode = predict(st.r, v2, st.t, { maxT: 8 * 86400, maxSteps: 3500 });
        this.predNode.start = st.r.clone();
      } else this.predNode = null;
      if (!this.moonOrbit || Math.abs(this.moonOrbit.t - ship.t) > 86400) this.buildMoonOrbit(ship.t);
      this.renderInfo();
    }
    // draw relative to the camera
    const moonNow = moonPos(ship.t, new THREE.Vector3());
    const setLine = (line, pts, stride, offset) => {
      const a = line.geometry.attributes.position.array;
      const n = Math.min(pts ? pts.length / stride : 0, a.length / 3);
      for (let i = 0; i < n; i++) {
        a[i * 3] = pts[i * stride] + offset.x - this.camI.x;
        a[i * 3 + 1] = pts[i * stride + 1] + offset.y - this.camI.y;
        a[i * 3 + 2] = pts[i * stride + 2] + offset.z - this.camI.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
    };
    const zero = new THREE.Vector3();
    if (this.pred) {
      setLine(this.lineEarth, this.pred.earthPts, 3, zero);
      setLine(this.lineMoon, this.pred.moonPts, 4, moonNow);
      this.lineMoon.visible = this.pred.moonPts.length > 0;
    }
    if (this.predNode) { setLine(this.lineNode, this.predNode.earthPts, 3, zero); setLine(this.lineNodeMoon, this.predNode.moonPts, 4, moonNow); }
    this.lineNode.visible = this.lineNodeMoon.visible = !!this.predNode;
    if (this.moonOrbit) setLine(this.lineMoonOrbit, this.moonOrbit.pts, 3, zero);
    this.shipMark.position.copy(ship.r).sub(this.camI);
    this.updateLabels(camera, moonNow);
    return this.camI;
  }

  buildMoonOrbit(t) {
    const pts = [];
    const v = new THREE.Vector3();
    for (let i = 0; i <= 400; i++) { moonPos(t + (i / 400) * 27.32 * 86400, v); pts.push(v.x, v.y, v.z); }
    this.moonOrbit = { t, pts };
  }

  updateLabels(camera, moonNow) {
    for (const l of this.labels) l.remove();
    this.labels = [];
    const ship = this.game.ship, U = this.game.hud.units;
    const add = (posI, text, cls = '') => {
      const p = posI.clone().sub(this.camI);
      const v = p.clone().project(camera);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return;
      const d = document.createElement('div');
      d.className = 'maplabel ' + cls;
      d.textContent = text;
      d.style.cssText = `position:fixed;left:${(v.x * 0.5 + 0.5) * innerWidth}px;top:${(-v.y * 0.5 + 0.5) * innerHeight}px;transform:translate(-50%,-140%);font:600 12px var(--display);letter-spacing:.05em;color:${cls === 'moon' ? 'var(--violet)' : cls === 'node' ? '#5aa8ff' : 'var(--amber)'};text-shadow:0 0 6px #000;pointer-events:none;white-space:nowrap;z-index:6`;
      document.body.appendChild(d);
      this.labels.push(d);
    };
    // apsides around the current body
    const body = ship.env.body;
    const rs = relState(ship, body);
    const el = elements(rs.r, rs.v, rs.mu);
    const center = body === EARTH ? new THREE.Vector3() : moonNow;
    if (el.e < 1 && el.ev.length() > 1e-4) {
      const peDir = el.ev.clone().normalize();
      add(center.clone().addScaledVector(peDir, el.pe), `Pe ${U.dist(el.pe - body.R)}`);
      if (isFinite(el.ap)) add(center.clone().addScaledVector(peDir, -el.ap), `Ap ${U.dist(el.ap - body.R)}`);
    }
    add(moonNow, 'MOON', 'moon');
    add(ship.r, 'YOU');
    const P = this.pred;
    if (P && P.closeMoon && P.closeMoon.d < MOON.soi && P.moonPts.length) {
      add(moonNow.clone().add(P.closeMoon.r), `Moon Pe ${U.dist(P.closeMoon.d - MOON.R)}`, 'moon');
    }
    if (P && P.impact) add(P.impact.body === EARTH ? P.impact.r : moonNow.clone().add(P.impact.r), P.impact.body === EARTH ? 'Impact/Reentry' : 'Lunar impact', 'moon');
    if (this.predNode && this.predNode.start) add(this.predNode.start, 'Burn', 'node');
  }

  renderInfo() {
    const ship = this.game.ship, U = this.game.hud.units;
    const body = ship.env.body;
    const rs = relState(ship, body);
    const el = elements(rs.r, rs.v, rs.mu);
    let h = `<div><b>${body.name}</b> · ${U.dist(ship.env.h)} up · ${U.speed(rs.v.length()).join(' ')}</div>`;
    h += `<div>Apoapsis <b>${isFinite(el.ap) ? U.dist(el.ap - body.R) : 'escape'}</b></div>`;
    h += `<div>Periapsis <b>${U.dist(el.pe - body.R)}</b></div>`;
    h += `<div>Inclination <b>${(el.inc * 57.2958).toFixed(1)}°</b></div>`;
    if (el.e < 1) h += `<div>Period <b>${fmtTime(el.period)}</b> · Ap in <b>${fmtTime(el.tAp)}</b></div>`;
    const P = this.pred;
    if (P) {
      if (P.soiIn) h += `<div style="color:var(--violet)">Moon encounter in ${fmtTime(P.soiIn - ship.t)}</div>`;
      if (P.closeMoon && P.closeMoon.d < MOON.soi) h += `<div style="color:var(--violet)">Closest to Moon: ${U.dist(P.closeMoon.d - MOON.R)}</div>`;
      if (P.impact) h += `<div style="color:var(--red)">${P.impact.body.name} ${P.impact.body === EARTH ? 'atmosphere/impact' : 'impact'} in ${fmtTime(P.impact.t - ship.t)}</div>`;
    }
    h += `<div class="dim">Δv left ≈ ${Math.round(deltaV(ship.craft)).toLocaleString('en-US')} m/s (vacuum)</div>`;
    this.game.progress.orbitCheck(body, el.pe);
    $('m-info').innerHTML = h;
    if (this.planDirty) { this.planDirty = false; this.renderPlan(); }
    this.renderNode();
  }

  // ----- planning panel -----
  renderPlan() {
    const ship = this.game.ship, C = this.game.controller;
    const body = ship.env.body;
    const rs = relState(ship, body);
    const el = elements(rs.r, rs.v, rs.mu);
    const p = $('m-plan');
    const btns = [];
    const inAtmo = body === EARTH && ship.env.h < EARTH.atmoTop;
    if (body === EARTH) {
      if (inAtmo && el.pe - EARTH.R < 140000) btns.push(['Autopilot: ascend to orbit', () => this.game.engage(ascentAp())]);
      if (el.e < 1 && el.ap - EARTH.R > 140000) btns.push(['Circularize at apoapsis', () => this.plan(() => planCircularize(ship, true))]);
      if (el.pe - EARTH.R > 140000) {
        btns.push(['Go to the Moon', () => this.planAsync((cb) => planMoonTransfer(ship, 120000, cb))]);
        btns.push(['Deorbit for reentry (Pe 40 km)', () => this.plan(() => planPeriapsis(ship, 40000))]);
      }
    } else {
      if (el.e >= 1 || el.ap - MOON.R > 3000000) btns.push(['Capture into lunar orbit', () => this.plan(() => planCapture(ship))]);
      if (el.e < 1) btns.push(['Return to Earth', () => this.planAsync((cb) => planReturn(ship, 45000, cb))]);
      if (el.e < 1) btns.push(['Circularize at apoapsis', () => this.plan(() => planCircularize(ship, true))]);
      btns.push(['Autopilot: land on the Moon', () => { this.game.engage(landAp()); this.game.toggleMap(); }]);
    }
    let h = '<div class="dim small">Plan a burn — the autopilot can fly it for you.</div>';
    p.innerHTML = h;
    for (const [label, fn] of btns) {
      const b = document.createElement('button'); b.className = 'btn sm wide'; b.textContent = label;
      b.addEventListener('click', () => { this.game.audio.click(); fn(); });
      p.appendChild(b);
    }
    const nd = document.createElement('div'); nd.id = 'm-node'; p.appendChild(nd);
    const prog = document.createElement('div'); prog.className = 'prog'; prog.id = 'm-prog'; prog.hidden = true; prog.innerHTML = '<i></i>'; p.appendChild(prog);
    this.renderNode();
  }

  plan(fn) {
    const node = fn();
    if (!node) { this.game.hud.toast('No solution from here', 'bad'); return; }
    this.setNode(node);
  }
  async planAsync(fn) {
    if (this.busy) return;
    const pg = $('m-prog'); pg.hidden = false;
    this.busy = true;
    this.game.hud.toast('Computing trajectory…');
    try {
      const node = await fn((f) => { pg.firstChild.style.width = (f * 100).toFixed(0) + '%'; });
      if (!node) this.game.hud.toast('No transfer found — try from a circular orbit', 'bad');
      else this.setNode(node);
    } finally { this.busy = false; pg.hidden = true; this.predT = 0; }
  }
  setNode(node) {
    const C = this.game.controller;
    C.node = { ...node };
    C.cancelAp();
    this.predT = 0;
    this.renderNode();
  }
  renderNode() {
    const el = $('m-node'); if (!el) return;
    const ship = this.game.ship, C = this.game.controller;
    const n = C.node;
    if (!n) { el.innerHTML = ''; return; }
    const dv = (n.dvLeft || n.dv).length();
    const bt = burnTime(ship, dv);
    const executing = C.ap && C.ap.name === 'Burn';
    el.innerHTML = `<div class="node"><div><b>${n.label}</b></div><div>Δv <b>${Math.round(dv)} m/s</b> · burn ${isFinite(bt) ? fmtTime(bt) : 'no thrust'}</div><div>In <b>${fmtTime(n.t - ship.t)}</b>${n.moonPe !== undefined ? ` · Moon Pe ${this.game.hud.units.dist(n.moonPe)}` : ''}${n.earthPe !== undefined ? ` · Earth Pe ${this.game.hud.units.dist(n.earthPe)}` : ''}</div></div>`;
    const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px';
    const b1 = document.createElement('button'); b1.className = 'btn sm primary'; b1.textContent = executing ? 'Flying…' : 'Autopilot';
    b1.disabled = executing;
    b1.onclick = () => { C.engage(nodeExec(n)); this.game.hud.toast('Autopilot will fly the burn'); this.renderNode(); };
    const b2 = document.createElement('button'); b2.className = 'btn sm'; b2.textContent = 'Warp to it';
    b2.onclick = () => { this.game.warpTo(n.t - bt / 2 - 30); if (!executing) C.engage(nodeExec(n)); };
    const b3 = document.createElement('button'); b3.className = 'btn sm'; b3.textContent = 'Delete';
    b3.onclick = () => { C.node = null; if (executing) C.cancelAp(); this.predNode = null; this.renderNode(); };
    row.append(b1, b2, b3);
    el.appendChild(row);
  }
}
