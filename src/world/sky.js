// Sky: single-scattering style atmosphere dome (works from the runway to deep space), stars and the Sun.

import * as THREE from 'three';
import { EARTH } from '../core/geo.js';

const SKY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main(){
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const SKY_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uEarthC;   // Earth centre relative to camera (world)
uniform vec3 uSun;
uniform float uR;
varying vec3 vDir;
const float H = 8000.0;
const vec3 BETA = vec3(5.8e-6, 13.5e-6, 33.1e-6);
float sunlit(vec3 n){ return smoothstep(-0.16, 0.10, dot(n, uSun)); }
void main(){
  #include <logdepthbuf_fragment>
  vec3 D = normalize(vDir);
  vec3 C = uEarthC;
  float rc = length(C);
  float hc = rc - uR;
  vec3 up = -C / rc;
  float t = dot(C, D);
  vec3 P = D * t - C;              // closest point of the ray to the Earth centre, relative to centre
  float b = length(P);
  float tau = 0.0;                 // sea-level-equivalent metres of air along the ray
  vec3 nScatter = up;
  float hitsEarth = (t > 0.0 && b < uR) ? 1.0 : 0.0;
  if (hc < 140000.0) {
    float se = dot(D, up);
    float hor = -sqrt(max(0.0, 1.0 - (uR / rc) * (uR / rc)));
    float x = max(se - hor, 0.0);
    tau = exp(-max(hc, 0.0) / H) * H / (x + 0.012 + 0.6 * x * x * 0.0);
    tau = min(tau, 2.6e6);
    nScatter = normalize(up + D * 0.25);
    if (se < hor) tau = exp(-max(hc, 0.0) / H) * H / 0.012;
  }
  if (t > 0.0 && hitsEarth < 0.5) {
    // limb seen from above: column through the tangent point
    float ht = b - uR;
    float limb = exp(-max(ht, 0.0) / H) * sqrt(6.2832 * (uR + ht) * H);
    if (hc >= 140000.0) { tau = limb; nScatter = P / b; }
    else tau = max(tau, limb * 0.5 * smoothstep(0.0, 30000.0, hc));
  }
  float lit = sunlit(nScatter);
  // reddening of sunlight reaching the scattering region
  float sunEl = dot(nScatter, uSun);
  float tauSun = H / (max(sunEl, 0.0) + 0.03);
  vec3 sunCol = exp(-BETA * tauSun * 0.9);
  vec3 ray = (1.0 - exp(-BETA * tau)) * sunCol * lit;
  float mu = max(dot(D, uSun), 0.0);
  float mie = pow(mu, 18.0) * 0.18 + pow(mu, 600.0) * 1.2;
  vec3 col = ray * 1.25 + sunCol * mie * (1.0 - exp(-tau / 35000.0)) * lit;
  // sun disk (hidden by the planet itself when the ray hits it)
  float disk = smoothstep(0.99993, 0.99997, mu);
  vec3 sunDisk = vec3(1.0, 0.97, 0.92) * disk * 40.0 * mix(vec3(1.0), sunCol, smoothstep(30000.0, 0.0, hc));
  col += sunDisk * (1.0 - hitsEarth);
  col = col / (1.0 + col * 0.35);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uEarthC: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uR: { value: EARTH.R },
    };
    const geo = new THREE.SphereGeometry(1e9, 64, 32);
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    });
    this.dome = new THREE.Mesh(geo, this.mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -100;
    scene.add(this.dome);

    // stars: deterministic so the sky looks the same every session
    const N = 4200, p = new Float32Array(N * 3), c = new Float32Array(N * 3);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      let x, y, z;
      // concentrate some stars toward a galactic band
      const band = rnd() < 0.4;
      const th = rnd() * Math.PI * 2;
      const ph = band ? Math.PI / 2 + (rnd() - 0.5) * 0.35 : Math.acos(2 * rnd() - 1);
      x = Math.sin(ph) * Math.cos(th); y = Math.cos(ph); z = Math.sin(ph) * Math.sin(th);
      // tilt the band
      const ty = y * 0.46 - z * 0.89, tz = y * 0.89 + z * 0.46;
      p[i * 3] = x * 9e8; p[i * 3 + 1] = ty * 9e8; p[i * 3 + 2] = tz * 9e8;
      const m = Math.pow(rnd(), 3.2);
      const b = 0.25 + m * 1.1;
      const tint = rnd();
      c[i * 3] = b * (tint < 0.15 ? 1.0 : tint > 0.85 ? 0.78 : 0.93);
      c[i * 3 + 1] = b * (tint > 0.85 ? 0.86 : 0.93);
      c[i * 3 + 2] = b * (tint < 0.15 ? 0.75 : 1.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    this.starMat = new THREE.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 1, depthWrite: false, depthTest: true });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -99;
    scene.add(this.stars);

    // Sun glare sprite
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const x = cv.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,250,240,1)'); gr.addColorStop(0.08, 'rgba(255,240,210,0.9)');
    gr.addColorStop(0.25, 'rgba(255,200,140,0.18)'); gr.addColorStop(1, 'rgba(255,180,120,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false }));
    this.sun.renderOrder = 50;
    this.sun.frustumCulled = false;
    scene.add(this.sun);
  }

  // camI: camera position in frame I; sun: unit vector; returns sky brightness (0..1) at the camera
  update(camI, sun) {
    this.uniforms.uEarthC.value.copy(camI).negate();
    this.uniforms.uSun.value.copy(sun);
    this.dome.position.set(0, 0, 0);
    const r = camI.length(), h = r - EARTH.R;
    const up = camI.clone().divideScalar(r);
    const sunEl = up.dot(sun);
    const air = Math.exp(-Math.max(0, h) / 8000);
    const bright = Math.max(0, Math.min(1, (sunEl + 0.12) / 0.3)) * Math.min(1, air * 3.5);
    // in sunlight the sky only turns black enough for stars near space (fading in from 45 to 90 km); at night
    // they're out from the ground up
    const sunUp = Math.max(0, Math.min(1, (sunEl + 0.12) / 0.3));
    const space = Math.min(1, Math.max(0, (h - 45000) / 45000));
    this.starMat.opacity = Math.max(0, Math.min(1 - bright * 1.6, 1 - sunUp * (1 - space * space * (3 - 2 * space))));
    const d = 4e9;
    this.sun.position.copy(sun).multiplyScalar(d);
    const s = d * 0.06 * (1 - 0.5 * Math.min(1, air * 2));
    this.sun.scale.set(s, s, 1);
    this.sun.material.opacity = 0.9;
    return bright;
  }
}
