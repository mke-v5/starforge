-- From a 300 km Mars orbit back to Earth orbit with the game's sequence
local S = require("./Sim")
local O = require("./Orbit")
local I = require("./Interplanetary")
local THREE = S.THREE
local Ctl = S.Control
local EARTH, MARS, SUN = S.Geo.EARTH, S.Geo.MARS, S.Geo.SUN
local ship, C, craft, eph = S.setup("selene", { noPlace = true, t = 845400000 + 342 * 86400 })
eph:update(ship.t)
local cen, cv = ship:bodyCenter(MARS, ship.t, THREE.Vector3.new()), ship:bodyVel(MARS, ship.t, THREE.Vector3.new())
local ax = eph:axis(MARS)
local radial = THREE.Vector3.new(1, 0, 0):cross(ax):normalize()
local rr = MARS.R + 300000
ship.r:copy(cen):addScaledVector(radial, rr)
ship.v:copy(cv):addScaledVector(THREE.Vector3.new():crossVectors(ax, radial):normalize(), math.sqrt(MARS.mu / rr))
ship.parked = nil; ship.ctl.gear = false
craft:draw("FU", craft:capacity("FU") * 0.3)
ship:updateEnv(ship.t)
print("start", S.line(ship, 0), "body", ship.env.body.name)
local DAY = 86400
local cacheT, cacheV = -1e18, 0
local function earthWake(s)
	if math.abs(s.t - cacheT) < 3600 then return cacheV end
	local p = O.predict(s.r, s.v, s.t, { maxT = 500 * DAY, maxSteps = 20000, oneRev = false, noExtend = true, earthStop = -EARTH.R * 0.9 })
	cacheT, cacheV = s.t, p.earthPe.t
	return cacheV
end
local steps = {
	function() return Ctl.planBurnAp("Earth injection", function(s) return I.planEarthReturnFromMars(s) end) end,
	function() return Ctl.waitAp("Leaving Mars", function(s) return s.env.body ~= MARS end, function(s)
		local p = O.predict(s.r, s.v, s.t, { maxT = 30 * DAY, maxSteps = 6000, oneRev = false, noExtend = true })
		return if p.marsOut then p.marsOut + 60 else s.t + DAY end) end,
	function() return Ctl.planBurnAp("Course correction", function(s) return I.planPlanetCorrection(s, EARTH, 300e3) end, true) end,
	function() return Ctl.waitAp("Cruise to Earth", function(s) return earthWake(s) - s.t < 10 * DAY or s.env.body == EARTH end, function(s) return earthWake(s) - 10 * DAY end) end,
	function() return Ctl.planBurnAp("Final correction", function(s) return I.planPlanetCorrection(s, EARTH, 300e3) end, true) end,
	function() return Ctl.waitAp("Arriving at Earth", function(s) return s.env.body == EARTH end, function(s)
		local p = O.predict(s.r, s.v, s.t, { maxT = 15 * DAY, maxSteps = 6000, oneRev = false, noExtend = true })
		return if p.earthBack then p.earthBack + 30 else s.t + 6 * 3600 end) end,
	function() return Ctl.planBurnAp("Earth orbit capture", function(s) return I.planOrbitCapture(s, EARTH) end) end,
}
C:engage(Ctl.sequenceAp("Trip home", steps))
local levels = { 1, 2, 4, 10, 50, 100, 1000, 10000, 100000, 1000000 }
local dt, frames, last = 1 / 20, 0, -1e18
local t0 = ship.t
local function canWarp(lv)
	local E = ship.env
	if lv <= 4 then return true end
	if ship.thrustNow > 0 or ship.ctl.throttle > 0 then return lv <= 10 and E.rho < 1e-6 and E.agl > 20000 end
	if E.body.atmoTop > 0 and E.h < E.body.atmoTop + 2000 then return false end
	if E.agl < 10000 then return false end
	if lv > 100000 and E.body ~= SUN then return false end
	return true
end
while C.ap and frames < 3e6 do
	eph:update(ship.t)
	local want = 1
	if C.ap.wakeAt then
		local left = C.ap.wakeAt - ship.t
		for _, lv in ipairs(levels) do if lv * dt * 3 < left and canWarp(lv) then want = lv end end
	elseif ship.thrustNow > 0 and canWarp(10) then want = 10 end
	ship.warp = want
	ship:step(dt, C)
	frames += 1
	S.events(ship, 0)
	if ship.dead then print("DEAD", S.line(ship, 0)); break end
	if C.status ~= "" then print(string.format("  [day %.1f] STATUS %s", (ship.t - t0) / DAY, C.status)); C.status = "" end
	if ship.t - last > 30 * DAY then last = ship.t; print(string.format("[day %.1f] %s %s", (ship.t - t0) / DAY, C.apStatus, S.line(ship, 0))) end
end
local rs = O.relState(ship, EARTH)
local el = O.elements(rs.r, rs.v, EARTH.mu)
print(string.format("END day %.1f frames %d body %s Earth Ap/Pe %.0f/%.0f km FU %.0f", (ship.t - t0) / DAY, frames, ship.env.body.name, (el.ap - EARTH.R) / 1000, (el.pe - EARTH.R) / 1000, craft:amount("FU")))
