// Hangar: snap-together ship editor with live stats.
import * as THREE from 'three';
import { PARTS, PART, CATS, SIZES, RES, WING_LIMITS, variantDef } from '../ship/parts.js';
import { Craft } from '../ship/craft.js';
import { buildPartMesh, makeMaterials } from '../ship/meshes.js';
import { Q_FWD, mirrorQuat, PRESETS } from '../ship/designs.js';
import { deltaV } from '../ship/orbit.js';
import { atmosphere } from '../core/atmo.js';
import { save, load } from '../core/store.js';
import { G0 } from '../core/geo.js';
import { missionCheck } from './verdict.js';
import { encodeDesign, decodeDesign, shareLink } from '../core/share.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#e8ecf0', '#c9ced6', '#8e98a6', '#3d4b5c', '#1d232c', '#f3f0e6', '#b8372e', '#2f5fae', '#2e7d5b', '#d9a22b', '#5a3d8a', '#ff7a3d'];
const ACCENTS = ['#ffb347', '#7fd4ff', '#ff5a4f', '#73e2a7', '#c58bff', '#ffffff', '#ffd400', '#ff7a3d', '#1d232c'];

export class Builder {
  constructor(game) {
    this.game = game;
    this.renderer = game.renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
    this.orbit = { yaw: -0.8, pitch: 0.35, dist: 30, target: new THREE.Vector3() };
    this.cat = 'cockpit';
    this.placing = null;     // part id being placed
    this.selected = -1;
    this.sym = true;
    this.markers = true;
    this.undoStack = [];
    this.ghost = null;
    this.buildEnvironment();
    this.bindUi();
    this.pointer = new THREE.Vector2();
    this.ray = new THREE.Raycaster();
    this.thumbs = {};
  }

  // ---------------- hangar scene ----------------
  buildEnvironment() {
    const s = this.scene;
    s.background = new THREE.Color(0x0b0f17);
    s.fog = new THREE.Fog(0x0b0f17, 80, 260);
    // floor with grid
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#1a1f27'; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#262d38'; g.lineWidth = 2;
    for (let i = 0; i <= 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke(); }
    g.strokeStyle = '#3a3220'; g.lineWidth = 6; g.beginPath(); g.moveTo(256, 0); g.lineTo(256, 512); g.stroke();
    const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(30, 30); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    s.add(floor);
    this.floor = floor;
    // walls and ceiling lights
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x232a35, roughness: 0.9, metalness: 0.2 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(260, 60), wallMat); back.position.set(0, 30, -90); s.add(back);
    const left = back.clone(); left.rotation.y = Math.PI / 2; left.position.set(-110, 30, 0); s.add(left);
    const right = back.clone(); right.rotation.y = -Math.PI / 2; right.position.set(110, 30, 0); s.add(right);
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 1; j++) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(14, 0.3, 1.2), new THREE.MeshBasicMaterial({ color: 0xfff3dc }));
      l.position.set(i * 30, 45, j * 30); s.add(l);
    }
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(260, 2.5), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    stripe.position.set(0, 6, -89.9); s.add(stripe);
    s.add(new THREE.HemisphereLight(0xcfd8e8, 0x2a2622, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(30, 60, 40); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -40; key.shadow.camera.right = 40; key.shadow.camera.top = 40; key.shadow.camera.bottom = -40;
    s.add(key);
    const fill = new THREE.DirectionalLight(0x9cc4ff, 0.8); fill.position.set(-40, 20, -30); s.add(fill);
    // simple environment for metal reflections
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.MeshBasicMaterial({ color: 0x1b2230, side: THREE.BackSide })));
    for (let i = 0; i < 6; i++) { const p = new THREE.Mesh(new THREE.PlaneGeometry(30, 4), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })); p.position.set(Math.cos(i) * 30, 35, Math.sin(i) * 30); p.lookAt(0, 0, 0); envScene.add(p); }
    const gnd = new THREE.Mesh(new THREE.CircleGeometry(48, 24), new THREE.MeshBasicMaterial({ color: 0x3a3a3a })); gnd.rotation.x = -Math.PI / 2; gnd.position.y = -5; envScene.add(gnd);
    this.env = pm.fromScene(envScene, 0.02).texture;
    s.environment = this.env;
    this.game.scene.environment = this.env;      // reuse in flight for ship reflections
    this.shipRoot = new THREE.Group();
    s.add(this.shipRoot);
    this.markerGroup = new THREE.Group();
    s.add(this.markerGroup);
  }

  // ---------------- UI ----------------
  bindUi() {
    const cats = $('hb-cats');
    for (const c of CATS) {
      const b = document.createElement('button'); b.textContent = c.name; b.dataset.cat = c.id;
      b.onclick = () => { this.cat = c.id; this.renderCats(); this.renderParts(); };
      cats.appendChild(b);
    }
    $('hb-sym').onclick = () => { this.sym = !this.sym; $('hb-sym').classList.toggle('on', this.sym); };
    $('hb-rotL').onclick = () => this.rotateSel(new THREE.Vector3(1, 0, 0), -15);
    $('hb-rotR').onclick = () => this.rotateSel(new THREE.Vector3(1, 0, 0), 15);
    $('hb-tiltU').onclick = () => this.rotateSel(new THREE.Vector3(0, 0, 1), 5);
    $('hb-tiltD').onclick = () => this.rotateSel(new THREE.Vector3(0, 0, 1), -5);
    $('hb-del').onclick = () => this.deleteSel();
    $('hb-undo').onclick = () => this.undo();
    $('hb-markers').onclick = () => { this.markers = !this.markers; $('hb-markers').classList.toggle('on', this.markers); this.updateMarkers(); };
    $('hb-paint').onclick = () => this.togglePaint();
    $('hb-new').onclick = () => this.game.dialog('New ship', '<p class="dim">Start from an empty hangar or a preset?</p>', [
      ['Empty (start with a cockpit)', () => this.setDesign({ name: 'My ship', colors: { hull: '#e8ecf0', accent: '#ffb347' }, parts: [], vertical: false })],
      ...PRESETS.map((p) => [`Copy of ${p.make().name}`, () => { const d = p.make(); d.name = d.name + ' mk2'; this.setDesign(d); }]),
    ]);
    $('hb-load').onclick = () => this.shipsDialog();
    $('hb-save').onclick = () => this.saveDesign();
    $('hb-launch').onclick = () => { if (!this.valid()) return; this.saveDesign(true); this.game.setDesign(this.design); this.game.openLaunch(); };
    $('hb-name').onchange = () => { this.design.name = $('hb-name').value.trim() || 'My ship'; };
    const cv = this.game.canvas;
    this.drag = null;
    cv.addEventListener('pointerdown', (e) => { if (this.game.state !== 'hangar') return; this.drag = { x: e.clientX, y: e.clientY, moved: 0, id: e.pointerId }; this.hover(e); });
    cv.addEventListener('pointermove', (e) => {
      if (this.game.state !== 'hangar') return;
      if (this.drag && this.drag.id === e.pointerId) this.drag.moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      this.hover(e);
    });
    cv.addEventListener('pointerup', (e) => {
      if (this.game.state !== 'hangar' || !this.drag) return;
      const tap = this.drag.moved < 8;
      this.drag = null;
      if (tap) this.tap(e);
    });
  }
  // ---- reshaping wings: span, chords and sweep of the selected wing (and its mirror twin) ----
  renderShape() {
    const el = $('hb-shape');
    const d = this.selected >= 0 ? this.design.parts[this.selected] : null;
    const base = d && PART[d.id];
    const show = (on) => { el.hidden = !on; $('hangar').classList.toggle('shaping', on); };
    if (!base || !base.wing || this.placing) { show(false); this._shapeFor = -1; return; }
    if (this._shapeFor === this.selected && !el.hidden) { this.shapeValues(); return; }
    this._shapeFor = this.selected;
    const L = WING_LIMITS;
    const row = (k, label, min, max, step) => `<label><span class="dim">${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"><span class="v" data-v="${k}"></span></label>`;
    el.innerHTML = `<div class="sh-h"><b>Shape ${base.name}</b><button class="btn sm" id="sh-reset" style="min-height:26px">Reset</button></div>
      ${row('span', 'Span', L.span[0], Math.min(L.span[1], base.wing.span * 3), 0.05)}
      ${row('root', 'Root chord', L.root[0], Math.min(L.root[1], base.wing.root * 2.5), 0.05)}
      ${row('tip', 'Tip chord', L.tip[0], Math.min(L.tip[1], Math.max(base.wing.tip * 3, base.wing.root * 1.5)), 0.05)}
      ${row('sweep', 'Sweep', -35, 70, 1)}
      <div class="dim" id="sh-info"></div>`;
    show(true);
    $('hb-paintp').hidden = true;
    for (const inp of el.querySelectorAll('input')) {
      inp.addEventListener('pointerdown', () => { if (!this._shapeUndo) { this.push(); this._shapeUndo = true; } });
      inp.addEventListener('change', () => { this._shapeUndo = false; });
      inp.addEventListener('input', () => {
        if (!this._shapeUndo) { this.push(); this._shapeUndo = true; }
        const cur = this.shapeOf(this.design.parts[this.selected]);
        const k = inp.dataset.k;
        cur[k] = k === 'sweep' ? (+inp.value * Math.PI) / 180 : +inp.value;
        if (k === 'root' && cur.tip > cur.root * 1.5) cur.tip = cur.root * 1.5;
        this.setShape(cur);
      });
    }
    $('sh-reset').onclick = () => { this.push(); this.setShape(null); };
    this.shapeValues();
  }
  shapeOf(d) { const w = variantDef(PART[d.id], d.w).wing; return { span: w.span, root: w.root, tip: w.tip, sweep: w.sweep }; }
  setShape(o) {
    const d = this.design.parts[this.selected];
    const r2 = (v) => Math.round(v * 100) / 100;
    const val = o ? { span: r2(o.span), root: r2(o.root), tip: r2(o.tip), sweep: Math.round(o.sweep * 1000) / 1000 } : undefined;
    for (const rec of [d, d.sym >= 0 ? this.design.parts[d.sym] : null]) { if (!rec) continue; if (val) rec.w = { ...val }; else delete rec.w; }
    if (!this._shapeRaf) this._shapeRaf = requestAnimationFrame(() => { this._shapeRaf = 0; this.rebuild(); });
    this.shapeValues();
  }
  shapeValues() {
    const el = $('hb-shape'), d = this.design.parts[this.selected];
    if (!d || el.hidden) return;
    const w = variantDef(PART[d.id], d.w).wing;
    for (const inp of el.querySelectorAll('input')) {
      const k = inp.dataset.k, v = k === 'sweep' ? (w.sweep * 180) / Math.PI : w[k];
      if (document.activeElement !== inp) inp.value = v;
      el.querySelector(`[data-v="${k}"]`).textContent = k === 'sweep' ? `${Math.round(v)}°` : `${v.toFixed(2)} m`;
    }
    const def = variantDef(PART[d.id], d.w);
    $('sh-info').textContent = `${w.area.toFixed(1)} m² each · aspect ratio ${w.ar.toFixed(1)} · ${(def.mass / 1000).toFixed(2)} t`;
  }
  renderCats() { for (const b of $('hb-cats').children) b.classList.toggle('on', b.dataset.cat === this.cat); }
  renderParts() {
    const el = $('hb-parts'); el.innerHTML = '';
    for (const p of PARTS.filter((x) => x.cat === this.cat)) {
      const b = document.createElement('button'); b.className = 'pcard' + (this.placing === p.id ? ' on' : '');
      const img = document.createElement('img'); img.alt = ''; img.src = this.thumb(p);
      const info = document.createElement('div');
      info.innerHTML = `<div class="pn">${p.name}</div><div class="pd">${p.desc}</div><div class="pm">${partSpec(p)}</div>`;
      b.append(img, info);
      b.onclick = () => { this.placing = this.placing === p.id ? null : p.id; this.selected = -1; this.renderParts(); this.refreshGhost(); this.hint(); };
      el.appendChild(b);
    }
  }
  hint() {
    let t;
    if (!this.design.parts.length) t = 'Pick a cockpit to start your ship';
    else if (this.placing) t = `Tap on your ship to attach the ${PART[this.placing].name} · tap empty space to cancel`;
    else if (this.selected >= 0) t = `${PART[this.design.parts[this.selected].id].name} selected · ${PART[this.design.parts[this.selected].id].wing ? 'reshape it with the sliders, ' : ''}rotate, tilt or delete it`;
    else t = 'Pick a part, then tap your ship · drag to look around · tap a part to select it';
    $('hb-hint').textContent = t;
    this.renderShape();
  }
  togglePaint() {
    const p = $('hb-paintp');
    if (!p.hidden) { p.hidden = true; return; }
    $('hb-shape').hidden = true; $('hangar').classList.remove('shaping'); this._shapeFor = -1;
    const sw = (list, key) => list.map((c) => `<button class="sw${this.design.colors[key] === c ? ' on' : ''}" data-k="${key}" data-c="${c}" style="background:${c}"></button>`).join('');
    p.innerHTML = `<div class="dim small">Hull</div><div class="swatches">${sw(COLORS, 'hull')}</div><div class="dim small">Accent</div><div class="swatches">${sw(ACCENTS, 'accent')}</div>`;
    for (const b of p.querySelectorAll('.sw')) b.onclick = () => { this.push(); this.design.colors[b.dataset.k] = b.dataset.c; this.rebuild(); this.togglePaint(); this.togglePaint(); };
    p.hidden = false;
  }
  shipsDialog() {
    const opts = this.game.shipList().map((d) => [d.name + (PRESETS.some((p) => p.make().name === d.name) ? ' (preset)' : ''), () => this.setDesign(JSON.parse(JSON.stringify(d)))]);
    if (this.craft && this.craft.parts.length) opts.push([`Share “${this.design.name}” (code or link)…`, () => this.shareDialog()]);
    opts.push(['Import a ship from a code…', () => this.importDialog()]);
    const mine = this.game.designs;
    if (mine.length) opts.push(['Delete a saved ship…', () => this.game.dialog('Delete', '', mine.map((d) => [d.name, () => { this.game.designs = mine.filter((x) => x !== d); save('designs', this.game.designs); }]))]);
    this.game.dialog('Ships', '', opts);
  }
  // ---- share codes ----
  async shareDialog() {
    this.design.name = ($('hb-name').value.trim() || this.design.name || 'My ship').slice(0, 24);
    const code = await encodeDesign(this.design), link = shareLink(code);
    const copy = (text, what) => async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
        ta.remove();
      }
      this.game.hud.toast(ok ? `${what} copied` : 'Couldn’t copy — select the code and copy it by hand', ok ? 'good' : 'bad');
    };
    this.game.dialog(`Share “${this.design.name}”`, `<p class="dim small">Anyone can paste this code into their hangar (Ships → Import), or open the link to get the ship straight away.</p><textarea id="sh-code" class="field code" readonly rows="4" spellcheck="false">${code}</textarea><p class="dim small">${code.length.toLocaleString('en-US')} characters · ${this.craft.parts.length} parts</p>`, [
      ['Copy code', copy(code, 'Ship code')],
      ['Copy link', copy(link, 'Link')],
    ]);
    const ta = $('sh-code'); if (ta) ta.onfocus = () => ta.select();
  }
  importDialog() {
    this.game.dialog('Import a ship', '<p class="dim small">Paste a ship code (starts with SF1.) or a shared link:</p><textarea id="sh-in" class="field code" rows="4" spellcheck="false" placeholder="SF1.…"></textarea>', [
      ['Import', () => this.importCode($('sh-in').value)],
    ]);
    setTimeout(() => $('sh-in') && $('sh-in').focus(), 50);
  }
  async importCode(code) {
    let d;
    try { d = await decodeDesign(code); } catch (e) { this.game.hud.toast(`That code didn’t work: ${e.message}`, 'bad'); return false; }
    const taken = new Set(this.game.shipList().map((x) => x.name));
    let name = d.name, k = 2;
    while (taken.has(name)) name = `${d.name.slice(0, 20)} (${k++})`;
    d.name = name;
    this.game.designs = [...this.game.designs, JSON.parse(JSON.stringify(d))];
    save('designs', this.game.designs);
    this.setDesign(d);
    this.game.hud.toast(`Imported “${d.name}” — ${d.parts.length} parts`, 'good');
    return true;
  }
  saveDesign(quiet) {
    this.design.name = ($('hb-name').value.trim() || this.design.name || 'My ship').slice(0, 24);
    if (PRESETS.some((p) => p.make().name === this.design.name)) { this.design.name += ' (mine)'; $('hb-name').value = this.design.name; }
    const list = this.game.designs.filter((d) => d.name !== this.design.name);
    list.push(JSON.parse(JSON.stringify(this.design)));
    this.game.designs = list;
    save('designs', list);
    if (!quiet) this.game.hud.toast(`Saved “${this.design.name}”`, 'good');
  }

  // ---------------- open/close ----------------
  open(design) {
    this.renderCats(); this.renderParts();
    $('hb-sym').classList.toggle('on', this.sym);
    $('hb-markers').classList.toggle('on', this.markers);
    this.setDesign(JSON.parse(JSON.stringify(design)));
    this.game.scene.environment = this.env;
  }
  onBack() { this.saveDesign(true); this.game.setDesign(this.design); }
  setDesign(d) {
    this.design = d;
    if (!this.design.colors) this.design.colors = { hull: '#e8ecf0', accent: '#ffb347' };
    $('hb-name').value = d.name || 'My ship';
    this.undoStack = [];
    this.selected = -1;
    this.placing = d.parts.length ? null : 'ck-kestrel';
    if (!d.parts.length) { this.cat = 'cockpit'; this.renderCats(); this.renderParts(); }
    this.rebuild(true);
  }
  push() { this.undoStack.push(JSON.stringify(this.design)); if (this.undoStack.length > 60) this.undoStack.shift(); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.design = JSON.parse(s); this.selected = -1; this.rebuild(); }

  rebuild(frame = false) {
    if (this.craft) { this.shipRoot.remove(this.craft.group); this.craft.dispose(); }
    this.craft = new Craft(this.design);
    this.craft.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    this.shipRoot.add(this.craft.group);
    this.layout();
    if (frame || !this.framed) { this.frameCamera(); this.framed = true; }
    this.updateMarkers();
    this.updateStats();
    this.highlight();
    this.hint();
  }
  // body frame -> hangar: horizontal ships sit on their wheels, vertical ships stand on their tail
  layout() {
    const c = this.craft;
    if (this.design.vertical) {
      this.shipRoot.rotation.set(Math.PI / 2, 0, 0);       // body -Z (nose) -> +Y (up)
      const low = c.parts.length ? c.box.max.z : 0;
      this.shipRoot.position.set(0, low + 0.05, 0);
    } else {
      this.shipRoot.rotation.set(0, 0, 0);
      const low = c.parts.length ? -c.box.min.y : 0;
      this.shipRoot.position.set(0, Math.max(1.5, low + 0.05), 0);
    }
    this.shipRoot.updateMatrixWorld(true);
  }
  frameCamera() {
    const box = new THREE.Box3().setFromObject(this.shipRoot);
    if (box.isEmpty()) { this.orbit.target.set(0, 2, 0); this.orbit.dist = 18; return; }
    this.orbit.target.copy(box.getCenter(new THREE.Vector3()));
    this.orbit.dist = Math.max(10, box.getSize(new THREE.Vector3()).length() * 1.3);
  }

  // ---------------- picking and placement ----------------
  pick(e) {
    const r = this.game.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObject(this.craft.group, true).filter((h) => h.object.userData.part !== undefined && h.object.visible);
    return hits[0] || null;
  }
  hover(e) {
    if (!this.placing || !this.ghost) return;
    const h = this.pick(e);
    const pl = h ? this.placement(this.placing, h) : null;
    this.ghost.visible = !!pl;
    if (pl) this.setGhost(pl);
  }
  tap(e) {
    const h = this.pick(e);
    if (this.placing) {
      if (!this.design.parts.length) { this.placeRoot(this.placing); return; }
      if (!h) { this.placing = null; this.renderParts(); this.refreshGhost(); this.hint(); return; }
      const pl = this.placement(this.placing, h);
      if (pl) this.place(pl);
      return;
    }
    this.selected = h ? h.object.userData.part : -1;
    this.highlight(); this.hint();
  }
  placeRoot(id) {
    this.push();
    this.design.parts.push({ id, p: [0, 0, 0], q: Q_FWD.toArray(), mirror: false, parent: -1, sym: -1 });
    this.placing = null; this.renderParts(); this.refreshGhost();
    this.rebuild(true);
  }

  // compute attachment of part `id` at raycast hit h; returns {p, q, parent, node:boolean, normal}
  placement(id, h) {
    const def = PART[id];
    const parentIdx = h.object.userData.part;
    const PP = this.craft.parts[parentIdx];
    if (!PP) return null;
    const inv = new THREE.Matrix4().copy(this.shipRoot.matrixWorld).invert();
    const hit = h.point.clone().applyMatrix4(inv);
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld).transformDirection(inv).normalize() : new THREE.Vector3(1, 0, 0);
    // 1. stack nodes near the hit
    if (def.nodes && def.nodes.length) {
      let best = null, bd = Infinity;
      for (let i = 0; i < this.craft.parts.length; i++) {
        const Q = this.craft.parts[i];
        if (!Q.def.nodes) continue;
        for (const nd of Q.def.nodes) {
          const pW = new THREE.Vector3(...nd.p).applyMatrix4(Q.T);
          const d = pW.distanceTo(hit);
          const lim = Math.max(0.8, SIZES[nd.s] * 0.6);
          if (d > lim || d >= bd) continue;
          if (this.nodeUsed(i, pW)) continue;
          const want = nd.n[1] < 0 ? 1 : -1;        // attach our top node to a bottom node and vice versa
          const myNode = def.nodes.find((m) => Math.sign(m.n[1]) === want);
          if (!myNode) continue;
          bd = d; best = { Q, i, nd, pW, myNode };
        }
      }
      if (best) {
        const q = new THREE.Quaternion(...this.design.parts[best.i].q);
        if (this.design.parts[best.i].mirror) q.copy(mirrorQuat(q));          // keep stacks aligned on mirrored parents
        const p = best.pW.clone().sub(new THREE.Vector3(...best.myNode.p).applyQuaternion(q));
        return { p, q, parent: best.i, node: true };
      }
    }
    if (def.surface === false || !PP.def.surface) return null;
    // 2. surface attach: +X along the surface normal, +Y toward the nose
    const xAxis = n.clone();
    let fwd = new THREE.Vector3(0, 0, -1);
    if (Math.abs(fwd.dot(xAxis)) > 0.95) fwd = new THREE.Vector3(0, 1, 0);
    const yAxis = fwd.addScaledVector(xAxis, -fwd.dot(xAxis)).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
    const p = hit.clone();
    if (def.nodes && def.nodes.length) p.addScaledVector(xAxis, (def.size ? SIZES[def.size] : 1) / 2);   // radial stack parts sit on the surface
    return { p, q, parent: parentIdx, node: false, normal: n };
  }
  nodeUsed(i, pW) {
    for (let j = 0; j < this.craft.parts.length; j++) {
      if (j === i) continue;
      const Q = this.craft.parts[j];
      for (const nd of Q.def.nodes || []) if (new THREE.Vector3(...nd.p).applyMatrix4(Q.T).distanceTo(pW) < 0.08) return true;
    }
    return false;
  }
  place(pl) {
    this.push();
    const id = this.placing;
    const parts = this.design.parts;
    const a = parts.length;
    parts.push({ id, p: pl.p.toArray().map(r3), q: pl.q.toArray().map(r5), mirror: false, parent: pl.parent, sym: -1 });
    // symmetry twin across the centreline
    if (this.sym && Math.abs(pl.p.x) > 0.15) {
      const pp = parts[pl.parent];
      const parentTwin = pp && pp.sym >= 0 ? pp.sym : pl.parent;
      const mq = mirrorQuat(pl.q);
      parts.push({ id, p: [r3(-pl.p.x), r3(pl.p.y), r3(pl.p.z)], q: mq.toArray().map(r5), mirror: true, parent: parentTwin, sym: a });
      parts[a].sym = a + 1;
    }
    this.game.audio.click();
    this.rebuild();
    this.refreshGhost();
  }
  rotateSel(axis, deg) {
    const i = this.selected;
    if (i < 0) { this.game.hud.toast('Select a part first'); return; }
    this.push();
    const P = this.design.parts[i];
    const apply = (rec, sgn) => {
      const q = new THREE.Quaternion(...rec.q);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, sgn * deg * Math.PI / 180));
      rec.q = q.toArray().map(r5);
    };
    apply(P, 1);
    if (P.sym >= 0 && this.design.parts[P.sym]) apply(this.design.parts[P.sym], axis.x ? -1 : 1);
    this.rebuild();
  }
  deleteSel() {
    const i = this.selected;
    if (i < 0) { this.game.hud.toast('Select a part first'); return; }
    if (i === 0 && this.design.parts.length > 1) { this.game.hud.toast('Delete the other parts before the root', 'bad'); return; }
    this.push();
    const parts = this.design.parts;
    const kill = new Set();
    const mark = (k) => { if (kill.has(k)) return; kill.add(k); parts.forEach((p, j) => { if (p.parent === k) mark(j); }); };
    mark(i);
    if (parts[i].sym >= 0) mark(parts[i].sym);
    const map = new Map();
    const keep = [];
    parts.forEach((p, j) => { if (!kill.has(j)) { map.set(j, keep.length); keep.push(p); } });
    for (const p of keep) { p.parent = p.parent >= 0 ? (map.get(p.parent) ?? -1) : -1; p.sym = p.sym >= 0 ? (map.get(p.sym) ?? -1) : -1; }
    this.design.parts = keep;
    this.selected = -1;
    this.rebuild();
  }

  // ---------------- ghost, markers, highlight ----------------
  refreshGhost() {
    if (this.ghost) { this.shipRoot.remove(this.ghost); this.ghost = null; }
    if (!this.placing) return;
    const M = makeMaterials(this.design.colors);
    const g = buildPartMesh(PART[this.placing], M);
    g.traverse((o) => { if (o.isMesh) { o.material = o.material.clone ? (Array.isArray(o.material) ? o.material.map((m) => ghostMat(m)) : ghostMat(o.material)) : o.material; o.raycast = () => {}; } });
    g.visible = false;
    this.ghost = g;
    this.shipRoot.add(g);
  }
  setGhost(pl) {
    this.ghost.position.copy(pl.p);
    this.ghost.quaternion.copy(pl.q);
    this.ghost.scale.set(1, 1, 1);
  }
  highlight() {
    if (!this.craft) return;
    for (const P of this.craft.parts) {
      const on = P.i === this.selected || (this.selected >= 0 && this.design.parts[this.selected] && this.design.parts[this.selected].sym === P.i);
      if (P.m) for (const m of P.m.heatList) { m.emissive.setRGB(on ? 0.25 : 0, on ? 0.15 : 0, on ? 0.02 : 0); }
    }
  }
  updateMarkers() {
    const g = this.markerGroup;
    while (g.children.length) g.remove(g.children[0]);
    if (!this.markers || !this.craft.parts.length) return;
    const st = this.stats;
    const mk = (pos, color, r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 })); m.renderOrder = 10; m.position.copy(pos).applyMatrix4(this.shipRoot.matrixWorld); g.add(m); return m; };
    mk(this.craft.com, 0xffd84a, 0.45);
    if (st && st.col) mk(st.col, 0x4ab8ff, 0.4);
    if (st && st.cot) mk(st.cot, 0xff7a3d, 0.3);
  }

  // ---------------- stats ----------------
  updateStats() {
    const c = this.craft;
    const el = $('hb-stats');
    if (!c.parts.length) { el.className = 'hb-stats panel'; el.innerHTML = '<div class="dim">Empty hangar</div>'; this.stats = null; return; }
    const st = this.stats = {};
    const mass = c.mass;
    const atm0 = { rho: 1.225, p: 101325, mach: 0, h: 0, T: 288, a: 340 };
    const vac = { rho: 0, p: 0, mach: 0, h: 1e6, T: 3, a: 300 };
    let tSL = 0, tVac = 0;
    const cot = new THREE.Vector3(); let tw = 0;
    for (const P of c.engines) {
      const a = c.engineOutput(P, atm0)[0];
      const save = P.eng.mode; if (P.eng.e.type === 'hybrid') P.eng.mode = 'rocket';
      const v = c.engineOutput(P, vac)[0]; P.eng.mode = save;
      tSL += a; tVac += v;
      cot.addScaledVector(P.eng.pos, Math.max(a, v)); tw += Math.max(a, v);
    }
    if (tw > 0) st.cot = cot.divideScalar(tw);
    let S = 0, Sh = 0; const col = new THREE.Vector3(); let mac = 0;
    for (const P of c.wings) {
      S += P.wing.area;
      if (Math.abs(P.wing.n.y) > 0.5) { Sh += P.wing.area; col.addScaledVector(P.wing.ac, P.wing.area); mac += P.def.wing.mac * P.wing.area; }
    }
    if (Sh > 0) { st.col = col.divideScalar(Sh); mac /= Sh; }
    const vs = S > 0 ? Math.sqrt((2 * mass * G0) / (1.225 * Math.max(Sh, 0.1) * 1.25)) : Infinity;
    const dvVac = deltaV(c, false), dvAtm = deltaV(c, true);
    const twr = tSL / (mass * G0);
    const rows = [
      ['Mass', `${(mass / 1000).toFixed(1)} t`],
      ['Parts', c.parts.length],
      ['Thrust (sea level)', `${(tSL / 1000).toFixed(0)} kN`],
      ['Thrust (vacuum)', `${(tVac / 1000).toFixed(0)} kN`],
      ['TWR (Earth)', twr.toFixed(2)],
      ['Δv (main engines)', dvVac > 0 ? `${Math.round(dvVac).toLocaleString('en-US')} m/s` : '—'],
    ];
    const jets = c.engines.filter((P) => ['jet', 'scram', 'hybrid'].includes(P.eng.e.type));
    if (jets.length) {
      let mdot = 0; for (const P of jets) { const [t, isp] = c.engineOutput(P, atm0); mdot += t / (isp * G0); }
      const lf = c.capacity('LF');
      if (mdot > 0) rows.push(['Jet fuel time (full)', `${Math.round(lf / mdot / 60)} min`]);
    }
    if (c.engines.some((P) => P.eng.e.lift)) rows.push(['Hover TWR (lift)', (c.engines.filter((P) => P.eng.e.lift).reduce((s, P) => s + c.engineOutput(P, atm0)[0], 0) / (mass * G0)).toFixed(2)]);
    if (S > 0) { rows.push(['Wing area', `${S.toFixed(1)} m²`]); rows.push(['Stall speed', isFinite(vs) ? `${Math.round(vs)} m/s` : '—']); }
    const gl = c.gLimit;
    if (isFinite(gl)) rows.push(['Wings break at', `${gl.toFixed(1)} g`]);
    for (const k of ['LF', 'OX', 'FU', 'XE', 'ABL']) { const cap = c.capacity(k); if (cap > 0) rows.push([RES[k].name, `${Math.round(cap).toLocaleString('en-US')} kg`]); }
    const pw = c.powerBudget(true);
    if (pw.gen > 0 || pw.draw > 0) rows.push(['Power (gen / drives)', `${fmtKW(pw.gen)} / ${fmtKW(pw.draw)}`]);
    // warnings and checks
    const warn = [];
    const good = [];
    if (!c.engines.length) warn.push(['No engines', 'bad']);
    if (st.col && !this.design.vertical) {
      const margin = (st.col.z - c.com.z) / Math.max(0.5, mac);
      st.margin = margin;
      if (margin < 0) warn.push(['Unstable: lift is ahead of the centre of mass (move wings back or add a tail)', 'bad']);
      else if (margin < 0.04) warn.push(['Very twitchy pitch — move wings a little back', '']);
      else if (margin > 0.6) warn.push(['Very stable — may struggle to pitch up', '']);
      else good.push('Pitch stability looks good');
    }
    const gears = c.gears;
    if (!gears.length) warn.push(['No landing gear', '']);
    else if (!this.design.vertical) {
      const wheels = gears.map((P) => P.gear.ext.clone().multiplyScalar(P.gear.g.len + P.gear.g.wheel).add(P.gear.mount));
      const ahead = wheels.filter((w) => w.z < c.com.z - 0.2), behind = wheels.filter((w) => w.z > c.com.z);
      if (!ahead.length || !behind.length) warn.push(['Gear must be both ahead of and behind the centre of mass', 'bad']);
      else {
        const xs = behind.map((w) => w.x);
        const track = Math.max(...xs) - Math.min(...xs);
        const h = c.com.y - Math.min(...wheels.map((w) => w.y));
        if (track < h * 0.9) warn.push(['Main gear track is narrow — the ship may tip over', '']);
        const back = Math.min(...behind.map((w) => w.z)) - c.com.z;
        if (back > 3.5) warn.push(['Main gear far behind the centre of mass — hard to rotate for take-off', '']);
        if (back < 0.25) warn.push(['Main gear barely behind the centre of mass — may tip onto the tail', '']);
      }
    }
    if (twr < 1 && this.design.vertical) warn.push(['TWR below 1 — this rocket can’t lift off Earth', 'bad']);
    if (!this.design.vertical && S > 0 && tSL / (mass * G0) < 0.2) warn.push(['Low thrust for take-off', '']);
    const fusionHeat = c.engines.reduce((s, P) => s + (P.eng.e.fusion ? P.eng.e.heat : 0), 0);
    if (fusionHeat > 0 && c.radCap < fusionHeat * 0.6) warn.push([`Fusion drive needs radiators (${Math.ceil(fusionHeat * 0.7 / 5e7)}+)`, '']);
    if (!c.parts[0].def.cat || c.parts[0].def.cat !== 'cockpit') warn.push(['The root part should be a cockpit', '']);
    if (c.docks.length && !c.rcsList.length) warn.push(['Add RCS thrusters so the docking port can steer in', '']);
    if (pw.draw > pw.gen) {
      const mins = c.ecCap > 0 ? (c.ecCap / Math.max(1, pw.draw - pw.gen)) * 60 : 0;
      warn.push([`Electric drives need ${fmtKW(pw.draw)} but the ship makes ${fmtKW(pw.gen)}${mins >= 1 ? ` — batteries last ${Math.round(mins)} min at full thrust` : ''}. Add a reactor.`, pw.gen <= 0 ? 'bad' : '']);
    }
    const reHeat = c.parts.reduce((s2, P) => s2 + (P.def.reactor ? P.def.reactor.heat : 0), 0);
    if (reHeat > 0 && c.radCap < reHeat) warn.push(['Reactors run hot — add a radiator panel', '']);
    if (isFinite(gl) && gl < 3.5) warn.push([`Wings too weak for this weight (break at ${gl.toFixed(1)} g) — thicker roots, shorter spans or more wing`, gl < 2 ? 'bad' : '']);
    let h = rows.map(([k, v]) => `<div class="row"><span class="dim">${k}</span><b>${v}</b></div>`).join('');
    // what this ship can do, at a glance
    const mc = st.mission = missionCheck(c, this.design);
    if (mc) {
      h += '<div class="mc"><div class="mc-h">Mission check</div>';
      for (const m of mc.list) h += `<div class="mc-row ${m.ok ? 'ok' : m.soft ? 'soft' : 'no'}"><i>${m.ok ? '✓' : m.soft ? '~' : '✗'}</i><span>${m.label}<small>${m.detail}</small></span></div>`;
      h += '</div>';
    }
    h += `<div class="row"><span class="dim">Launch</span><span><button class="btn sm" id="hb-vert" style="min-height:26px">${this.design.vertical ? 'Vertical' : 'Runway'}</button></span></div>`;
    for (const [w, k] of warn) h += `<div class="warn ${k}">⚠ ${w}</div>`;
    for (const g of good) h += `<div class="good small">✓ ${g}</div>`;
    h += `<div class="dim small" style="margin-top:6px"><span style="color:#ffd84a">●</span> mass <span style="color:#4ab8ff">●</span> lift <span style="color:#ff7a3d">●</span> thrust</div>`;
    el.className = 'hb-stats panel';
    el.innerHTML = h;
    $('hb-vert').onclick = () => { this.push(); this.design.vertical = !this.design.vertical; this.rebuild(true); };
  }
  valid() {
    if (!this.craft || !this.craft.parts.length) { this.game.hud.toast('Add a cockpit first', 'bad'); return false; }
    return true;
  }

  // ---------------- thumbnails ----------------
  thumb(def) {
    if (this.thumbs[def.id]) return this.thumbs[def.id];
    if (!this.thumbR) {
      this.thumbCanvas = document.createElement('canvas'); this.thumbCanvas.width = this.thumbCanvas.height = 128;
      this.thumbR = new THREE.WebGLRenderer({ canvas: this.thumbCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      this.thumbR.outputColorSpace = THREE.SRGBColorSpace;
      this.thumbScene = new THREE.Scene();
      this.thumbScene.add(new THREE.HemisphereLight(0xdde6f5, 0x30302a, 1.6));
      const d = new THREE.DirectionalLight(0xffffff, 2.2); d.position.set(3, 5, 4); this.thumbScene.add(d);
      this.thumbScene.environment = this.env;
      this.thumbCam = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
      this.thumbMats = makeMaterials({ hull: '#dfe4ea', accent: '#ffb347' });
    }
    const g = buildPartMesh(def, this.thumbMats);
    g.rotation.set(-Math.PI / 2, 0, 0);                    // part +Y -> -Z like on the ship
    if (!def.nodes || !def.nodes.length || def.wing) g.rotation.set(-Math.PI / 2, 0, 0);
    this.thumbScene.add(g);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
    this.thumbCam.position.copy(c).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(s * 1.9));
    this.thumbCam.lookAt(c);
    this.thumbR.setClearColor(0x0b111c, 1);
    this.thumbR.render(this.thumbScene, this.thumbCam);
    const url = this.thumbCanvas.toDataURL('image/png');
    this.thumbScene.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.thumbs[def.id] = url;
    return url;
  }

  // ---------------- frame ----------------
  frame(dt, camIn) {
    this.orbit.yaw -= camIn.dx * 0.006;
    this.orbit.pitch = Math.max(-0.2, Math.min(1.45, this.orbit.pitch + camIn.dy * 0.006));
    this.orbit.dist = Math.max(4, Math.min(160, this.orbit.dist * Math.exp(camIn.zoom * 0.12)));
    const o = this.orbit;
    this.camera.position.set(o.target.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, o.target.y + Math.sin(o.pitch) * o.dist, o.target.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist);
    this.camera.position.y = Math.max(0.5, this.camera.position.y);
    this.camera.lookAt(o.target);
    const w = innerWidth, h = innerHeight;
    if (this.camera.aspect !== w / h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    if (this.craft) this.craft.updateVisuals(dt, performance.now() / 1000, {});
    this.renderer.shadowMap.enabled = true;
    this.renderer.render(this.scene, this.camera);
  }
}

const fmtKW = (kw) => (kw >= 1000 ? `${(kw / 1000).toFixed(1)} MW` : `${Math.round(kw)} kW`);
function ghostMat(m) { const g = m.clone(); g.transparent = true; g.opacity = 0.45; g.depthWrite = false; if (g.emissive) g.emissive.setRGB(0.1, 0.25, 0.4); return g; }
const r3 = (v) => Math.round(v * 1000) / 1000;
const r5 = (v) => Math.round(v * 100000) / 100000;
function partSpec(p) {
  const out = [`${(p.mass / 1000).toFixed(2)} t`];
  if (p.engine) {
    const e = p.engine;
    if (e.type === 'rocket') out.push(`${Math.round(e.thrust / 1000)} kN · Isp ${e.ispVac}s`);
    else if (e.type === 'hybrid') out.push(`${Math.round(e.thrust / 1000)} kN air / ${Math.round(e.rocket.thrust / 1000)} kN rocket`);
    else out.push(`${Math.round(e.thrust / 1000)} kN · Mach ${e.maxMach}`);
  }
  if (p.wing) out.push(`${p.wing.area.toFixed(1)} m²${p.wing.ctrl ? ' · control' : ''}`);
  if (p.res) out.push(Object.entries(p.res).map(([k, v]) => `${RES[k].name} ${Math.round(v)} kg`).join(' · '));
  if (p.gear) out.push(`${Math.round(p.gear.load / 1000)} t load`);
  if (p.torque) out.push(`${Math.round(p.torque / 1000)} kN·m gyro`);
  if (p.radiator) out.push(`${Math.round(p.radiator / 1e6)} MW`);
  return out.join(' · ');
}
