// Part catalogue. Units: metres, kilograms, newtons, seconds.
//
// Part-local axes: +Y = forward / stack axis (toward the nose), +Z = top (dorsal), +X = right.
// Stack parts have nodes on their ±Y ends. Surface-attached parts mount at the origin and extend along +X,
// with +Y pointing forward along the parent. Engines push along local +Y (exhaust leaves through -Y).

import * as THREE from 'three';

export const SIZES = { S: 1.25, M: 2.5, L: 3.75 };
export const RES = {
  LF: { name: 'Fuel', color: '#ffb347', unit: 'kg' },
  OX: { name: 'Oxidizer', color: '#7fd4ff', unit: 'kg' },
  FU: { name: 'Fusion pellets', color: '#c58bff', unit: 'kg' },
  EC: { name: 'Charge', color: '#9cf28a', unit: 'kWh' },
  GAS: { name: 'RCS gas', color: '#d8e2ec', unit: 'kg' },
  XE: { name: 'Xenon', color: '#7ff0e8', unit: 'kg' },
  ABL: { name: 'Ablator', color: '#a0785a', unit: 'kg' },
};
export const CATS = [
  { id: 'cockpit', name: 'Cockpits' },
  { id: 'fuselage', name: 'Fuselage & tanks' },
  { id: 'engine', name: 'Engines' },
  { id: 'wing', name: 'Wings' },
  { id: 'control', name: 'Control' },
  { id: 'gear', name: 'Landing gear' },
  { id: 'aero', name: 'Nose & adapters' },
  { id: 'utility', name: 'Utility' },
];

const stack = (len, size, top = true, bot = true, sizeTop = size, sizeBot = size) => {
  const n = [];
  if (top) n.push({ p: [0, len / 2, 0], n: [0, 1, 0], s: sizeTop });
  if (bot) n.push({ p: [0, -len / 2, 0], n: [0, -1, 0], s: sizeBot });
  return n;
};

// Volume helper: usable propellant mass for a cylinder
const cyl = (d, l) => Math.PI * (d / 2) ** 2 * l * 0.85;
const LF_RHO = 810, OX_RHO = 1140;
const rocketTank = (d, l) => { const v = cyl(d, l); const lf = v * 0.33 * LF_RHO, ox = v * 0.67 * OX_RHO * 0.92; return { LF: Math.round(lf), OX: Math.round(ox) }; };
const jetTank = (d, l) => ({ LF: Math.round(cyl(d, l) * LF_RHO * 0.8) });

export const PARTS = [
  // ---------------- cockpits ----------------
  { id: 'ck-kestrel', cat: 'cockpit', name: 'Kestrel cockpit', desc: 'Sleek single-seat fighter nose with a bubble canopy. Light and slippery.',
    size: 'S', len: 4.2, mass: 950, maxT: 1500, cd: 0.10, torque: 8000, ec: 20, crash: 9,
    nodes: stack(4.2, 'S', false, true), surface: true, mesh: 'cockpitFighter' },
  { id: 'ck-horizon', cat: 'cockpit', name: 'Horizon flight deck', desc: 'Two-crew spaceplane nose. Wide windows, tough heat-tile chin.',
    size: 'M', len: 5.0, mass: 3200, maxT: 1900, cd: 0.14, torque: 40000, ec: 60, crash: 10,
    nodes: stack(5.0, 'M', false, true), surface: true, mesh: 'cockpitShuttle' },
  { id: 'ck-aurora', cat: 'cockpit', name: 'Aurora capsule', desc: 'Blunt crew capsule built for vertical rockets. Pair with a heat shield.',
    size: 'M', len: 3.0, mass: 2600, maxT: 2000, cd: 0.45, torque: 25000, ec: 50, crash: 12,
    nodes: stack(3.0, 'M', true, true, 'S', 'M'), surface: true, mesh: 'capsule' },
  { id: 'ck-vanguard', cat: 'cockpit', name: 'Vanguard bridge', desc: 'Heavy 3.75 m command nose for big starships. Strong gyros.',
    size: 'L', len: 6.5, mass: 7000, maxT: 1800, cd: 0.16, torque: 120000, ec: 150, crash: 10,
    nodes: stack(6.5, 'L', false, true), surface: true, mesh: 'cockpitHeavy' },

  { id: 'ck-bastion', cat: 'cockpit', name: 'Bastion armored pod', desc: 'Heavily armored crew pod. Shrugs off hard landings (25 m/s) and 2,600 K of heat — the cockpit that comes home.',
    size: 'M', len: 3.2, mass: 4800, maxT: 2600, cd: 0.4, torque: 30000, ec: 60, crash: 25,
    nodes: stack(3.2, 'M', true, true, 'S', 'M'), surface: true, mesh: 'armored' },

  // ---------------- fuselage & tanks ----------------
  { id: 'fs-s2', cat: 'fuselage', name: 'S fuselage 2 m', desc: 'Short 1.25 m fuel section.', size: 'S', len: 2, mass: 160, maxT: 1400, res: jetTank(1.25, 2), nodes: stack(2, 'S'), surface: true, mesh: 'tube' },
  { id: 'fs-s4', cat: 'fuselage', name: 'S fuselage 4 m', desc: 'Long 1.25 m fuel section.', size: 'S', len: 4, mass: 300, maxT: 1400, res: jetTank(1.25, 4), nodes: stack(4, 'S'), surface: true, mesh: 'tube' },
  { id: 'rt-s4', cat: 'fuselage', name: 'S rocket tank', desc: 'Fuel + oxidizer for rocket engines.', size: 'S', len: 4, mass: 280, maxT: 1300, res: rocketTank(1.25, 4), nodes: stack(4, 'S'), surface: true, mesh: 'tank' },
  { id: 'fs-m4', cat: 'fuselage', name: 'M fuselage 4 m', desc: '2.5 m spaceplane section full of jet fuel.', size: 'M', len: 4, mass: 900, maxT: 1500, res: jetTank(2.5, 4), nodes: stack(4, 'M'), surface: true, mesh: 'tube' },
  { id: 'fs-m8', cat: 'fuselage', name: 'M fuselage 8 m', desc: 'Long 2.5 m fuel section.', size: 'M', len: 8, mass: 1700, maxT: 1500, res: jetTank(2.5, 8), nodes: stack(8, 'M'), surface: true, mesh: 'tube' },
  { id: 'rt-m4', cat: 'fuselage', name: 'M rocket tank 4 m', desc: 'Fuel + oxidizer, 2.5 m.', size: 'M', len: 4, mass: 800, maxT: 1400, res: rocketTank(2.5, 4), nodes: stack(4, 'M'), surface: true, mesh: 'tank' },
  { id: 'rt-m8', cat: 'fuselage', name: 'M rocket tank 8 m', desc: 'Long fuel + oxidizer tank, 2.5 m.', size: 'M', len: 8, mass: 1500, maxT: 1400, res: rocketTank(2.5, 8), nodes: stack(8, 'M'), surface: true, mesh: 'tank' },
  { id: 'fu-l4', cat: 'fuselage', name: 'Fusion magazine L', desc: 'Big 3.75 m pellet magazine for fusion starships.', size: 'L', len: 4, mass: 2600, maxT: 1500, res: { FU: 8000 }, nodes: stack(4, 'L'), surface: true, mesh: 'fusionTank' },
  { id: 'fu-m3', cat: 'fuselage', name: 'Fusion pellet magazine', desc: 'Deuterium–helium-3 pellets for fusion drives. Tiny mass, enormous energy.', size: 'M', len: 3, mass: 900, maxT: 1500, res: { FU: 2000 }, nodes: stack(3, 'M'), surface: true, mesh: 'fusionTank' },
  { id: 'cb-m4', cat: 'fuselage', name: 'M cargo bay', desc: 'Empty structural section with a cargo door.', size: 'M', len: 4, mass: 700, maxT: 1500, nodes: stack(4, 'M'), surface: true, mesh: 'cargo' },
  { id: 'rt-l8', cat: 'fuselage', name: 'L rocket tank', desc: 'Huge 3.75 m fuel + oxidizer tank.', size: 'L', len: 8, mass: 3200, maxT: 1400, res: rocketTank(3.75, 8), nodes: stack(8, 'L'), surface: true, mesh: 'tank' },
  { id: 'xe-s2', cat: 'fuselage', name: 'Xenon tank', desc: 'Pressurised xenon for ion drives. A little goes a very long way.', size: 'S', len: 2, mass: 220, maxT: 1400, res: { XE: 1200 }, nodes: stack(2, 'S'), surface: true, mesh: 'xenon' },
  { id: 'lb-m6', cat: 'fuselage', name: 'Lifting body', desc: 'Flattened 2.5 m fuselage that generates its own lift — wingless spaceplanes glide home on it. Carries jet fuel.', size: 'M', len: 6, mass: 1900, maxT: 1900, res: jetTank(2.5, 5),
    wing: { root: 6, tip: 3.6, span: 1.9, sweep: 0.5, thick: 1.6, ctrl: 0, body: true }, nodes: stack(6, 'M'), surface: true, mesh: 'liftbody', heatTiles: true },
  { id: 'fs-l6', cat: 'fuselage', name: 'L fuselage 6 m', desc: 'Wide 3.75 m fuel section.', size: 'L', len: 6, mass: 2600, maxT: 1500, res: jetTank(3.75, 6), nodes: stack(6, 'L'), surface: true, mesh: 'tube' },

  // ---------------- engines ----------------
  { id: 'en-swift', cat: 'engine', name: 'Swift turbofan', desc: 'Air-breathing jet. Very efficient, works to about Mach 2.2 and 18 km.',
    size: 'S', len: 3.2, mass: 1100, maxT: 1700, crash: 8, nodes: stack(3.2, 'S', true, false), surface: true, mesh: 'jet',
    engine: { type: 'jet', thrust: 75000, isp: 6000, fuel: { LF: 1 }, maxMach: 2.4, ceiling: 20000, spool: 2.5, gimbal: 0, heat: 25000 } },
  { id: 'en-scram', cat: 'engine', name: 'Shrike scramjet', desc: 'Needs speed to light (Mach 1.5+). Peaks around Mach 5–8 high in the sky.',
    size: 'S', len: 4.0, mass: 1400, maxT: 2200, crash: 8, nodes: stack(4, 'S', true, false), surface: true, mesh: 'scram',
    engine: { type: 'scram', thrust: 130000, isp: 3200, fuel: { LF: 1 }, minMach: 1.4, peakMach: 6.5, maxMach: 11, ceiling: 48000, spool: 1.5, gimbal: 0, heat: 60000 } },
  { id: 'en-valk', cat: 'engine', name: 'Valkyrie hybrid', desc: 'Breathes air to Mach 5.5, then switches to closed-cycle rocket. The heart of a single-stage spaceplane.',
    size: 'M', len: 4.5, mass: 2600, maxT: 2200, crash: 8, nodes: stack(4.5, 'M', true, false), surface: true, mesh: 'hybrid',
    engine: { type: 'hybrid', thrust: 200000, isp: 3400, fuel: { LF: 1 }, maxMach: 5.8, ceiling: 30000, spool: 1.8,
      rocket: { thrust: 300000, ispVac: 450, ispSL: 390, fuel: { LF: 0.31, OX: 0.69 } }, gimbal: 3, heat: 60000 } },
  { id: 'en-comet', cat: 'engine', name: 'Comet rocket', desc: 'Small, reliable kerosene–oxygen rocket.',
    size: 'S', len: 2.0, mass: 600, maxT: 2000, crash: 7, nodes: stack(2, 'S', true, false), surface: true, mesh: 'rocketS',
    engine: { type: 'rocket', thrust: 90000, ispVac: 340, ispSL: 300, fuel: { LF: 0.31, OX: 0.69 }, spool: 0.25, gimbal: 5, heat: 40000 } },
  { id: 'en-titan', cat: 'engine', name: 'Titan booster', desc: 'Powerful sea-level rocket for heavy lifting.',
    size: 'M', len: 3.6, mass: 3500, maxT: 2000, crash: 7, nodes: stack(3.6, 'M', true, false), surface: true, mesh: 'rocketM',
    engine: { type: 'rocket', thrust: 900000, ispVac: 330, ispSL: 295, fuel: { LF: 0.31, OX: 0.69 }, spool: 0.4, gimbal: 4, heat: 200000 } },
  { id: 'en-lantern', cat: 'engine', name: 'Lantern vacuum engine', desc: 'Huge nozzle, superb in space, feeble in thick air.',
    size: 'M', len: 4.0, mass: 1900, maxT: 2000, crash: 6, nodes: stack(4, 'M', true, false), surface: true, mesh: 'rocketVac',
    engine: { type: 'rocket', thrust: 280000, ispVac: 385, ispSL: 140, fuel: { LF: 0.31, OX: 0.69 }, spool: 0.3, gimbal: 3, heat: 70000 } },
  { id: 'en-behemoth', cat: 'engine', name: 'Behemoth heavy', desc: '3.75 m main engine with 2.4 MN of thrust.',
    size: 'L', len: 5.0, mass: 7500, maxT: 2000, crash: 7, nodes: stack(5, 'L', true, false), surface: true, mesh: 'rocketL',
    engine: { type: 'rocket', thrust: 2400000, ispVac: 345, ispSL: 310, fuel: { LF: 0.31, OX: 0.69 }, spool: 0.5, gimbal: 3, heat: 500000 } },
  { id: 'en-prometheus', cat: 'engine', name: 'Prometheus nuclear', desc: 'Nuclear thermal rocket. Runs on fuel alone with 900 s of efficiency.',
    size: 'M', len: 5.0, mass: 4200, maxT: 2400, crash: 6, nodes: stack(5, 'M', true, false), surface: true, mesh: 'nuclear',
    engine: { type: 'rocket', thrust: 120000, ispVac: 900, ispSL: 320, fuel: { LF: 1 }, spool: 1.5, gimbal: 2, heat: 900000 } },
  { id: 'en-helios', cat: 'engine', name: 'Helios fusion torch', desc: 'Magnetic-nozzle fusion drive: 600 kN, Isp 20,000 s — runway to the Moon and back on one tank. Runs very hot: bring radiators.',
    size: 'M', len: 5.5, mass: 6500, maxT: 2600, crash: 6, nodes: stack(5.5, 'M', true, false), surface: true, mesh: 'fusion',
    engine: { type: 'rocket', thrust: 600000, ispVac: 20000, ispSL: 4000, fuel: { FU: 1 }, spool: 2.0, gimbal: 3, heat: 1.2e8, fusion: true } },
  { id: 'en-helios-l', cat: 'engine', name: 'Helios Heavy fusion drive', desc: '3.75 m fusion torch with 1.2 MN — enough to lift a starship straight off the pad. Needs serious radiators.',
    size: 'L', len: 7.0, mass: 15000, maxT: 2600, crash: 6, nodes: stack(7, 'L', true, false), surface: true, mesh: 'fusion',
    engine: { type: 'rocket', thrust: 1200000, ispVac: 9000, ispSL: 3200, fuel: { FU: 1 }, spool: 2.5, gimbal: 4, heat: 2.8e8, fusion: true } },
  { id: 'en-raptor', cat: 'engine', name: 'Raptor afterburning turbojet', desc: 'Fighter engine with an afterburner: push the throttle past 90 % for 60 % more thrust at a quarter of the efficiency. Mach 2.8.',
    size: 'S', len: 3.8, mass: 1500, maxT: 1800, crash: 8, nodes: stack(3.8, 'S', true, false), surface: true, mesh: 'afterburner',
    engine: { type: 'jet', thrust: 80000, isp: 5000, fuel: { LF: 1 }, maxMach: 2.8, ceiling: 21000, spool: 2.0, gimbal: 0, heat: 40000, ab: { thrust: 1.6, isp: 0.25 } } },
  { id: 'en-ion', cat: 'engine', name: 'Ion drive', desc: 'Gridded ion thruster: tiny push, superb efficiency (Isp 6,000 s). Burns xenon and 1.5 MW of electricity — bring a reactor.',
    size: 'S', len: 1.6, mass: 700, maxT: 1600, crash: 6, nodes: stack(1.6, 'S', true, false), surface: true, mesh: 'ion',
    engine: { type: 'rocket', thrust: 12000, ispVac: 6000, ispSL: 300, fuel: { XE: 1 }, spool: 1.0, gimbal: 0, heat: 2e5, power: 1500 } },
  { id: 'en-plasma', cat: 'engine', name: 'Plasma lift thruster', desc: 'Belly-mounted fusion-plasma thruster for hovering and vertical landings anywhere — even on the airless Moon. Mount it under the hull.',
    size: 'S', len: 0.9, mass: 900, maxT: 2200, crash: 7, nodes: [], surface: true, mesh: 'plasma', thrustAxis: [-1, 0, 0], com: [0.35, 0, 0], nozzle: [0.8, 0, 0],
    engine: { type: 'rocket', thrust: 160000, ispVac: 2200, ispSL: 1300, fuel: { FU: 1 }, spool: 0.5, gimbal: 6, heat: 8e6, fusion: true, lift: true } },
  { id: 'en-liftfan', cat: 'engine', name: 'Lift fan', desc: 'Vertical lift fan for hovering and VTOL. Air only, below 12 km. Mount it facing down.',
    size: 'S', len: 0.8, mass: 450, maxT: 1200, crash: 6, nodes: [], surface: true, mesh: 'liftfan', thrustAxis: [-1, 0, 0], com: [0.3, 0, 0], nozzle: [0.6, 0, 0],
    engine: { type: 'jet', thrust: 90000, isp: 4000, fuel: { LF: 1 }, maxMach: 0.8, ceiling: 12000, spool: 0.8, gimbal: 8, heat: 10000, lift: true } },
  { id: 'en-pod', cat: 'engine', name: 'Swift engine pod', desc: 'Surface-mount turbofan nacelle — hang it under a wing.',
    size: 'S', len: 3.4, mass: 1200, maxT: 1700, crash: 8, nodes: [], surface: true, mesh: 'pod', com: [1.0, 0, 0], nozzle: [1.0, -1.7, 0],
    engine: { type: 'jet', thrust: 75000, isp: 6000, fuel: { LF: 1 }, maxMach: 2.2, ceiling: 19000, spool: 2.5, gimbal: 0, heat: 25000 } },

  // ---------------- wings ----------------
  { id: 'wg-delta-l', cat: 'wing', name: 'Big delta wing', desc: 'Large high-speed delta with elevons and a carbon thermal skin. Made for spaceplanes and reentry.', mass: 1400, maxT: 2100, crash: 8,
    wing: { root: 9, tip: 1.2, span: 6.5, sweep: 0.95, thick: 0.45, ctrl: 0.22 }, nodes: [], surface: true, mesh: 'wing', heatTiles: true },
  { id: 'wg-delta-m', cat: 'wing', name: 'Delta wing', desc: 'Mid-size delta with elevons.', mass: 650, maxT: 1700, crash: 8,
    wing: { root: 5.2, tip: 0.8, span: 4.2, sweep: 0.9, thick: 0.3, ctrl: 0.22 }, nodes: [], surface: true, mesh: 'wing', heatTiles: true },
  { id: 'wg-swept', cat: 'wing', name: 'Swept wing', desc: 'Efficient swept wing with ailerons. Good lift at all speeds.', mass: 600, maxT: 1400, crash: 8,
    wing: { root: 3.2, tip: 1.3, span: 6.5, sweep: 0.55, thick: 0.28, ctrl: 0.2 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'wg-straight', cat: 'wing', name: 'Straight wing', desc: 'High-lift, low-speed wing with flaperons.', mass: 520, maxT: 1300, crash: 8,
    wing: { root: 2.5, tip: 1.8, span: 6, sweep: 0.08, thick: 0.3, ctrl: 0.24 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'wg-forward', cat: 'wing', name: 'Forward-swept wing', desc: 'Agile and unstable — for experts.', mass: 560, maxT: 1400, crash: 8,
    wing: { root: 3.0, tip: 1.4, span: 5.5, sweep: -0.45, thick: 0.26, ctrl: 0.22 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'wg-strake', cat: 'wing', name: 'Strake', desc: 'Long thin lifting strake along the fuselage.', mass: 160, maxT: 1500, crash: 9,
    wing: { root: 5, tip: 0.3, span: 1.2, sweep: 1.25, thick: 0.15, ctrl: 0 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'wg-fin', cat: 'wing', name: 'Tail fin', desc: 'Swept stabilizer with a rudder. Mount on top for yaw stability.', mass: 260, maxT: 1500, crash: 8,
    wing: { root: 3.4, tip: 1.2, span: 3.0, sweep: 0.85, thick: 0.2, ctrl: 0.3 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'wg-tailplane', cat: 'wing', name: 'Tailplane', desc: 'Horizontal stabilizer with elevator.', mass: 220, maxT: 1400, crash: 8,
    wing: { root: 2.4, tip: 1.2, span: 3.2, sweep: 0.5, thick: 0.18, ctrl: 0.35 }, nodes: [], surface: true, mesh: 'wing' },

  // ---------------- control ----------------
  { id: 'ct-canard', cat: 'control', name: 'All-moving canard', desc: 'Small foreplane that pivots as a whole. Strong pitch control.', mass: 140, maxT: 1500, crash: 8,
    wing: { root: 1.7, tip: 0.6, span: 1.9, sweep: 0.7, thick: 0.12, ctrl: 1 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'ct-elevon', cat: 'control', name: 'Elevon flap', desc: 'Bolt-on control surface. Place on wing trailing edges.', mass: 90, maxT: 1500, crash: 8,
    wing: { root: 0.9, tip: 0.9, span: 2.6, sweep: 0, thick: 0.1, ctrl: 1 }, nodes: [], surface: true, mesh: 'wing' },
  { id: 'ct-wheel-s', cat: 'control', name: 'Reaction wheel S', desc: 'Gyroscopic torque for turning in space. Uses charge.', size: 'S', len: 0.5, mass: 150, maxT: 1500, torque: 20000, ec: 0,
    nodes: stack(0.5, 'S'), surface: true, mesh: 'wheelS' },
  { id: 'ct-wheel-m', cat: 'control', name: 'Reaction wheel M', desc: 'Big gyro ring for 2.5 m ships.', size: 'M', len: 0.6, mass: 450, maxT: 1500, torque: 80000, ec: 0,
    nodes: stack(0.6, 'M'), surface: true, mesh: 'wheelM' },
  { id: 'ct-rcs', cat: 'control', name: 'RCS thruster block', desc: 'Four-way cold-gas thrusters for fine attitude control in space. Carries its own gas; tops up from jet fuel.', mass: 40, maxT: 1500, crash: 8,
    rcs: { thrust: 2500, isp: 260 }, res: { GAS: 60 }, nodes: [], surface: true, mesh: 'rcs', com: [0.18, 0, 0] },

  // ---------------- gear ----------------
  { id: 'gr-light', cat: 'gear', name: 'Light landing gear', desc: 'Retractable wheel for small planes. Steers if mounted up front.', mass: 120, maxT: 1300, crash: 7,
    gear: { len: 1.5, wheel: 0.32, k: 140000, c: 14000, load: 14000, steer: true }, nodes: [], surface: true, mesh: 'gear' },
  { id: 'gr-heavy', cat: 'gear', name: 'Heavy landing gear', desc: 'Twin-wheel bogie for big spaceplanes.', mass: 420, maxT: 1400, crash: 8,
    gear: { len: 2.2, wheel: 0.55, k: 520000, c: 52000, load: 60000, steer: true, twin: true }, nodes: [], surface: true, mesh: 'gear' },
  { id: 'gr-leg', cat: 'gear', name: 'Landing leg', desc: 'Shock-absorbing leg for vertical landings on the Moon.', mass: 180, maxT: 1500, crash: 10,
    gear: { len: 2.0, wheel: 0, k: 220000, c: 26000, load: 25000, leg: true }, nodes: [], surface: true, mesh: 'leg' },

  { id: 'gr-skid', cat: 'gear', name: 'Landing skid', desc: 'Fixed skid for VTOLs and landers: no wheels, lots of grip, very tough. Mount in pairs under the hull.', mass: 110, maxT: 1700, crash: 12,
    gear: { len: 0.7, wheel: 0, k: 260000, c: 30000, load: 40000, leg: true, skid: true }, nodes: [], surface: true, mesh: 'skid' },
  { id: 'gr-leg-l', cat: 'gear', name: 'Starship leg', desc: 'Long telescoping leg for big vertical landers. Mount on the engine, angled down and out.', mass: 650, maxT: 1700, crash: 11,
    gear: { len: 5.0, wheel: 0, k: 900000, c: 110000, load: 60000, leg: true, stroke: 0.7 }, nodes: [], surface: true, mesh: 'leg' },

  // ---------------- nose & adapters ----------------
  { id: 'ae-nose-s', cat: 'aero', name: 'S nose cone', desc: 'Pointy aerodynamic cap.', size: 'S', len: 2.4, mass: 90, maxT: 2000, cd: 0.08, nodes: stack(2.4, 'S', false, true), surface: true, mesh: 'cone' },
  { id: 'ae-nose-m', cat: 'aero', name: 'M nose cone', desc: 'Ogive nose for 2.5 m.', size: 'M', len: 4, mass: 300, maxT: 2000, cd: 0.08, nodes: stack(4, 'M', false, true), surface: true, mesh: 'cone' },
  { id: 'ae-needle-s', cat: 'aero', name: 'Needle nose', desc: 'Long, sharp 1.25 m nose for supersonic jets — the least drag there is.', size: 'S', len: 4.2, mass: 130, maxT: 1900, cd: 0.05, nodes: stack(4.2, 'S', false, true), surface: true, mesh: 'needle' },
  { id: 'ae-blunt-m', cat: 'aero', name: 'Blunt nose cap', desc: 'Rounded 2.5 m cap. Draggy, but it spreads reentry heat over a wide nose and takes 2,400 K.', size: 'M', len: 1.4, mass: 380, maxT: 2400, cd: 0.45, nodes: stack(1.4, 'M', false, true), surface: true, mesh: 'blunt' },
  { id: 'ae-tail-m', cat: 'aero', name: 'M tail cone', desc: 'Tapered tail fairing.', size: 'M', len: 3, mass: 250, maxT: 1600, nodes: stack(3, 'M', true, true, 'M', 'S'), surface: true, mesh: 'adapter' },
  { id: 'ae-ad-sm', cat: 'aero', name: 'Adapter S→M', desc: 'Joins 1.25 m and 2.5 m parts.', size: 'M', len: 1.6, mass: 180, maxT: 1500, res: { LF: 300 }, nodes: stack(1.6, 'M', true, true, 'S', 'M'), surface: true, mesh: 'adapter' },
  { id: 'ae-ad-ml', cat: 'aero', name: 'Adapter M→L', desc: 'Joins 2.5 m and 3.75 m parts.', size: 'L', len: 2, mass: 400, maxT: 1500, res: { LF: 1200 }, nodes: stack(2, 'L', true, true, 'M', 'L'), surface: true, mesh: 'adapter' },
  { id: 'ae-intake', cat: 'aero', name: 'Ram intake', desc: 'Shock-cone intake. Lets jets breathe better at high speed (+15% thrust).', size: 'S', len: 1.6, mass: 140, maxT: 1700, cd: 0.12, intake: 0.15,
    nodes: stack(1.6, 'S', false, true), surface: true, mesh: 'intake' },

  // ---------------- utility ----------------
  { id: 'ut-shield-m', cat: 'utility', name: 'Heat shield M', desc: 'Ablative shield. Survives 3,300 K reentry heat while its ablator lasts (it burns away with every hot reentry; the station tops it up).', size: 'M', len: 0.4, mass: 250, maxT: 3300, cd: 0.6, shield: true, res: { ABL: 400 },
    nodes: stack(0.4, 'M'), surface: true, mesh: 'shield' },
  { id: 'ut-shield-s', cat: 'utility', name: 'Heat shield S', desc: 'Small ablative shield (its ablator burns away with use).', size: 'S', len: 0.3, mass: 70, maxT: 3300, cd: 0.6, shield: true, res: { ABL: 110 },
    nodes: stack(0.3, 'S'), surface: true, mesh: 'shield' },
  { id: 'ut-radiator', cat: 'utility', name: 'Radiator panel', desc: 'Dumps engine heat into space. Essential for fusion drives.', mass: 120, maxT: 1800, crash: 6,
    radiator: 5e7, nodes: [], surface: true, mesh: 'radiator', com: [2.1, 0, 0] },
  { id: 'ut-solar', cat: 'utility', name: 'Solar wing', desc: 'Charges the batteries in sunlight.', mass: 80, maxT: 1200, crash: 5,
    solar: 6, nodes: [], surface: true, mesh: 'solar', com: [2.7, 0, 0] },
  { id: 'ut-reactor', cat: 'utility', name: 'Fission reactor', desc: 'Compact reactor: a steady 1.6 MW of electricity for ion drives, years of fuel. Runs hot — add a radiator.', size: 'S', len: 2.2, mass: 2400, maxT: 1800, crash: 6,
    reactor: { power: 1600, heat: 3.5e6 }, ecStore: 50, nodes: stack(2.2, 'S'), surface: true, mesh: 'reactor' },
  { id: 'ut-fusioncore', cat: 'utility', name: 'Fusion power core', desc: 'Burns a trickle of fusion pellets for 8 MW of electricity. Needs radiators.', size: 'M', len: 2.4, mass: 4200, maxT: 2000, crash: 6,
    reactor: { power: 8000, heat: 1.6e7, fuel: { FU: 0.4 } }, ecStore: 200, nodes: stack(2.4, 'M'), surface: true, mesh: 'fusioncore' },
  { id: 'ut-battery', cat: 'utility', name: 'Battery pack', desc: 'Stores 200 kWh of charge.', size: 'S', len: 0.6, mass: 300, maxT: 1500, ecStore: 200, nodes: stack(0.6, 'S'), surface: true, mesh: 'battery' },
  { id: 'ut-light', cat: 'utility', name: 'Landing light', desc: 'Bright floodlight for night landings.', mass: 15, maxT: 1500, light: true, nodes: [], surface: true, mesh: 'lamp' },
  { id: 'ut-strobe', cat: 'utility', name: 'Nav strobe', desc: 'Blinking position light.', mass: 5, maxT: 1500, strobe: true, nodes: [], surface: true, mesh: 'strobe' },
  { id: 'ut-dock', cat: 'utility', name: 'Docking port', desc: 'Docks with Meridian Station, where you can refuel. Mount it on the hull facing out (the top or the nose is best) and bring RCS thrusters to steer in.',
    mass: 240, maxT: 1700, crash: 8, dock: { h: 0.75, r: 0.7 }, nodes: [], surface: true, mesh: 'dock', com: [0.35, 0, 0] },
];

export const PART = Object.fromEntries(PARTS.map((p) => [p.id, p]));

// wing planform -> area, aspect ratio, mean aerodynamic chord and aerodynamic centre
function deriveWing(w) {
  w.area = w.span * (w.root + w.tip) / 2;
  w.ar = (2 * w.span * w.span) / w.area;            // as part of a mirrored pair
  // aerodynamic centre: quarter chord of the mean aerodynamic chord
  const lam = w.tip / w.root;
  const mac = (2 / 3) * w.root * (1 + lam + lam * lam) / (1 + lam);
  const yMac = (w.span / 3) * (1 + 2 * lam) / (1 + lam);
  const leY = -Math.tan(w.sweep) * yMac;             // leading edge offset at MAC (chord axis = +Y forward)
  w.ac = [yMac, leY - 0.25 * mac + w.root * 0.5, 0];  // in part coords: x = spanwise, y = chordwise
  w.mac = mac;
  // structural limit: the root carries the bending moment of the lift acting at the MAC station; a deep,
  // broad root resists it (section ~ chord × thickness²), a long slender span doesn't. N per m² of wing.
  w.sigma = Math.min(150000, Math.max(20000, 3.5e6 * w.thick * w.thick * w.root / Math.max(0.3, yMac) / w.area));
}

// limits for reshaping a wing in the hangar (metres; sweep in radians)
export const WING_LIMITS = { span: [0.5, 18], root: [0.3, 16], tip: [0.05, 16], sweep: [-0.7, 1.25] };
// A reshaped copy of a wing part: o = { span, root, tip, sweep }. Structure (mass, fuel, heat capacity) scales
// with the area, a little more for long slender spans.
const _variants = new Map();
export function variantDef(def, o) {
  if (!def.wing || !o || def.wing.body) return def;
  const L = WING_LIMITS, c = (v, k, d) => Math.min(L[k][1], Math.max(L[k][0], Number.isFinite(v) ? v : d));
  const w0 = def.wing;
  const span = c(o.span, 'span', w0.span), root = c(o.root, 'root', w0.root), tip = Math.min(root * 1.5, c(o.tip, 'tip', w0.tip)), sweep = c(o.sweep, 'sweep', w0.sweep);
  const key = `${def.id}|${span.toFixed(2)}|${root.toFixed(2)}|${tip.toFixed(2)}|${sweep.toFixed(3)}`;
  let v = _variants.get(key);
  if (v) return v;
  const w = { ...w0, span, root, tip, sweep, thick: w0.thick * Math.sqrt(root / w0.root) };
  deriveWing(w);
  const k = (w.area / w0.area) * Math.pow(span / w0.span, 0.3) / Math.pow(w.area / w0.area, 0.15);
  v = { ...def, wing: w, mass: Math.round(def.mass * k), com: [w.ac[0], w.ac[1], 0], shaped: true };
  if (def.res) v.res = Object.fromEntries(Object.entries(def.res).map(([r, a]) => [r, Math.round(a * w.area / w0.area)]));
  _variants.set(key, v);
  return v;
}

// derived properties
for (const p of PARTS) {
  if (p.wing) { deriveWing(p.wing); if (p.wing.body) { p.wing.ac[0] = 0; p.wing.ac[1] = 0; p.wing.ar = (2 * p.wing.span) ** 2 / p.wing.area; } }
  if (p.engine) {
    const e = p.engine;
    if (e.type === 'rocket') e.isp = e.ispVac;
  }
  if (!p.com) p.com = p.wing ? [p.wing.ac[0], p.wing.ac[1], 0] : p.gear ? [p.gear.len * 0.5, 0, 0] : [0, 0, 0];
  if (p.engine && !p.thrustAxis) p.thrustAxis = [0, 1, 0];
  if (p.engine && !p.nozzle) p.nozzle = p.thrustAxis[0] ? [0.3, 0, 0] : [0, -(p.len || 1) / 2, 0];
  if (!p.cd) p.cd = p.wing ? 0.02 : 0.3;
  if (!p.crash) p.crash = 8;
  p.dia = p.size ? SIZES[p.size] : 0.8;
}

export function resourceTotals(def) { return def.res ? { ...def.res } : {}; }
