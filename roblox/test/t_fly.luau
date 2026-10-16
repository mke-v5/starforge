-- takeoff and climb with simple stick inputs: full throttle, pull up at 80 m/s, level out
local S = require("./Sim")
local KEY = KEY or "kestrel"
local ship, C, craft = S.setup(KEY)
print("mass", math.round(craft.mass), "engines", #craft.engines, "wings", #craft.wings)
C.input.throttle = 1
local t = 0
for i = 1, 20 * 90 do
	local E = ship.env
	C.input.pitch = if E.vSurf and E.vSurf > 80 and t < 60 and E.agl < 1500 then 0.5 else 0
	ship:step(1 / 20, C)
	t += 1 / 20
	S.events(ship, t)
	if i % 200 == 0 then print(S.line(ship, t)) end
	if ship.dead then print("DEAD"); break end
end
