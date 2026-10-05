// localStorage helpers (wrapped: storage can be unavailable in private modes)
const P = 'starforge.';
export function load(key, fallback) {
  try { const v = localStorage.getItem(P + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(P + key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
export const DEFAULT_SETTINGS = { tod: 'day', assist: 'assisted', quality: 'medium', units: 'metric', heat: '1', invert: '0', sound: '1', buildings: '1', clouds: '1' };
export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...load('settings', {}) };
  const mobile = matchMedia('(pointer:coarse)').matches;
  if (!load('settings', null) && mobile) s.quality = 'low';
  return s;
}
