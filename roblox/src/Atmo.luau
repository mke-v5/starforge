--!native
-- Air models (port of src/core/atmo.js): U.S. Standard Atmosphere 1976 to 86 km with an exponential
-- thermosphere tail to 140 km for Earth; NASA Glenn's simple CO2 model for Mars.

local A = {}

local LAYERS = {
	-- base geopotential alt (m), base T (K), lapse (K/m), base P (Pa)
	{ 0, 288.15, -0.0065, 101325 },
	{ 11000, 216.65, 0, 22632.06 },
	{ 20000, 216.65, 0.001, 5474.889 },
	{ 32000, 228.65, 0.0028, 868.0187 },
	{ 47000, 270.65, 0, 110.9063 },
	{ 51000, 270.65, -0.0028, 66.93887 },
	{ 71000, 214.65, -0.002, 3.956420 },
	{ 84852, 186.946, 0, 0.3734 },
}
local Rgas, g0, RE = 287.053, 9.80665, 6356766
A.RHO0 = 1.225
A.noMarsAir = false

local out = { rho = 0, T = 288.15, p = 101325, a = 340.3 }

function A.atmosphere(h)
	if h > 140000 then out.rho = 0; out.p = 0; out.T = 1000; out.a = 300; return out end
	if h < -500 then h = -500 end
	if h <= 86000 then
		local H = (RE * h) / (RE + h)
		local L = LAYERS[1]
		for i = #LAYERS, 1, -1 do if H >= LAYERS[i][1] then L = LAYERS[i]; break end end
		local Hb, Tb, lap, Pb = L[1], L[2], L[3], L[4]
		local dH = H - Hb
		local T, p
		if lap == 0 then T = Tb; p = Pb * math.exp(-g0 * dH / (Rgas * Tb))
		else T = Tb + lap * dH; p = Pb * math.pow(Tb / T, g0 / (Rgas * lap)) end
		out.T = T; out.p = p; out.rho = p / (Rgas * T)
	else
		local rho
		if h < 100000 then rho = 6.96e-6 * math.exp(-(h - 86000) / 5560)
		elseif h < 120000 then rho = 5.6e-7 * math.exp(-(h - 100000) / 6200)
		else rho = 2.2e-8 * math.exp(-(h - 120000) / 11400) end
		out.T = 186.9 + (h - 86000) * 0.012
		out.rho = rho * math.min(1, (140000 - h) / 4000 + 0.0001)
		out.p = out.rho * Rgas * out.T
	end
	out.a = math.sqrt(1.4 * Rgas * out.T)
	return out
end

local outM = { rho = 0, T = 210, p = 610, a = 240 }
function A.marsAtmosphere(h)
	if h > 125000 or A.noMarsAir then outM.rho = 0; outM.p = 0; outM.T = 150; outM.a = 220; return outM end
	local hh = math.max(-9000, h)
	local Tc = if hh < 7000 then -31 - 0.000998 * hh else -23.4 - 0.00222 * hh
	local T = math.max(140, Tc + 273.15)
	local p = 699 * math.exp(-0.00009 * hh)
	if hh > 100000 then p *= math.max(0, (125000 - hh) / 25000) end
	outM.T = T; outM.p = p; outM.rho = p / (192.1 * T); outM.a = math.sqrt(1.29 * 192.1 * T)
	return outM
end

function A.airAt(body, h)
	if body and body.id == "earth" then return A.atmosphere(h) end
	if body and body.id == "mars" then return A.marsAtmosphere(h) end
	return A.atmosphere(1e9)
end

return A
