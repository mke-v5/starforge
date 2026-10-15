-- Part catalogue (port of src/ship/parts.js). The numbers live in PartsData (generated from the web game);
-- this module adds lookups and wing reshaping.
-- Part-local axes: +Y = forward / stack axis, +Z = top, +X = right. Engines push along local +Y.

local Data = require(script.Parent.PartsData)

local P = {}
P.SIZES = Data.SIZES
P.RES = Data.RES
P.CATS = Data.CATS
P.WING_LIMITS = Data.WING_LIMITS
P.PARTS = Data.PARTS
P.PART = {}
for _, p in ipairs(P.PARTS) do P.PART[p.id] = p end

local function shallow(t) local o = {}; for k, v in pairs(t) do o[k] = v end; return o end

-- wing planform -> area, aspect ratio, mean aerodynamic chord and aerodynamic centre
local function deriveWing(w)
	w.area = w.span * (w.root + w.tip) / 2
	w.ar = (2 * w.span * w.span) / w.area
	local lam = w.tip / w.root
	local mac = (2 / 3) * w.root * (1 + lam + lam * lam) / (1 + lam)
	local yMac = (w.span / 3) * (1 + 2 * lam) / (1 + lam)
	local leY = -math.tan(w.sweep) * yMac
	w.ac = { yMac, leY - 0.25 * mac + w.root * 0.5, 0 }
	w.mac = mac
end
P.deriveWing = deriveWing

local _variants = {}
-- reshaped copy of a wing part: o = { span, root, tip, sweep }
function P.variantDef(def, o)
	if not def.wing or not o then return def end
	local L = P.WING_LIMITS
	local function c(v, k, d)
		if type(v) ~= "number" or v ~= v then v = d end
		return math.min(L[k][2], math.max(L[k][1], v))
	end
	local w0 = def.wing
	local span = c(o.span, "span", w0.span)
	local root = c(o.root, "root", w0.root)
	local tip = math.min(root * 1.5, c(o.tip, "tip", w0.tip))
	local sweep = c(o.sweep, "sweep", w0.sweep)
	local key = string.format("%s|%.2f|%.2f|%.2f|%.3f", def.id, span, root, tip, sweep)
	local v = _variants[key]
	if v then return v end
	local w = shallow(w0)
	w.span = span; w.root = root; w.tip = tip; w.sweep = sweep
	w.thick = w0.thick * math.sqrt(root / w0.root)
	deriveWing(w)
	local k = (w.area / w0.area) * math.pow(span / w0.span, 0.3) / math.pow(w.area / w0.area, 0.15)
	v = shallow(def)
	v.wing = w
	v.mass = math.round(def.mass * k)
	v.com = { w.ac[1], w.ac[2], 0 }
	v.shaped = true
	if def.res then
		v.res = {}
		for r, a in pairs(def.res) do v.res[r] = math.round(a * w.area / w0.area) end
	end
	_variants[key] = v
	return v
end

return P
