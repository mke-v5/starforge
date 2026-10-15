--!native
-- Shared constants and coordinate helpers (port of src/core/geo.js).
-- All distances are metres, angles radians unless noted.
-- Body-fixed axes: +Y = north pole, +X = (lat 0, lon 0), east at lon 0 = -Z.
-- The physics frame "I" is geocentric and inertial with the same +Y axis; Earth rotates about +Y.

local G = {}

G.D2R = math.pi / 180
G.R2D = 180 / math.pi
G.G0 = 9.80665

G.EARTH = { id = "earth", name = "Earth", R = 6371000, mu = 3.986004418e14, omega = 7.2921159e-5, atmoTop = 140000, soi = 9.245e8 }
G.MOON = { id = "moon", name = "Moon", R = 1737400, mu = 4.9048695e12, omega = 2 * math.pi / (27.321661 * 86400), atmoTop = 0, soi = 66100000 }
G.MARS = { id = "mars", name = "Mars", R = 3389500, mu = 4.282837e13, omega = 2 * math.pi / 88642.663, atmoTop = 125000, soi = 5.77e8 }
G.SUN = { id = "sun", name = "Sun", R = 6.957e8, mu = 1.32712440018e20, omega = 2 * math.pi / (25.38 * 86400), atmoTop = 0, soi = math.huge }
G.AU = 1.495978707e11
G.BODIES = { earth = G.EARTH, moon = G.MOON, mars = G.MARS, sun = G.SUN }

local function clamp(v, a, b) if v < a then return a elseif v > b then return b end return v end
G.clamp = clamp
function G.lerp(a, b, t) return a + (b - a) * t end
function G.smoothstep(a, b, x) local t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) end
-- JavaScript's % (sign follows the dividend)
G.jsmod = math.fmod
function G.hypot(a, b, c) c = c or 0; return math.sqrt(a * a + b * b + c * c) end
function G.isFinite(x) return x == x and x ~= math.huge and x ~= -math.huge end

local D2R, R2D = G.D2R, G.R2D

-- body-fixed position from latitude, longitude (degrees) and height
function G.llh(lat, lon, h, R, out)
	local p, l, r = lat * D2R, lon * D2R, R + h
	local c = math.cos(p)
	return out:set(r * c * math.cos(l), r * math.sin(p), -r * c * math.sin(l))
end
function G.toLLH(v, R)
	local r = math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
	return { lat = math.asin(clamp(v.y / r, -1, 1)) * R2D, lon = math.atan2(-v.z, v.x) * R2D, h = r - R }
end
-- local east/north/up unit vectors at a body-fixed position
function G.enu(pos, up, east, north)
	up:copy(pos):normalize()
	local lon = math.atan2(-pos.z, pos.x)
	east:set(-math.sin(lon), 0, -math.cos(lon))
	north:crossVectors(up, east):normalize()
end

function G.gcDist(lat1, lon1, lat2, lon2, R)
	R = R or G.EARTH.R
	local p1, p2, dl = lat1 * D2R, lat2 * D2R, (lon2 - lon1) * D2R
	local a = math.sin((p2 - p1) / 2) ^ 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ^ 2
	return 2 * R * math.asin(math.min(1, math.sqrt(a)))
end
function G.gcBearing(lat1, lon1, lat2, lon2)
	local p1, p2, dl = lat1 * D2R, lat2 * D2R, (lon2 - lon1) * D2R
	return math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))
end
function G.gcDest(lat, lon, brg, d, R)
	R = R or G.EARTH.R
	local p1, l1, a = lat * D2R, lon * D2R, d / R
	local p2 = math.asin(math.sin(p1) * math.cos(a) + math.cos(p1) * math.sin(a) * math.cos(brg))
	local l2 = l1 + math.atan2(math.sin(brg) * math.sin(a) * math.cos(p1), math.cos(a) - math.sin(p1) * math.sin(p2))
	return { lat = p2 * R2D, lon = math.fmod(l2 * R2D + 540, 360) - 180 }
end

function G.fmtDist(m)
	local a = math.abs(m)
	if a < 1000 then return string.format("%d m", math.round(m)) end
	if a < 100000 then return string.format("%.1f km", m / 1000) end
	return string.format("%d km", math.round(m / 1000))
end
function G.fmtSpeed(v)
	if math.abs(v) < 1000 then return string.format("%d m/s", math.round(v)) end
	return string.format("%.2f km/s", v / 1000)
end
function G.fmtTime(s)
	if not G.isFinite(s) then return "—" end
	s = math.max(0, s)
	local d = math.floor(s / 86400); s -= d * 86400
	local h = math.floor(s / 3600); s -= h * 3600
	local m = math.floor(s / 60); s = math.floor(s - m * 60)
	if d > 0 then return string.format("%dd %dh %dm", d, h, m) end
	if h > 0 then return string.format("%dh %02dm", h, m) end
	return string.format("%dm %02ds", m, s)
end

return G
