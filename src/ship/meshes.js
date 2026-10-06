// Procedural part models. Every builder returns a THREE.Group in part-local axes (see parts.js).

import * as THREE from 'three';
import { SIZES } from './parts.js';

const V2 = (x, y) => new THREE.Vector2(x, y);

// ---------- materials ----------
let panelTex = null;
function panels() {
  if (panelTex) return panelTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c8c8c8'; g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#8a8a8a'; g.lineWidth = 2;
  for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke(); }
  for (let j = 0; j < 4; j++) for (let i = 0; i <= 3; i++) {
    const x = i * 85 + (j % 2) * 42;
    g.beginPath(); g.moveTo(x, j * 64); g.lineTo(x, j * 64 + 64); g.stroke();
  }
  g.fillStyle = '#9a9a9a';
  for (let k = 0; k < 120; k++) g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  panelTex = new THREE.CanvasTexture(c);
  panelTex.wrapS = panelTex.wrapT = THREE.RepeatWrapping;
  panelTex.colorSpace = THREE.SRGBColorSpace;
  panelTex.anisotropy = 4;
  return panelTex;
}

// Hull decal patterns, painted over the panel lines (white = hull colour, dark = a darker shade of it)
export const PATTERNS = [['panels', 'Panels'], ['stripes', 'Racing stripes'], ['checker', 'Test checker'], ['hazard', 'Hazard'], ['camo', 'Splinter camo'], ['chevron', 'Chevrons']];
const patternTex = {};
function pattern(kind) {
  if (!kind || kind === 'panels') return panels();
  if (patternTex[kind]) return patternTex[kind];
  const base = panels().image;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.drawImage(base, 0, 0);
  g.fillStyle = 'rgba(40,40,44,0.78)';
  if (kind === 'stripes') { g.fillRect(96, 0, 22, 256); g.fillRect(138, 0, 22, 256); }
  else if (kind === 'checker') { for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) if ((x + y) % 2) g.fillRect(x * 128, y * 128, 128, 128); }
  else if (kind === 'hazard') {
    g.save(); g.beginPath(); g.rect(0, 0, 256, 256); g.clip();
    g.fillStyle = 'rgba(25,25,28,0.85)';
    for (let i = -256; i < 512; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 32, 0); g.lineTo(i + 32 - 256, 256); g.lineTo(i - 256, 256); g.closePath(); g.fill(); }
    g.restore();
  } else if (kind === 'camo') {
    let sd = 7; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 26; k++) {
      g.fillStyle = k % 2 ? 'rgba(40,46,40,0.55)' : 'rgba(80,86,78,0.45)';
      g.beginPath(); const cx = rnd() * 256, cy = rnd() * 256;
      g.moveTo(cx, cy); for (let i = 0; i < 4; i++) g.lineTo(cx + (rnd() - 0.5) * 120, cy + (rnd() - 0.5) * 120); g.closePath(); g.fill();
    }
  } else if (kind === 'chevron') {
    g.lineWidth = 18; g.strokeStyle = 'rgba(40,40,44,0.8)';
    for (const y of [40, 168]) { g.beginPath(); g.moveTo(0, y + 50); g.lineTo(128, y); g.lineTo(256, y + 50); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return (patternTex[kind] = t);
}

export function makeMaterials(colors) {
  const tex = pattern(colors.pattern);
  const hull = new THREE.MeshStandardMaterial({ color: colors.hull, metalness: 0.35, roughness: 0.42, map: tex, side: THREE.DoubleSide });
  // glow trim: the accent colour lit from within (night-time running lights for the whole ship)
  const accent = new THREE.MeshStandardMaterial({ color: colors.accent, metalness: 0.3, roughness: 0.35, emissive: new THREE.Color(colors.accent).multiplyScalar(colors.glow ? 1.1 : 0.12), side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2f37, metalness: 0.7, roughness: 0.38 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.2, roughness: 0.75, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0d1724, metalness: 0.9, roughness: 0.06, envMapIntensity: 1.5 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa1aa, metalness: 0.85, roughness: 0.3 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  const cells = new THREE.MeshStandardMaterial({ color: 0x1b2f63, metalness: 0.6, roughness: 0.25, emissive: 0x060c1c });
  const fusion = new THREE.MeshStandardMaterial({ color: 0x2d1b45, metalness: 0.5, roughness: 0.3, emissive: 0x7a3cff, emissiveIntensity: 0.9 });
  return { hull, accent, dark, black, glass, metal, glow, cells, fusion };
}

// ---------- helpers ----------
function lathe(pts, mat, seg = 32, phiStart = 0, phiLen = Math.PI * 2) {
  const g = new THREE.LatheGeometry(pts, seg, phiStart, phiLen);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function cylY(r1, r2, h, mat, seg = 32, open = false) {
  const g = new THREE.CylinderGeometry(r1, r2, h, seg, 1, open);
  return new THREE.Mesh(g, mat);
}
function ring(r, y, w, mat) { const m = cylY(r * 1.012, r * 1.012, w, mat, 40, true); m.position.y = y; m.material.side = THREE.DoubleSide; return m; }

function tubeUV(mesh, len, r) {
  // scale panel UVs so panels stay ~1.6 m wide regardless of size
  const uv = mesh.geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (Math.PI * 2 * r) / 3.2, uv.getY(i) * len / 3.2);
  uv.needsUpdate = true;
}

function ogive(len, r, n = 18, blunt = 0.06) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;                       // 0 at base, 1 at tip
    const rr = r * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - t * 0.15) + (t > 0.98 ? 0 : 0);
    pts.push(V2(Math.max(i === n ? 0 : r * blunt, rr), -len / 2 + t * len));
  }
  return pts;
}

// ---------- builders ----------
const B = {
  tube(def, M) {
    const r = SIZES[def.size] / 2, g = new THREE.Group();
    const m = cylY(r, r, def.len, M.hull, 40); tubeUV(m, def.len, r); g.add(m);
    g.add(ring(r, def.len / 2 - 0.06, 0.12, M.dark), ring(r, -def.len / 2 + 0.06, 0.12, M.dark));
    if (def.len >= 4) g.add(ring(r, 0, 0.25, M.accent));
    return g;
  },
  tank(def, M) {
    const r = SIZES[def.size] / 2, g = new THREE.Group();
    const m = cylY(r, r, def.len, M.hull, 40); tubeUV(m, def.len, r); g.add(m);
    for (const y of [-0.42, 0.42]) g.add(ring(r, y * def.len, 0.18, M.accent));
    g.add(ring(r, def.len / 2 - 0.06, 0.12, M.dark), ring(r, -def.len / 2 + 0.06, 0.12, M.dark));
    // feed line
    const pipe = cylY(r * 0.07, r * 0.07, def.len * 0.92, M.metal, 10); pipe.position.set(r * 1.02, 0, 0); g.add(pipe);
    return g;
  },
  fusionTank(def, M) {
    const g = B.tube(def, M), r = SIZES[def.size] / 2;
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.35, def.len * 0.6, 0.06), M.fusion);
      const a = (i / 6) * Math.PI * 2; w.position.set(Math.sin(a) * r * 1.01, 0, Math.cos(a) * r * 1.01); w.rotation.y = a; g.add(w);
    }
    return g;
  },
  cargo(def, M) {
    const g = B.tube(def, M), r = SIZES[def.size] / 2;
    for (const s of [-1, 1]) { const seam = new THREE.Mesh(new THREE.BoxGeometry(0.05, def.len * 0.9, 0.05), M.dark); seam.position.set(s * r * 0.45, 0, r * 0.9); g.add(seam); }
    return g;
  },
  cockpitFighter(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(V2(Math.max(0.0001, r * Math.pow(1 - t, 0.62) * (t < 0.15 ? 1 : 1)), -L / 2 + t * L)); }
    pts[pts.length - 1].x = 0;
    const body = lathe(pts, M.hull, 40); g.add(body);
    // canopy bubble
    const can = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.glass);
    can.scale.set(r * 0.62, L * 0.30, r * 0.75); can.rotation.x = 0; can.position.set(0, L * 0.02, r * 0.52);
    can.rotation.set(Math.PI / 2, 0, 0); can.scale.set(r * 0.6, r * 0.75, L * 0.28);
    can.position.set(0, L * 0.05, r * 0.55);
    g.add(can);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(r * 0.62, 0.04, 6, 20, Math.PI), M.dark);
    frame.position.set(0, -L * 0.04, r * 0.55); frame.rotation.set(Math.PI / 2, 0, 0); g.add(frame);
    g.add(ring(r, -L / 2 + 0.06, 0.12, M.dark));
    // accent nose stripe
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.08, L * 0.5, 0.05), M.accent); st.position.set(0, -L * 0.15, r * 0.97); st.rotation.x = 0.06; g.add(st);
    return g;
  },
  cockpitShuttle(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(V2(Math.max(0.0001, r * Math.pow(1 - t, 0.45)), -L / 2 + t * L)); }
    pts[pts.length - 1].x = 0;
    g.add(lathe(pts, M.hull, 40, -Math.PI / 2, Math.PI));          // top half
    g.add(lathe(pts.map((p) => V2(p.x * 1.004, p.y)), M.black, 40, Math.PI / 2, Math.PI));  // heat-tile belly
    // window band
    for (let i = -2; i <= 2; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.12), M.glass);
      const a = i * 0.32;
      w.position.set(Math.sin(a) * r * 0.86, L * 0.08, Math.cos(a) * r * 0.86);
      w.rotation.set(-0.5, a, 0);
      g.add(w);
    }
    g.add(ring(r, -L / 2 + 0.06, 0.12, M.dark));
    return g;
  },
  cockpitHeavy(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 24; i++) { const t = i / 24; pts.push(V2(Math.max(0.0001, r * Math.pow(1 - t, 0.5)), -L / 2 + t * L)); }
    pts[pts.length - 1].x = 0;
    g.add(lathe(pts, M.hull, 48));
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.83, r * 0.93, 0.7, 48, 1, true, -1.2, 2.4), M.glass);
    band.position.y = L * 0.05; band.material.side = THREE.DoubleSide; g.add(band);
    g.add(ring(r, -L / 2 + 0.08, 0.16, M.accent));
    return g;
  },
  capsule(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [V2(0.0001, -L / 2), V2(r, -L / 2), V2(r * 0.98, -L / 2 + 0.15), V2(r * 0.45, L / 2 - 0.1), V2(r * 0.42, L / 2), V2(0.0001, L / 2)];
    g.add(lathe(pts, M.hull, 40));
    for (const a of [-0.5, 0.5]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.1), M.glass);
      w.position.set(Math.sin(a) * r * 0.72, 0.1, Math.cos(a) * r * 0.72); w.rotation.set(-0.25, a, 0); g.add(w);
    }
    g.add(ring(r, -L / 2 + 0.08, 0.16, M.accent));
    return g;
  },
  cone(def, M) {
    const r = SIZES[def.size] / 2, g = new THREE.Group();
    g.add(lathe(ogive(def.len, r), M.hull, 40));
    const tip = new THREE.Mesh(new THREE.SphereGeometry(r * 0.07, 10, 8), M.accent); tip.position.y = def.len / 2 - r * 0.05; g.add(tip);
    return g;
  },
  adapter(def, M) {
    const top = SIZES[def.nodes[0].s] / 2, bot = SIZES[def.nodes[1].s] / 2, g = new THREE.Group();
    g.add(cylY(top, bot, def.len, M.hull, 40));
    g.add(ring(Math.max(top, bot), def.len / 2 * (top > bot ? 1 : -1) * 0.94, 0.1, M.dark));
    return g;
  },
  intake(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const sh = cylY(r * 0.85, r, L, M.hull, 32, true); sh.material = M.hull; g.add(sh);
    const inner = cylY(r * 0.8, r * 0.95, L * 0.98, M.black, 32, true); inner.material = M.black.clone(); inner.material.side = THREE.BackSide; g.add(inner);
    const spike = lathe([V2(0.0001, L / 2 + 0.5), V2(r * 0.55, L / 2 - 0.4), V2(r * 0.5, -L / 2)], M.metal, 24); g.add(spike);
    g.add(ring(r * 0.85, L / 2 - 0.04, 0.08, M.accent));
    return g;
  },
  jet(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [V2(r, L / 2), V2(r, -L * 0.15), V2(r * 0.8, -L / 2 + 0.4), V2(r * 0.62, -L / 2)];
    g.add(lathe(pts, M.dark, 32));
    // nozzle petals
    const noz = lathe([V2(r * 0.66, -L / 2 + 0.3), V2(r * 0.6, -L / 2 - 0.25)], M.metal, 16); g.add(noz);
    const hot = cylY(r * 0.5, r * 0.5, 0.05, M.glow.clone(), 24); hot.position.y = -L / 2 - 0.05; hot.userData.glow = true; g.add(hot);
    g.add(ring(r, L / 2 - 0.1, 0.18, M.accent));
    return g;
  },
  scram(def, M) {
    const L = def.len, g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, L, 0.8), M.dark); g.add(body);
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.4, 0.15), M.metal); ramp.position.set(0, L / 2 - 0.4, 0.45); ramp.rotation.x = 0.35; g.add(ramp);
    const hot = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.55), M.glow.clone()); hot.position.y = -L / 2 - 0.03; hot.userData.glow = true; g.add(hot);
    const st = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.2, 0.82), M.accent); st.position.y = L * 0.2; g.add(st);
    return g;
  },
  hybrid(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    g.add(lathe([V2(r, L / 2), V2(r, -L * 0.1), V2(r * 0.85, -L / 2 + 0.2), V2(r * 0.7, -L / 2)], M.dark, 40));
    const bell = lathe([V2(r * 0.4, -L / 2 + 0.6), V2(r * 0.55, -L / 2 - 0.1), V2(r * 0.75, -L / 2 - 0.55)], M.metal, 32); bell.material = M.metal.clone(); bell.material.side = THREE.DoubleSide; g.add(bell);
    const hot = cylY(r * 0.38, r * 0.38, 0.05, M.glow.clone(), 24); hot.position.y = -L / 2 + 0.5; hot.userData.glow = true; g.add(hot);
    g.add(ring(r, L / 2 - 0.1, 0.25, M.accent));
    g.add(ring(r, 0, 0.12, M.accent));
    return g;
  },
  rocketBell(def, M, rTop, rExit, bellLen) {
    const L = def.len, g = new THREE.Group();
    const mountH = L - bellLen;
    const mount = cylY(rTop, rTop * 0.75, mountH, M.dark, 24); mount.position.y = L / 2 - mountH / 2; g.add(mount);
    const pts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(V2(rTop * 0.35 + (rExit - rTop * 0.35) * Math.pow(t, 0.7), L / 2 - mountH - t * bellLen)); }
    const bell = lathe(pts, M.metal.clone(), 32); bell.material.side = THREE.DoubleSide; g.add(bell);
    const hot = cylY(rTop * 0.32, rTop * 0.32, 0.04, M.glow.clone(), 20); hot.position.y = L / 2 - mountH - 0.1; hot.userData.glow = true; g.add(hot);
    // turbopump
    const tp = cylY(rTop * 0.12, rTop * 0.12, mountH * 0.8, M.metal, 10); tp.position.set(rTop * 0.5, L / 2 - mountH / 2, rTop * 0.3); g.add(tp);
    return g;
  },
  rocketS(def, M) { const r = SIZES.S / 2; return B.rocketBell(def, M, r, r * 0.8, def.len * 0.6); },
  rocketM(def, M) { const r = SIZES.M / 2; return B.rocketBell(def, M, r, r * 0.92, def.len * 0.6); },
  rocketL(def, M) { const r = SIZES.L / 2; return B.rocketBell(def, M, r, r * 0.95, def.len * 0.6); },
  rocketVac(def, M) { const r = SIZES.M / 2; return B.rocketBell(def, M, r * 0.8, r * 1.0, def.len * 0.8); },
  nuclear(def, M) {
    const r = SIZES.M / 2, L = def.len, g = B.rocketBell(def, M, r * 0.9, r * 0.75, L * 0.4);
    for (let i = 0; i < 3; i++) g.add(ring(r * 0.9, L / 2 - 0.5 - i * 0.6, 0.18, M.accent));
    return g;
  },
  fusion(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const core = cylY(r * 0.7, r * 0.6, L * 0.5, M.dark, 32); core.position.y = L / 4; g.add(core);
    for (let i = 0; i < 3; i++) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(r * (0.75 + i * 0.12), 0.14, 10, 40), M.fusion.clone());
      t.rotation.x = Math.PI / 2; t.position.y = -L * 0.05 - i * L * 0.16; t.userData.glow = true; g.add(t);
    }
    // magnetic nozzle struts
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, L * 0.55, 0.1), M.metal);
      s.position.set(Math.sin(a) * r * 0.85, -L * 0.22, Math.cos(a) * r * 0.85); s.rotation.set(Math.cos(a) * 0.12, 0, -Math.sin(a) * 0.12); g.add(s);
    }
    g.add(ring(r * 0.7, L / 2 - 0.1, 0.2, M.accent));
    return g;
  },
  liftfan(def, M) {
    const g = new THREE.Group();
    const housing = cylY(0.75, 0.75, 0.6, M.dark, 32, true); housing.material = M.dark.clone(); housing.material.side = THREE.DoubleSide;
    housing.rotation.z = Math.PI / 2; housing.position.x = 0.32; g.add(housing);
    const fan = new THREE.Group(); fan.userData.spin = true;
    for (let i = 0; i < 9; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.68), M.metal); b.rotation.x = (i / 9) * Math.PI * 2; b.position.z = 0; const piv = new THREE.Group(); piv.rotation.x = (i / 9) * Math.PI * 2; b.position.set(0, 0, 0.36); b.rotation.set(0.5, 0, 0); piv.add(b); fan.add(piv); }
    fan.position.x = 0.3; g.add(fan);
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), M.accent); hub.position.x = 0.3; g.add(hub);
    return g;
  },
  plasma(def, M) {
    const g = new THREE.Group();
    const body = cylY(0.55, 0.62, 0.5, M.dark, 24); body.rotation.z = Math.PI / 2; body.position.x = 0.25; g.add(body);
    const bell = lathe([V2(0.25, 0), V2(0.42, -0.25), V2(0.55, -0.45)], M.metal.clone(), 24); bell.material.side = THREE.DoubleSide;
    bell.rotation.z = Math.PI / 2; bell.position.x = 0.5; g.add(bell);
    const hot = cylY(0.24, 0.24, 0.04, M.glow.clone(), 20); hot.rotation.z = Math.PI / 2; hot.position.x = 0.52; hot.userData.glow = true; g.add(hot);
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.06, 8, 24), M.fusion.clone()); t.rotation.y = Math.PI / 2; t.position.x = 0.35; t.userData.glow = true; g.add(t);
    return g;
  },
  pod(def, M) {
    const g = new THREE.Group();
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.6, 0.12), M.hull); pylon.position.set(0.45, 0.2, 0); g.add(pylon);
    const r = 0.6, L = def.len;
    const n = lathe([V2(r * 0.85, L / 2), V2(r, L * 0.2), V2(r * 0.9, -L / 2 + 0.3), V2(r * 0.6, -L / 2)], M.dark, 28); n.position.x = 1.0; g.add(n);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.88, 0.06, 8, 24), M.accent); lip.rotation.x = Math.PI / 2; lip.position.set(1.0, L / 2, 0); g.add(lip);
    const fan = new THREE.Mesh(new THREE.CircleGeometry(r * 0.82, 24), M.metal); fan.rotation.x = -Math.PI / 2; fan.position.set(1.0, L / 2 - 0.15, 0); g.add(fan);
    const hot = cylY(r * 0.5, r * 0.5, 0.04, M.glow.clone(), 20); hot.position.set(1.0, -L / 2 - 0.02, 0); hot.userData.glow = true; g.add(hot);
    return g;
  },
  wing(def, M) {
    const w = def.wing, g = new THREE.Group();
    const ctrl = w.ctrl >= 1 ? 1 : w.ctrl;
    const mainEnd = ctrl >= 1 ? 0 : 1 - ctrl;        // chord fraction of the fixed part
    const tilesBelow = !!def.heatTiles;
    const lead = (s) => w.root / 2 - Math.tan(w.sweep) * s * w.span;
    const chord = (s) => w.root + (w.tip - w.root) * s;
    const build = (c0, c1, mat, matBelow) => {
      const NS = 8, NC = 10;
      const top = [], bot = [];
      const pos = [], idx = [], uv = [];
      for (let i = 0; i <= NS; i++) {
        const s = i / NS, x = s * w.span, le = lead(s), ch = chord(s);
        const th = w.thick * (ch / w.root);
        for (let j = 0; j <= NC; j++) {
          const c = c0 + (c1 - c0) * (j / NC);
          const y = le - c * ch;
          const t = 2.6 * th * (0.2969 * Math.sqrt(c) - 0.126 * c - 0.3516 * c * c + 0.2843 * c ** 3 - 0.1036 * c ** 4);
          pos.push(x, y, t, x, y, -t);
          uv.push(x / 3, y / 3, x / 3, y / 3);
        }
      }
      const row = (NC + 1) * 2;
      const topIdx = [], botIdx = [];
      for (let i = 0; i < NS; i++) for (let j = 0; j < NC; j++) {
        const a = i * row + j * 2, b = a + 2, c = a + row, d = c + 2;
        topIdx.push(a, b, c, b, d, c);
        botIdx.push(a + 1, c + 1, b + 1, b + 1, c + 1, d + 1);
      }
      // tip cap
      const tip = NS * row;
      for (let j = 0; j < NC; j++) { const a = tip + j * 2; topIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      // trailing face (for the split at the hinge)
      for (let i = 0; i < NS; i++) { const a = i * row + NC * 2, c = a + row; topIdx.push(a, c, a + 1, a + 1, c, c + 1); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex([...topIdx, ...botIdx]);
      geo.addGroup(0, topIdx.length, 0);
      geo.addGroup(topIdx.length, botIdx.length, 1);
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, [mat, matBelow]);
      return m;
    };
    if (mainEnd > 0) g.add(build(0, mainEnd, M.hull, tilesBelow ? M.black : M.hull));
    if (ctrl > 0) {
      // control surface pivots about the hinge line
      const h0 = new THREE.Vector3(0, lead(0) - (ctrl >= 1 ? 0.25 : mainEnd) * chord(0), 0);
      const h1 = new THREE.Vector3(w.span, lead(1) - (ctrl >= 1 ? 0.25 : mainEnd) * chord(1), 0);
      const pivot = new THREE.Group();
      pivot.position.copy(h0);
      const surf = build(ctrl >= 1 ? 0 : mainEnd + 0.01, 1, ctrl >= 1 ? M.hull : M.accent, tilesBelow ? M.black : (ctrl >= 1 ? M.hull : M.accent));
      surf.position.copy(h0).negate();
      pivot.add(surf);
      pivot.userData.hingeAxis = h1.clone().sub(h0).normalize();
      pivot.userData.ctrl = true;
      g.add(pivot);
    }
    return g;
  },
  gear(def, M) {
    const G = def.gear, g = new THREE.Group();
    const strut = new THREE.Group(); strut.userData.gearStrut = true;
    const s = cylY(0.07, 0.07, G.len, M.metal, 10); s.rotation.z = Math.PI / 2; s.position.x = G.len / 2; strut.add(s);
    const oleo = cylY(0.11, 0.11, G.len * 0.45, M.dark, 12); oleo.rotation.z = Math.PI / 2; oleo.position.x = G.len * 0.25; strut.add(oleo);
    const wheels = G.twin ? [-0.32, 0.32] : [0];
    for (const dz of wheels) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(G.wheel, G.wheel, 0.28, 24), M.black);
      wh.rotation.x = Math.PI / 2; wh.position.set(G.len, 0, dz); wh.userData.wheel = true; strut.add(wh);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(G.wheel * 0.5, G.wheel * 0.5, 0.3, 16), M.metal);
      hub.rotation.x = Math.PI / 2; hub.position.set(G.len, 0, dz); strut.add(hub);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, G.len * 0.8, 0.5), M.hull); door.position.set(0.05, G.len * 0.3, 0.4); g.add(door);
    g.add(strut);
    return g;
  },
  leg(def, M) {
    const G = def.gear, g = new THREE.Group();
    const strut = new THREE.Group(); strut.userData.gearStrut = true;
    const s = cylY(0.09, 0.07, G.len, M.metal, 10); s.rotation.z = Math.PI / 2; s.position.x = G.len / 2; strut.add(s);
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.12, 20), M.dark); pad.rotation.z = Math.PI / 2; pad.position.x = G.len + 0.06; strut.add(pad);
    const brace = cylY(0.05, 0.05, G.len * 0.8, M.accent, 8); brace.rotation.z = Math.PI / 2 - 0.4; brace.position.set(G.len * 0.42, G.len * 0.17, 0); strut.add(brace);
    g.add(strut);
    return g;
  },
  shield(def, M) {
    const r = SIZES[def.size] / 2, g = new THREE.Group();
    g.add(lathe([V2(0.0001, -def.len / 2 - 0.15), V2(r * 0.7, -def.len / 2 - 0.08), V2(r * 1.04, -def.len / 2), V2(r * 1.04, def.len / 2), V2(0.0001, def.len / 2)], M.black, 40));
    g.add(ring(r * 1.04, def.len / 2 - 0.05, 0.08, M.accent));
    return g;
  },
  wheelS(def, M) { const r = SIZES.S / 2, g = new THREE.Group(); g.add(cylY(r, r, def.len, M.dark, 32)); g.add(ring(r, 0, 0.12, M.accent)); return g; },
  wheelM(def, M) { const r = SIZES.M / 2, g = new THREE.Group(); g.add(cylY(r, r, def.len, M.dark, 40)); g.add(ring(r, 0, 0.14, M.accent)); return g; },
  battery(def, M) { const r = SIZES.S / 2, g = new THREE.Group(); g.add(cylY(r, r, def.len, M.dark, 24)); for (const y of [-0.15, 0.15]) g.add(ring(r, y, 0.06, M.accent)); return g; },
  rcs(def, M) {
    const g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), M.dark); b.position.x = 0.18; g.add(b);
    for (const [x, y, z] of [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 8), M.metal);
      n.position.set(0.18 + x * 0.2, y * 0.2, z * 0.2);
      n.lookAt(n.position.clone().add(new THREE.Vector3(x, y, z))); n.rotateX(Math.PI / 2);
      g.add(n);
    }
    return g;
  },
  radiator(def, M) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(new THREE.BoxGeometry(4.0, 1.6, 0.06), M.metal.clone()); p.position.x = 2.1; p.userData.radiator = true; g.add(p);
    for (let i = 0; i < 8; i++) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.04, 1.6, 0.1), M.dark); f.position.set(0.3 + i * 0.5, 0, 0); g.add(f); }
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), M.dark); arm.position.x = 0.1; g.add(arm);
    return g;
  },
  solar(def, M) {
    const g = new THREE.Group();
    const p = new THREE.Mesh(new THREE.BoxGeometry(5.0, 1.4, 0.04), M.cells); p.position.x = 2.7; g.add(p);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.12), M.metal); arm.position.x = 0.15; g.add(arm);
    for (let i = 1; i < 5; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.42, 0.05), M.metal); l.position.set(0.2 + i, 0, 0); g.add(l); }
    return g;
  },
  lamp(def, M) {
    const g = new THREE.Group();
    const b = cylY(0.12, 0.16, 0.25, M.dark, 12); b.rotation.z = Math.PI / 2; b.position.x = 0.12; g.add(b);
    const l = new THREE.Mesh(new THREE.CircleGeometry(0.11, 12), new THREE.MeshBasicMaterial({ color: 0xfff6dd })); l.position.x = 0.26; l.rotation.y = Math.PI / 2; g.add(l);
    return g;
  },
  dock(def, M) {
    // androgynous port along local +X: flange, tunnel, collar, gold face ring and three guide petals
    const g = new THREE.Group(), h = def.dock.h;
    const alongX = (m, x) => { m.rotation.z = -Math.PI / 2; m.position.x = x; g.add(m); return m; };
    alongX(cylY(0.85, 0.85, 0.12, M.dark, 28), 0.06);
    alongX(cylY(0.62, 0.62, h - 0.2, M.metal, 28), (h - 0.2) / 2 + 0.1);
    alongX(cylY(0.74, 0.74, 0.12, M.dark, 28), h - 0.12);
    const face = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.74, 28), M.accent); face.rotation.y = Math.PI / 2; face.position.x = h - 0.05; g.add(face);
    const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.3, 20), M.black); hatch.rotation.y = Math.PI / 2; hatch.position.x = h - 0.06; g.add(hatch);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const pet = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.34, 0.05), M.hull);
      pet.position.set(h - 0.02, Math.cos(a) * 0.6, Math.sin(a) * 0.6);
      pet.rotation.x = a; pet.rotateZ(0.2);
      g.add(pet);
    }
    return g;
  },
  armored(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [V2(0.0001, -L / 2), V2(r, -L / 2), V2(r, -L / 2 + 0.5), V2(r * 0.62, L / 2 - 0.15), V2(r * 0.5, L / 2), V2(0.0001, L / 2)];
    g.add(lathe(pts, M.dark, 8));                          // faceted armour
    for (const y of [-L / 2 + 0.25, 0]) { const b = ring(r * (y < 0 ? 1 : 0.84), y, 0.22, M.accent); g.add(b); }
    for (const a of [-0.45, 0.45]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.08), M.glass);
      w.position.set(Math.sin(a) * r * 0.74, L * 0.12, Math.cos(a) * r * 0.74); w.rotation.set(-0.35, a, 0); g.add(w);
    }
    return g;
  },
  xenon(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    for (const y of [-L / 2, L / 2]) { const f = cylY(r, r, 0.12, M.dark, 24); f.position.y = y * 0.94; g.add(f); }
    for (const y of [-L / 4, L / 4]) { const sp = new THREE.Mesh(new THREE.SphereGeometry(r * 0.82, 24, 16), M.metal); sp.position.y = y; g.add(sp); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; const t = new THREE.Mesh(new THREE.BoxGeometry(0.08, L, 0.08), M.accent); t.position.set(Math.sin(a) * r * 0.92, 0, Math.cos(a) * r * 0.92); g.add(t); }
    return g;
  },
  liftbody(def, M) {
    // a round core blending into wide flat chines: the hull itself is the wing
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const core = cylY(r, r, L, M.hull, 40); tubeUV(core, L, r); g.add(core);
    const shape = new THREE.Shape();
    const wR = def.wing.root, wT = def.wing.tip, sp = def.wing.span + r;
    shape.moveTo(0, L / 2 - 0.2); shape.lineTo(sp, L / 2 - (wR - wT) - 0.4); shape.lineTo(sp, -L / 2 + 0.3); shape.lineTo(0, -L / 2);
    for (const side of [1, -1]) {
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 2 });
      const m = new THREE.Mesh(geo, M.hull); m.position.z = -0.11 - r * 0.25; m.scale.x = side; g.add(m);
      const tiles = new THREE.Mesh(new THREE.PlaneGeometry(sp, L * 0.92), M.black); tiles.position.set(side * sp / 2, 0, -0.11 - r * 0.25 - 0.13); tiles.rotation.y = Math.PI; g.add(tiles);
    }
    g.add(ring(r, L / 2 - 0.1, 0.14, M.accent));
    return g;
  },
  afterburner(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    g.add(lathe([V2(r, L / 2), V2(r, -L * 0.05), V2(r * 0.9, -L / 2 + 0.6), V2(r * 0.84, -L / 2)], M.dark, 32));
    // long variable nozzle with petals
    const noz = lathe([V2(r * 0.84, -L / 2 + 0.5), V2(r * 0.76, -L / 2 - 0.45)], M.metal.clone(), 18); noz.material.side = THREE.DoubleSide; g.add(noz);
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const pet = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.5, 0.02), M.dark); pet.position.set(Math.sin(a) * r * 0.79, -L / 2 - 0.2, Math.cos(a) * r * 0.79); pet.rotation.y = a; g.add(pet); }
    const hot = cylY(r * 0.62, r * 0.62, 0.05, M.glow.clone(), 24); hot.position.y = -L / 2 - 0.1; hot.userData.glow = true; g.add(hot);
    g.add(ring(r, L / 2 - 0.1, 0.18, M.accent));
    g.add(ring(r, -L * 0.05, 0.1, M.accent));
    return g;
  },
  ion(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const body = cylY(r * 0.7, r * 0.9, L * 0.6, M.dark, 32); body.position.y = L * 0.2; g.add(body);
    const grid = cylY(r, r, 0.08, M.metal, 40); grid.position.y = -L * 0.12; g.add(grid);
    const glow = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, 40), new THREE.MeshBasicMaterial({ color: 0x5fd8ff, side: THREE.DoubleSide }));
    glow.rotation.x = Math.PI / 2; glow.position.y = -L * 0.17; glow.userData.glow = true; g.add(glow);
    const lip = cylY(r * 1.02, r * 0.98, L * 0.3, M.hull, 40, true); lip.material = M.hull; lip.position.y = -L * 0.3; g.add(lip);
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; const c = cylY(0.05, 0.05, L * 0.55, M.accent, 8); c.position.set(Math.sin(a) * r * 0.82, L * 0.2, Math.cos(a) * r * 0.82); g.add(c); }
    return g;
  },
  skid(def, M) {
    const G = def.gear, g = new THREE.Group();
    const strut = new THREE.Group(); strut.userData.gearStrut = true;
    for (const y of [-0.9, 0.9]) { const s = cylY(0.06, 0.06, G.len, M.metal, 8); s.rotation.z = Math.PI / 2; s.position.set(G.len / 2, y, 0); strut.add(s); }
    const bar = cylY(0.09, 0.09, 3.0, M.dark, 12); bar.position.x = G.len; strut.add(bar);
    for (const y of [-1.5, 1.5]) { const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), M.dark); tip.position.set(G.len - (y > 0 ? 0.08 : 0), y, 0); strut.add(tip); }
    g.add(strut);
    return g;
  },
  needle(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push(V2(Math.max(0.0001, r * Math.pow(1 - t, 1.6)), -L / 2 + t * L)); }
    g.add(lathe(pts, M.hull, 32));
    const probe = cylY(0.025, 0.04, 1.2, M.metal, 8); probe.position.y = L / 2 + 0.5; g.add(probe);
    g.add(ring(r, -L / 2 + 0.06, 0.1, M.accent));
    return g;
  },
  blunt(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const pts = [];
    for (let i = 0; i <= 14; i++) { const a = (i / 14) * Math.PI / 2; pts.push(V2(Math.max(0.0001, r * Math.cos(a)), -L / 2 + L * Math.sin(a))); }
    g.add(lathe(pts, M.black, 40));
    g.add(ring(r, -L / 2 + 0.05, 0.1, M.accent));
    return g;
  },
  reactor(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    g.add(cylY(r * 0.8, r * 0.8, L, M.dark, 28));
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, L * 0.8, r * 0.36), M.metal); fin.position.set(Math.sin(a) * r * 0.86, 0, Math.cos(a) * r * 0.86); fin.rotation.y = a; g.add(fin); }
    for (const y of [-L / 2 + 0.1, L / 2 - 0.1]) g.add(ring(r, y, 0.18, M.accent));
    const band = cylY(r * 0.81, r * 0.81, 0.12, new THREE.MeshStandardMaterial({ color: 0x103040, emissive: 0x2fb8ff, emissiveIntensity: 1.2 }), 28); band.userData.glow = true; g.add(band);
    const sign = new THREE.Mesh(new THREE.CircleGeometry(0.16, 3), new THREE.MeshBasicMaterial({ color: 0xffd400 })); sign.position.set(0, L * 0.3, r * 0.81 + 0.01); g.add(sign);
    return g;
  },
  fusioncore(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    g.add(cylY(r * 0.55, r * 0.55, L, M.dark, 32));
    const t = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, r * 0.24, 16, 48), M.fusion.clone()); t.rotation.x = Math.PI / 2; t.userData.glow = true; g.add(t);
    for (const y of [-L / 2 + 0.1, L / 2 - 0.1]) { g.add(ring(r, y, 0.16, M.accent)); const d = cylY(r, r, 0.08, M.hull, 40); d.position.y = y; g.add(d); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const s = new THREE.Mesh(new THREE.BoxGeometry(0.1, L, 0.1), M.metal); s.position.set(Math.sin(a) * r * 0.95, 0, Math.cos(a) * r * 0.95); g.add(s); }
    return g;
  },
  cryo(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    const foam = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.85, metalness: 0.05, map: M.hull.map });
    const body = cylY(r, r, L, foam, 40); tubeUV(body, L, r); g.add(body);
    for (let i = 0; i < 5; i++) g.add(ring(r, -L / 2 + (i + 0.5) * (L / 5), 0.08, M.dark));
    for (const y of [-L / 2 + 0.1, L / 2 - 0.1]) g.add(ring(r, y, 0.18, M.accent));
    const vent = cylY(0.06, 0.06, 0.5, M.metal, 8); vent.rotation.z = Math.PI / 2; vent.position.set(r + 0.2, L * 0.4, 0); g.add(vent);
    return g;
  },
  amcell(def, M) {
    const r = SIZES[def.size] / 2, L = def.len, g = new THREE.Group();
    for (const y of [-L / 2 + 0.08, L / 2 - 0.08]) { const f = cylY(r, r, 0.16, M.dark, 24); f.position.y = y; g.add(f); }
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; const b = new THREE.Mesh(new THREE.BoxGeometry(0.1, L, 0.1), M.metal); b.position.set(Math.sin(a) * r * 0.9, 0, Math.cos(a) * r * 0.9); g.add(b); }
    const core = new THREE.Mesh(new THREE.SphereGeometry(r * 0.38, 20, 14), new THREE.MeshStandardMaterial({ color: 0x300020, emissive: 0xff40d0, emissiveIntensity: 1.6 }));
    core.userData.glow = true; g.add(core);
    for (const y of [-0.25, 0.25]) { const t = new THREE.Mesh(new THREE.TorusGeometry(r * 0.62, 0.07, 8, 32), M.accent); t.rotation.x = Math.PI / 2; t.position.y = y; g.add(t); }
    return g;
  },
  strobe(def, M) {
    const g = new THREE.Group();
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff3b3b })); s.position.x = 0.08; s.userData.strobe = true; g.add(s);
    return g;
  },
};

export function buildPartMesh(def, M) {
  const fn = B[def.mesh] || B.tube;
  const g = fn(def, M);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
