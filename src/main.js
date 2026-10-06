// Starforge — game orchestration: screens, flight loop, camera, events.
import * as THREE from 'three';
import { EARTH, MOON, D2R, R2D, clamp, smoothstep, llh, enu, toLLH, gcDist, fmtTime } from './core/geo.js';
import { Ephemeris, nowSimTime, gravity, moonPos, moonVel } from './core/astro.js';
import { loadSettings, load, save } from './core/store.js';
import { Progress, MILESTONES } from './core/progress.js';
import { World } from './world/world.js';
import { Craft } from './ship/craft.js';
import { Ship } from './ship/physics.js';
import { Controller, landAp, ascentAp, nodeExec, reentryAp, landRunwayAp, flyToMoonAp } from './ship/control.js';
import { PRESETS } from './ship/designs.js';
import { PART } from './ship/parts.js';
import { deltaV, elements, relState, predict, engineClass, planCircularize } from './ship/orbit.js';
import { Effects } from './fx/effects.js';
import { Audio } from './fx/audio.js';
import { Input } from './ui/input.js';
import { Hud, fmtWarp } from './ui/hud.js';
import { LaunchScreen } from './ui/launch.js';
import { MapView, MOON_SITES } from './ui/mapview.js';
import { HELP_HTML } from './ui/help.js';
import { Tutorial, flightSchool } from './ui/tutorial.js';
import { Station, STATION, stationKepler } from './world/station.js';
import { rendezvousAp, proxAp, departAp, choosePort } from './ship/rendezvous.js';
import { Places } from './world/places.js';
import { navInfo, headingAp, flyToAp, runwayFor, fmtDist } from './ship/navigate.js';

const $ = (id) => document.getElementById(id);
const x0dv = (g) => deltaV(g.craft, false);
const WARPS = [1, 2, 4, 10, 50, 100, 1000, 10000, 100000];
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

class Game {
  constructor() {
    this.settings = loadSettings();
    this.canvas = $('gl');
    const mobile = matchMedia('(pointer:coarse)').matches;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !mobile, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    // resolution scale: the quality setting sets the ceiling, and it drops automatically if frames get slow
    this.prMax = () => Math.min(window.devicePixelRatio || 1, { low: 1, medium: mobile ? 1.35 : 1.5, high: 2 }[this.settings.quality] || 1.5);
    this.pr = this.prMax();
    this.perf = { acc: 0, n: 0, good: 0, bad: 0 };
    this.renderer.setPixelRatio(this.pr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.3, 1e10);
    this.eph = new Ephemeris().update(nowSimTime());
    this.world = new World(this.scene, this.renderer, this.settings);
    this.world.buildings.enabled = this.settings.buildings !== '0';
    this.effects = new Effects(this.scene);
    this.station = new Station(this.scene);
    this.audio = new Audio();
    this.audio.setOn(this.settings.sound !== '0');
    this.input = new Input(this.canvas);
    this.input.invertPitch = this.settings.invert === '1';
    this.progress = new Progress((m) => { this.hud && this.hud.toast(`★ ${m.name}`, 'big'); this.audio.chime(); });
    this.designs = load('designs', []);
    const lastName = load('lastDesign', 'Kestrel');
    this.design = this.shipList().find((d) => d.name === lastName) || PRESETS[0].make();
    this.lastSite = load('lastSite', null);
    this.state = 'boot';
    this.ship = null;
    this.paused = false;
    this.camMode = 'chase';
    this.cam = { yaw: 0, pitch: 0.18, dist: 30, smooth: new THREE.Vector3(), init: false };
    this.camI = new THREE.Vector3(EARTH.R * 3, EARTH.R * 0.6, EARTH.R * 2.5);
    this.engGroup = 'all';
    this.lights = false;
    this.flightTime = 0;
    this.titleOrbit = 0;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.hud = new Hud(this);
    this.places = new Places(this.world.airports);
    this.dest = null;                 // where the pilot wants to go: { kind, name, code?, sub, lat, lon, airport? }
    this.launchScreen = new LaunchScreen(this);
    this.mapView = new MapView(this);
    this.bindUi();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    this.bootSequence();
    // first user gesture unlocks audio
    const unlock = () => { this.audio.init(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
    window.__sf = this;
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 78 : 62;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- screens ----------------
  show(id) {
    for (const s of ['boot', 'title', 'launch', 'hangar', 'hud', 'mapui']) $(s).classList.toggle('show', s === id);
    this.state = id;
  }
  modal(id, on = true) { $(id).classList.toggle('show', on); }

  async bootSequence() {
    this.show('boot');
    const fill = $('bootfill'), msg = $('bootmsg');
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      const p = this.world.earth.stats.drawn;
      fill.style.width = Math.min(95, 10 + p * 12) + '%';
      msg.textContent = this.world.airports.ready ? 'Streaming the planet…' : 'Loading airports…';
      if (p >= 6 && this.world.airports.ready) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    fill.style.width = '100%';
    this.toTitle();
    this.checkShareLink();
    addEventListener('hashchange', () => this.checkShareLink());
  }

  // a shared ship link (#ship=SF1.…): bring the ship into the hangar
  async checkShareLink() {
    const m = location.hash.match(/^#ship=([A-Za-z0-9._-]+)/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    if (this.ship) { this.pendingShip = m[1]; this.hud.toast('A shared ship is waiting — open the hangar to get it'); return; }
    this.pendingShip = m[1];
    await this.openHangar();
  }

  toTitle() {
    this.endFlight();
    this.show('title');
    const f = load('flight', null);
    $('t-resume').hidden = !f;
    if (f) $('t-resume').textContent = `Continue flight · ${f.design && f.design.name ? f.design.name : 'ship'} ${f.where || ''}`;
    $('t-continue').hidden = !this.lastSite;
    $('t-continue').classList.toggle('primary', !f);
    if (this.lastSite) $('t-continue').textContent = `Fly again · ${this.lastSite.label || 'last site'}`;
  }

  bindUi() {
    $('t-fly').onclick = () => { this.audio.click(); this.openLaunch(); };
    $('t-school').onclick = () => { this.audio.click(); this.startSchool(); };
    $('t-continue').onclick = () => { this.audio.click(); if (this.lastSite) this.relaunch(this.lastSite); };
    $('t-hangar').onclick = () => { this.audio.click(); this.openHangar(); };
    $('t-settings').onclick = () => this.openSettings();
    $('t-log').onclick = () => this.openLog();
    $('t-help').onclick = () => this.openHelp();
    for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => { this.audio.click(); if (this.state === 'hangar' && this.builder && this.builder.onBack) this.builder.onBack(); this.toTitle(); };
    for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => { b.closest('.modal').classList.remove('show'); };
    $('h-menu').onclick = () => this.pause(true);
    $('h-cam').onclick = () => this.cycleCam();
    $('h-map').onclick = () => this.toggleMap();
    $('h-wd').onclick = () => this.warpStep(-1);
    $('h-wu').onclick = () => this.warpStep(1);
    $('p-resume').onclick = () => this.pause(false);
    $('p-restart').onclick = () => { this.pause(false); this.relaunch(this.site); };
    $('p-hangar').onclick = () => { this.pause(false); this.openHangar(); };
    $('p-site').onclick = () => { this.pause(false); this.endFlight(); this.openLaunch(); };
    $('p-settings').onclick = () => this.openSettings();
    $('p-help').onclick = () => this.openHelp();
    $('p-title').onclick = () => { this.pause(false); this.toTitle(); };
    $('c-restart').onclick = () => { this.modal('crash', false); if (this.site && this.site.resumed && this.resumeSnap) this.resumeFlight(this.resumeSnap); else this.relaunch(this.site); };
    $('t-resume').onclick = () => { this.audio.click(); const f = load('flight', null); if (f) this.resumeFlight(f); };
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveFlight(); });
    addEventListener('pagehide', () => this.saveFlight());
    $('c-hangar').onclick = () => { this.modal('crash', false); this.openHangar(); };
    $('c-title2').onclick = () => { this.modal('crash', false); this.toTitle(); };
    // settings segments
    for (const seg of document.querySelectorAll('.seg')) {
      const key = seg.dataset.set;
      for (const b of seg.children) b.onclick = () => {
        this.settings[key] = b.dataset.v; save('settings', this.settings);
        this.applySettings(); this.syncSettings();
      };
    }
    this.input.bindTouch($('stick'), $('knob'), $('rudder'), $('rknob'), $('thr'), (v) => { this.controller && (this.controller.input.throttle = v); });
  }
  applySettings() {
    this.settings.heatScale = +this.settings.heat;
    this.audio.setOn(this.settings.sound !== '0');
    this.input.invertPitch = this.settings.invert === '1';
    this.world.buildings.enabled = this.settings.buildings !== '0';
    if (this.pr !== this.prMax()) { this.pr = this.prMax(); this.renderer.setPixelRatio(this.pr); this.resize(); }
    if (this.world.quality !== this.settings.quality) this.world.setQuality(this.settings.quality);
  }
  syncSettings() { for (const seg of document.querySelectorAll('.seg')) for (const b of seg.children) b.classList.toggle('on', String(this.settings[seg.dataset.set]) === b.dataset.v); }
  openSettings() { this.syncSettings(); this.modal('settings'); }
  openHelp() { $('help-body').innerHTML = HELP_HTML; this.modal('help'); }
  openLog() {
    const el = $('lb-list'); el.innerHTML = '';
    for (const m of MILESTONES) {
      const d = document.createElement('div'); d.className = 'ach' + (this.progress.has(m.id) ? ' done' : '');
      d.innerHTML = `<div class="ic">${this.progress.has(m.id) ? '★' : '·'}</div><div><div class="nm">${m.name}</div><div class="sub">${m.desc}</div></div>`;
      el.appendChild(d);
    }
    this.modal('logbook');
  }

  shipList() { return [...PRESETS.map((p) => p.make()), ...this.designs]; }
  setDesign(d) { this.design = JSON.parse(JSON.stringify(d)); save('lastDesign', d.name); }

  openLaunch() { this.endFlight(); this.show('launch'); this.launchScreen.open(); }
  async openHangar() {
    this.endFlight();
    if (!this.builder) {
      const { Builder } = await import('./builder/builder.js');
      this.builder = new Builder(this);
    }
    this.show('hangar');
    this.builder.open(this.design);
    if (this.pendingShip) { const code = this.pendingShip; this.pendingShip = null; await this.builder.importCode(code); }
  }

  // ---------------- flight lifecycle ----------------
  launch(site) {
    const label = site.type === 'padAt' ? site.label : site.airport ? `${site.airport.iata || site.airport.ident} ${site.type}` : site.name;
    this.lastSite = { ...site, label, rwIdx: site.rw ? site.rw.idx : undefined, rw: undefined, airport: undefined };
    save('lastSite', this.lastSite);
    this.startFlight(site);
  }
  relaunch(site) {
    if (!site) return this.openLaunch();
    if (site.rwIdx !== undefined && !site.rw) {
      const rw = this.world.airports.runways[site.rwIdx];
      if (!rw) return this.openLaunch();
      site = { ...site, rw, airport: rw.ap };
    }
    this.startFlight(site);
  }

  endFlight() {
    if (this.tutorial && !this._keepTut) this.tutorial.stop();
    if (this.ship) {
      this.scene.remove(this.craft.group);
      this.craft.dispose();
      this.ship = null; this.craft = null;
    }
    this.effects.clearWorld();
    this.station.hide(); this.station.occupied = -1;
    this.world.setHangar(null);
    if (this.spot) { this.scene.remove(this.spot); this.spot = null; }
    this.mapOpen = false;
    this.mapView.close();
    this.paused = false;
  }

  async startFlight(site) {
    this.endFlight();
    this.site = site;
    this.applySettings();
    const craft = new Craft(this.design);
    this.craft = craft;
    this.scene.add(craft.group);
    this.eph.update(this.simStart(site));
    const ship = new Ship(craft, this.world, this.eph, this.settings);
    this.ship = ship;
    this.station.seed(ship.t); this.station.occupied = -1;
    ship.station = this.station;
    const C = this.controller = new Controller(this.settings);
    C.destFn = () => this.dest;
    C.onEngineGroup = (g) => { this.engGroup = this.availableGroups().includes(g) ? g : 'all'; };
    this.effects.attach(craft);
    this.setupLights(craft);
    this.engGroup = 'all';
    this.applyEngGroup();
    this.flightTime = 0;
    this.prevContacts = 0;
    this.cam.init = false;
    this.camMode = 'chase';
    this.cam.dist = Math.max(12, craft.size * 1.5 + 8);
    this.cam.yaw = 0; this.cam.pitch = craft.vertical ? 0.05 : 0.16;
    this.progress.startFlight({ airport: site.airport, ownPad: site.type === 'padAt', custom: !PRESETS.some((p) => p.make().name === this.design.name) });
    const A = this.world.airports;
    let body = EARTH, lat, lon, hdg = 0, needGround = true, h;
    const vert = craft.vertical;
    const hComFor = (ground) => vert ? ground + (craft.box.max.z - craft.com.z) + 0.15 : ground + (craft.com.y - craft.box.min.y) + 0.15;
    if (site.type === 'runway' || site.type === 'hangar' || site.type === 'pad') {
      const rw = site.rw;
      const fromLe = site.fromLe;
      const hang = A.hangarFor(rw, fromLe);
      this.world.setHangar(hang);
      if (site.type === 'runway') {
        const along = fromLe ? -rw.len / 2 + Math.max(40, craft.size) : rw.len / 2 - Math.max(40, craft.size);
        const p = this.rwPoint(rw, along, 0);
        lat = p.lat; lon = p.lon; hdg = fromLe ? rw.brg : rw.brg + Math.PI;
        h = A.elevAt(rw, along);
      } else if (site.type === 'hangar') {
        // inside the hangar, nose toward the runway
        const toRunway = hang.heading - Math.PI / 2;
        const p = this.offsetLL(hang.lat, hang.lon, toRunway, -60 + 30 - craft.size * 0.35);
        lat = p.lat; lon = p.lon; hdg = toRunway;
        h = hang.elev;
      } else {
        const toRunway = hang.heading - Math.PI / 2;
        const p = this.offsetLL(hang.lat, hang.lon, toRunway, 40);
        lat = p.lat; lon = p.lon; hdg = hang.heading;
        h = hang.elev;
      }
    } else if (site.type === 'padAt') {
      lat = site.lat; lon = site.lon; hdg = 0;
      this.world.setLaunchPad(null);
    } else if (site.type === 'moon') {
      body = MOON; lat = site.lat; lon = site.lon; hdg = 0;
    } else if (site.type === 'air') {
      lat = site.lat; lon = site.lon; hdg = site.hdg * D2R; needGround = false;
    } else needGround = false;
    if (site.type === 'docked' || site.type === 'stationNear') {
      // off the station's aft port, facing it; docked there if the ship has a docking port
      const st = this.station, t = ship.t;
      const portI = 1, pPos = new THREE.Vector3(), pAx = new THREE.Vector3(), pUp = new THREE.Vector3();
      st.port(portI, t, pPos, pAx, pUp);
      ship.r.copy(pPos).addScaledVector(pAx, 30 + craft.size * 0.8);
      st.pointVel(ship.r, t, ship.v);
      this.orientTo(ship, pAx.clone().negate(), pUp);
      ship.w.copy(st.w).applyQuaternion(ship.q.clone().invert());
      ship.parked = null; ship.ctl.gear = false;
      C.setSas('hold');
      const part = craft.docks[0];
      if (site.type === 'docked') {
        if (part) { st.dock(ship, part, choosePort(st, ship.bodyToWorld(part.dock.pos, new THREE.Vector3()), t)); ship.events.length = 0; }
        else setTimeout(() => this.hud.toast(`${this.design.name} has no docking port — starting next to the station`, 'bad'), 600);
      }
    }
    // stream terrain at the spawn point before physics starts
    this.show('boot');
    $('bootmsg').textContent = body === MOON ? 'Landing on the Moon…' : 'Preparing the ground…';
    if (site.type === 'orbit' || site.type === 'lunarOrbit') $('bootmsg').textContent = 'Reaching orbit…';
    const camAt = body === MOON ? null : llh(lat || 0, lon || 0, 400, EARTH.R, new THREE.Vector3());
    this.spawning = true;
    if (needGround) {
      const t0 = performance.now();
      while (performance.now() - t0 < 20000) {
        // aim the world streaming at the spawn point
        const pF = llh(lat, lon, (h || 0) + 60, body.R, new THREE.Vector3());
        const pI = this.eph.toI(body, pF, new THREE.Vector3());
        this.camI.copy(pI);
        this.camera.position.set(0, 0, 0);
        this.camera.lookAt(pI.clone().normalize().negate().add(new THREE.Vector3(0.01, 0, 0)));
        this.world.update(this.camI, this.camera, this.eph, 0.016);
        const minZ = body === EARTH ? 13 : 6;
        const ready = this.world.terrainReady(body, lat, lon, minZ);
        $('bootfill').style.width = Math.min(95, 10 + (performance.now() - t0) / 120) + '%';
        if (ready) break;
        await new Promise((r) => setTimeout(r, 60));
        if (this.ship !== ship) { this.spawning = false; return; }   // flight was cancelled
      }
    }
    if (site.type === 'padAt' && this.ship === ship) {
      // now that the ground is known, pour the pad level with it (on water it floats like a barge) and let the
      // terrain rebuild flattened around it
      const g0 = this.world.groundAt(EARTH, lat, lon);
      h = site.elev = Math.max(this.world.isWater(lat, lon) ? 1.5 : 0, g0) + 0.3;
      this.world.setLaunchPad({ lat, lon, elev: h });
      const t1 = performance.now();
      while (performance.now() - t1 < 8000 && this.ship === ship) {
        this.world.update(this.camI, this.camera, this.eph, 0.016);
        if (this.world.terrainReady(EARTH, lat, lon, 13)) break;
        await new Promise((r) => setTimeout(r, 60));
      }
    }
    this.spawning = false;
    if (this.ship !== ship) return;
    const ground = needGround ? this.world.groundAt(body, lat, lon) : 0;
    if (site.type === 'runway' || site.type === 'hangar' || site.type === 'pad' || site.type === 'padAt' || site.type === 'moon') {
      const gh = Math.max(ground, h !== undefined ? h - 0.25 : ground);
      ship.placeAt(body, lat, lon, hComFor(gh), hdg, vert ? Math.PI / 2 : 0);
      ship.ctl.gear = true;
    } else if (site.type === 'air') {
      // never start below the hills (the terrain here may still be coarse: keep a margin)
      ship.placeAt(EARTH, lat, lon, Math.max(site.alt, this.world.groundAt(EARTH, lat, lon) + 150), hdg, 0);
      ship.parked = null;
      const up = ship.env.up || ship.r.clone().normalize();
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
      ship.v.addScaledVector(fwd, site.speed);
      ship.ctl.gear = false;
      C.input.throttle = 0.7;
    } else if (site.type === 'orbit') {
      const r = EARTH.R + site.alt;
      ship.r.set(r, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.eph.earthAngle + (-122 * D2R));
      const vdir = new THREE.Vector3(0, 1, 0).cross(ship.r).normalize();
      ship.v.copy(vdir).multiplyScalar(Math.sqrt(EARTH.mu / r));
      this.orientTo(ship, vdir, ship.r.clone().normalize());
      ship.parked = null; ship.ctl.gear = false;
      C.setSas('prograde');
    } else if (site.type === 'docked' || site.type === 'stationNear') {
      // (placed above)
    } else if (site.type === 'lunarOrbit') {
      const r = MOON.R + site.alt;
      const m = this.eph.moon, mv = this.eph.moonV;
      const radial = m.clone().normalize().negate();
      ship.r.copy(m).addScaledVector(radial, r);
      const vdir = new THREE.Vector3().crossVectors(this.eph.mY, radial).normalize();
      ship.v.copy(mv).addScaledVector(vdir, Math.sqrt(MOON.mu / r));
      this.orientTo(ship, vdir, radial);
      ship.parked = null; ship.ctl.gear = false;
      C.setSas('prograde');
    }
    ship.updateEnv(ship.t);
    this.cam.smooth.copy(ship.r);
    this.show('hud');
    $('h-info').hidden = false;
    this.hud.toast(site.airport ? `${site.airport.name}` : site.name || '', '');
    if (site.type === 'hangar') this.hud.toast('Throttle up gently to roll out of the hangar', '');
    this.input.take();
  }

  // ---------------- saving and resuming a flight ----------------
  whereText() {
    const ship = this.ship, E = ship.env;
    if (ship.docked) return `docked at ${STATION.name}`;
    const rs = relState(ship, E.body), el = elements(rs.r, rs.v, rs.mu);
    if (E.body === MOON) return ship.parked || ship.contacts > 0 ? 'on the Moon' : el.e < 1 && el.pe > MOON.R + 5000 ? 'in lunar orbit' : 'near the Moon';
    if (ship.parked || ship.contacts > 0) { const n = this.world.airports.nearestRunway(E.lat, E.lon, 8000); return n ? `at ${n.rw.ap.iata || n.rw.ap.ident}` : 'on the ground'; }
    if (el.e < 1 && el.pe > EARTH.R + EARTH.atmoTop && el.ap < EARTH.R + 2e6) return 'in Earth orbit';
    if (E.h > 2e6) return 'between Earth and the Moon';
    if (E.h > EARTH.atmoTop) return 'in space';
    return 'in flight';
  }
  snapshot() {
    const ship = this.ship, craft = this.craft, C = this.controller;
    if (!ship || ship.dead || this.spawning || !this.site) return null;
    const n = C.node, site = this.site, F = this.progress.flight;
    const v3 = (v) => [v.x, v.y, v.z];
    return {
      v: 1, savedAt: Date.now(), design: this.design,
      site: { type: site.type, name: site.name || '', label: site.label || '', airport: site.airport ? site.airport.ident : null, pad: site.type === 'padAt' ? { lat: site.lat, lon: site.lon, elev: site.elev } : null },
      t: ship.t, r: v3(ship.r), vel: v3(ship.v), q: [ship.q.x, ship.q.y, ship.q.z, ship.q.w], w: v3(ship.w),
      parked: ship.parked ? { body: ship.parked.body === MOON ? 'moon' : 'earth', pF: v3(ship.parked.pF), qF: [ship.parked.qF.x, ship.parked.qF.y, ship.parked.qF.z, ship.parked.qF.w] } : null,
      parts: craft.parts.map((P) => ({ a: P.alive ? 1 : 0, r: Object.fromEntries(Object.entries(P.res).map(([k, x]) => [k, x.amt])), T: Math.round(P.temp) })),
      ec: craft.ec, gear: ship.ctl.gear, rcs: ship.ctl.rcs, eg: this.engGroup, sas: C.sas, thr: C.input.throttle,
      node: n ? { t: n.t, dv: v3(n.dv), label: n.label, body: n.body === MOON ? 'moon' : 'earth', moonPe: n.moonPe, earthPe: n.earthPe, eTarget: n.eTarget, target: n.target || null, miss: n.miss, rw: n.runway ? n.runway.idx : null, vertical: !!n.vertical } : null,
      flight: F ? { ...F, from: F.from ? F.from.ident : null } : null,
      flightTime: this.flightTime, where: this.whereText(),
      homeTo: C.ap && C.ap.home ? C.ap.home : null,
      moonTo: C.ap && C.ap.moonSite ? C.ap.moonSite : null,
      rdvTo: !!(C.ap && C.ap.rdvStation),
      dest: this.destLite(this.dest),
      flyTo: !!(C.ap && C.ap.nav && C.ap.dest),
      station: { r: v3(this.station.r), v: v3(this.station.v), t: this.station.t },
      docked: ship.docked ? { port: ship.docked.port, part: ship.docked.part, qRel: ship.docked.qRel.toArray(), pRel: v3(ship.docked.pRel) } : null,
    };
  }
  saveFlight() { try { const s = this.snapshot(); if (s) save('flight', s); } catch (e) { /* storage full or unavailable */ } }
  clearSavedFlight() { save('flight', null); }
  async resumeFlight(s) {
    this.endFlight();
    this.resumeSnap = s;
    const A = this.world.airports;
    const findAp = (id) => (id ? A.airports.find((a) => a.ident === id) || null : null);
    this.site = { type: s.site.type, name: s.site.name, label: s.site.label, airport: findAp(s.site.airport), resumed: true };
    if (s.site.pad && s.site.pad.elev !== undefined) { Object.assign(this.site, s.site.pad); this.world.setLaunchPad(s.site.pad); }
    this.applySettings();
    this.design = s.design;
    const craft = new Craft(this.design);
    this.craft = craft;
    craft.parts.forEach((P, i) => {
      const d = s.parts[i]; if (!d) return;
      if (!d.a) { P.alive = false; if (P.mesh) P.mesh.visible = false; }
      for (const k in d.r) if (P.res[k]) P.res[k].amt = d.r[k];
      if (d.T) P.temp = d.T;
    });
    craft._intake = undefined;
    if (s.ec !== undefined) craft.ec = s.ec;
    craft.recompute();
    this.scene.add(craft.group);
    this.eph.update(s.t);
    const ship = new Ship(craft, this.world, this.eph, this.settings);
    this.ship = ship;
    const C = this.controller = new Controller(this.settings);
    C.destFn = () => this.dest;
    C.onEngineGroup = (g) => { this.engGroup = this.availableGroups().includes(g) ? g : 'all'; };
    this.effects.attach(craft);
    this.setupLights(craft);
    this.engGroup = s.eg && this.availableGroups().includes(s.eg) ? s.eg : 'all';
    this.applyEngGroup();
    this.flightTime = s.flightTime || 0;
    this.prevContacts = 0;
    this.cam.init = false; this.camMode = 'chase';
    this.cam.dist = Math.max(12, craft.size * 1.5 + 8); this.cam.yaw = 0; this.cam.pitch = craft.vertical ? 0.05 : 0.16;
    this.progress.startFlight({ airport: null, custom: false });
    if (s.flight) this.progress.flight = { ...s.flight, from: findAp(s.flight.from) };
    ship.t = s.t;
    ship.r.fromArray(s.r); ship.v.fromArray(s.vel); ship.q.fromArray(s.q).normalize(); ship.w.fromArray(s.w);
    if (s.station) this.station.setState(new THREE.Vector3().fromArray(s.station.r), new THREE.Vector3().fromArray(s.station.v), s.station.t);
    else this.station.seed(s.t);
    this.station.advanceTo(s.t); this.station.occupied = -1;
    ship.station = this.station;
    if (s.docked && craft.parts[s.docked.part] && craft.parts[s.docked.part].alive) {
      ship.docked = { port: s.docked.port, part: s.docked.part, qRel: new THREE.Quaternion().fromArray(s.docked.qRel), pRel: new THREE.Vector3().fromArray(s.docked.pRel) };
      this.station.occupied = s.docked.port;
    }
    if (s.parked) ship.parked = { body: s.parked.body === 'moon' ? MOON : EARTH, pF: new THREE.Vector3().fromArray(s.parked.pF), qF: new THREE.Quaternion().fromArray(s.parked.qF) };
    ship.ctl.gear = s.gear; ship.ctl.rcs = s.rcs !== false;
    C.sas = s.sas || 'hold'; C.input.throttle = s.thr || 0;
    if (s.node) {
      const nd = s.node;
      C.node = { t: nd.t, dv: new THREE.Vector3().fromArray(nd.dv), label: nd.label, body: nd.body === 'moon' ? MOON : EARTH, moonPe: nd.moonPe, earthPe: nd.earthPe, eTarget: nd.eTarget, target: nd.target, miss: nd.miss, vertical: nd.vertical };
      if (nd.rw != null && A.runways[nd.rw]) { C.node.runway = A.runways[nd.rw]; C.node.airport = C.node.runway.ap; }
    }
    ship.updateEnv(ship.t);
    // close to the ground: stream terrain under the ship before the physics runs
    if (ship.env.agl < 30000 || ship.parked) {
      this.show('boot');
      $('bootmsg').textContent = 'Resuming your flight…';
      this.spawning = true;
      const E = ship.env, body = E.body, t0 = performance.now();
      while (performance.now() - t0 < 15000) {
        this.camI.copy(ship.r);
        this.camera.position.set(0, 0, 0);
        this.camera.lookAt(ship.r.clone().sub(this.eph.bodyCenter(body, new THREE.Vector3())).normalize().negate().add(new THREE.Vector3(0.01, 0, 0)));
        this.world.update(this.camI, this.camera, this.eph, 0.016);
        $('bootfill').style.width = Math.min(95, 10 + (performance.now() - t0) / 100) + '%';
        if (this.world.terrainReady(body, E.lat, E.lon, body === EARTH ? 12 : 6)) break;
        await new Promise((r) => setTimeout(r, 60));
        if (this.ship !== ship) { this.spawning = false; return; }
      }
      this.spawning = false;
    }
    this.cam.smooth.copy(ship.r);
    this.show('hud');
    $('h-info').hidden = false;
    this.hud.toast(`Welcome back — ${this.whereText()}`, '');
    this.input.take();
    // a fly-me-home trip in progress carries on (not mid-reentry: that needs the stick or Land at…)
    if (s.homeTo && (ship.env.body === MOON || ship.env.h > EARTH.atmoTop + 5000)) {
      const a = findAp(s.homeTo);
      if (a) setTimeout(() => { if (this.ship === ship && !this.controller.ap) { this.mapView.flyHomeAll(a); this.hud.toast(`Autopilot resumed: flying you home to ${a.iata || a.ident}`); } }, 1500);
    }
    // and so does a trip to the Moon (from orbit or on the way)
    if (s.moonTo && (ship.env.body === MOON || ship.env.h > EARTH.atmoTop + 5000) && !ship.parked) {
      const site = MOON_SITES.find((x) => x.name === s.moonTo) || null;
      setTimeout(() => { if (this.ship === ship && !this.controller.ap) { this.flyToMoon(site); } }, 1500);
    }
    // a destination carries over, and so does a fly-to in progress (once airborne)
    if (s.dest) this.setDest(this.destFrom(s.dest), true);
    if (s.flyTo && this.dest && ship.env.body === EARTH && ship.contacts === 0 && ship.env.rho > 0.02) {
      setTimeout(() => { if (this.ship === ship && !this.controller.ap) { this.flyTo(this.dest); } }, 1500);
    }
    // so does a trip to the station (from orbit; an ascent in progress is left to the pilot)
    if (s.rdvTo && !ship.docked && ship.env.body === EARTH && ship.env.h > EARTH.atmoTop + 5000) {
      setTimeout(() => { if (this.ship === ship && !this.controller.ap) { this.engage(rendezvousAp(ship, this.station)); this.hud.toast(`Autopilot resumed: on the way to ${STATION.name}`); } }, 1500);
    }
  }

  // choose a start time so the launch site has the requested lighting
  simStart(site) {
    const now = nowSimTime();
    const tod = this.settings.tod || 'day';
    if (tod === 'real') return now;
    if (site.type === 'docked' || site.type === 'stationNear') return this.stationDaylight(now);
    const moon = site.type === 'moon' || site.type === 'lunarOrbit';
    let lat = site.lat, lon = site.lon;
    if (site.rw) { lat = site.rw.latC; lon = site.rw.lonC; }
    if (lat === undefined) { lat = 0; lon = moon ? 0 : -122; }
    const body = moon ? MOON : EARTH;
    const period = moon ? 29.53 * 86400 : 86400;
    const eph = new Ephemeris();
    const upF = llh(lat, lon, 0, 1, new THREE.Vector3()).normalize();
    const elev = (t) => { eph.update(t); const up = eph.toI(body, upF.clone().multiplyScalar(body.R), new THREE.Vector3()).sub(eph.bodyCenter(body, new THREE.Vector3())).normalize(); return Math.asin(up.dot(eph.sun)) * R2D; };
    const N = 192;
    let best = now, bestScore = -1e9;
    const samples = [];
    for (let i = -N / 2; i <= N / 2; i++) { const t = now + (i / N) * period; samples.push([t, elev(t)]); }
    const peak = Math.max(...samples.map((x) => x[1]));
    for (let i = 1; i < samples.length; i++) {
      const [t, e] = samples[i], [, ep] = samples[i - 1];
      let score;
      if (tod === 'day') score = -Math.abs(e - Math.min(peak - 8, 48)) - (e < ep ? 6 : 0);           // mid-morning
      else if (tod === 'sunset') score = -Math.abs(e - 4) * 3 - (e > ep ? 20 : 0);                       // sun setting
      else score = -e;                                                                                   // darkest
      score -= Math.abs(t - now) / period * 2;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // a start time with the station in sunshine for the next half hour
  stationDaylight(now) {
    const eph = new Ephemeris(), r = new THREE.Vector3();
    const lit = (t) => { eph.update(t); stationKepler(t, r); const a = r.dot(eph.sun); return a > 0 || r.lengthSq() - a * a > EARTH.R * EARTH.R; };
    for (let t = now; t < now + 6000; t += 30) {
      let ok = true;
      for (let k = 0; k <= 1800 && ok; k += 120) ok = lit(t + k);
      if (ok) return t + 60;
    }
    return now;
  }

  orientTo(ship, fwd, up) {
    const z = fwd.clone().negate();
    const x = new THREE.Vector3().crossVectors(up, z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    ship.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    ship.w.set(0, 0, 0);
  }
  rwPoint(rw, along, cross) {
    const dE = along * rw.dx + cross * rw.dy, dN = along * rw.dy - cross * rw.dx;
    return { lat: rw.latC + (dN / EARTH.R) * R2D, lon: rw.lonC + (dE / (EARTH.R * rw.cosC)) * R2D };
  }
  offsetLL(lat, lon, brg, d) {
    const dN = Math.cos(brg) * d, dE = Math.sin(brg) * d;
    return { lat: lat + (dN / EARTH.R) * R2D, lon: lon + (dE / (EARTH.R * Math.cos(lat * D2R))) * R2D };
  }

  setupLights(craft) {
    const lamp = craft.parts.find((P) => P.def.light);
    if (!lamp) return;
    const s = new THREE.SpotLight(0xfff2dc, 0, 600, 0.45, 0.5, 1.2);
    s.position.copy(lamp.com);
    const t = new THREE.Object3D();
    t.position.copy(lamp.com).add(new THREE.Vector3(0, -0.5, -10));
    craft.group.add(s, t);
    s.target = t;
    this.spot = s;
  }

  // ---------------- actions ----------------
  action(id) {
    const ship = this.ship, C = this.controller;
    if (!ship) return;
    this.audio.click();
    switch (id) {
      case 'gear':
        if (ship.ctl.gear && (ship.contacts > 0 || ship.parked) && this.craft.gears.some((P) => P.gear.contact)) { this.hud.toast('Gear locked — weight on wheels', 'bad'); break; }
        ship.ctl.gear = !ship.ctl.gear; this.hud.toast(ship.ctl.gear ? 'Gear down' : 'Gear up'); break;
      case 'brake': C.input.brake = !C.input.brake; break;
      case 'rcs': ship.ctl.rcs = !ship.ctl.rcs; this.hud.toast(ship.ctl.rcs ? 'RCS on' : 'RCS off'); break;
      case 'lights': this.lights = !this.lights; if (!this.spot) this.hud.toast(this.lights ? 'Nav lights on' : 'Lights off'); break;
      case 'engines': {
        const groups = this.availableGroups();
        const i = groups.indexOf(this.engGroup);
        this.engGroup = groups[(i + 1) % groups.length];
        this.applyEngGroup();
        this.hud.toast(`Engines: ${this.engGroup}`);
        break;
      }
      case 'mode': { const m = ship.ctl.engineMode; ship.ctl.engineMode = m === 'auto' ? 'air' : m === 'air' ? 'rocket' : 'auto'; break; }
      case 'auto': this.autopilotMenu(); break;
      case 'info': $('h-info').hidden = !$('h-info').hidden; break;
      case 'dock': this.dockAction(); break;
      case 'refuel': this.refuel(); break;
      case 'nav': this.navAction(); break;
    }
  }
  // dock with the station (autopilot) or undock and back away
  dockAction() {
    const ship = this.ship, C = this.controller, st = this.station;
    if (ship.docked) {
      const port = ship.docked.port;
      st.undock(ship);
      C.input.throttle = 0;
      this.engage(departAp(st, port));
      return;
    }
    if (!this.craft.docks.length) { this.hud.toast('This ship has no docking port', 'bad'); return; }
    if (!this.craft.rcsList.length) { this.hud.toast('Docking needs RCS thrusters', 'bad'); return; }
    if (ship.r.distanceTo(st.r) > 8000) { this.engage(rendezvousAp(ship, st)); return; }
    this.engage(proxAp(st));
  }
  refuel() {
    if (!this.ship || !this.ship.docked) { this.hud.toast(`Dock at ${STATION.short} to refuel`, 'bad'); return; }
    this.craft.refuel();
    this.hud.toast(`Tanks full — courtesy of ${STATION.name}`, 'good');
    this.audio.chime();
  }
  engineClass(P) { return engineClass(P); }
  availableGroups() {
    const g = new Set(this.craft.engines.map((P) => this.engineClass(P)));
    const out = ['all'];
    for (const k of ['main', 'jets', 'lift']) if (g.has(k)) out.push(k);
    if (out.length === 2) return ['all'];
    return out;
  }
  applyEngGroup() {
    for (const P of this.craft.parts) if (P.eng) P.eng.active = this.engGroup === 'all' || this.engineClass(P) === this.engGroup;
    if (this.controller) this.controller.engGroup = this.engGroup;
  }
  setSas(m) {
    if (!this.controller) return;
    this.audio.click();
    this.controller.setSas(m);
    if (this.controller.ap && this.controller.ap.name !== 'Burn') this.controller.cancelAp();
  }
  engage(ap) {
    const C = this.controller;
    C.engage(ap);
    if (ap.name === 'Auto-land' || ap.name === 'Ascent') C.input.throttle = 0;
    this.hud.toast(`Autopilot: ${ap.name}`);
  }
  autopilotMenu() {
    const ship = this.ship, C = this.controller;
    const opts = [];
    if (C.ap) opts.push(['Stop autopilot', () => C.cancelAp()]);
    if (ship.docked) {
      opts.push(['Refuel at the station', () => this.refuel()]);
      opts.push(['Undock and back away', () => this.dockAction()]);
      this.dialog('Autopilot', `<p class="dim small">Docked at ${STATION.name}.</p>`, opts);
      return;
    }
    const cls = new Set(this.craft.engines.filter((P) => P.alive !== false).map((P) => this.engineClass(P)));
    const rocket = cls.has('main') || this.craft.engines.some((P) => P.alive !== false && P.eng.e.type === 'hybrid');
    if (rocket && ((ship.env.body === EARTH && ship.env.h < 120000) || (ship.env.body === MOON && ship.env.agl < 20000))) opts.push([ship.env.body === MOON ? 'Take off to lunar orbit' : 'Ascend to orbit', () => this.engage(ascentAp())]);
    if (rocket && ship.env.body === EARTH && x0dv(this) > 6000) opts.push([ship.contacts > 0 ? 'Fly me to the Moon (launch, transfer, land)…' : 'Fly me to the Moon…', () => this.mapView.pickMoonSite((st) => this.flyToMoon(st), true)]);
    { const E = ship.env; if (E.body === EARTH && E.h < 400000 && E.vSurf > 2500 && (E.vVert < 0 || E.h < EARTH.atmoTop)) opts.push(['Reentry: belly-first, then hand back control', () => this.engage(reentryAp())]); }
    // powered landings need engines that can hold the craft up: lift thrusters, or rockets on a tail-sitter / in low gravity
    const canHover = cls.has('lift') || (rocket && (this.craft.vertical || ship.env.body === MOON));
    if (canHover && !ship.parked && ship.contacts === 0) opts.push([ship.env.body === MOON || (ship.env.h > EARTH.atmoTop && ship.env.body === EARTH) ? 'Land here (deorbit, brake, touch down)' : 'Powered landing (hover down)', () => this.engage(landAp())]);
    // the whole way home (or down to a famous spot) in one go
    {
      const E = ship.env, MV = this.mapView;
      const rs = relState(ship, E.body), el = elements(rs.r, rs.v, rs.mu);
      const inSpace = E.body === MOON || el.e >= 1 || E.h > 2e6 || (E.h > EARTH.atmoTop && el.pe - EARTH.R > 100000);
      if (rocket && inSpace && MV.canComeHome()) opts.push([E.body === MOON && E.agl < 50 ? 'Take off and fly me home…' : 'Fly me home to an airport…', () => MV.pickHome((a) => MV.flyHomeAll(a))]);
      if (rocket && E.body === MOON && el.e < 1 && E.agl > 5000) opts.push(['Land at a famous site…', () => MV.pickMoonSite((s) => MV.landAtSiteAuto(s))]);
    }
    // the station: the whole trip from a launch pad or runway, or from orbit; or just the docking when close
    {
      const E = ship.env, st = this.station;
      const d = ship.r.distanceTo(st.r);
      const rs = elements(ship.r, ship.v, EARTH.mu);
      const inOrbit = E.body === EARTH && rs.e < 1 && rs.pe > EARTH.R + 130000;
      const grounded = E.body === EARTH && (ship.parked || ship.contacts > 0);
      if (d < 8000 && this.craft.docks.length) opts.push([`Dock at ${STATION.short}`, () => this.dockAction()]);
      else if (rocket && (inOrbit || (grounded && (this.craft.vertical || this.mapView.canGlideHome())))) {
        opts.push([grounded ? `Fly to ${STATION.name} (launch window, ascent, rendezvous${this.craft.docks.length ? ', dock' : ''})` : `Rendezvous${this.craft.docks.length ? ' and dock' : ''} with ${STATION.name}`, () => this.engage(rendezvousAp(ship, st))]);
      }
    }
    // flying somewhere on the planet
    if (ship.env.body === EARTH && (ship.env.rho > 0.02 || ship.contacts > 0) && this.canCruise()) {
      if (this.dest) opts.push([`Fly me to ${this.dest.name} (${fmtDist(navInfo(ship, this.dest).d)})`, () => this.flyTo(this.dest)]);
      opts.push(['Fly to a city or airport…', () => this.pickDest((p) => this.flyTo(p))]);
    }
    if (ship.env.body === EARTH && ship.env.rho > 0.05) opts.push(['Cruise: hold altitude & heading', () => this.engage(cruiseAp(ship))]);
    { const E = ship.env, rw = E.body === EARTH && E.h < 25000 && ship.contacts === 0 && this.craft.wings.length ? this.landingRunway() : null;
      if (rw) opts.push([`Land at ${rw.name} (${this.hud.units.dist(rw.d)})`, () => this.engage(landRunwayAp(this.world.airports, rw.rw, rw.name, this.terrainFn()))]); }
    if (C.node) opts.push(['Fly the planned burn', () => this.engage(nodeExec(C.node))]);
    if (rocket) opts.push(['Plan burns in the map…', () => this.toggleMap()]);
    this.dialog('Autopilot', '', opts);
  }
  // Flight school: the Kestrel on San Francisco's runway 28R with guided steps
  async startSchool() {
    const A = this.world.airports;
    const L = this.shipList();
    this.setDesign(L.find((d) => /kestrel/i.test(d.name)) || L[0]);
    const sfo = A.search('SFO', 1)[0];
    const rw = sfo && sfo.runways.find((r) => r.he === '28R' || r.le === '28R') || (sfo && sfo.runways[0]);
    if (!rw) { this.openLaunch(); return; }
    this.tutorial = this.tutorial || new Tutorial(this);
    this.tutorial.stop();
    await this.startFlight({ type: 'runway', rw, airport: sfo, fromLe: rw.he === '28R' ? false : true });
    // (startFlight ends the previous flight, which also stops any lesson; the new one starts below)
    if (this.ship) this.tutorial.start(flightSchool());
  }
  terrainFn() { return (la, lo) => this.world.groundAt(EARTH, la, lo); }
  // best runway to land on: the longest runway of the nearest few airports, favouring big ones
  landingRunway() {
    const A = this.world.airports, E = this.ship.env;
    if (!A.ready) return null;
    let best = null;
    for (const { d, a } of A.nearest(E.lat, E.lon, 8, 2)) {
      if (d > 600000) continue;
      for (const rw of a.runways) {
        if (rw.len < 1500) continue;
        const score = d - Math.min(rw.len, 3500) * 20 + (a.type === 0 ? -20000 : 0);
        if (!best || score < best.score) best = { rw, d, score, name: a.iata || a.ident };
      }
    }
    return best;
  }
  // ---------------- destination ("fly here") ----------------
  setDest(p, quiet = false) {
    this.dest = p || null;
    if (!quiet) this.hud.toast(p ? `Destination: ${p.name}` : 'Destination cleared');
    if (this.mapView) { this.mapView.planDirty = true; if (this.ship) this.mapView.buildDest(this.ship); }
    if (this.launchScreen) this.launchScreen.renderDest();
  }
  destLite(p) { return p ? { kind: p.kind, name: p.name, code: p.code, sub: p.sub, lat: p.lat, lon: p.lon, ap: p.airport ? p.airport.ident : null } : null; }
  destFrom(o) {
    if (!o) return null;
    const ap = o.ap ? this.world.airports.airports.find((a) => a.ident === o.ap) : null;
    return { kind: o.kind, name: o.name, code: o.code, sub: o.sub, lat: o.lat, lon: o.lon, airport: ap || undefined };
  }
  // search airports and cities; onPick(place)
  pickDest(onPick = (p) => this.setDest(p), title = 'Fly to…') {
    const $b = $('d-btns');
    $('d-title').textContent = title;
    $('d-body').innerHTML = '<p class="dim small">Search a city or an airport. The HUD shows its distance and time, and the autopilot can fly you there.</p><input id="d-q" class="field" type="search" placeholder="City or airport (e.g. Paris, LHR, Denver)" autocomplete="off" spellcheck="false" style="width:100%;margin:6px 0 4px">';
    const A = this.world.airports;
    const list = (q) => {
      $b.innerHTML = ''; $b.style.flexDirection = 'column';
      let res;
      if (q) res = this.places.search(q, 8);
      else {
        res = [];
        const home = this.site && this.site.airport;
        if (home) res.push(this.places.fromAirport(home));
        for (const c of ['LHR', 'JFK', 'HND', 'SYD', 'DXB', 'GIG']) { const a = A.search(c, 1)[0]; if (a && a !== home) res.push(this.places.fromAirport(a)); }
      }
      const E = this.ship && this.ship.env;
      for (const p of res) {
        const b = document.createElement('button'); b.className = 'btn wide';
        const d = E && E.body === EARTH ? ` · ${fmtDist(gcDist(E.lat, E.lon, p.lat, p.lon))}` : '';
        b.textContent = `${p.name} · ${p.sub}${d}`;
        b.onclick = () => { this.modal('dialog', false); onPick(p); };
        $b.appendChild(b);
      }
      if (this.dest && !q) {
        const x = document.createElement('button'); x.className = 'btn wide'; x.textContent = `Clear destination (${this.dest.name})`;
        x.onclick = () => { this.modal('dialog', false); this.setDest(null); };
        $b.appendChild(x);
      }
      const c = document.createElement('button'); c.className = 'btn ghost wide'; c.textContent = 'Cancel'; c.onclick = () => this.modal('dialog', false); $b.appendChild(c);
    };
    list('');
    this.modal('dialog');
    const q = $('d-q');
    q.oninput = () => list(q.value);
    setTimeout(() => q.focus(), 50);
  }
  // can this craft fly itself somewhere in the air? (wings and air-breathing engines)
  canCruise() {
    const c = this.craft;
    if (!c) return false;
    const S = c.wings.reduce((a, P) => a + (P.alive !== false ? P.wing.area : 0), 0);
    return S > c.mass / 1500 && c.engines.some((P) => P.alive !== false && (engineClass(P) === 'jets' || P.eng.e.type === 'hybrid'));
  }
  flyTo(p) {
    if (p !== this.dest) this.setDest(p, true);
    const ship = this.ship;
    if (!this.canCruise()) { this.hud.toast('Fly-to needs wings and jet engines', 'bad'); return; }
    this.engage(flyToAp(this.world.airports, p, this.terrainFn()));
    const n = navInfo(ship, p), rw = runwayFor(this.world.airports, p);
    this.hud.toast(`${rw ? `Flying to ${p.name}, landing at ${rw.name}` : `Flying to ${p.name} (no runway there)`}${n && isFinite(n.d) ? ' · ' + fmtDist(n.d) : ''}`);
  }
  navAction() {
    const ship = this.ship, E = ship && ship.env;
    if (!ship || E.body !== EARTH) { this.pickDest(); return; }
    const opts = [];
    if (this.dest) {
      const n = navInfo(ship, this.dest);
      if (this.canCruise() && (E.rho > 0.02 || ship.contacts > 0)) opts.push([`Fly me to ${this.dest.name} (${fmtDist(n.d)})`, () => this.flyTo(this.dest)]);
      if (E.rho > 0.02 && ship.contacts === 0) opts.push([`Hold a heading toward ${this.dest.name}`, () => this.engage(headingAp(this.dest))]);
      opts.push(['Change destination…', () => this.pickDest()]);
      opts.push([`Clear destination`, () => this.setDest(null)]);
      this.dialog(this.dest.name, `<p class="dim small">${this.dest.sub} · ${fmtDist(n.d)} away${isFinite(n.eta) ? ' · ' + fmtTime(n.eta) + ' at this speed' : ''}</p>`, opts);
    } else this.pickDest();
  }

  dialog(title, body, opts) {
    $('d-title').textContent = title; $('d-body').innerHTML = body;
    const el = $('d-btns'); el.innerHTML = ''; el.style.flexDirection = 'column';
    for (const [label, fn] of opts) {
      const b = document.createElement('button'); b.className = 'btn wide'; b.textContent = label;
      b.onclick = () => { this.modal('dialog', false); fn(); };
      el.appendChild(b);
    }
    const c = document.createElement('button'); c.className = 'btn ghost wide'; c.textContent = 'Cancel'; c.onclick = () => this.modal('dialog', false); el.appendChild(c);
    this.modal('dialog');
  }
  pause(on) {
    if (!this.ship) return;
    this.paused = on;
    this.modal('pause', on);
  }
  cycleCam() {
    const modes = ['chase', 'cockpit', 'free', 'flyby'];
    this.camMode = modes[(modes.indexOf(this.camMode) + 1) % modes.length];
    this.flyby = null;
    this.hud.toast({ chase: 'Chase camera', cockpit: 'Cockpit view', free: 'Free camera (follows attitude)', flyby: 'Fly-by camera' }[this.camMode]);
  }
  toggleMap() {
    if (!this.ship) return;
    this.mapOpen = !this.mapOpen;
    if (this.mapOpen) { this.show('mapui'); this.mapView.open(); }
    else { this.mapView.close(); this.show('hud'); this.camera.near = 0.3; this.camera.updateProjectionMatrix(); }
  }
  canWarp(level) {
    const ship = this.ship, E = ship.env;
    if (level <= 4) return ship.parked || true;
    if (ship.parked || ship.docked) return true;
    if (ship.thrustNow > 0 || ship.ctl.throttle > 0) return 'Cut the throttle to warp';
    if (E.body === EARTH && E.h < EARTH.atmoTop + 2000) return 'Can’t warp in the atmosphere';
    if (E.agl < 10000) return 'Too close to the surface';
    return true;
  }
  warpStep(d) {
    if (!this.ship) return;
    const i = WARPS.indexOf(this.ship.warp);
    const n = clamp(i + d, 0, WARPS.length - 1);
    const ok = this.canWarp(WARPS[n]);
    if (ok !== true) { this.hud.toast(ok, 'bad'); return; }
    this.ship.warp = WARPS[n];
    this.warpTarget = null;
  }
  warpTo(t) {
    const ok = this.canWarp(1000);
    if (ok !== true) { this.hud.toast(ok, 'bad'); return; }
    this.warpTarget = t;
  }

  // ---------------- per-frame ----------------
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000; this.last = now;
    if (!(dt > 0)) dt = 0.016;
    this.adaptResolution(dt);
    dt = Math.min(dt, this.maxDt || 0.05);
    const inp = this.input.poll();
    const keys = this.input.take();
    const camIn = this.input.takeCam();
    if (this.spawning) { this.render(dt); return; }
    if (this.ship && this.state !== 'boot') this.flightFrame(dt, inp, keys, camIn);
    else if (this.state === 'hangar' && this.builder) { this.builder.frame(dt, camIn, keys); return; }
    else this.idleFrame(dt);
    this.render(dt);
  }

  // dynamic resolution: keep the frame rate up on weaker GPUs and phones
  adaptResolution(dt) {
    if (dt > 0.25 || document.hidden) return;          // tab switches and hitches don't count
    const P = this.perf;
    P.acc += dt; P.n++;
    if (P.acc < 2) return;
    const fps = P.n / P.acc;
    P.acc = 0; P.n = 0;
    const max = this.prMax(), min = Math.min(max, 0.75);
    let pr = this.pr;
    // drop after two slow windows in a row (loading hitches come and go), recover after three fast ones
    if (fps < 40) { P.good = 0; if (++P.bad >= 2 && pr > min) { pr = Math.max(min, pr - 0.15); P.bad = 0; } }
    else if (fps > 56) { P.bad = 0; if (++P.good >= 3 && pr < max) { pr = Math.min(max, pr + 0.1); P.good = 0; } }
    else { P.good = 0; P.bad = 0; }
    if (Math.abs(pr - this.pr) > 1e-3) { this.pr = pr; this.renderer.setPixelRatio(pr); this.resize(); }
  }

  idleFrame(dt) {
    // slow orbit around the Earth behind menus
    this.titleOrbit += dt * 0.012;
    this.eph.update(nowSimTime());
    const a = this.titleOrbit;
    const sun = this.eph.sun;
    // keep the day side in view
    const base = sun.clone().multiplyScalar(EARTH.R * 2.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.9 + Math.sin(a) * 0.25);
    base.y += EARTH.R * 0.9;
    this.camI.copy(base);
    this.camera.position.set(0, 0, 0); this.camera.up.set(0, 1, 0);
    const d = this.camI.clone().negate().normalize();
    this.camera.lookAt(d);
    // frame the planet beside the menu on wide screens, low behind it on tall ones
    const asp = this.camera.aspect, tanV = Math.tan((this.camera.fov * D2R) / 2), tanH = tanV * asp;
    const nx = asp > 1.15 ? clamp(0.25 + (asp - 1.15) * 0.25, 0.25, 0.42) : 0, ny = asp > 1.15 ? -0.04 : -0.55;
    const dc = new THREE.Vector3(nx * tanH, ny * tanV, -1).normalize();
    this.camera.quaternion.multiply(new THREE.Quaternion().setFromUnitVectors(dc, new THREE.Vector3(0, 0, -1)));
    this.camera.near = 1000; this.camera.updateProjectionMatrix();
    this.world.update(this.camI, this.camera, this.eph, dt);
  }

  flightFrame(dt, inp, keys, camIn) {
    const ship = this.ship, C = this.controller, craft = this.craft;
    // keys
    for (const k of keys) this.key(k);
    if (this.paused || this.state === 'boot') { this.eph.update(ship.t); this.placeCamera(dt, camIn); this.world.update(this.camI, this.camera, this.eph, dt); this.placeShip(); this.station.update(this.camI, this.eph, this.flightTime); return; }
    // continuous inputs
    C.input.pitch = inp.pitch; C.input.roll = inp.roll; C.input.yaw = inp.yaw;
    if (inp.thr) C.input.throttle = clamp(C.input.throttle + inp.thr * dt * 0.6, 0, 1);
    ship.ctl.tx = inp.trX; ship.ctl.ty = inp.trY; ship.ctl.tz = -inp.trZ;
    const holdBrake = inp.brake;
    const wasBrake = C.input.brake;
    if (holdBrake) C.input.brake = true;
    // warp to target
    if (this.warpTarget) {
      const left = this.warpTarget - ship.t;
      if (left <= 0) { ship.warp = 1; this.warpTarget = null; }
      else {
        let w = 1;
        for (const lv of WARPS) if (lv * dt * 3 < left && this.canWarp(lv) === true) w = lv;
        ship.warp = w;
      }
    }
    // autopilots that coast for a long time say when they need control again: warp there automatically,
    // and never warp past it
    if (C.ap && C.ap.wakeAt != null) {
      if (C.ap.wakeAt !== this._apWake) { this._apWake = C.ap.wakeAt; if (C.ap.wakeAt - ship.t > 30) this.warpTarget = C.ap.wakeAt; }
      const left = C.ap.wakeAt - ship.t;
      while (ship.warp > (left > 0 ? 1 : 4) && ship.warp * dt * 3 > left) ship.warp = WARPS[Math.max(0, WARPS.indexOf(ship.warp) - 1)];
    }
    if (ship.warp > 4 && this.canWarp(ship.warp) !== true && !ship.parked) ship.warp = 1;
    // simulate
    this.eph.update(ship.t);
    ship.step(dt, C);
    if (holdBrake) C.input.brake = wasBrake;
    this.stationFrame(ship);
    this.eph.update(ship.t);
    this.flightTime += dt;
    if (this.tutorial) this.tutorial.update(dt);
    this._saveT = (this._saveT || 0) + dt;
    if (this._saveT > 5) { this._saveT = 0; this.saveFlight(); }
    this.handleEvents();
    // milestones and landing detection
    this.progress.tick(ship, dt * ship.warp, this.world.airports);
    // camera and world
    if (this.mapOpen) this.camI.copy(this.mapView.update(dt, camIn, this.camera));
    else this.placeCamera(dt, camIn);
    this.world.update(this.camI, this.camera, this.eph, dt);
    this.placeShip();
    if (this.mapOpen) this.station.hide(); else this.station.update(this.camI, this.eph, this.flightTime);
    // effects
    const vb = ship.dirToBody(ship.env.vAir, _v);
    const flux = 1.83e-4 * Math.sqrt(Math.max(0, ship.env.rho)) * Math.pow(ship.env.vSurf, 3) * this.settings.heatScale;
    this.effects.update(dt, craft, ship.env, vb, flux);
    craft.updateVisuals(dt, this.flightTime, ship.ctl);
    this.effects.updateWorld(dt, this.camI, (p) => gravity(p, this.eph.moon, new THREE.Vector3()), (p) => {
      const body = p.distanceTo(this.eph.moon) < MOON.soi ? MOON : EARTH;
      const f = this.eph.toFixed(body, p, new THREE.Vector3());
      const ll = toLLH(f, body.R);
      return ll.h < this.world.groundAt(body, ll.lat, ll.lon) - 2;
    });
    if (this.spot) this.spot.intensity = this.lights ? 9000 : 0;
    // HUD + audio
    this.hudExtras(dt);
    if (!this.mapOpen) this.hud.update(dt, ship, C, this.extra);
    else { $('m-wv').textContent = fmtWarp(ship.warp); }
    this.updateAudio(flux);
  }

  // keep the station in step with the ship; latch the ports when they meet gently
  stationFrame(ship) {
    const st = this.station;
    st.advanceTo(ship.t);
    const d = ship.r.distanceTo(st.r);
    ship.nearStation = d < 200;
    if (d < 80 && !ship.docked) {
      const cap = st.checkCapture(ship);
      if (cap && cap.fail && !(this._capT > ship.t - 3)) {
        this._capT = ship.t;
        this.hud.toast(cap.vrel > 0.8 ? `Too fast to latch (${cap.vrel.toFixed(1)} m/s) — under 0.8 m/s` : 'Not lined up with the port', 'bad');
      }
    }
  }

  key(k) {
    const ship = this.ship, C = this.controller;
    switch (k) {
      case 'Escape': if (this.mapOpen) this.toggleMap(); else this.pause(!this.paused); break;
      case 'g': this.action('gear'); break;
      case 'r': this.action('rcs'); break;
      case 'u': this.action('lights'); break;
      case 'm': this.toggleMap(); break;
      case 'c': this.cycleCam(); break;
      case 't': this.setSas(C.sas === 'off' ? 'hold' : 'off'); break;
      case 'z': C.input.throttle = 1; break;
      case 'x': C.input.throttle = 0; break;
      case '.': case '>': this.warpStep(1); break;
      case ',': case '<': this.warpStep(-1); break;
      case 'e': break;
      case 'p': this.action('auto'); break;
      case 'y': this.action('dock'); break;
      case '9': this.action('nav'); break;
      case 'o': this.action('info'); break;
      case 'v': this.action('engines'); break;
      case 'f': this.action('mode'); break;
      case '1': this.setSas('hold'); break;
      case '2': this.setSas('prograde'); break;
      case '3': this.setSas('retrograde'); break;
      case '4': this.setSas('normal'); break;
      case '5': this.setSas('antinormal'); break;
      case '6': this.setSas('radialOut'); break;
      case '7': this.setSas('radialIn'); break;
      case '8': this.setSas('target'); break;
      case '0': this.setSas('off'); break;
      case 'F1': case '?': this.openHelp(); break;
    }
  }

  handleEvents() {
    const ship = this.ship;
    for (const e of ship.events.splice(0)) {
      if (e.type === 'break') {
        const P = e.part;
        const pw = ship.bodyToWorld(P.com, new THREE.Vector3());
        this.effects.explode(pw, ship.v, clamp(Math.sqrt(P.def.mass / 800), 0.6, 3));
        for (const Q of e.removed) if (Q.mesh && Q !== this.craft.root) {
          const q = ship.q.clone();
          const pos = ship.bodyToWorld(new THREE.Vector3().setFromMatrixPosition(Q.mesh.matrix), new THREE.Vector3());
          const mesh = Q.mesh.clone(); mesh.matrixAutoUpdate = true; mesh.visible = true;
          mesh.position.set(0, 0, 0); mesh.quaternion.identity(); mesh.scale.set(Q.d.mirror ? -1 : 1, 1, 1);
          const qm = new THREE.Quaternion(...Q.d.q);
          this.effects.addDebris(mesh, pos, ship.v, q.multiply(qm));
        }
        this.audio.boom(clamp(P.def.mass / 2000, 0.5, 2));
        if (!ship.dead) this.hud.toast(`${e.why === 'overheat' ? 'Burned up' : e.why === 'overstress' ? 'Overstressed — snapped off' : e.why === 'containment' ? 'Containment failure' : 'Lost'}: ${P.def.name}`, 'bad');
      } else if (e.type === 'destroyed') {
        const why = { impact: 'Hit the ground too hard.', overheat: 'Overheated and broke apart.', building: 'Flew into a building.', splash: 'Hit the water too hard.', overstress: 'Pulled too hard — the airframe broke up.', containment: 'The antimatter trap lost power.', collision: `Crashed into ${STATION.name}.` }[e.why] || 'Destroyed.';
        $('c-why').textContent = why + ` (${Math.round(ship.env.vSurf)} m/s)`;
        this.clearSavedFlight();
        setTimeout(() => { if (this.ship === ship) { this.modal('crash'); } }, 2600);
        this.audio.boom(3);
      } else if (e.type === 'antimatter') {
        // the trap failed: a flash far bigger than any part breaking, and it takes the ship with it
        const pw = ship.bodyToWorld(e.part.com, new THREE.Vector3());
        this.effects.explode(pw, ship.v, 3);
        if (!ship.dead) ship.breakPart(this.craft.root, 'containment');
      } else if (e.type === 'landed') {
        this.onLanded();
      } else if (e.type === 'docked') {
        if (ship.warp > 1) ship.warp = 1;
        this.warpTarget = null;
        this.hud.toast(`Docked at ${STATION.name} (${e.port} port) — tap Refuel to fill the tanks`, 'good');
        this.audio.thump(0.5);
        this.progress.docked();
      } else if (e.type === 'undocked') {
        this.hud.toast('Undocked');
        this.audio.thump(0.25);
      } else if (e.type === 'warpStop') {
        this.hud.toast(e.why === 'atmosphere' ? 'Warp stopped: entering the atmosphere' : 'Warp stopped: near the surface', '');
        this.warpTarget = null;
      }
    }
  }

  onLanded() {
    const ship = this.ship, E = ship.env;
    if (ship.warp > 1) ship.warp = 1;
    this.warpTarget = null;
    let ap = null;
    if (E.body === EARTH) {
      const n = this.world.airports.nearestRunway(E.lat, E.lon, 5000);
      if (n) { const { along, cross } = this.world.airports.local(n.rw, E.lat, E.lon); if (Math.abs(cross) < n.rw.w / 2 + 60 && Math.abs(along) < n.rw.len / 2 + 300) ap = n.rw.ap; }
    }
    if (this.flightTime > 5) {
      this.hud.toast(E.body === MOON ? 'Touchdown on the Moon' : ap ? `Landed at ${ap.name}` : 'Landed', 'good');
      this.audio.thump(0.6);
    }
    this.progress.landed(ship, ap, this.dest);
  }

  // the whole trip to the Moon on autopilot, ending in lunar orbit or on a famous site
  flyToMoon(site = null) {
    const C = this.controller, ship = this.ship;
    if (!ship) return;
    C.node = null;
    this.engage(flyToMoonAp(ship, { site, elevAt: (st) => this.world.groundAt(MOON, st.lat, st.lon) }));
    this.hud.toast(`Autopilot: to the Moon${site ? ' — landing at ' + site.name : ''}. About three days; time warp runs by itself between burns.`);
  }

  // A one-tap suggestion while flying by hand: coasting up out of the air on a path that falls back in →
  // offer to circularize at apoapsis (the burn is planned and flown for you)
  assist(ship, dv) {
    const C = this.controller, E = ship.env;
    if (C.ap || ship.contacts > 0 || ship.ctl.throttle > 0.05 || E.vVert <= 0 || dv < 30) return null;
    const rs = relState(ship, E.body), el = elements(rs.r, rs.v, E.body.mu);
    if (el.e >= 1) return null;
    const R = E.body.R, apAlt = el.ap - R, peAlt = el.pe - R;
    if (E.body === EARTH ? !(E.h > 55000 && apAlt > 110000 && peAlt < 90000) : !(apAlt > 12000 && peAlt < 6000)) return null;
    const node = planCircularize(ship, true);
    if (!node || node.dv.length() > dv) return null;
    return {
      label: `Circularize at apoapsis · ${Math.round(node.dv.length())} m/s`,
      fn: () => { const n = planCircularize(ship, true); if (n) { C.node = n; this.engage(nodeExec(n)); } },
    };
  }

  hudExtras(dt) {
    const ship = this.ship, E = ship.env, craft = this.craft, C = this.controller;
    this._xt = (this._xt || 0) - dt;
    if (this._xt > 0 && this.extra) return;
    this._xt = 0.25;
    const x = this.extra = this.extra || {};
    x.lights = this.lights;
    x.engGroup = this.engGroup;
    x.multiGroup = this.availableGroups().length > 1;
    x.dv = deltaV(craft, E.rho > 0.1, this.engGroup === 'all' ? null : (P) => P.eng.active);
    x.endurance = this.endurance();
    let T = 0; for (const P of craft.engines) if (P.eng.active) T += craft.engineOutput(P, E)[0];
    const g = E.body.mu / Math.pow(E.body.R + E.h, 2);
    x.twr = T / (craft.mass * g);
    const airborne = ship.contacts === 0;
    x.cloudFog = this.camMode === 'cockpit' || this.camMode === 'chase' ? this.world.clouds.fog : 0;
    x.night = this.world.shared.night;
    x.stress = craft.wings.reduce((m, P) => Math.max(m, P.alive !== false ? P.wing.load : 0), 0);
    x.stall = airborne && E.q > 50 && E.vSurf > 20 && E.mach < 2.5 && craft.wings.some((P) => P.wing.stalled && P.wing.area > 4);
    x.pullUp = airborne && E.vVert < -25 && E.agl < -E.vVert * 7 && E.agl < 1500;
    x.gearUp = airborne && !ship.ctl.gear && E.agl < 250 && E.vVert < -1 && craft.gears.length > 0;
    let fuelFrac = 1; for (const k of ['LF', 'LH2', 'OX', 'FU']) { const cap = craft.capacity(k); if (cap > 0) fuelFrac = Math.min(fuelFrac, craft.amount(k) / cap); }
    x.lowFuel = fuelFrac < 0.1;
    x.flameout = ship.ctl.throttle > 0.1 && craft.engines.some((P) => P.eng.active && P.eng.thr > 0.2) && craft.engines.every((P) => !P.eng.active || P.eng.flame < 0.01) && !craft.engines.some((P) => P.eng.active && P.eng.starved);
    if (C.status) { this.hud.toast(C.status); C.status = ''; }
    x.apMsg = C.ap ? C.apStatus || '' : '';
    x.assist = this.assist(ship, x.dv);
    if (C.ap && C.node && C.ap.name === 'Burn') {
      const left = (C.node.dvLeft || C.node.dv).length();
      x.apMsg = C.node.started ? `${Math.round(left)} m/s to go` : `burn in ${Math.round(C.node.tStart - ship.t)} s`;
    }
    {
      const st = this.station;
      if (E.body === EARTH && E.h > 30000) {
        const d = ship.r.distanceTo(st.r), rv = ship.v.clone().sub(st.v);
        const closing = -rv.dot(ship.r.clone().sub(st.r).normalize());
        x.station = { d, vrel: rv.length(), closing, docked: !!ship.docked };
        if (d < 1000 && rv.length() < 5 && this.site && !['docked', 'stationNear'].includes(this.site.type)) this.progress.unlock('rendezvous');
      } else x.station = ship.docked ? { d: 0, vrel: 0, closing: 0, docked: true } : null;
    }
    x.dest = this.dest;
    x.nav = this.dest && E.body === EARTH ? navInfo(ship, this.dest) : null;
    if (x.nav) x.nav.short = isFinite(x.endurance) && x.nav.eta > x.endurance * 1.05 && ship.contacts === 0 && E.rho > 0.02 && !craft.engines.some((P) => P.eng.mode === 'rocket' && P.eng.flame > 0);
    if (E.body === EARTH && E.agl < 20000) {
      const n = this.world.airports.nearestRunway(E.lat, E.lon, 80000);
      x.nearest = n ? { name: n.rw.ap.iata || n.rw.ap.ident, d: n.d } : null;
    } else x.nearest = null;
    // encounter preview (cheap, every few seconds)
    this._enc = (this._enc || 0) - 0.25;
    if (this._enc <= 0) {
      this._enc = 3;
      if (E.body === EARTH && E.h > 140000) {
        const p = predict(ship.r, ship.v, ship.t, { maxT: 6 * 86400, maxSteps: 1500 });
        x.encounter = p.soiIn ? `Moon encounter in ${fmtT(p.soiIn - ship.t)} · Pe ${this.hud.units.dist(p.closeMoon.d - MOON.R)}` : '';
      } else x.encounter = '';
      const rs = relState(ship, E.body); const el = elements(rs.r, rs.v, rs.mu);
      this.progress.orbitCheck(E.body, el.pe);
    }
  }

  // seconds of fuel left at the current throttle for air-breathing flight
  endurance() {
    const craft = this.craft, E = this.ship.env;
    let lf = 0;
    for (const P of craft.engines) {
      if (!P.eng.active || P.eng.flame <= 0) continue;
      const [T, isp] = craft.engineOutput(P, E);
      const mix = craft.fuelMix(P);
      lf += (mix.LF || 0) * T * P.eng.thr / (isp * 9.80665);
    }
    return lf > 0 ? craft.amount('LF') / lf : Infinity;
  }

  updateAudio(flux) {
    const ship = this.ship, craft = this.craft;
    let jet = 0, rocket = 0, fusion = 0, spool = 0;
    for (const P of craft.engines) {
      const f = P.eng.flame;
      if (P.eng.e.fusion) fusion = Math.max(fusion, f);
      else if (P.eng.mode === 'jet' || P.eng.mode === 'air' || P.eng.mode === 'scram') { jet = Math.max(jet, f); spool = Math.max(spool, P.eng.thr); }
      else rocket = Math.max(rocket, f);
    }
    const vac = 1 - Math.min(1, ship.env.p / 30000);
    this.audio.update({ jet, rocket, fusion, jetSpool: spool, q: ship.env.q, heat: clamp((flux - 2e5) / 1.5e6, 0, 1), vac, paused: this.paused || this.mapOpen && false });
  }

  // ---------------- camera ----------------
  placeCamera(dt, camIn) {
    const ship = this.ship, craft = this.craft;
    const cam = this.cam;
    cam.yaw -= camIn.dx * 0.006;
    cam.pitch = clamp(cam.pitch + camIn.dy * 0.006, -1.4, 1.5);
    cam.dist = clamp(cam.dist * Math.exp(camIn.zoom * 0.12), craft.size * 0.5 + 3, 20000);
    const up = ship.env.up ? ship.env.up.clone() : ship.r.clone().normalize();
    const shipPos = ship.r;
    this.camera.near = this.camMode === 'cockpit' ? 0.1 : clamp(cam.dist * 0.01, 0.2, 5);
    this.camera.far = 1e10;
    if (this.camMode === 'flyby') {
      this.flybyCamera(dt, camIn, up);
    } else if (this.camMode === 'cockpit') {
      const root = craft.root;
      const eye = new THREE.Vector3(0, root.dia * 0.45, -root.len * 0.15).add(root.com);
      this.camI.copy(ship.bodyToWorld(eye, _v));
      this.camera.position.set(0, 0, 0);
      this.camera.quaternion.copy(ship.q);
    } else {
      // reference heading: nose projected onto the horizon (or velocity when airborne and fast)
      let fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
      if (craft.vertical && ship.contacts > 0) fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
      let ref = fwd.clone().addScaledVector(up, -fwd.dot(up));
      if (ref.lengthSq() < 1e-4) ref = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q).addScaledVector(up, -new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q).dot(up));
      ref.normalize();
      let camUp = up;
      let off;
      if (this.camMode === 'free') {
        // orbit in the ship's own frame
        off = new THREE.Vector3(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch)).applyQuaternion(ship.q);
        camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
      } else {
        const back = ref.clone().negate();
        const side = new THREE.Vector3().crossVectors(up, back).normalize();
        off = back.clone().multiplyScalar(Math.cos(cam.yaw)).addScaledVector(side, Math.sin(cam.yaw));
        off.multiplyScalar(Math.cos(cam.pitch)).addScaledVector(up, Math.sin(cam.pitch));
      }
      const target = shipPos.clone().addScaledVector(up, craft.size * 0.08);
      this.camI.copy(target).addScaledVector(off, cam.dist);
      // keep the camera above the ground
      const body = ship.env.body;
      const f = this.eph.toFixed(body, this.camI, _w);
      const ll = toLLH(f, body.R);
      const g = this.world.groundAt(body, ll.lat, ll.lon) + 1.5;
      if (ll.h < g) this.camI.addScaledVector(up, g - ll.h);
      this.camera.position.set(0, 0, 0);
      this.camera.up.copy(camUp);
      this.camera.lookAt(target.clone().sub(this.camI));
    }
    this.camera.updateProjectionMatrix();
  }

  // Fly-by: a camera left standing ahead of and beside the flight path while the ship passes, then moved on.
  // Near the ground it's fixed to the ground; in space it drifts along at the ship's velocity.
  flybyCamera(dt, camIn, up) {
    const ship = this.ship, craft = this.craft, E = ship.env, body = E.body;
    const nearGround = (body === EARTH && E.h < 60000) || (body === MOON && E.agl < 20000);
    const V = Math.max(E.vSurf, 1);
    const reach = clamp(V * 7, 60 + craft.size * 3, nearGround ? 4000 : 900);
    let F = this.flyby;
    const camNow = () => (F.ground ? this.eph.toI(F.body, F.p, new THREE.Vector3()) : F.p.clone().addScaledVector(F.v, ship.t - F.t));
    if (!F || F.body !== body || F.ground !== nearGround || camNow().distanceTo(ship.r) > reach * 1.15) {
      // a new spot: some seconds ahead along the path, off to one side, a little above
      const vel = (nearGround ? E.vAir.clone() : ship.v.clone().sub(body === MOON ? this.eph.moonV : new THREE.Vector3()));
      const dir = vel.lengthSq() > 1 ? vel.normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(ship.q);
      const side = new THREE.Vector3().crossVectors(dir, up);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0).applyQuaternion(ship.q);
      side.normalize().multiplyScalar(((this._flySide = -(this._flySide || 1)) > 0 ? 1 : -1));
      const ahead = Math.min(reach * 0.75, V * 4 + craft.size * 2);
      const p = ship.r.clone().addScaledVector(dir, ahead).addScaledVector(side, 12 + craft.size * 1.5 + V * 0.12).addScaledVector(up, 3 + craft.size * 0.3);
      F = this.flyby = nearGround
        ? { ground: true, body, p: this.eph.toFixed(body, p, new THREE.Vector3()) }
        : { ground: false, body, p, v: ship.v.clone(), t: ship.t };
    }
    this.camI.copy(camNow());
    if (F.ground) {
      // stay above the ground
      const f = this.eph.toFixed(body, this.camI, _w), ll = toLLH(f, body.R);
      const g = this.world.groundAt(body, ll.lat, ll.lon) + 2;
      if (ll.h < g) this.camI.addScaledVector(up, g - ll.h);
    }
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(up);
    this.camera.lookAt(ship.r.clone().sub(this.camI));
    this.camera.near = 0.5;
  }

  placeShip() {
    const ship = this.ship, craft = this.craft;
    const origin = _v.copy(craft.com).applyQuaternion(ship.q);
    craft.group.position.copy(ship.r).sub(origin).sub(this.camI);
    craft.group.quaternion.copy(ship.q);
    craft.group.visible = !(this.camMode === 'cockpit' && !this.mapOpen) || true;
  }

  render(dt) {
    this.renderer.render(this.scene, this.camera);
    if (this.ship && this.state === 'hud' && !this.mapOpen) { this.hud.updateTarget(this.camera, this.camI, this.ship); this.hud.updateDest(this.camera, this.camI, this.ship, this.dest, this.eph); this.hud.renderNavball(this.renderer, this.ship, this.controller, this.dest); }
  }
}

function fmtT(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }

// cruise autopilot: hold altitude and heading via the fly-by-wire flight law
function cruiseAp(ship) {
  let hT = ship.env.h, hdgT = null;
  return {
    name: 'Cruise',
    update(s, dt, C) {
      const E = s.env;
      const up = E.up;
      const north = new THREE.Vector3(0, 1, 0).addScaledVector(up, -up.y).normalize();
      const east = new THREE.Vector3().crossVectors(north, up);
      const v = E.vAir;
      const hdg = Math.atan2(v.dot(east), v.dot(north));
      if (hdgT === null) hdgT = hdg;
      let e = hdgT - hdg; e = Math.atan2(Math.sin(e), Math.cos(e));
      C.bankHold = clamp(e * 1.5, -0.5, 0.5);
      C.gammaHold = clamp((hT - E.h) / 2500, -0.15, 0.15);
      if (E.rho < 0.02) return { done: true, msg: 'Cruise needs thicker air' };
      return {};
    },
  };
}

new Game();
