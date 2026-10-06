// Hangar mission check: from the design alone, can this ship take off, reach orbit, dock at the station, land on
// the Moon and come back? Rough delta-v budgets (with the usual losses) and thrust checks; the numbers are shown
// so the player can see how far off a design is.

import { deltaV, engineClass } from '../ship/orbit.js';
import { G0, MOON } from '../core/geo.js';

const SL = { rho: 1.225, p: 101325, mach: 0, h: 0, T: 288, a: 340 };
const VAC = { rho: 0, p: 0, mach: 0, h: 1e6, T: 3, a: 300 };
const gMoon = MOON.mu / (MOON.R * MOON.R);

// delta-v from orbit (m/s): trans-lunar injection, capture into a low orbit, descent, ascent, the way home
export const MOON_BUDGET = { tli: 3150, capture: 850, descent: 1900, ascent: 1900, home: 850 };

export function missionCheck(c, design) {
  if (!c.parts.length || !c.engines.length) return null;
  const mass = c.mass;
  const out = [];
  const cls = (P) => engineClass(P);
  const thrust = (filter, env) => c.engines.reduce((s, P) => {
    if (!filter(P)) return s;
    const save = P.eng.mode;
    if (P.eng.e.type === 'hybrid' && env === VAC) P.eng.mode = 'rocket';
    const t = c.engineOutput(P, env)[0];
    P.eng.mode = save;
    return s + t;
  }, 0);
  const isMain = (P) => cls(P) === 'main' || P.eng.e.type === 'hybrid';
  const isAir = (P) => cls(P) === 'jets' || P.eng.e.type === 'hybrid' || P.eng.e.type === 'scram';
  const isLift = (P) => cls(P) === 'lift';
  const tSL = thrust(() => true, SL), tMainVac = thrust(isMain, VAC), tLiftVac = thrust(isLift, VAC), tLiftSL = thrust(isLift, SL);
  const S = c.wings.reduce((s, P) => s + P.wing.area, 0);
  const dv = tMainVac > 0 ? deltaV(c, false, isMain) : 0;
  const vertical = !!design.vertical;

  // ---- getting off the ground ----
  const vs = S > 0 ? Math.sqrt((2 * mass * G0) / (1.225 * S * 1.25)) : Infinity;
  let takeoff;
  if (vertical) takeoff = { ok: tSL / (mass * G0) > 1.1, label: 'Lifts off its pad', detail: `TWR ${(tSL / (mass * G0)).toFixed(2)} (needs 1.1)` };
  else if (tLiftSL / (mass * G0) > 1.05) takeoff = { ok: true, label: 'Takes off vertically', detail: `hover TWR ${(tLiftSL / (mass * G0)).toFixed(2)}` };
  else {
    const wheels = c.gears.some((P) => !P.gear.g.leg);
    // wheels both ahead of and behind the centre of mass, or it sits on its tail or nose
    const ends = c.gears.map((P) => P.gear.ext.clone().multiplyScalar(P.gear.g.len + P.gear.g.wheel).add(P.gear.mount).z);
    const stance = ends.some((z) => z < c.com.z - 0.2) && ends.some((z) => z > c.com.z);
    takeoff = { ok: wheels && stance && S > 0 && vs < 120 && tSL / (mass * G0) > 0.2, label: 'Takes off from a runway',
      detail: !wheels ? 'needs wheeled landing gear' : !stance ? 'needs wheels ahead of and behind the centre of mass' : S > 0 ? `lift-off ~${Math.round(vs * 1.15 * 3.6)} km/h · TWR ${(tSL / (mass * G0)).toFixed(2)}` : 'no wings' };
  }
  out.push(takeoff);

  // ---- orbit: ~9.4 km/s from the ground in a rocket; an air-breathing climb takes some of that ----
  let assist = 0;
  for (const P of c.engines) if (isAir(P) && S > 0) {
    const e = P.eng.e;
    const mach = Math.min(e.maxMach || 0, 8);
    assist = Math.max(assist, mach * 295 * (e.type === 'jet' ? 0.6 : 0.8));
  }
  const needOrbit = Math.round((vertical ? 9400 : 9300) - assist * 0.8);
  const twrVac = tMainVac / (mass * G0);
  let orbit;
  if (!tMainVac) orbit = { ok: false, label: 'Reaches orbit', detail: 'needs rocket engines — jets stop working in thin air' };
  else if (twrVac < 0.35) orbit = { ok: false, label: 'Reaches orbit', detail: `rocket thrust too low (TWR ${twrVac.toFixed(2)}, needs 0.35)` };
  else orbit = { ok: dv >= needOrbit && takeoff.ok, label: 'Reaches orbit', detail: `Δv ${fmt(dv)} of ~${fmt(needOrbit)} m/s` };
  out.push(orbit);

  // ---- the station: orbit, then rendezvous and docking ----
  // (a craft built for space — it can't get there from the ground — is judged from orbit)
  const fromOrbit = !orbit.ok && tMainVac > 0 && !takeoff.ok;
  const base = fromOrbit ? 0 : needOrbit;
  const needStation = base + 400;
  const dockOk = c.docks.length > 0 && c.rcsList.length > 0;
  out.push({
    ok: (orbit.ok || fromOrbit) && dv >= needStation && dockOk, label: fromOrbit ? 'From orbit: docks at the station' : 'Docks at Meridian Station',
    detail: !c.docks.length ? 'needs a docking port' : !c.rcsList.length ? 'needs RCS thrusters to steer in' : `Δv ${fmt(dv)} of ~${fmt(needStation)} m/s`,
  });

  // ---- the Moon and back: land with hover or main thrust in lunar gravity; home by gliding or a powered landing ----
  const B = MOON_BUDGET;
  if (fromOrbit) {
    // to lunar orbit and back to Earth orbit (no landing, no reentry)
    const need = B.tli + B.capture + B.home + 900;
    out.push({ ok: dv >= need, label: 'From orbit: to the Moon and back', detail: `Δv ${fmt(dv)} of ~${fmt(need)} m/s` });
    return { list: out, dv, needOrbit, needStation, needMoon: need };
  }
  const glideHome = S > 0 && !vertical;
  const needMoon = needOrbit + B.tli + B.capture + B.descent + B.ascent + B.home + (glideHome ? 100 : 1000);
  const landT = Math.max(tLiftVac, tMainVac);
  const moonTwr = landT / (mass * gMoon);
  out.push({
    ok: orbit.ok && dv >= needMoon && moonTwr > 1.3, label: 'Lands on the Moon and comes home',
    detail: moonTwr <= 1.3 ? `too little thrust for lunar gravity (TWR ${moonTwr.toFixed(1)} there)` : `Δv ${fmt(dv)} of ~${fmt(needMoon)} m/s`,
  });

  // ---- coming back through the air ----
  const weak = c.parts.reduce((b, P) => (!b || (P.def.maxT || 1e9) < (b.def.maxT || 1e9) ? P : b), null);
  const maxT = weak.def.maxT || 0;
  if (orbit.ok) out.push({ ok: maxT >= 1200, label: 'Survives reentry', detail: `heat limit ${maxT} K (${weak.def.name})`, soft: maxT >= 1000 });
  if (glideHome && isFinite(vs)) {
    const wheels = c.gears.some((P) => !P.gear.g.leg);
    out.push({ ok: wheels && vs < 95, label: 'Lands on a runway', detail: wheels ? `touchdown ~${Math.round(vs * 1.2 * 3.6)} km/h` : 'needs wheeled landing gear', soft: wheels && vs < 120 });
  }
  return { list: out, dv, needOrbit, needStation, needMoon };
}

const fmt = (v) => Math.round(v).toLocaleString('en-US');
