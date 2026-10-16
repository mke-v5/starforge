-- Starhopper hop: straight up for BURN seconds, then the land autopilot brings it back down
local S = require("./Sim")
local Ctl = S.Control
local BURN = BURN or 30
local ship, C, craft, eph = S.setup("starhopper", { lat = 28.61, lon = -80.69 })
C.input.throttle = 1
local t, last, engaged = 0, 0, false
for i = 1, 20 * 1200 do
	eph:update(ship.t)
	if t > BURN and not engaged then C.input.throttle = 0 end
	if t > BURN and not engaged and ship.env.vVert < 50 then engaged = true; C:engage(Ctl.landAp()); print("engage", S.line(ship, t)) end
	ship:step(1 / 20, C)
	t += 1 / 20
	S.events(ship, t)
	if C.status ~= "" then print("  STATUS", C.status); C.status = "" end
	if t - last > 15 then last = t; print(" ", C.apStatus, S.line(ship, t)) end
	if ship.dead or (engaged and not C.ap) then break end
end
print("FINAL", S.line(ship, t), "dead", ship.dead)
