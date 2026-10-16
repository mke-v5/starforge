-- top speed: take off, climb to ~2 km, then hold a shallow dive at full throttle
local S = require("./Sim")
local KEY = KEY or "kestrel"
local ALT = ALT or 10000
local DIVE = DIVE or -3
local ship, C, craft = S.setup(KEY)
C.input.throttle = 1
local t, best = 0, 0
for i = 1, 20 * 400 do
	local E = ship.env
	local p = 0
	if E.vSurf > 80 and E.agl < ALT and t < 160 then p = 0.4
	elseif t >= 160 or E.agl >= ALT then
		-- aim for a 3 degree dive above 500 m, level below
		local gammaT = if E.agl > 600 then DIVE else 0
		local gamma = math.deg(math.asin(math.clamp(E.vVert / math.max(1, E.vSurf), -1, 1)))
		p = math.clamp((gammaT - gamma) * 0.08, -0.6, 0.6)
	end
	C.input.pitch = p
	ship:step(1 / 20, C)
	t += 1 / 20
	S.events(ship, t)
	if t > 30 and E.mach > best then best = E.mach end
	if i % 400 == 0 then print(S.line(ship, t)) end
	if ship.dead then print("DEAD"); break end
end
print("best Mach", best)
