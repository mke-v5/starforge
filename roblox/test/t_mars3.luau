-- Mars trip with the same autopilot sequence the game uses, and game-like automatic time warp
local S = require("./Sim")
local O = require("./Orbit")
local I = require("./Interplanetary")
local THREE = S.THREE
local Ctl = S.Control
local EARTH, MARS, SUN = S.Geo.EARTH, S.Geo.MARS, S.Geo.SUN
local ship, C, craft, eph = S.setup("selene", { noPlace = true, t = 845400000 })
local r = EARTH.R + 300000
ship.r:set(r, 0, 0)
ship.v:copy(THREE.Vector3.new(0, 1, 0):cross(ship.r):normalize()):multiplyScalar(math.sqrt(EARTH.mu / r))
ship.parked = nil; ship.ctl.gear = false
local DAY = 86400
local BURNWARP = BURNWARP or 1
local function cruiseWake(s)
	local p = O.predict(s.r, s.v, s.t, { maxT = 500 * DAY, maxSteps = 20000, oneRev = false, noExtend = true, marsStop = -MARS.R * 0.9 })
	return p.closeMars.t
end
local steps = {
	function() return Ctl.planBurnAp("Mars injection", function(s) return I.planMarsTransfer(s) end) end,
	function() return Ctl.waitAp("Leaving Earth", function(s) return s.env.body ~= EARTH end, function(s) return s.t + 6 * 3600 end) end,
	function() return Ctl.planBurnAp("Course correction", function(s) return I.planPlanetCorrection(s, MARS, 300e3) end, true) end,
	function() return Ctl.waitAp("Cruise to Mars", function(s) local ta = cruiseWake(s); return ta - s.t < 20 * DAY or s.env.body == MARS end, function(s) return cruiseWake(s) - 20 * DAY end) end,
	function() return Ctl.planBurnAp("Final correction", function(s) return I.planPlanetCorrection(s, MARS, 300e3) end, true) end,
	function() return Ctl.waitAp("Arriving at Mars", function(s) return s.env.body == MARS end, function(s)
		local p = O.predict(s.r, s.v, s.t, { maxT = 30 * DAY, maxSteps = 6000, oneRev = false, noExtend = true, marsStop = -MARS.R * 0.9 })
		return if p.marsIn then p.marsIn + 30 else s.t + DAY end) end,
	function() return Ctl.planBurnAp("Mars orbit capture", function(s) return I.planOrbitCapture(s, MARS) end) end,
}
C:engage(Ctl.sequenceAp("Trip to Mars", steps))
local levels = { 1, 2, 4, 10, 50, 100, 1000, 10000, 100000, 1000000 }
local dt, t, last, frames = 1 / 20, 0, -1e9, 0
local function canWarp(lv)
	local E = ship.env
	if lv <= 4 then return true end
	if ship.thrustNow > 0 or ship.ctl.throttle > 0 then return false end
	if E.body.atmoTop > 0 and E.h < E.body.atmoTop + 2000 then return false end
	if E.agl < 10000 then return false end
	if lv > 100000 and E.body ~= SUN then return false end
	return true
end
local lastName = ""
while C.ap and frames < 3e6 do
	eph:update(ship.t)
	local want = 1
	if C.ap.wakeAt then
		local left = C.ap.wakeAt - ship.t
		for _, lv in ipairs(levels) do if lv * dt * 3 < left and canWarp(lv) then want = lv end end
		if left <= 30 then want = 1 end
	end
	if want == 1 and C.ap and not C.ap.wakeAt and ship.thrustNow > 0 and ship.env.rho < 1e-6 and ship.env.agl > 20000 then want = BURNWARP or 1 end
	ship.warp = want
	ship:step(dt, C)
	frames += 1
	S.events(ship, t)
	if ship.dead then print("DEAD", S.line(ship, ship.t)); break end
	if C.status ~= "" then print(string.format("  [day %.1f] STATUS %s", (ship.t - 845400000) / DAY, C.status)); C.status = "" end
	local nm = C.apStatus
	if ship.t - last > 20 * DAY then last = ship.t; print(string.format("[day %.1f frames %d] %s warp %d %s", (ship.t - 845400000) / DAY, frames, C.apStatus, want, S.line(ship, 0))) end
end
local rs = O.relState(ship, MARS)
local el = O.elements(rs.r, rs.v, MARS.mu)
print(string.format("END day %.1f frames %d body %s  Mars Ap/Pe %.0f/%.0f km  FU %.0f", (ship.t - 845400000) / DAY, frames, ship.env.body.name, (el.ap - MARS.R) / 1000, (el.pe - MARS.R) / 1000, craft:amount("FU")))
