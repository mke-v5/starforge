-- Mars trip, end to end: Earth orbit -> injection -> correction -> capture -> landing (no autopilot sequence)
local S = require("./Sim")
local O = require("./Orbit")
local I = require("./Interplanetary")
local THREE = S.THREE
local Ctl = S.Control
local EARTH, MARS = S.Geo.EARTH, S.Geo.MARS
local KEY = KEY or "selene"
local ship, C, craft, eph = S.setup(KEY, { noPlace = true, t = 845400000 })
local r = EARTH.R + 300000
ship.r:set(r, 0, 0)
local vdir = THREE.Vector3.new(0, 1, 0):cross(ship.r):normalize()
ship.v:copy(vdir):multiplyScalar(math.sqrt(EARTH.mu / r))
ship.parked = nil; ship.ctl.gear = false
local function setEng(cls) for _, P in ipairs(craft.engines) do P.eng.active = (cls == nil) or O.engineClass(P) == cls end end
setEng("main")
local t = 0
local function run(secs, warp, stopFn)
	local dt = 1 / 20
	local t0 = ship.t
	local i = 0
	while ship.t - t0 < secs and i < 3e6 do
		eph:update(ship.t)
		ship.warp = warp
		if warp > 4 and (ship.thrustNow > 0 or C.input.throttle > 0 or ship.ctl.throttle > 0) then ship.warp = 1 end
		ship:step(dt, C)
		t += dt * ship.warp
		S.events(ship, t)
		if ship.dead then print("DEAD", S.line(ship, t)); os.exit(1) end
		if C.status ~= "" then print("  STATUS", C.status); C.status = "" end
		if stopFn and stopFn() then return true end
		i += 1
	end
	return false
end
local function warpUntil(tt) for _, w in ipairs({ 100000, 10000, 1000, 100, 10 }) do run(math.max(0, tt - ship.t - w * 0.06), w, function() return tt - ship.t < w * 0.06 end) end end
local function burn(node, label)
	print(label, string.format("dv %.1f in %.1f h", node.dv:length(), (node.t - ship.t) / 3600))
	C.node = node; C:engage(Ctl.nodeExec(node))
	warpUntil(node.t - O.burnTime(ship, node.dv:length()) / 2 - 40)
	run(4000, 1, function() return not C.ap end)
	print("  after", S.line(ship, t), "FU", string.format("%.0f", craft:amount("FU")))
end
local tmi = I.planMarsTransfer(ship)
burn(tmi, "TMI")
local p = O.predict(ship.r, ship.v, ship.t, { maxT = 500 * 86400, maxSteps = 20000, oneRev = false, noExtend = true, marsStop = -MARS.R * 0.9 })
print("predicted Mars pe km", string.format("%.0f", (p.closeMars.d - MARS.R) / 1000))
-- coast a few days, then correct
warpUntil(ship.t + 5 * 86400)
local mcc = I.planPlanetCorrection(ship, MARS, 300e3)
if mcc then burn(mcc, "MCC") end
p = O.predict(ship.r, ship.v, ship.t, { maxT = 500 * 86400, maxSteps = 20000, oneRev = false, noExtend = true, marsStop = -MARS.R * 0.9 })
print("after MCC Mars pe km", string.format("%.0f", (p.closeMars.d - MARS.R) / 1000), "arrive in days", string.format("%.0f", (p.closeMars.t - ship.t) / 86400))
-- second correction 20 days out
warpUntil(p.closeMars.t - 20 * 86400)
local mcc2 = I.planPlanetCorrection(ship, MARS, 300e3)
if mcc2 then burn(mcc2, "MCC2") end
run(4e6, 10000, function() return ship.env.body == MARS end)
print("in Mars SOI", S.line(ship, t))
run(4e6, 1000, function() local rs = O.relState(ship, MARS); return rs.r:length() - MARS.R < 3e6 end)
local cap = I.planOrbitCapture(ship, MARS)
burn(cap, "capture")
local rs = O.relState(ship, MARS)
local el = O.elements(rs.r, rs.v, MARS.mu)
print("Mars orbit Ap/Pe km", string.format("%.0f %.0f", (el.ap - MARS.R) / 1000, (el.pe - MARS.R) / 1000))
setEng(nil)
ship.ctl.gear = true
C:engage(Ctl.landAp())
local last = 0
for _ = 1, 400 do
	if not C.ap or ship.parked then break end
	local w = if C.ap.wakeAt and C.ap.wakeAt - ship.t > 200 then 100 else 1
	run(if w > 1 then math.min(C.ap.wakeAt - ship.t - 100, 2000) else 30, w, function()
		if ship.t - last > 30 then last = ship.t; print("  land", C.apStatus, S.line(ship, t)) end
		return not C.ap or ship.parked
	end)
end
print("FINAL", S.line(ship, t), "parked", ship.parked ~= nil, "FU", string.format("%.0f", craft:amount("FU")))
