local S = require("./Sim")
local O = require("./Orbit")
local THREE = S.THREE
local Ctl = S.Control
local EARTH, MOON = S.Geo.EARTH, S.Geo.MOON
local ship, C, craft, eph = S.setup("selene", { noPlace = true, t = 845400000 })
local r = EARTH.R + 400000
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
	while ship.t - t0 < secs and i < 2e6 do
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
local tli = O.planMoonTransfer(ship, 100000)
print("TLI", string.format("dv %.0f in %.0f moonPe %.0f", tli.dv:length(), tli.t - ship.t, tli.moonPe / 1000))
C.node = tli; C:engage(Ctl.nodeExec(tli))
local function warpUntil(tt) for _, w in ipairs({ 1000, 100, 10 }) do run(math.max(0, tt - ship.t - w * 0.06), w, function() return tt - ship.t < w * 0.06 end) end end
warpUntil(tli.t - O.burnTime(ship, tli.dv:length()) / 2 - 40)
print("pre-burn", S.line(ship, t))
run(1200, 1, function() return not C.ap end)
print("post-burn", S.line(ship, t), "FU", string.format("%.0f", craft:amount("FU")))
local p = O.predict(ship.r, ship.v, ship.t, { maxT = 6 * 86400, oneRev = false })
print("predicted moon Pe km", string.format("%.0f", (p.closeMoon.d - MOON.R) / 1000))
local mcc = O.planCorrection(ship, MOON, 100000)
print("MCC", mcc and string.format("dv %.1f moonPe %.0f", mcc.dv:length(), mcc.moonPe / 1000))
if mcc then C.node = mcc; C:engage(Ctl.nodeExec(mcc)); if mcc.t - ship.t > 300 then warpUntil(mcc.t - 90) end; run(900, 1, function() return not C.ap end) end
p = O.predict(ship.r, ship.v, ship.t, { maxT = 6 * 86400, oneRev = false })
print("after MCC moon Pe km", string.format("%.0f", (p.closeMoon.d - MOON.R) / 1000))
run(4e6, 10000, function() return ship.env.body == MOON end)
print("in SOI", S.line(ship, t))
run(4e6, 1000, function() local rs = O.relState(ship, MOON); return rs.r:length() - MOON.R < 3e6 end)
local cap = O.planCapture(ship, 100000)
print("capture dv", string.format("%.0f in %.0f", cap.dv:length(), cap.t - ship.t))
C.node = cap; C:engage(Ctl.nodeExec(cap))
warpUntil(cap.t - O.burnTime(ship, cap.dv:length()) / 2 - 40)
run(1200, 1, function() return not C.ap end)
local rs = O.relState(ship, MOON)
local el = O.elements(rs.r, rs.v, MOON.mu)
print("lunar orbit Ap/Pe km", string.format("%.0f %.0f", (el.ap - MOON.R) / 1000, (el.pe - MOON.R) / 1000), "FU", string.format("%.0f", craft:amount("FU")))
setEng("lift")
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
