// The whole environment: Earth, Moon, sky, airports, buildings and lighting, positioned around a floating origin.

import * as THREE from 'three';
import { EARTH, MOON, clamp, toLLH, smoothstep } from '../core/geo.js';
import { Loader } from './loader.js';
import { Planet } from './planet.js';
import { Sky } from './sky.js';
import { Airports, buildHangar, buildLaunchPad } from './airports.js';
import { Buildings } from './buildings.js';
import { CloudLayer } from './clouds.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();

export class World {
  constructor(scene, renderer, settings) {
    this.scene = scene;
    this.settings = settings;
    this.loader = new Loader();
    this.shared = {
      uSun: { value: new THREE.Vector3(1, 0, 0) },
      uCamAlt: { value: 0 },
      uFogK: { value: 1 / 42000 },
      uNightK: { value: 1 },
      uDebug: { value: 0 },
      uEarthshine: { value: 0.01 },
      uCloud: { value: new THREE.Vector4(0, 1, 0, 0) },
      uCloudOct: { value: { low: 5, medium: 8, high: 11 }[settings.quality || 'medium'] || 8 },
      uDetail: { value: (settings.quality || 'medium') === 'low' ? 0 : 1 },
      uTime: { value: 0 },
      anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
      night: 0,
    };
    this.earth = new Planet({ body: EARTH, loader: this.loader, kind: 'earth', maxZ: 14, imgMaxZ: 14, maxRelief: 9000, shared: this.shared });
    this.moon = new Planet({ body: MOON, loader: this.loader, kind: 'moon', maxZ: 9, maxRelief: 11000, shared: this.shared, capColor: '#888' });
    scene.add(this.earth.group, this.moon.group);
    this.sky = new Sky(scene);
    this.airports = new Airports();
    this.earth.flatten = this.airports.flattener();
    this.airports.onReady = () => this.earth.invalidate((t) => this.earth.flatten.has(t));
    this.airports.load().catch((e) => console.warn('airports', e));
    this.earth.group.add(this.airports.group);
    this.buildings = new Buildings(this.loader, this.shared);
    this.clouds = new CloudLayer(this.shared);
    this.earth.group.add(this.clouds.group);
    this.setQuality(settings.quality || 'medium');
    this.earth.group.add(this.buildings.group);
    this.hangar = null;
    // lighting for ships and props
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sunLight.position.set(1, 0, 0);
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sunTarget);
    this.sunLight.target = this.sunTarget;
    this.hemi = new THREE.HemisphereLight(0x9cb8de, 0x3a3328, 0.6);
    scene.add(this.sunLight, this.hemi);
    this.camI = new THREE.Vector3();
    this.camLL = { lat: 0, lon: 0, h: 0 };
    this.frame = 0;
    this.nearBuildings = false;
  }

  // graphics quality, applied live: terrain detail and tile budget, cloud octaves, close-up ground detail,
  // how far around the camera buildings and roads stream
  setQuality(q) {
    const detail = { low: [0.95, 240], medium: [0.62, 360], high: [0.45, 520] }[q] || [0.62, 360];
    this.earth.splitRatio = detail[0]; this.earth.maxTiles = detail[1];
    this.moon.splitRatio = detail[0] * 1.1; this.moon.maxTiles = Math.round(detail[1] * 0.6);
    this.shared.uCloudOct.value = { low: 5, medium: 8, high: 11 }[q] || 8;
    this.shared.uDetail.value = q === 'low' ? 0 : 1;
    this.buildings.radius = q === 'high' ? 2 : 1;
    if (this.clouds) this.clouds.setQuality(q);
    this.quality = q;
  }

  // ---- queries used by physics ----
  groundAt(body, lat, lon) {
    if (body === EARTH) {
      const r = this.earth.heightAt(lat, lon);
      if (r.z < 13 && this.airports.ready) {
        // coarse terrain under a runway: trust the runway elevation
        for (const rw of this.airports.runwaysNear(lat, lon)) {
          const { along, cross } = this.airports.local(rw, lat, lon);
          if (Math.abs(along) < rw.len / 2 + 100 && Math.abs(cross) < rw.w / 2 + 40) return this.airports.elevAt(rw, along) - 0.25;
        }
        for (const p of this.airports.extra) {
          const { along, cross } = this.airports.local(p, lat, lon);
          if (Math.abs(along) < p.len / 2 && Math.abs(cross) < p.w / 2) return p.e1 - 0.25;
        }
      }
      return r.h;
    }
    return this.moon.heightAt(lat, lon).h;
  }
  isWater(lat, lon) { return this.earth.waterAt(lat, lon); }
  buildingTop(lat, lon, h) { return this.buildings.hit(lat, lon, h); }
  terrainReady(body, lat, lon, minZ) { const p = body === EARTH ? this.earth : this.moon; return p.heightAt(lat, lon).z >= minZ; }

  // place the player's hangar at an apron
  setHangar(info) {
    if (this.hangar) { this.earth.group.remove(this.hangar); this.hangar = null; }
    if (!info) { this.airports.extra = []; return; }
    this.airports.addPad(info.pad);
    const g = buildHangar();
    // local frame at the apron: -z toward the runway (door faces runway), y up
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3();
    const R = EARTH.R + info.elev;
    pos.set(Math.cos(info.lat * Math.PI / 180) * Math.cos(info.lon * Math.PI / 180), Math.sin(info.lat * Math.PI / 180), -Math.cos(info.lat * Math.PI / 180) * Math.sin(info.lon * Math.PI / 180)).multiplyScalar(R);
    up.copy(pos).normalize();
    const lon = Math.atan2(-pos.z, pos.x);
    east.set(-Math.sin(lon), 0, -Math.cos(lon));
    north.crossVectors(up, east).normalize();
    // direction toward the runway centreline = left of departure heading
    const hd = info.heading;
    const dep = north.clone().multiplyScalar(Math.cos(hd)).addScaledVector(east, Math.sin(hd));
    const toRunway = new THREE.Vector3().crossVectors(up, dep).normalize();   // left of travel
    const zAxis = toRunway.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize();
    g.matrix.makeBasis(xAxis, up, zAxis).setPosition(pos.clone().addScaledVector(toRunway, -60));
    g.matrixAutoUpdate = false;
    this.earth.group.add(g);
    this.hangar = g;
    this.earth.invalidate((t) => t.contains(info.lat, info.lon) || (Math.abs(t.lat - info.lat) < 0.2 && Math.abs(t.lon - info.lon) < 0.2));
  }

  // a launch pad built wherever the player chose: a flattened concrete square with a service tower
  setLaunchPad(info) {
    if (this.hangar) { this.earth.group.remove(this.hangar); this.hangar = null; }
    if (!info) { this.airports.extra = []; return; }
    const D2R = Math.PI / 180;
    this.airports.addPad({ idx: -1, latC: info.lat, lonC: info.lon, cosC: Math.cos(info.lat * D2R), dx: 0, dy: 1, len: 130, w: 130, e1: info.elev, e2: info.elev, ap: null });
    const g = buildLaunchPad();
    const pos = new THREE.Vector3(Math.cos(info.lat * D2R) * Math.cos(info.lon * D2R), Math.sin(info.lat * D2R), -Math.cos(info.lat * D2R) * Math.sin(info.lon * D2R)).multiplyScalar(EARTH.R + info.elev);
    const up = pos.clone().normalize();
    const lonR = Math.atan2(-pos.z, pos.x);
    const east = new THREE.Vector3(-Math.sin(lonR), 0, -Math.cos(lonR));
    const north = new THREE.Vector3().crossVectors(up, east).normalize();
    g.matrix.makeBasis(east, up, north.clone().negate()).setPosition(pos);
    g.matrixAutoUpdate = false;
    this.earth.group.add(g);
    this.hangar = g;
    this.earth.invalidate((t) => t.contains(info.lat, info.lon) || (Math.abs(t.lat - info.lat) < 0.2 && Math.abs(t.lon - info.lon) < 0.2));
  }

  // ---- per-frame placement and streaming ----
  update(camI, camera, eph, dt) {
    this.frame++;
    this.shared.uTime.value = (this.shared.uTime.value + dt) % 3600;
    this.camI.copy(camI);
    const sun = eph.sun;
    this.shared.uSun.value.copy(sun);
    // Earth: rotate by GMST, translate by -camera
    this.earth.group.position.copy(camI).negate();
    this.earth.group.quaternion.copy(eph.earthQ);
    this.earth.group.updateMatrixWorld(true);
    this.moon.group.position.copy(eph.moon).sub(camI);
    this.moon.group.quaternion.copy(eph.moonQ);
    this.moon.group.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const vp = _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // camera in Earth-fixed coordinates
    const camE = eph.toFixed(EARTH, camI, _v);
    const camE0 = (this._camE || (this._camE = new THREE.Vector3())).copy(camE);
    const ll = toLLH(camE, EARTH.R);
    this.camLL = ll;
    this.earth.update(camE, _m2.multiplyMatrices(vp, this.earth.group.matrixWorld), true);
    const camM = eph.toFixed(MOON, camI, _w);
    this.moon.update(camM, _m2.multiplyMatrices(vp, this.moon.group.matrixWorld), true);
    this.loader.tick();
    // sky and light
    const bright = this.sky.update(camI, sun);
    this.sky.dome.position.set(0, 0, 0);
    this.sky.stars.position.set(0, 0, 0);
    this.sky.sun.position.copy(sun).multiplyScalar(4e9);
    const ground = this.earth.heightAt(ll.lat, ll.lon).h;
    this.shared.uCamAlt.value = Math.max(0, ll.h);
    // clouds: painted onto the globe, so they only show from high up (they fade in through the stratosphere)
    {
      const on = this.settings.clouds !== '0';
      const t = eph.t || 0, rot = (t / 86400) * 0.35;
      this.shared.uCloud.value.set(on ? smoothstep(9000, 30000, ll.h) : 0, Math.cos(rot), Math.sin(rot), ((t / 86400) * 0.04) % 50);
    }
    const up = _w.copy(camI).normalize();
    const sunEl = up.dot(sun);
    const air = Math.exp(-Math.max(0, ll.h) / 8000);
    // sunlight colour: reddened near the horizon when inside the atmosphere
    const redden = air * (1 - smoothstep(0.0, 0.35, sunEl));
    this.sunLight.color.setRGB(1, 1 - 0.45 * redden, 1 - 0.75 * redden);
    // Earth's shadow on the ship
    const inShadow = sunShadow(camI, sun, EARTH.R) || sunShadow(camI.clone().sub(eph.moon), sun, MOON.R);
    const day = inShadow ? 0 : 1;
    this.sunLight.intensity = 3.2 * day * (ll.h < 100000 ? smoothstep(-0.12, 0.06, sunEl) : 1);
    this.sunLight.position.copy(sun).multiplyScalar(1000);
    this.sunTarget.position.set(0, 0, 0);
    this.hemi.intensity = 0.15 + 0.9 * bright;
    this.hemi.color.setRGB(0.55 * bright + 0.05, 0.68 * bright + 0.06, 0.9 * bright + 0.1);
    this.hemi.groundColor.setRGB(0.25 * bright + 0.02, 0.22 * bright + 0.02, 0.18 * bright + 0.02);
    this.hemi.position.copy(up);
    const night = 1 - smoothstep(-0.18, 0.02, sunEl);
    this.shared.night = night;
    // city lights read as glowing ground up close; let them fade in with altitude
    this.shared.uNightK.value = 0.12 + 0.88 * smoothstep(1500, 25000, ll.h);
    // airports near the camera
    const agl = ll.h - ground;
    if (this.frame % 15 === 0 || !this.airports.meshes.size) this.airports.updateMeshes(ll.lat, ll.lon, agl < 30000 ? 45000 : 0, this.shared);
    this.airports.setNight(night);
    this.buildings.update(ll.lat, ll.lon, agl, this.earth);
    this.clouds.update(camE0, ll, this.settings.clouds !== '0', night);
    this.agl = agl;
    return { bright, night, sunEl, agl };
  }
}

function sunShadow(p, sun, R) {
  const along = p.dot(sun);
  if (along > 0) return false;
  return p.lengthSq() - along * along < R * R * 0.98;
}
