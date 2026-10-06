// Headless browser harness: loads the game, waits for the title screen, and lets a scenario drive it.
//
// The game's own render loop is stopped during simulation so a scenario can step the physics as fast as the CPU
// allows (`__t.sim`), and resumed rendering on demand (`__t.settle`) so map tiles stream and screenshots draw.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

let _pw = null;
export async function playwright() {
  if (_pw) return _pw;
  try { _pw = await import('playwright'); } catch (e) {
    // fall back to a globally installed copy
    const root = execSync('npm root -g').toString().trim();
    _pw = await import(path.join(root, 'playwright', 'index.mjs'));
  }
  return _pw;
}

export async function launch() {
  const { chromium } = await playwright();
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  // behind an HTTPS-only proxy: route https through it, leave the local server direct
  const px = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (px) args.push(`--proxy-server=https=${px.replace(/^https?:\/\//, '')}`);
  const opts = { args };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return chromium.launch(opts);
}

// In-page helpers, installed after the game boots.
const PAGE_HELPERS = () => {
  const sf = window.__sf;
  const inp = { pitch: 0, roll: 0, yaw: 0, thr: 0, trX: 0, trY: 0, trZ: 0, brake: false };
  const cam = () => ({ dx: 0, dy: 0, zoom: 0 });
  window.__t = {
    inp,
    stopLoop() { if (!sf._frameOrig) { sf._frameOrig = sf.frame; sf.frame = () => {}; } },
    // step the game as fast as possible: `seconds` of simulation time (time warp counts), with dt per frame
    async sim(seconds, o = {}) {
      this.stopLoop();
      const dt = o.dt || 0.05;
      const t0 = sf.ship ? sf.ship.t : 0, wall = performance.now();
      let n = 0;
      while (sf.ship && sf.ship.t - t0 < seconds) {
        sf.flightFrame(dt, inp, [], cam());
        if (o.every && n % o.every === 0 && o.log) o.log(sf);   // n counts frames
        if (o.until && o.until(sf)) return { n, stopped: true, t: sf.ship.t - t0 };
        // realtimeNear: near the ground, go no faster than real time so the terrain under the ship streams in
        const E = sf.ship.env;
        n++;
        if (o.realtimeNear && !sf.ship.parked && E.agl < (o.nearAgl || 3000) && sf.ship.contacts === 0) await new Promise((r) => setTimeout(r, dt * sf.ship.warp * 1000));
        else if (n % 100 === 0) await new Promise((r) => setTimeout(r, 0));
        if (performance.now() - wall > (o.wallMax || 240000)) return { n, timeout: true, t: sf.ship.t - t0 };
        if (sf.ship.dead && !o.allowDead) return { n, dead: true, t: sf.ship.t - t0 };
      }
      return { n, t: sf.ship ? sf.ship.t - t0 : 0 };
    },
    // run frames in real time with rendering (tiles stream, the screen draws)
    async settle(realSeconds = 3, o = {}) {
      this.stopLoop();
      const end = performance.now() + realSeconds * 1000;
      let last = performance.now();
      while (performance.now() < end) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
        if (sf.ship && sf.state !== 'boot') { if (o.step !== false) sf.flightFrame(dt, inp, [], cam()); }
        else if (sf.state !== 'hangar') sf.idleFrame(dt);
        sf.render(dt);
      }
    },
    resumeLoop() { if (sf._frameOrig) { sf.frame = sf._frameOrig; sf._frameOrig = null; sf.last = performance.now(); requestAnimationFrame((t) => sf.frame(t)); } },
    design(name) { const d = sf.shipList().find((x) => x.name === name); if (!d) throw new Error('no design ' + name); sf.setDesign(d); return d; },
    // a launch site by airport code + runway end, or a special site type
    site(spec) {
      if (spec.type === 'runway' || spec.type === 'pad' || spec.type === 'hangar') {
        const A = sf.world.airports;
        const ap = A.search(spec.airport, 1)[0];
        if (!ap) throw new Error('no airport ' + spec.airport);
        const rw = (spec.rw && ap.runways.find((r) => r.he === spec.rw || r.le === spec.rw)) || ap.runways[0];
        return { type: spec.type, rw, airport: ap, fromLe: spec.rw ? rw.le === spec.rw : true };
      }
      return { name: spec.type, ...spec };
    },
    async start(design, spec) { this.design(design); await sf.startFlight(this.site(spec)); },
    orbit() {
      const s = sf.ship, R = 6371000, mu = 3.986004418e14;
      const r = s.r.length(), v2 = s.v.lengthSq(), en = v2 / 2 - mu / r, a = -mu / (2 * en);
      const h = s.r.clone().cross(s.v).length(), e = Math.sqrt(Math.max(0, 1 + 2 * en * h * h / (mu * mu)));
      return { pe: (a * (1 - e) - R) / 1000, ap: (a * (1 + e) - R) / 1000, e, inc: Math.acos(Math.min(1, Math.max(-1, s.r.clone().cross(s.v).normalize().y))) * 57.29578 };
    },
  };
};

export class Run {
  constructor(browser, base, opts = {}) {
    this.browser = browser; this.base = base; this.opts = opts;
    this.errors = []; this.notes = []; this.fails = [];
  }
  async open(viewport = { width: 1280, height: 720 }, extra = {}) {
    this.ctx = await this.browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra });
    const page = this.page = await this.ctx.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource|net::|ERR_|favicon/.test(t)) this.errors.push(`[${m.type()}] ${t}`);
    });
    page.on('pageerror', (e) => this.errors.push(`[pageerror] ${e.message}`));
    await page.goto(this.base + '/index.html');
    await page.waitForFunction(() => window.__sf && window.__sf.state === 'title', null, { timeout: 90000 });
    await page.evaluate(PAGE_HELPERS);
    return page;
  }
  eval(fn, arg) { return this.page.evaluate(fn, arg); }
  log(...a) { this.notes.push(a.join(' ')); if (this.opts.verbose) console.log('   ', ...a); }
  check(cond, msg) { if (!cond) this.fails.push(msg); else this.log('ok:', msg); return !!cond; }
  async shot(name) {
    if (!this.opts.shots) return;
    const dir = path.resolve(this.opts.shotDir || 'tests/shots');
    fs.mkdirSync(dir, { recursive: true });
    await this.page.screenshot({ path: path.join(dir, name + '.png') });
  }
  async close() { if (this.ctx) await this.ctx.close(); }
}
