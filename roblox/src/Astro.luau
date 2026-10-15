--!native
-- Sun, Moon and planet positions and body orientations (port of src/core/astro.js).
-- Simulation time t = seconds since J2000.0 (2000-01-01 12:00, treated as UTC).
-- Frame I: geocentric, +Y = Earth's north pole, +X = vernal equinox, RA increases toward -Z.

local THREE = require(script.Parent.Three)
local Geo = require(script.Parent.Geo)
local V3, Quat, M4 = THREE.Vector3.new, THREE.Quaternion.new, THREE.Matrix4.new
local D2R, EARTH, MOON, MARS, SUN, AU = Geo.D2R, Geo.EARTH, Geo.MOON, Geo.MARS, Geo.SUN, Geo.AU
local fmod = math.fmod

local S = {}
S.noSun = false

local J2000_UNIX = 946728000   -- 2000-01-01 12:00:00 UTC
function S.nowSimTime()
	local ok, dt = pcall(function() return DateTime.now().UnixTimestampMillis / 1000 end)
	return (if ok then dt else os.time()) - J2000_UNIX
end

local function sinD(x) return math.sin(x * D2R) end
local function cosD(x) return math.cos(x * D2R) end

-- equatorial (x toward equinox, y toward RA 90, z north) -> frame I
local function eqToI(x, y, z, out) return out:set(x, z, -y) end

local function eclToI(lonDeg, latDeg, dist, epsDeg, out)
	local cb = cosD(latDeg)
	local x, y, z = cb * cosD(lonDeg), cb * sinD(lonDeg), sinD(latDeg)
	local ce, se = cosD(epsDeg), sinD(epsDeg)
	return eqToI(x * dist, (y * ce - z * se) * dist, (y * se + z * ce) * dist, out)
end

function S.obliquity(t) return 23.439 - 0.00000036 * (t / 86400) end

-- Greenwich mean sidereal time as an angle (rad): the Earth rotation angle about +Y
function S.earthAngle(t)
	local d = t / 86400
	return fmod(280.46061837 + 360.98564736629 * d, 360) * D2R
end

function S.sunDir(t, out)
	local d = t / 86400
	local g = 357.529 + 0.98560028 * d
	local q = 280.459 + 0.98564736 * d
	local L = q + 1.915 * sinD(g) + 0.020 * sinD(2 * g)
	eclToI(L, 0, 1, S.obliquity(t), out)
	return out:normalize()
end

-- Moon centre in frame I (metres)
function S.moonPos(t, out)
	local d = t / 86400
	local Lp = 218.316 + 13.176396 * d
	local M = 134.963 + 13.064993 * d
	local F = 93.272 + 13.229350 * d
	local D = 297.850 + 12.190749 * d
	local Ms = 357.529 + 0.98560028 * d
	local lon = Lp + 6.289 * sinD(M) + 1.274 * sinD(2 * D - M) + 0.658 * sinD(2 * D) + 0.214 * sinD(2 * M)
		- 0.186 * sinD(Ms) - 0.114 * sinD(2 * F)
	local lat = 5.128 * sinD(F) + 0.281 * sinD(M + F) + 0.278 * sinD(M - F) + 0.173 * sinD(2 * D - F)
	local km = 385001 - 20905 * cosD(M) - 3699 * cosD(2 * D - M) - 2956 * cosD(2 * D) - 570 * cosD(2 * M)
	return eclToI(lon, lat, km * 1000, S.obliquity(t), out)
end

-- JPL approximate Keplerian elements (Standish, valid 1800–2050): [a au, e, I°, L°, ϖ°, Ω°] and rates per century
local ELEMENTS = {
	earth = { { 1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0 }, { 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0 } },
	mars = { { 1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891 }, { 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343 } },
	venus = { { 0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255 }, { 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418 } },
	jupiter = { { 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909 }, { -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106 } },
}
local EPS0 = 23.43928 * D2R
local CE, SE = math.cos(EPS0), math.sin(EPS0)
local function eclJ2000ToI(xe, ye, ze, T, out)
	local pA = 1.396971 * T * D2R
	local cp, sp = math.cos(pA), math.sin(pA)
	local x, y = xe * cp - ye * sp, xe * sp + ye * cp
	local eps = (23.43928 - 0.0130042 * T) * D2R
	local ce, se = math.cos(eps), math.sin(eps)
	return eqToI(x, y * ce - ze * se, y * se + ze * ce, out)
end
local function eqJ2000ToI(x, y, z, T, out) return eclJ2000ToI(x, y * CE + z * SE, -y * SE + z * CE, T, out) end

-- heliocentric position (m) of a planet ("earth" = Earth–Moon barycentre) in frame I axes
function S.helio(key, t, out)
	local el = ELEMENTS[key]
	local e0, r = el[1], el[2]
	local T = t / (86400 * 36525)
	local a = (e0[1] + r[1] * T) * AU
	local e = e0[2] + r[2] * T
	local I = (e0[3] + r[3] * T) * D2R
	local L = e0[4] + r[4] * T
	local w = e0[5] + r[5] * T
	local W = (e0[6] + r[6] * T) * D2R
	local om = w * D2R - W
	local M = fmod(L - w, 360) * D2R
	if M > math.pi then M -= 2 * math.pi elseif M < -math.pi then M += 2 * math.pi end
	local E = M + e * math.sin(M)
	for _ = 1, 12 do
		local dE = (M - (E - e * math.sin(E))) / (1 - e * math.cos(E))
		E += dE
		if math.abs(dE) < 1e-15 then break end
	end
	local xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
	local co, so, cW, sW, cI, sI = math.cos(om), math.sin(om), math.cos(W), math.sin(W), math.cos(I), math.sin(I)
	local xe = (co * cW - so * sW * cI) * xp + (-so * cW - co * sW * cI) * yp
	local ye = (co * sW + so * cW * cI) * xp + (-so * sW + co * cW * cI) * yp
	local ze = (so * sI) * xp + (co * sI) * yp
	return eclJ2000ToI(xe, ye, ze, T, out)
end

local _h1, _h2, _h3 = V3(), V3(), V3()
function S.sunPos(t, out) return S.helio("earth", t, out):negate() end
function S.marsPos(t, out) S.helio("earth", t, _h3); return S.helio("mars", t, out):sub(_h3) end
local _v1, _v2 = V3(), V3()
function S.marsVel(t, out) S.marsPos(t + 30, _v1); S.marsPos(t - 30, _v2); return out:subVectors(_v1, _v2):divideScalar(60) end
function S.sunVel(t, out) S.sunPos(t + 30, _v1); S.sunPos(t - 30, _v2); return out:subVectors(_v1, _v2):divideScalar(60) end
function S.planetPos(key, t, out) S.helio("earth", t, _h3); return S.helio(key, t, out):sub(_h3) end

-- Orientation of Mars' body-fixed frame in I (IAU pole and prime meridian): X (lon 0), Y (north), Z
function S.marsBasis(t, outX, outY, outZ)
	local d = t / 86400
	local T = d / 36525
	local ra, dec = (317.68143 - 0.1061 * T) * D2R, (52.88650 - 0.0609 * T) * D2R
	local Wm = fmod(176.630 + 350.89198226 * d, 360) * D2R
	local cd = math.cos(dec)
	eqJ2000ToI(cd * math.cos(ra), cd * math.sin(ra), math.sin(dec), T, outY)
	eqJ2000ToI(-math.sin(ra), math.cos(ra), 0, T, _h1)
	_h2:crossVectors(outY, _h1)
	outX:copy(_h1):multiplyScalar(math.cos(Wm)):addScaledVector(_h2, math.sin(Wm)):normalize()
	outZ:crossVectors(outX, outY):normalize()
end

local _a, _b = V3(), V3()
function S.moonVel(t, out)
	S.moonPos(t + 5, _a); S.moonPos(t - 5, _b)
	return out:subVectors(_a, _b):multiplyScalar(0.1)
end

-- Moon body-fixed frame in I (tidally locked: lon 0 faces the Earth)
function S.moonBasis(t, mpos, outX, outY, outZ)
	local e = S.obliquity(t) * D2R
	outY:set(0, math.cos(e), math.sin(e))
	outX:copy(mpos):multiplyScalar(-1):normalize()
	outX:addScaledVector(outY, -outX:dot(outY)):normalize()
	outZ:crossVectors(outX, outY):normalize()
end

local _QI = Quat()
local _Y = V3(0, 1, 0)

-- A snapshot of all bodies at time t, reused by physics and rendering.
local Ephemeris = {}
Ephemeris.__index = Ephemeris
S.Ephemeris = Ephemeris
function Ephemeris.new()
	local self = setmetatable({}, Ephemeris)
	self.t = 0
	self.earthAngle = 0
	self.earthQ = Quat(); self.earthQInv = Quat()
	self.sun = V3(1, 0, 0)
	self.moon = V3(); self.moonV = V3()
	self.mX = V3(); self.mY = V3(); self.mZ = V3()
	self.moonQ = Quat(); self.moonQInv = Quat()
	self.sunP = V3(); self.sunV = V3()
	self.mars = V3(); self.marsV = V3()
	self.aX = V3(); self.aY = V3(); self.aZ = V3()
	self.marsQ = Quat(); self.marsQInv = Quat()
	self._m = M4()
	return self
end
function Ephemeris:update(t)
	self.t = t
	self.earthAngle = S.earthAngle(t)
	self.earthQ:setFromAxisAngle(_Y, self.earthAngle)
	self.earthQInv:copy(self.earthQ):invert()
	S.sunPos(t, self.sunP); S.sunVel(t, self.sunV)
	self.sun:copy(self.sunP):normalize()
	S.marsPos(t, self.mars); S.marsVel(t, self.marsV)
	S.marsBasis(t, self.aX, self.aY, self.aZ)
	self._m:makeBasis(self.aX, self.aY, self.aZ)
	self.marsQ:setFromRotationMatrix(self._m)
	self.marsQInv:copy(self.marsQ):invert()
	S.moonPos(t, self.moon)
	S.moonVel(t, self.moonV)
	S.moonBasis(t, self.moon, self.mX, self.mY, self.mZ)
	self._m:makeBasis(self.mX, self.mY, self.mZ)
	self.moonQ:setFromRotationMatrix(self._m)
	self.moonQInv:copy(self.moonQ):invert()
	return self
end
function Ephemeris:quat(body)
	if body == EARTH then return self.earthQ elseif body == MARS then return self.marsQ elseif body == SUN then return _QI end
	return self.moonQ
end
function Ephemeris:quatInv(body)
	if body == EARTH then return self.earthQInv elseif body == MARS then return self.marsQInv elseif body == SUN then return _QI end
	return self.moonQInv
end
function Ephemeris:toI(body, vFixed, out)
	if body == EARTH then return out:copy(vFixed):applyQuaternion(self.earthQ) end
	return out:copy(vFixed):applyQuaternion(self:quat(body)):add(self:bodyCenter(body, _b))
end
function Ephemeris:toFixed(body, vI, out)
	if body == EARTH then return out:copy(vI):applyQuaternion(self.earthQInv) end
	return out:copy(vI):sub(self:bodyCenter(body, _b)):applyQuaternion(self:quatInv(body))
end
function Ephemeris:surfaceVel(body, pI, out)
	if body == EARTH then return out:set(EARTH.omega * pI.z, 0, -EARTH.omega * pI.x) end
	if body == SUN then return out:copy(self.sunV) end
	local m = body == MARS
	_a:copy(pI):sub(if m then self.mars else self.moon)
	out:crossVectors(if m then self.aY else self.mY, _a):multiplyScalar(body.omega)
	return out:add(if m then self.marsV else self.moonV)
end
function Ephemeris:bodyCenter(body, out)
	if body == EARTH then return out:set(0, 0, 0) elseif body == MARS then return out:copy(self.mars) elseif body == SUN then return out:copy(self.sunP) end
	return out:copy(self.moon)
end
function Ephemeris:bodyVel(body, out)
	if body == EARTH then return out:set(0, 0, 0) elseif body == MARS then return out:copy(self.marsV) elseif body == SUN then return out:copy(self.sunV) end
	return out:copy(self.moonV)
end
function Ephemeris:axis(body)
	if body == EARTH or body == SUN then return _Y elseif body == MARS then return self.aY end
	return self.mY
end

-- positions of the Moon, Sun and Mars at time t, cached for the last few times asked (RK4 repeats instants)
local _cache = {}
function S.bodiesAt(t)
	for _, c in ipairs(_cache) do if c.t == t then return c end end
	local c
	if #_cache < 6 then c = { t = t, moon = V3(), sun = V3(), mars = V3() } else c = table.remove(_cache, 1) end
	c.t = t; S.moonPos(t, c.moon); S.sunPos(t, c.sun); S.marsPos(t, c.mars)
	table.insert(_cache, c)
	return c
end
local _ga = { x = 0, y = 0, z = 0 }
local function tidal(p, c, mu, o)
	local dx, dy, dz = c.x - p.x, c.y - p.y, c.z - p.z
	local d2 = dx * dx + dy * dy + dz * dz
	local d = math.sqrt(d2)
	local k = mu / (d2 * d)
	local c2 = c.x * c.x + c.y * c.y + c.z * c.z
	local cr = math.sqrt(c2)
	local kc = mu / (c2 * cr)
	o.x += dx * k - c.x * kc; o.y += dy * k - c.y * kc; o.z += dz * k - c.z * kc
end
-- gravity at I-frame position p and time t: the Earth plus the Moon, Sun and Mars (with indirect terms)
function S.gravity(p, t, out)
	local B = S.bodiesAt(t)
	local r2 = p.x * p.x + p.y * p.y + p.z * p.z
	local r = math.sqrt(r2)
	local k = -EARTH.mu / (r2 * r)
	_ga.x = p.x * k; _ga.y = p.y * k; _ga.z = p.z * k
	tidal(p, B.moon, MOON.mu, _ga)
	if not S.noSun then tidal(p, B.sun, SUN.mu, _ga) end
	tidal(p, B.mars, MARS.mu, _ga)
	return out:set(_ga.x, _ga.y, _ga.z)
end

return S
