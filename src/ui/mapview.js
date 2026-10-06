// Map view: orbit camera around Earth/Moon/ship, predicted trajectories, apsis labels and burn planning.
import * as THREE from 'three';
import { EARTH, MOON, clamp, fmtTime, D2R, llh, toLLH, gcDist, gcBearing, gcDest } from '../core/geo.js';
import { moonPos, moonVel } from '../core/astro.js';
import { predict, elements, relState, propagate, planCircularize, planMoonTransfer, planReturn, planCapture, planPeriapsis, planCorrection, planDeorbitTo, planLandingTo, planMoonLandingTo, landingModel, burnTime, deltaV } from '../ship/orbit.js';
import { nodeExec, landAp, ascentAp, reentryAp, coastToAp, landRunwayAp, sequenceAp, flyHomeAp, planBurnAp } from '../ship/control.js';
import { kepler, closestApproach, relInclination, planPlaneMatch, planIntercept, rendezvousAp } from '../ship/rendezvous.js';
import { STATION } from '../world/station.js';

const $ = (id) => document.getElementById(id);

// places to land on the Moon (selenographic, east positive)
export const MOON_SITES = [
  { name: 'Tranquility Base', sub: 'Apollo 11, 1969', lat: 0.674, lon: 23.473 },
  { name: 'Ocean of Storms', sub: 'Apollo 12 and Surveyor 3', lat: -3.012, lon: -23.422 },
  { name: 'Hadley Rille', sub: 'Apollo 15', lat: 26.132, lon: 3.634 },
  { name: 'Taurus–Littrow', sub: 'Apollo 17, the last crewed landing', lat: 20.191, lon: 30.772 },
  { name: 'Von Kármán crater', sub: 'Chang’e 4, far side', lat: -45.444, lon: 177.588 },
  { name: 'Shackleton rim', sub: 'South pole', lat: -89.4, lon: 129.8 },
  { name: 'Tycho crater', sub: 'Bright young crater', lat: -43.3, lon: -11.2 },
  { name: 'Copernicus crater', sub: '93 km wide, terraced walls', lat: 9.62, lon: -20.08 },
];

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
    this.lineEarthAfter = mk(0xffb347, 0.55);   // after leaving the Moon's sphere of influence
    this.lineNodeAfter = mk(0x5aa8ff, 0.5);
    this.lineStation = mk(0x73e2a7, 0.75);
    this.lineDest = mk(0xffb347, 0.85);
    // ship marker
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'); x.fillStyle = '#7fd4ff'; x.beginPath(); x.moveTo(32, 6); x.lineTo(54, 56); x.lineTo(32, 44); x.lineTo(10, 56); x.closePath(); x.fill();
    this.shipMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
    this.shipMark.scale.set(0.035, 0.035, 1); this.shipMark.renderOrder = 60; this.group.add(this.shipMark);
    // the station: a green square
    const c2 = document.createElement('canvas'); c2.width = c2.height = 64;
    const x2 = c2.getContext('2d'); x2.strokeStyle = '#73e2a7'; x2.lineWidth = 7; x2.strokeRect(14, 14, 36, 36); x2.fillStyle = '#73e2a7'; x2.fillRect(27, 27, 10, 10);
    this.stMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c2), depthTest: false, sizeAttenuation: false }));
    this.stMark.scale.set(0.028, 0.028, 1); this.stMark.renderOrder = 59; this.group.add(this.stMark);
    this.ca = null; this.stPts = null;
    // the destination: an amber pin and the great-circle route to it along the ground
    const c3 = document.createElement('canvas'); c3.width = c3.height = 64;
    const x3 = c3.getContext('2d'); x3.fillStyle = '#ffb347'; x3.beginPath(); x3.arc(32, 22, 14, 0, Math.PI * 2); x3.fill(); x3.beginPath(); x3.moveTo(20, 30); x3.lineTo(32, 60); x3.lineTo(44, 30); x3.fill(); x3.fillStyle = '#1b1206'; x3.beginPath(); x3.arc(32, 22, 5, 0, Math.PI * 2); x3.fill();
    this.dstMark = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c3), depthTest: false, sizeAttenuation: false }));
    this.dstMark.center.set(0.5, 0.05);
    this.dstMark.scale.set(0.034, 0.034, 1); this.dstMark.renderOrder = 61; this.dstMark.visible = false; this.group.add(this.dstMark);
    this.destPtsF = null;
    // tap the globe (without dragging) to choose a destination there
    const cv = game.canvas;
    cv.addEventListener('pointerdown', (e) => { if (game.mapOpen) this._tap = { x: e.clientX, y: e.clientY, t: performance.now(), n: (this._tap && performance.now() - this._tap.t < 400 ? 2 : 1) }; });
    cv.addEventListener('pointerup', (e) => {
      const tp = this._tap; this._tap = null;
      if (!tp || !game.mapOpen || tp.n > 1) return;
      if (Math.hypot(e.clientX - tp.x, e.clientY - tp.y) > 8 || performance.now() - tp.t > 450) return;
      this.tapAt(e.clientX, e.clientY);
    });
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
    for (const [k, n] of [['ship', 'Ship'], ['earth', 'Earth'], ['moon', 'Moon'], ['station', 'Station']]) {
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
    $('m-attrib').hidden = k === 'moon';
    for (const b of $('m-focus').children) b.classList.toggle('on', b.dataset.k === k);
    if (reset) this.dist = k === 'earth' ? 4.2 * EARTH.R : k === 'moon' ? 6 * MOON.R : 3 * EARTH.R;
    if (k === 'ship' || k === 'station') this.dist = Math.max(2e5, Math.min(this.dist, 2e7));
  }

  focusPos(out) {
    const ship = this.game.ship;
    if (this.focus === 'earth') return out.set(0, 0, 0);
    if (this.focus === 'moon') return moonPos(ship.t, out);
    if (this.focus === 'station') return out.copy(this.game.station.r);
    return out.copy(ship.r);
  }

  // camera and drawing; returns the camera position in frame I
  update(dt, cam, camera) {
    const ship = this.game.ship;
    this.yaw -= cam.dx * 0.005; this.pitch = clamp(this.pitch + cam.dy * 0.005, -1.5, 1.5);
    this.dist *= Math.exp(cam.zoom * 0.15);
    const minD = this.focus === 'moon' ? MOON.R * 1.3 : this.focus === 'earth' ? EARTH.R * 1.3 : this.focus === 'station' ? 2e3 : 5e4;
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
      this.buildStation(ship);
      this.buildDest(ship);
      this.renderInfo();
    }
    // draw relative to the camera
    const moonNow = moonPos(ship.t, new THREE.Vector3());
    const setLine = (line, pts, stride, offset, i0 = 0, i1 = Infinity) => {
      const a = line.geometry.attributes.position.array;
      const total = pts ? pts.length / stride : 0;
      const s0 = Math.max(0, i0), s1 = Math.min(total, i1);
      const n = Math.max(0, Math.min(s1 - s0, a.length / 3));
      for (let k = 0; k < n; k++) {
        const i = s0 + k;
        a[k * 3] = pts[i * stride] + offset.x - this.camI.x;
        a[k * 3 + 1] = pts[i * stride + 1] + offset.y - this.camI.y;
        a[k * 3 + 2] = pts[i * stride + 2] + offset.z - this.camI.z;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.setDrawRange(0, n);
      line.visible = n > 1;
    };
    // Earth-frame path up to the Moon's sphere of influence, the Moon-relative path around the Moon, then the path after leaving it
    const drawPred = (P, lE, lM, lA) => {
      if (!P) { lE.visible = lM.visible = lA.visible = false; return; }
      const zero = new THREE.Vector3();
      if (P.startInSoi) lE.visible = false;
      else setLine(lE, P.earthPts, 3, zero, 0, P.soiInIdx >= 0 ? P.soiInIdx + 1 : Infinity);
      setLine(lM, P.moonPts, 4, moonNow);
      if (P.soiOutIdx >= 0) setLine(lA, P.earthPts, 3, zero, P.soiOutIdx); else lA.visible = false;
    };
    drawPred(this.pred, this.lineEarth, this.lineMoon, this.lineEarthAfter);
    drawPred(this.predNode, this.lineNode, this.lineNodeMoon, this.lineNodeAfter);
    if (this.moonOrbit) setLine(this.lineMoonOrbit, this.moonOrbit.pts, 3, new THREE.Vector3());
    if (this.stPts) setLine(this.lineStation, this.stPts, 3, new THREE.Vector3()); else this.lineStation.visible = false;
    this.stMark.position.copy(this.game.station.r).sub(this.camI);
    if (this.destPtsF && this.game.dest) {
      const q = this.game.eph.earthQ, a = this.lineDest.geometry.attributes.position.array, P = this.destPtsF, v = new THREE.Vector3();
      const n = Math.min(P.length / 3, a.length / 3);
      for (let i = 0; i < n; i++) { v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]).applyQuaternion(q).sub(this.camI); a[i * 3] = v.x; a[i * 3 + 1] = v.y; a[i * 3 + 2] = v.z; }
      this.lineDest.geometry.attributes.position.needsUpdate = true; this.lineDest.geometry.setDrawRange(0, n); this.lineDest.visible = n > 1;
      const d = this.game.dest;
      this.dstMark.position.copy(llh(d.lat, d.lon, 2000, EARTH.R, v)).applyQuaternion(q).sub(this.camI); this.dstMark.visible = true;
    } else { this.lineDest.visible = false; this.dstMark.visible = false; }
    this.shipMark.position.copy(ship.r).sub(this.camI);
    this.updateLabels(camera, moonNow);
    return this.camI;
  }

  // the station's orbit and the closest approach to it over the next orbit and a half
  buildStation(ship) {
    const st = this.game.station;
    st.advanceTo(ship.t);
    const T = 2 * Math.PI * Math.sqrt(st.r.length() ** 3 / EARTH.mu);
    const pts = [];
    for (let i = 0; i <= 200; i++) { const k = kepler(st.r, st.v, (i / 200) * T); pts.push(k.r.x, k.r.y, k.r.z); }
    this.stPts = pts;
    const el = elements(ship.r, ship.v, EARTH.mu);
    this.ca = ship.env.body === EARTH && !ship.docked && el.e < 1 && el.pe > EARTH.R + 60000 ? closestApproach(ship, st) : null;
  }

  // the ground route from the ship (or its sub-point) to the destination, in Earth-fixed coordinates
  buildDest(ship) {
    const d = this.game.dest, E = ship.env;
    if (!d) { this.destPtsF = null; return; }
    const lat0 = E.body === EARTH ? E.lat : d.lat, lon0 = E.body === EARTH ? E.lon : d.lon;
    const D = gcDist(lat0, lon0, d.lat, d.lon), b = gcBearing(lat0, lon0, d.lat, d.lon);
    const pts = [], v = new THREE.Vector3(), N = Math.max(2, Math.min(180, Math.ceil(D / 50000)));
    for (let i = 0; i <= N; i++) { const p = gcDest(lat0, lon0, b, (D * i) / N); llh(p.lat, p.lon, 3000, EARTH.R, v); pts.push(v.x, v.y, v.z); }
    this.destPtsF = pts;
  }
  // a tap on the globe: the nearest airport or city there becomes the destination
  tapAt(x, y) {
    const g = this.game, cam = g.camera;
    cam.updateMatrixWorld(true);
    const ndc = new THREE.Vector3((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1, 0.5);
    const dir = ndc.unproject(cam).sub(cam.position).normalize();
    const oc = this.camI.clone();                       // ray origin relative to the Earth's centre
    const b = oc.dot(dir), c = oc.lengthSq() - EARTH.R * EARTH.R, disc = b * b - c;
    if (disc < 0) return;
    const tHit = -b - Math.sqrt(disc);
    if (tHit < 0) return;
    const pI = oc.addScaledVector(dir, tHit);
    const ll = toLLH(g.eph.toFixed(EARTH, pI, new THREE.Vector3()), EARTH.R);
    const p = g.places.near(ll.lat, ll.lon);
    g.setDest(p);
    this.renderPlan();
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
      d.style.cssText = `position:fixed;left:${(v.x * 0.5 + 0.5) * innerWidth}px;top:${(-v.y * 0.5 + 0.5) * innerHeight}px;transform:translate(-50%,-140%);font:600 12px var(--display);letter-spacing:.05em;color:${cls === 'moon' ? 'var(--violet)' : cls === 'node' ? '#5aa8ff' : cls === 'st' ? 'var(--green)' : 'var(--amber)'};text-shadow:0 0 6px #000;pointer-events:none;white-space:nowrap;z-index:6`;
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
      if (el.pe > body.R) add(center.clone().addScaledVector(peDir, el.pe), `Pe ${U.dist(el.pe - body.R)}`);
      if (isFinite(el.ap)) add(center.clone().addScaledVector(peDir, -el.ap), `Ap ${U.dist(el.ap - body.R)}`);
    }
    add(moonNow, 'MOON', 'moon');
    add(ship.r, 'YOU');
    const st = this.game.station;
    if (!ship.docked) add(st.r, STATION.short.toUpperCase(), 'st');
    if (this.ca && this.ca.t > ship.t + 30) {
      add(this.ca.rShip, `Closest ${U.dist(this.ca.d)}`, 'st');
      if (this.ca.d > 20000) add(this.ca.rSt, `${STATION.short} then`, 'st');
    }
    const P = this.pred;
    if (P && P.closeMoon && P.closeMoon.d < MOON.soi && P.moonPts.length) {
      add(moonNow.clone().add(P.closeMoon.r), `Moon Pe ${U.dist(P.closeMoon.d - MOON.R)}`, 'moon');
    }
    if (P && P.soiIn && !P.startInSoi) add(moonPos(P.soiIn, new THREE.Vector3()), 'Moon at encounter', 'moon');
    if (P && P.impact) add(P.impact.body === EARTH ? P.impact.r : moonNow.clone().add(P.impact.r), P.impact.body === EARTH ? 'Impact/Reentry' : 'Lunar impact', 'moon');
    if (this.dstMark.visible && this.game.dest) add(this.dstMark.position.clone().add(this.camI), `${this.game.dest.code || this.game.dest.name}`, '');
    if (this.predNode && this.predNode.start) add(this.predNode.start, 'Burn', 'node');
  }

  renderInfo() {
    const ship = this.game.ship, U = this.game.hud.units;
    const body = ship.env.body;
    const rs = relState(ship, body);
    const el = elements(rs.r, rs.v, rs.mu);
    let h = `<div><b>${body.name}</b> · ${U.dist(ship.env.h)} up · ${U.speed(rs.v.length()).join(' ')}</div>`;
    const P = this.pred;
    const arr = this.arrival();
    if (arr) {
      // on the way to Earth the two-body numbers are skewed by the Moon: show the predicted arrival instead
      h += `<div>Arrival periapsis <b>${arr.peAlt < 0 ? 'below the surface' : U.dist(arr.peAlt)}</b> in <b>${fmtTime(arr.t - ship.t)}</b></div>`;
      h += `<div>Arrival inclination <b>${(arr.inc * 57.2958).toFixed(1)}°</b></div>`;
    } else {
      h += `<div>Apoapsis <b>${isFinite(el.ap) ? U.dist(el.ap - body.R) : 'escape'}</b></div>`;
      h += `<div>Periapsis <b>${el.pe < body.R ? 'below the surface' : U.dist(el.pe - body.R)}</b></div>`;
      h += `<div>Inclination <b>${(el.inc * 57.2958).toFixed(1)}°</b></div>`;
      if (el.e < 1) h += `<div>Period <b>${fmtTime(el.period)}</b> · Ap in <b>${fmtTime(el.tAp)}</b></div>`;
    }
    if (P) {
      if (P.soiIn) h += `<div style="color:var(--violet)">Moon encounter in ${fmtTime(P.soiIn - ship.t)}</div>`;
      if (P.closeMoon && P.closeMoon.d < MOON.soi) h += `<div style="color:var(--violet)">Closest to Moon: ${U.dist(P.closeMoon.d - MOON.R)}</div>`;
      if (P.impact) h += `<div style="color:var(--red)">${P.impact.body.name} ${P.impact.body === EARTH ? 'atmosphere/impact' : 'impact'} in ${fmtTime(P.impact.t - ship.t)}</div>`;
    }
    if (body === EARTH) {
      const st = this.game.station;
      if (ship.docked) h += `<div style="color:var(--green)">Docked at ${STATION.name}</div>`;
      else {
        const di = relInclination(ship, st) / D2R;
        h += `<div style="color:var(--green)">${STATION.short}: ${U.dist(ship.r.distanceTo(st.r))} away · planes ${di.toFixed(2)}° apart</div>`;
        if (this.ca && this.ca.t > ship.t + 30) h += `<div style="color:var(--green)">Closest approach ${U.dist(this.ca.d)} in ${fmtTime(this.ca.t - ship.t)} at ${this.ca.vRel < 100 ? this.ca.vRel.toFixed(1) : Math.round(this.ca.vRel)} m/s</div>`;
      }
    }
    h += `<div class="dim">Δv left ≈ ${Math.round(deltaV(ship.craft)).toLocaleString('en-US')} m/s (vacuum)</div>`;
    this.game.progress.orbitCheck(body, el.pe);
    $('m-info').innerHTML = h;
    if (!this.busy && (this.planDirty || this.planButtons().map((b) => b[0]).join('|') !== this._planSig)) { this.planDirty = false; this.renderPlan(); }
    this.renderNode();
  }

  // the predicted approach to Earth when coming back from far out (null in ordinary orbits)
  arrival() {
    const ship = this.game.ship, P = this.pred;
    if (!P || ship.env.body !== EARTH || ship.env.h < 2e6 || P.soiIn) return null;
    const pe = P.earthPe;
    if (!pe || !isFinite(pe.d) || pe.t < ship.t + 60 || pe.t > P.tEnd - 60) return null;
    const hl = Math.hypot(pe.hx, pe.hy, pe.hz);
    return { peAlt: P.impact && P.impact.body === EARTH ? -1 : pe.d - EARTH.R, t: pe.t, inc: Math.acos(clamp(pe.hy / Math.max(1, hl), -1, 1)) };
  }

  // ----- planning panel -----
  planButtons() {
    const ship = this.game.ship, E = ship.env;
    const body = ship.env.body;
    const rs = relState(ship, body);
    const el = elements(rs.r, rs.v, rs.mu);
    const P = this.pred;
    const btns = [];
    const inAtmo = body === EARTH && ship.env.h < EARTH.atmoTop;
    if (body === EARTH) {
      const toMoon = P && P.soiIn;
      const farOut = el.e >= 1 || el.ap - EARTH.R > 5e6;
      if (inAtmo && el.pe - EARTH.R < 140000) btns.push(['Autopilot: ascend to orbit', () => this.game.engage(ascentAp())]);
      const arr = this.arrival();
      const peAlt = arr ? arr.peAlt : el.pe - EARTH.R;
      if (toMoon && !inAtmo) btns.push(['Fine-tune Moon approach (100 km)', () => this.planAsync((cb) => planCorrection(ship, MOON, 100000, cb), 'Already on course')]);
      if (farOut && !toMoon && !inAtmo && el.e < 1 && peAlt > 140000) btns.push(['Brake into low orbit at periapsis', () => this.plan(() => planCircularize(ship, false))]);
      const hm = this.homeAirport();
      if (farOut && !toMoon && !inAtmo && el.e < 1.2 && this.canComeHome()) btns.push(['Autopilot: fly me home…', () => this.pickHome((a) => this.flyHomeAll(a))]);
      if (farOut && !toMoon && !inAtmo && peAlt > 140000) btns.push([`Fine-tune arrival (Pe 250 km${hm ? ', lined up for ' + this.code(hm) : ''})`, () => this.planAsync((cb) => planCorrection(ship, EARTH, 250000, cb, { iMin: this.iMinFor(hm) }), 'Already on course')]);
      if (farOut && !toMoon && !inAtmo) btns.push(['Fine-tune reentry (Pe 45 km, hot!)', () => this.planAsync((cb) => planCorrection(ship, EARTH, 45000, cb), 'Already on course')]);
      if (peAlt < 100000 && E.h > 60000 && E.h < 400000 && E.vSurf > 2500) btns.push(['Autopilot: reentry', () => { this.game.engage(reentryAp()); this.game.toggleMap(); }]);
      if (el.e < 1 && el.ap - EARTH.R > 140000 && !toMoon) btns.push(['Circularize at apoapsis',() => this.plan(() => planCircularize(ship, true))]);
      if (el.pe - EARTH.R > 140000 && !farOut) {
        if (this.canGlideHome()) btns.push(['Fly home to an airport…', () => this.pickHome()]);
        else if (this.canLandVertically()) btns.push(['Land at an airport…', () => this.pickHome((a) => this.planLandHome(a))]);
        // the station
        const st = this.game.station, docks = ship.craft.docks.length > 0;
        if (!ship.docked) {
          btns.push([`Autopilot: rendezvous${docks ? ' and dock' : ''} with ${STATION.short}`, () => { this.game.engage(rendezvousAp(ship, st)); this.renderPlan(); }]);
          const di = relInclination(ship, st);
          if (di > 0.0009) btns.push([`Match planes with ${STATION.short} (${(di / D2R).toFixed(2)}°)`, () => this.plan(() => planPlaneMatch(ship, st))]);
          if (ship.r.distanceTo(st.r) > 20000) btns.push([`Intercept ${STATION.short}`, () => this.planAsync((cb) => planIntercept(ship, st, cb), `No transfer to ${STATION.short} found`)]);
          if (this.ca && this.ca.d < 20000 && this.ca.t > ship.t + 60) btns.push([`Match speed at closest approach (${this.game.hud.units.dist(this.ca.d)})`, () => this.plan(() => this.planMatchAtClosest())]);
        }
        btns.push(['Go to the Moon', () => this.planAsync((cb) => planMoonTransfer(ship, 120000, cb))]);
        btns.push(['Deorbit for reentry (Pe 40 km)', () => this.plan(() => planPeriapsis(ship, 40000))]);
      }
    } else {
      const peAlt = el.pe - MOON.R;
      if (el.e >= 1 && (peAlt < 30000 || peAlt > 400000)) btns.push(['Adjust approach (Pe 100 km)', () => this.planAsync((cb) => planCorrection(ship, MOON, 100000, cb), 'Already on course')]);
      if (el.e >= 1 || el.ap - MOON.R > 3000000) btns.push(['Capture into lunar orbit', () => this.plan(() => planCapture(ship))]);
      const hm = this.homeAirport();
      const landed = E.agl < 50 && E.vSurf < 5;
      if ((el.e < 1 || landed) && this.canComeHome()) btns.push([landed ? 'Autopilot: take off and fly me home…' : 'Autopilot: fly me home…', () => this.pickHome((a) => this.flyHomeAll(a))]);
      if (el.e < 1 && !landed) {
        // spaceplanes come home into Earth orbit and reenter from there; heat-shielded craft can dive straight in
        const shield = ship.craft.parts.some((P) => P.alive && P.def.shield);
        const lined = hm ? ` (lined up for ${this.code(hm)})` : '';
        btns.push([(shield ? 'Return to Earth (direct reentry)' : 'Return to Earth orbit') + lined, () => this.planAsync((cb) => planReturn(ship, shield ? 45000 : 250000, cb, { iMin: this.iMinFor(hm) }))]);
      }
      if (E.agl < 20000 && E.vSurf < 300) btns.push(['Autopilot: take off to lunar orbit', () => { this.game.engage(ascentAp()); this.game.toggleMap(); }]);
      if (el.e < 1) btns.push(['Circularize at apoapsis', () => this.plan(() => planCircularize(ship, true))]);
      if (el.e < 1 && !landed) btns.push(['Land at a site…', () => this.pickMoonSite()]);
      btns.push(['Autopilot: land on the Moon', () => { this.game.engage(landAp()); this.game.toggleMap(); }]);
    }
    return btns;
  }

  renderPlan() {
    const p = $('m-plan');
    const btns = this.planButtons();
    this._planSig = btns.map((b) => b[0]).join('|');
    const g = this.game, d = g.dest, E = g.ship.env;
    let h = '<div class="dim small">Plan a burn — the autopilot can fly it for you. Tap the globe to pick a destination.</div>';
    if (d) h += `<div class="small" style="color:var(--amber);margin:2px 0">▸ ${d.name} <span class="dim">${d.sub}${E.body === EARTH ? ' · ' + Math.round(gcDist(E.lat, E.lon, d.lat, d.lon) / 1000).toLocaleString('en-US') + ' km' : ''}</span></div>`;
    p.innerHTML = h;
    {
      const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:6px';
      const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = d ? 'Change destination…' : 'Set destination…';
      b.addEventListener('click', () => { g.audio.click(); g.pickDest((pl) => { g.setDest(pl); this.renderPlan(); }); });
      row.appendChild(b);
      if (d) { const x = document.createElement('button'); x.className = 'btn sm'; x.textContent = '✕'; x.title = 'Clear destination'; x.addEventListener('click', () => { g.setDest(null); this.renderPlan(); }); row.appendChild(x); }
      p.appendChild(row);
    }
    if (d && E.body === EARTH && (E.rho > 0.02 || g.ship.contacts > 0) && g.canCruise()) {
      const b = document.createElement('button'); b.className = 'btn sm wide primary'; b.textContent = `Autopilot: fly me to ${d.code || d.name}`;
      b.addEventListener('click', () => { g.audio.click(); g.flyTo(d); g.toggleMap(); });
      p.appendChild(b);
    }
    for (const [label, fn] of btns) {
      const b = document.createElement('button'); b.className = 'btn sm wide'; b.textContent = label;
      b.addEventListener('click', () => { this.game.audio.click(); fn(); });
      p.appendChild(b);
    }
    const nd = document.createElement('div'); nd.id = 'm-node'; p.appendChild(nd);
    const prog = document.createElement('div'); prog.className = 'prog'; prog.id = 'm-prog'; prog.hidden = true; prog.innerHTML = '<i></i>'; p.appendChild(prog);
    this.renderNode();
  }

  // winged craft can glide home; this picks the destination airport and plans the deorbit
  canGlideHome() {
    const c = this.game.craft;
    const S = c.wings.reduce((a, P) => a + (P.alive !== false ? P.wing.area : 0), 0);
    return S > c.mass / 1500;
  }
  // tail-sitting rockets that can stand on their engines: they come home by falling engines-first and landing on legs
  canLandVertically() {
    const c = this.game.craft;
    return !!c.vertical && c.engines.some((P) => P.alive !== false && P.eng.mode === 'rocket');
  }
  canComeHome() { return this.canGlideHome() || this.canLandVertically(); }
  // plan a deorbit that brings a vertical lander down on an airport (middle of its longest runway)
  async planLandHome(a) {
    const g = this.game, ship = g.ship, C = g.controller;
    const rw = a.runways.reduce((b, r) => (!b || r.len > b.len ? r : b), null);
    const name = this.code(a), elev = ((rw.e1 || 0) + (rw.e2 || 0)) / 2;
    await this.planAsync((cb) => planLandingTo(ship, rw.latC, rw.lonC, name, cb, landingModel(ship.craft, C.thrustAxis(ship.craft, ship.env), elev)), 'No landing found today');
    const n = C.node;
    if (n && n.target) { n.target.elev = elev; n.vertical = true; this.renderNode(); }
  }
  // pick a famous spot on the Moon and plan the descent to it
  pickMoonSite(onPick = (s) => this.planMoonSite(s), orbitOnly = false) {
    const g = this.game, $b = $('d-btns');
    $('d-title').textContent = 'Land at…';
    $('d-body').innerHTML = '<p class="dim small">The autopilot times the descent burn (it may wait for the Moon to turn the site under your orbit), brakes, and hovers onto the spot.</p>';
    $b.innerHTML = ''; $b.style.flexDirection = 'column';
    for (const site of MOON_SITES) {
      const b = document.createElement('button'); b.className = 'btn wide';
      b.textContent = `${site.name} · ${site.sub}`;
      b.onclick = () => { g.modal('dialog', false); onPick(site); };
      $b.appendChild(b);
    }
    if (orbitOnly) { const o = document.createElement('button'); o.className = 'btn wide'; o.textContent = 'Just into lunar orbit'; o.onclick = () => { g.modal('dialog', false); onPick(null); }; $b.appendChild(o); }
    const c = document.createElement('button'); c.className = 'btn ghost wide'; c.textContent = 'Cancel'; c.onclick = () => g.modal('dialog', false); $b.appendChild(c);
    g.modal('dialog');
  }
  // all on autopilot: plan the descent, wait for it, fly it, brake and hover onto the spot
  landAtSiteAuto(site) {
    const g = this.game, C = g.controller;
    const elev = g.world.groundAt(MOON, site.lat, site.lon) || 0;
    const target = { lat: site.lat, lon: site.lon, elev, name: site.name, body: 'moon' };
    C.node = null;
    C.engage(sequenceAp(`Landing at ${site.name}`, [
      (s0, CC) => planBurnAp('Descent burn', (s) => planMoonLandingTo(s, site.lat, site.lon, site.name, null, landingModel(s.craft, CC.thrustAxis(s.craft, s.env), elev))),
      () => landAp(target),
    ]));
    g.hud.toast(`Autopilot: landing at ${site.name} — it may wait for the Moon to turn the site under your orbit`);
  }
  async planMoonSite(site) {
    const g = this.game, ship = g.ship, C = g.controller;
    const elev = g.world.groundAt(MOON, site.lat, site.lon) || 0;
    await this.planAsync((cb) => planMoonLandingTo(ship, site.lat, site.lon, site.name, cb, landingModel(ship.craft, C.thrustAxis(ship.craft, ship.env), elev)), 'No way down to there from this orbit');
    if (C.node && C.node.target) this.renderNode();
  }
  // the airport this flight started from (where "home" is), if it has a long enough runway
  homeAirport() {
    const a = this.game.site && this.game.site.airport;
    return a && a.runways && a.runways.some((rw) => rw.len > 1500) ? a : null;
  }
  code(a) { return a.iata || a.ident; }
  // the arrival orbit has to be tilted at least this much to pass over the airport (with a little margin)
  iMinFor(a) {
    if (!a) return 0;
    const rw = a.runways.reduce((b, r) => (!b || r.len > b.len ? r : b), null);
    return Math.min(Math.abs(rw.latC) + 3, 85) * D2R;
  }
  // The whole way home from the Moon (or from a return trajectory) to a runway, all on autopilot:
  // take off if landed, leave lunar orbit lined up for the airport, correct course on the way, brake into
  // low Earth orbit, deorbit at the right moment, fly the reentry and land.
  flyHomeAll(a) {
    const g = this.game, A = g.world.airports, C = g.controller, ship = g.ship;
    const rw = a.runways.reduce((b, r) => (!b || r.len > b.len ? r : b), null);
    const name = this.code(a), iMin = this.iMinFor(a);
    C.node = null;
    C.engage(flyHomeAp(ship, { A, rw, airport: a, name, iMin, terrain: g.terrainFn(), vertical: !this.canGlideHome() && this.canLandVertically() }));
    g.hud.toast(`Autopilot: flying you home to ${name}. Time warp runs by itself between burns.`);
    this.renderPlan();
  }
  pickHome(onPick = (a) => this.planHome(a)) {
    const g = this.game, A = g.world.airports;
    const $b = $('d-btns');
    $('d-title').textContent = 'Fly home to…';
    $('d-body').innerHTML = '<p class="dim small">Pick an airport. The autopilot will time the deorbit burn, fly the reentry and land on the runway.</p><input id="d-q" class="field" type="search" placeholder="City or airport (e.g. Paris, SFO)" autocomplete="off" spellcheck="false" style="width:100%;margin:6px 0 4px">';
    const list = (q) => {
      $b.innerHTML = '';
      $b.style.flexDirection = 'column';
      const hm = this.homeAirport();
      const da = g.dest ? (g.dest.airport || (() => { const n = A.nearest(g.dest.lat, g.dest.lon, 1, 1)[0]; return n && n.d < 100000 ? n.a : null; })()) : null;
      const res = q ? A.search(q, 6) : [...new Set([...(da ? [da] : []), ...(hm ? [hm] : []), ...['SFO', 'LHR', 'HND', 'JFK', 'CDG'].map((c) => A.search(c, 1)[0]).filter(Boolean)])];
      for (const a of res) {
        if (!a.runways.some((rw) => rw.len > 1500)) continue;
        const b = document.createElement('button'); b.className = 'btn wide';
        b.textContent = `${a.iata || a.ident} · ${a.name}${a.city ? ', ' + a.city : ''}`;
        b.onclick = () => { g.modal('dialog', false); onPick(a); };
        $b.appendChild(b);
      }
      const c = document.createElement('button'); c.className = 'btn ghost wide'; c.textContent = 'Cancel'; c.onclick = () => g.modal('dialog', false); $b.appendChild(c);
    };
    list('');
    g.modal('dialog');
    const q = $('d-q');
    q.oninput = () => list(q.value);
    setTimeout(() => q.focus(), 50);
  }
  async planHome(a) {
    const rw = a.runways.reduce((b, r) => (!b || r.len > b.len ? r : b), null);
    const name = a.iata || a.ident;
    await this.planAsync((cb) => planDeorbitTo(this.game.ship, rw.latC, rw.lonC, name, cb), 'No deorbit found');
    const n = this.game.controller.node;
    if (n && n.target) {
      n.runway = rw; n.airport = a;
      if (n.miss > 900e3) this.game.hud.toast(`This orbit never passes close to ${name} today — the jets will have to fly the last ${Math.round(n.miss / 1000)} km`, 'bad');
      this.renderNode();
    }
  }

  // a burn at the closest approach that leaves the ship at rest next to the station
  planMatchAtClosest() {
    const ship = this.game.ship, st = this.game.station, ca = this.ca;
    if (!ca) return null;
    const s2 = propagate(ship.r, ship.v, ship.t, ca.t - ship.t);
    const st2 = st.stateAt(ca.t);
    const w = new THREE.Vector3().crossVectors(st2.r, st2.v).divideScalar(st2.r.lengthSq());
    const dv = st2.v.clone().add(new THREE.Vector3().crossVectors(w, s2.r.clone().sub(st2.r))).sub(s2.v);
    return { t: s2.t, dv, body: EARTH, label: `Match speed with ${STATION.short}` };
  }

  plan(fn) {
    const node = fn();
    if (!node) { this.game.hud.toast('No solution from here', 'bad'); return; }
    this.setNode(node);
  }
  async planAsync(fn, failMsg = 'No transfer found — try from a circular orbit') {
    if (this.busy) return;
    const pg = $('m-prog'); pg.hidden = false;
    this.busy = true;
    this.game.hud.toast('Computing trajectory…');
    try {
      const node = await fn((f) => { pg.firstChild.style.width = (f * 100).toFixed(0) + '%'; });
      if (!node) this.game.hud.toast(failMsg, 'bad');
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
    const executing = C.ap && (C.ap.name === 'Burn' || /^(Home to|Landing at)/.test(C.ap.name));
    const have = deltaV(ship.craft, false, (P) => P.eng.active);
    const short = dv > have * 0.98 ? `<div style="color:var(--red)">Not enough fuel: ${Math.round(have)} m/s left on the active engines</div>` : '';
    const homeInfo = !n.target ? '' : n.target.body === 'moon' ? `<div class="dim">Comes down ≈ ${this.game.hud.units.dist(n.miss)} from ${n.target.name}; the landing hovers onto the spot</div>` : n.vertical ? `<div class="dim">Falls to ≈ ${this.game.hud.units.dist(n.miss)} from ${n.target.name}; the landing steers out the rest</div>` : `<div class="dim">Reentry ends ≈ ${this.game.hud.units.dist(n.miss)} from ${n.target.name}</div>`;
    el.innerHTML = `<div class="node"><div><b>${n.label}</b></div><div>Δv <b>${Math.round(dv)} m/s</b> · burn ${isFinite(bt) ? fmtTime(bt) : 'no thrust'}</div>${short}<div>In <b>${fmtTime(n.t - ship.t)}</b>${n.moonPe !== undefined ? ` · Moon Pe ${this.game.hud.units.dist(n.moonPe)}` : ''}${n.earthPe !== undefined ? ` · Earth Pe ${this.game.hud.units.dist(n.earthPe)}` : ''}</div>${homeInfo}</div>`;
    const row = document.createElement('div'); row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px';
    const b1 = document.createElement('button'); b1.className = 'btn sm primary'; b1.textContent = executing ? 'Flying…' : 'Autopilot';
    b1.disabled = executing;
    const home = n.target && (n.runway || n.vertical);
    if (home) b1.textContent = executing ? 'Flying…' : n.target.body === 'moon' ? 'Land there' : 'Fly me home';
    b1.onclick = () => {
      if (home) {
        const g = this.game, A = g.world.airports, name = n.target.name;
        if (n.target.body === 'moon') {
          C.engage(sequenceAp(`Landing at ${name}`, [() => nodeExec(n), () => landAp(n.target)]));
          g.hud.toast(`Autopilot: descent burn, braking and landing at ${name}`);
        } else if (n.vertical) {
          C.engage(sequenceAp(`Home to ${name}`, [() => nodeExec(n), () => landAp(n.target)]));
          g.hud.toast(`Autopilot: deorbit, fall and powered landing at ${name}`);
        } else {
          C.engage(sequenceAp(`Home to ${name}`, [() => nodeExec(n), () => coastToAp(), () => reentryAp(n.target, { then: `lining up for ${name}` }), () => landRunwayAp(A, n.runway, name, g.terrainFn())]));
          g.hud.toast(`Autopilot: deorbit, reentry and landing at ${name}`);
        }
      } else { C.engage(nodeExec(n)); this.game.hud.toast('Autopilot will fly the burn'); }
      this.renderNode();
    };
    const b2 = document.createElement('button'); b2.className = 'btn sm'; b2.textContent = 'Warp to it';
    b2.onclick = () => { this.game.warpTo(n.t - bt / 2 - 30); if (!executing) C.engage(nodeExec(n)); };
    const b3 = document.createElement('button'); b3.className = 'btn sm'; b3.textContent = 'Delete';
    b3.onclick = () => { C.node = null; if (executing) C.cancelAp(); this.predNode = null; this.renderNode(); };
    row.append(b1, b2, b3);
    el.appendChild(row);
  }
}
