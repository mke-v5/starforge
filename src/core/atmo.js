// U.S. Standard Atmosphere 1976 (to 86 km) with an exponential thermosphere tail to 140 km.

const LAYERS = [
  // base geopotential alt (m), base T (K), lapse (K/m), base P (Pa)
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.956420],
  [84852, 186.946, 0, 0.3734],
];
const Rgas = 287.053, g0 = 9.80665, RE = 6356766;
export const RHO0 = 1.225;

const out = { rho: 0, T: 288.15, p: 101325, a: 340.3 };

export function atmosphere(h) {
  if (h > 140000) { out.rho = 0; out.p = 0; out.T = 1000; out.a = 300; return out; }
  if (h < -500) h = -500;
  if (h <= 86000) {
    const H = (RE * h) / (RE + h);
    let L = LAYERS[0];
    for (let i = LAYERS.length - 1; i >= 0; i--) if (H >= LAYERS[i][0]) { L = LAYERS[i]; break; }
    const [Hb, Tb, lap, Pb] = L, dH = H - Hb;
    let T, p;
    if (lap === 0) { T = Tb; p = Pb * Math.exp(-g0 * dH / (Rgas * Tb)); }
    else { T = Tb + lap * dH; p = Pb * Math.pow(Tb / T, g0 / (Rgas * lap)); }
    out.T = T; out.p = p; out.rho = p / (Rgas * T);
  } else {
    // thermosphere: fit to standard densities (86 km 6.96e-6, 100 km 5.6e-7, 120 km 2.2e-8, 140 km 3.8e-9)
    let rho;
    if (h < 100000) rho = 6.96e-6 * Math.exp(-(h - 86000) / 5560);
    else if (h < 120000) rho = 5.6e-7 * Math.exp(-(h - 100000) / 6200);
    else rho = 2.2e-8 * Math.exp(-(h - 120000) / 11400);
    out.T = 186.9 + (h - 86000) * 0.012;
    out.rho = rho * Math.min(1, (140000 - h) / 4000 + 0.0001);     // fade to vacuum at the top
    out.p = out.rho * Rgas * out.T;
  }
  out.a = Math.sqrt(1.4 * Rgas * out.T);
  return out;
}
