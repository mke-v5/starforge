// Engine plumes, reentry plasma, explosions and debris.
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/geo.js';

const PLUME_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const PLUME_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCore; uniform vec3 uEdge; uniform float uI; uniform float uDiamonds; uniform float uTime;
varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  float along = 1.0 - vUv.y;                      // 0 at the nozzle, 1 at the tail
  float fall = pow(1.0 - along, 1.6);
  float flick = 0.85 + 0.15 * sin(uTime * 60.0 + along * 30.0);
  float d = uDiamonds * smoothstep(0.55, 1.0, sin(along * 40.0)) * (1.0 - along);
  vec3 col = mix(uEdge, uCore, fall) * (fall * 1.4 + d * 0.8) * uI * flick;
  gl_FragColor = vec4(col, 1.0);
}`;

const STYLE = {
  jet: { core: [1.0, 0.75, 0.45], edge: [0.9, 0.3, 0.1], len: 7, rad: 0.45 },
  scram: { core: [1.0, 0.85, 0.6], edge: [0.6, 0.35, 1.0], len: 14, rad: 0.5 },
  rocket: { core: [1.0, 0.92, 0.7], edge: [1.0, 0.45, 0.12], len: 22, rad: 0.48 },
  fusion: { core: [0.95, 0.85, 1.0], edge: [0.45, 0.25, 1.0], len: 70, rad: 0.32 },
  plasma: { core: [0.8, 0.95, 1.0], edge: [0.2, 0.5, 1.0], len: 9, rad: 0.45 },
};

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();        // world-space effects positioned relative to the camera each frame
    scene.add(this.root);
    this.plumes = [];
    this.particles = [];
    this.debris = [];
    this.time = 0;
    const g = new THREE.CylinderGeometry(1, 1.6, 1, 20, 1, true);
    g.translate(0, -0.5, 0);
    this.plumeGeo = g;
    // particle sprite texture
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    this.spriteTex = new THREE.CanvasTexture(c);
    // reentry glow
    this.plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){ vP = position; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
#include <logdepthbuf_vertex>
}`,
      fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uI; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
#include <logdepthbuf_fragment>
  float rim = pow(1.0 - abs(dot(vN, vV)), 1.5);
  float front = smoothstep(-0.2, 1.0, -vP.y);
  float n = 0.75 + 0.25 * sin(uTime * 40.0 + vP.y * 6.0 + vP.x * 3.0);
  vec3 col = mix(vec3(1.0, 0.35, 0.12), vec3(1.0, 0.75, 0.95), front) * (rim * 0.9 + front * 0.5) * uI * n;
  gl_FragColor = vec4(col, 1.0);
}`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.plasma = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.plasmaMat);
    this.plasma.visible = false;
    this.plasma.renderOrder = 20;
    this.plasmaLight = new THREE.PointLight(0xff7a3d, 0, 200, 1.5);
    this.flash = new THREE.PointLight(0xffaa55, 0, 400, 2);
    scene.add(this.flash);
  }

  // attach plumes to a craft's engines (in the craft's body frame)
  attach(craft) {
    for (const p of this.plumes) p.mesh.parent && p.mesh.parent.remove(p.mesh);
    this.plumes = [];
    for (const P of craft.parts) {
      if (!P.eng) continue;
      const e = P.eng.e;
      const style = e.fusion ? (e.lift ? STYLE.plasma : STYLE.fusion) : e.type === 'jet' ? STYLE.jet : e.type === 'scram' ? STYLE.scram : STYLE.rocket;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uCore: { value: new THREE.Vector3(...style.core) }, uEdge: { value: new THREE.Vector3(...style.edge) }, uI: { value: 0 }, uDiamonds: { value: 0 }, uTime: { value: 0 } },
        vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.plumeGeo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 30;
      mesh.position.copy(P.eng.pos);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), P.eng.dir);
      mesh.visible = false;
      craft.group.add(mesh);
      const r = (P.def.size ? { S: 1.25, M: 2.5, L: 3.75 }[P.def.size] : 1.0) * style.rad;
      this.plumes.push({ P, mesh, style, r, hybridRocket: e.type === 'hybrid' });
    }
    if (this.plasma.parent) this.plasma.parent.remove(this.plasma);
    craft.group.add(this.plasma);
    craft.group.add(this.plasmaLight);
    const b = craft.box;
    this.plasmaBox = { c: b.getCenter(new THREE.Vector3()), s: b.getSize(new THREE.Vector3()) };
  }

  // per-frame update. env: ship.env; vAirBody: air-relative velocity in body frame; heatFlux: W/m2 estimate
  update(dt, craft, env, vAirBody, heatFlux) {
    this.time += dt;
    const p = Math.min(1, env.p / 101325);
    for (const pl of this.plumes) {
      const E = pl.P.eng;
      const on = pl.P.alive && E.flame > 0.005;
      pl.mesh.visible = on;
      if (!on) continue;
      let st = pl.style;
      if (pl.hybridRocket) st = E.mode === 'rocket' ? STYLE.rocket : STYLE.jet;
      const u = pl.mesh.material.uniforms;
      u.uCore.value.set(...st.core); u.uEdge.value.set(...st.edge);
      const f = E.flame;
      const vac = 1 - p;
      const len = st.len * (0.35 + 0.65 * f) * (pl.r / 0.6) * (1 + vac * 0.8);
      const rad = pl.r * (1 + vac * 1.6 * (st === STYLE.rocket || st === STYLE.fusion ? 1 : 0.3));
      pl.mesh.scale.set(rad, Math.max(0.5, len), rad);
      u.uI.value = (0.6 + 0.6 * f) * (st === STYLE.jet ? 0.8 : 1.1);
      u.uDiamonds.value = st === STYLE.rocket ? p * 1.2 : st === STYLE.jet ? f * 0.6 : 0;
      u.uTime.value = this.time;
    }
    // reentry plasma
    const pi = clamp((heatFlux - 1.5e5) / 1.2e6, 0, 1);
    this.plasma.visible = pi > 0.01;
    this.plasmaLight.intensity = pi * 400;
    if (this.plasma.visible) {
      const V = vAirBody.length();
      const dir = vAirBody.clone().divideScalar(Math.max(1, V));      // direction of travel through the air (body)
      const s = this.plasmaBox.s;
      const rad = Math.max(s.x, s.y, s.z) * 0.55 + 1.5;
      this.plasma.position.copy(this.plasmaBox.c).addScaledVector(dir, rad * 0.2);
      // stretch backwards along the flow: sphere's -Y axis points into the flow
      this.plasma.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      this.plasma.scale.set(rad, rad * (1.1 + pi * 0.8), rad);
      this.plasmaMat.uniforms.uI.value = pi;
      this.plasmaMat.uniforms.uTime.value = this.time;
      this.plasmaLight.position.copy(this.plasma.position).addScaledVector(dir, rad);
    }
  }

  // ---- world-space particles (positions in frame I, rendered relative to the camera) ----
  explode(posI, velI, size = 1) {
    const n = Math.round(26 + 30 * size);
    for (let i = 0; i < n; i++) {
      const fire = i < n * 0.6;
      const m = new THREE.SpriteMaterial({ map: this.spriteTex, color: fire ? 0xffa040 : 0x40342c, transparent: true, depthWrite: false, blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: 1 });
      const s = new THREE.Sprite(m);
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const speed = (fire ? 12 : 5) * (0.4 + Math.random()) * size;
      this.particles.push({ s, p: posI.clone(), v: velI.clone().addScaledVector(dir, speed), life: 0, max: fire ? 1.2 + Math.random() : 3 + Math.random() * 3, grow: (fire ? 6 : 10) * size, fire });
      this.root.add(s);
    }
    this.flashT = 0.35; this.flashPos = posI.clone(); this.flashSize = size;
  }
  addDebris(mesh, posI, velI, quatI) {
    const g = mesh.clone(true);
    g.matrixAutoUpdate = true;
    g.visible = true;
    g.position.set(0, 0, 0);
    this.root.add(g);
    this.debris.push({ g, p: posI.clone(), v: velI.clone().add(new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8)), q: quatI.clone(), w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4), life: 0 });
  }
  updateWorld(dt, camI, gravityAt, groundCheck) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life += dt;
      const g = gravityAt(q.p);
      q.v.addScaledVector(g, dt * (q.fire ? -0.1 : 0.05));
      q.v.multiplyScalar(Math.exp(-dt * 1.2));
      q.p.addScaledVector(q.v, dt);
      const k = q.life / q.max;
      q.s.position.copy(q.p).sub(camI);
      const sz = 1 + q.grow * Math.sqrt(k);
      q.s.scale.set(sz, sz, 1);
      q.s.material.opacity = (1 - k) * (q.fire ? 1 : 0.7);
      if (k >= 1) { this.root.remove(q.s); q.s.material.dispose(); this.particles.splice(i, 1); }
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life += dt;
      d.v.addScaledVector(gravityAt(d.p), dt);
      d.p.addScaledVector(d.v, dt);
      const wl = d.w.length();
      if (wl > 0) d.q.multiply(new THREE.Quaternion().setFromAxisAngle(d.w.clone().divideScalar(wl), wl * dt));
      d.g.position.copy(d.p).sub(camI);
      d.g.quaternion.copy(d.q);
      if (d.life > 25 || groundCheck(d.p)) { this.root.remove(d.g); this.debris.splice(i, 1); }
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.position.copy(this.flashPos).sub(camI);
      this.flash.intensity = Math.max(0, this.flashT) * 20000 * this.flashSize;
    } else this.flash.intensity = 0;
  }
  clearWorld() {
    for (const q of this.particles) this.root.remove(q.s);
    for (const d of this.debris) this.root.remove(d.g);
    this.particles = []; this.debris = [];
  }
}
