-- Starhopper: land on the Moon from a 60 km circular lunar orbit with ~30% fuel
local S = require("./Sim")
local THREE = S.THREE
local Ctl = S.Control
local MOON = S.Geo.MOON
local KEY = KEY or "starhopper"
local ship, C, craft, eph = S.setup(KEY, { noPlace = true, t = 845400000 })
eph:update(ship.t)
local c = ship:bodyCenter(MOON, ship.t, THREE.Vector3.new())
local cv = ship:bodyVel(MOON, ship.t, THREE.Vector3.new())
local r = MOON.R + 60000
ship.r:copy(c):add(THREE.Vector3.new(r, 0, 0))
ship.v:copy(cv):add(THREE.Vector3.new(0, 0, -math.sqrt(MOON.mu / r)))
ship.parked = nil; ship.ctl.gear = false
local cap = craft:capacity("FU")
craft:draw("FU", cap * (FUELDRAIN or 0.7))
ship:updateEnv(ship.t)
print("start", S.line(ship, 0))
C:engage(Ctl.landAp())
local t, last = 0, 0
for i = 1, 400000 do
	eph:update(ship.t)
	local w = 1
	if C.ap and C.ap.wakeAt and C.ap.wakeAt - ship.t > 120 then w = 100 elseif C.ap and C.ap.wakeAt and C.ap.wakeAt - ship.t > 20 then w = 10 end
	if ship.thrustNow > 0 or ship.ctl.throttle > 0 then w = 1 end
	ship.warp = w
	ship:step(1 / 20, C)
	t += w / 20
	S.events(ship, t)
	if C.status ~= "" then print("  STATUS", C.status); C.status = "" end
	if ship.t - last > (if ship.env.agl < 2000 then 4 else 20) and ship.env.agl < 20000 then last = ship.t; print(" ", C.apStatus, S.line(ship, t), "ctlThr", string.format("%.3f", ship.ctl.throttle), C.engGroup) end
	if ship.dead or ship.parked then break end
	if not C.ap and ship.env.agl < 30 and ship.env.vSurf < 1 then break end
end
print("FINAL", S.line(ship, t), "dead", ship.dead, "parked", ship.parked ~= nil)
