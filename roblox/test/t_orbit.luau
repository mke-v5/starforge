local S = require("./Sim")
local Orbit = require("./Orbit")
local key = "starhopper"
local ship, C, craft = S.setup(key)
ship.parked = nil
C:engage(S.Control.ascentAp(120000))
local t, dt = 0, 1 / 30
local EARTH = S.Geo.EARTH
for i = 0, 30 * 1500 - 1 do
	ship:step(dt, C)
	S.events(ship, t)
	if ship.dead then print("DEAD", S.line(ship, t)); break end
	if C.status ~= "" then print("  STATUS", C.status); C.status = "" end
	if i % 600 == 0 then
		local el = Orbit.elements(ship.r, ship.v, EARTH.mu)
		print(S.line(ship, t), "ap", string.format("%.0f", (el.ap - EARTH.R) / 1000), "pe", string.format("%.0f", (el.pe - EARTH.R) / 1000), "ap?", C.ap and C.ap.name)
	end
	if not C.ap and t > 30 then
		local el = Orbit.elements(ship.r, ship.v, EARTH.mu)
		print("AP done", S.line(ship, t), "ap", string.format("%.0f", (el.ap - EARTH.R) / 1000), "pe", string.format("%.0f", (el.pe - EARTH.R) / 1000))
		break
	end
	if C.ap and C.ap.name == "Burn" and C.node and C.node.t - ship.t > 120 and ship.env.h > 141000 then ship.warp = 50 elseif ship.warp > 1 then ship.warp = 1 end
	t += dt
end
