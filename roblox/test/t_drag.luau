local S = require("./Sim")
local THREE = S.THREE
local Atmo = require("./Atmo")
local KEY = KEY or "kestrel"
local ship, C, craft = S.setup(KEY)
local h = 8000
local at = Atmo.atmosphere(h)
for _, M in ipairs({ 0.6, 0.8, 0.9, 0.95, 1.0, 1.05, 1.2, 1.5, 2.0 }) do
	local V = M * at.a
	local env = { rho = at.rho, mach = M, T = at.T, p = at.p, h = h, a = at.a, body = S.Geo.EARTH }
	-- body frame: nose along -z, small angle of attack (air coming from ahead, slightly from below)
	local alpha = math.rad(1.5)
	local vAir = THREE.Vector3.new(0, -math.sin(alpha) * V, -math.cos(alpha) * V)
	local F, Tq = THREE.Vector3.new(), THREE.Vector3.new()
	craft:aero(vAir, THREE.Vector3.new(), env, F, Tq)
	local Tmax = 0
	for _, P in ipairs(craft.engines) do P.eng.mode = P.eng.mode or "jet"; Tmax += (craft:engineOutput(P, env)) end
	print(string.format("M=%.2f drag=%6.1f kN lift=%6.1f kN thrust=%6.1f kN weight=%.1f kN", M, F.z / 1000, F.y / 1000, Tmax / 1000, craft.mass * 9.81 / 1000))
end
