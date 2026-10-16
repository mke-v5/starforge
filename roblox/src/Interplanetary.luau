-- Interplanetary planning (port of the web game's interplanetary.js): launch windows (Lambert), departure
-- burns from a parking orbit, course corrections toward a planet, capture, and the way back.
local THREE = require(script.Parent.Three)
local Geo = require(script.Parent.Geo)
local Astro = require(script.Parent.Astro)
local O = require(script.Parent.Orbit)

local V3 = THREE.Vector3.new
local EARTH, MARS, SUN, D2R, clamp = Geo.EARTH, Geo.MARS, Geo.SUN, Geo.D2R, Geo.clamp
local predict, propagate, elements, relState, basis = O.predict, O.propagate, O.elements, O.relState, O.basis
local bodyPos, bodyVelAt, vacPerf, hyperbolaVel, simBurnComp, solve3, yieldFrame, burnTime =
	O.bodyPos, O.bodyVelAt, O.vacPerf, O.hyperbolaVel, O.simBurnComp, O.solve3, O.yieldFrame, O.burnTime
local isFinite = Geo.isFinite

local I = {}
local DAY = 86400
local function keyOf(body) return if body == MARS then "mars" else "earth" end

-- heliocentric position and velocity of a planet (frame I axes)
local _a, _b = V3(), V3()
function I.planetPV(key, t)
	local r = Astro.helio(key, t, V3())
	Astro.helio(key, t + 60, _a); Astro.helio(key, t - 60, _b)
	return { r = r, v = _a:clone():sub(_b):divideScalar(120) }
end
-- north pole of the ecliptic in frame I (planets go round it anticlockwise)
local ECL_N = V3(0, math.cos(23.4393 * D2R), math.sin(23.4393 * D2R))

-- ---- Lambert's problem (universal variables): the orbit from R1 to R2 in time tof about mu ----
local function stC(z)
	if z > 1e-8 then return (1 - math.cos(math.sqrt(z))) / z end
	if z < -1e-8 then local q = math.sqrt(-z); return ((math.exp(q) + math.exp(-q)) / 2 - 1) / -z end
	return 0.5 - z / 24
end
local function stS(z)
	if z > 1e-8 then local s = math.sqrt(z); return (s - math.sin(s)) / (s * s * s) end
	if z < -1e-8 then local s = math.sqrt(-z); return ((math.exp(s) - math.exp(-s)) / 2 - s) / (s * s * s) end
	return 1 / 6 - z / 120
end
function I.lambert(R1, R2, tof, mu, refN)
	refN = refN or ECL_N
	local r1, r2 = R1:length(), R2:length()
	local th = math.acos(clamp(R1:dot(R2) / (r1 * r2), -1, 1))
	if V3():crossVectors(R1, R2):dot(refN) < 0 then th = 2 * math.pi - th end   -- prograde
	local A = math.sin(th) * math.sqrt((r1 * r2) / (1 - math.cos(th)))
	if not isFinite(A) or math.abs(A) < 1e-6 then return nil end
	local sm = math.sqrt(mu)
	local function y(z) return r1 + r2 + (A * (z * stS(z) - 1)) / math.sqrt(stC(z)) end
	local function F(z)
		local yz = y(z)
		if yz < 0 then return -math.huge end
		return math.pow(yz / stC(z), 1.5) * stS(z) + A * math.sqrt(yz) - sm * tof
	end
	-- F rises with z on a single revolution: bracket and bisect
	local lo, hi = -4 * math.pi * math.pi, 4 * math.pi * math.pi * 0.999
	while lo < hi and not (F(lo) > -math.huge) do lo += 0.5 end
	local flo, fhi = F(lo), F(hi)
	if not (flo < 0) or not (fhi > 0) then return nil end
	for _ = 1, 70 do
		local m = (lo + hi) / 2
		if F(m) < 0 then lo = m else hi = m end
	end
	local z = (lo + hi) / 2
	local yz = y(z)
	local f, g, gd = 1 - yz / r1, A * math.sqrt(yz / mu), 1 - yz / r2
	local v1 = R2:clone():addScaledVector(R1, -f):divideScalar(g)
	local v2 = R2:clone():multiplyScalar(gd):sub(R1):divideScalar(g)
	return { v1 = v1, v2 = v2 }
end

-- speed change to leave a circular orbit of radius rp onto a hyperbola with excess speed vinf (and the reverse)
local function escapeDv(vinf, mu, rp) return math.sqrt(vinf * vinf + (2 * mu) / rp) - math.sqrt(mu / rp) end
I.escapeDv = escapeDv

-- Search the coming months for the cheapest transfer from planet `from` to planet `to`
function I.findWindow(t0, from, to, opts, onProgress)
	opts = opts or {}
	local span, step = opts.span or 800 * DAY, opts.step or 2 * DAY
	local tofs = {}
	for d = opts.tofMin or 110, opts.tofMax or 400, 5 do table.insert(tofs, d * DAY) end
	local muF, muT = (if from == MARS then MARS.mu else EARTH.mu), (if to == MARS then MARS.mu else EARTH.mu)
	local rpF, rpT = opts.rpFrom or from.R + 300e3, opts.rpTo or to.R + 300e3
	local arrW, waitW, tofW = opts.arrWeight or 0.7, opts.waitWeight or 0, opts.tofWeight or 0.8
	local best = nil
	local function try(td, tof)
		local P1 = I.planetPV(keyOf(from), td)
		local P2 = I.planetPV(keyOf(to), td + tof)
		local L = I.lambert(P1.r, P2.r, tof, SUN.mu)
		if not L then return end
		local vd, va = L.v1:clone():sub(P1.v), L.v2:clone():sub(P2.v)
		local dvD, dvA = escapeDv(vd:length(), muF, rpF), escapeDv(va:length(), muT, rpT)
		local cost = dvD + arrW * dvA + waitW * (td - t0) / DAY + tofW * tof / DAY
		if not best or cost < best.cost then best = { cost = cost, td = td, ta = td + tof, tof = tof, vInfD = vd, vInfA = va, dvD = dvD, dvA = dvA } end
	end
	local N = math.ceil(span / step)
	for i = 0, N do
		local td = t0 + i * step
		for _, tof in ipairs(tofs) do try(td, tof) end
		if i % 10 == 0 then
			if onProgress then onProgress(i / N) end
			yieldFrame()
		end
	end
	if best then
		-- polish the date and flight time on a finer grid
		for _, g in ipairs({ { DAY, 2 * DAY }, { DAY / 4, DAY / 2 } }) do
			local c = best
			for a = -3, 3 do
				for b = -3, 3 do
					local td, tof = c.td + a * g[1], c.tof + b * g[2]
					if td >= t0 and tof >= 60 * DAY then try(td, tof) end
				end
			end
			yieldFrame()
		end
	end
	return best
end

-- the departure burn from the ship's orbit around `body` onto a hyperbola with excess velocity vInf:
-- the cheapest point within one orbit of tCenter
local function departureBurn(ship, body, vInf, tCenter)
	local rs = relState(ship, body)
	local el = elements(rs.r, rs.v, body.mu)
	local P = if el.e < 1 then el.period else 3600
	local t0 = math.max(ship.t + 300, tCenter - P / 2)
	local st = propagate(ship.r, ship.v, ship.t, t0 - ship.t)
	local best = nil
	local K = 120
	for k = 0, K do
		if k > 0 then st = propagate(st.r, st.v, st.t, P / K) end
		local c, cv = bodyPos(body, st.t, V3()), bodyVelAt(body, st.t, V3())
		local r, v = st.r:clone():sub(c), st.v:clone():sub(cv)
		local vh = hyperbolaVel(r, vInf, body.mu)
		-- only leave going the same way round as the parking orbit
		if vh and vh:clone():cross(r):dot(v:clone():cross(r)) >= 0 then
			local dv = vh:sub(v)
			if not best or dv:length() < best.dv:length() then best = { st = st, dv = dv, r = r, v = v } end
		end
		if k % 30 == 0 then yieldFrame() end
	end
	return best
end

local function predictOpts(maxT)
	return { maxT = maxT, maxSteps = 20000, oneRev = false, noExtend = true, earthStop = -EARTH.R * 0.9, moonStop = false, marsStop = -MARS.R * 0.9 }
end

-- Aim a burn at state `st` (orbital frame of `frameBody`) so the closest approach to planet `target` is at
-- radius `goal`: Levenberg-Marquardt on the closest-approach position
function I.aimPlanet(st, frameBody, target, goal, dv0, maxT, onProgress, perf, base)
	local c, cv = bodyPos(frameBody, st.t, V3()), bodyVelAt(frameBody, st.t, V3())
	local b = basis(st.r:clone():sub(c), st.v:clone():sub(cv))
	local function vec(x) return b.pro:clone():multiplyScalar(x.x):addScaledVector(b.nor, x.y):addScaledVector(b.rad, x.z) end
	local function evalC(x)
		local r0, v0, t0, energy = st.r, nil, st.t, nil
		if perf and x:length() > 50 then
			local bs = simBurnComp(base, perf, st.t, x:clone():normalize(), x:length(), frameBody)
			r0, v0, t0, energy = bs.r, bs.v, bs.t, bs.energy
		else
			v0 = st.v:clone():add(vec(x))
		end
		local pr = predict(r0, v0, t0, predictOpts(maxT))
		local p, d
		if target == MARS then
			p = if pr.closeMars.r then pr.closeMars.r:clone() else V3(1e13, 0, 0)
			d = pr.closeMars.d
		else
			-- (the closest point to the Earth, wherever it is — a miss far outside its sphere of influence
			-- still gives the solver a direction to work with)
			local pe = pr.earthPe
			p = if pe.x then V3(pe.x, pe.y, pe.z) else V3(1e13, 0, 0)
			d = pe.d
		end
		return { p = p, d = d, f = d - goal, pr = pr, energy = energy }
	end
	local x = V3(dv0:dot(b.pro), dv0:dot(b.nor), dv0:dot(b.rad))
	local cur = evalC(x)
	local tol = math.max(3000, (goal - target.R) * 0.05)
	local E3 = { V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1) }
	local dlt = 0.05
	local lam = 1e-3
	for it = 1, 24 do
		if math.abs(cur.f) <= tol then break end
		local R = cur.p:clone():sub(cur.p:clone():setLength(goal))
		local cols = {}
		for i, e in ipairs(E3) do
			cols[i] = evalC(x:clone():addScaledVector(e, dlt)).p:sub(evalC(x:clone():addScaledVector(e, -dlt)).p):divideScalar(2 * dlt)
			yieldFrame()
		end
		local A, g = { { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 } }, { 0, 0, 0 }
		for i = 1, 3 do
			g[i] = -cols[i]:dot(R)
			for j = 1, 3 do A[i][j] = cols[i]:dot(cols[j]) end
		end
		local tr = A[1][1] + A[2][2] + A[3][3]
		local ok = false
		for _ = 1, 10 do
			local M = {}
			for i = 1, 3 do
				M[i] = {}
				for j = 1, 3 do M[i][j] = A[i][j] + (if i == j then lam * tr + 1e-12 * tr else 0) end
			end
			local stp = solve3(M, g)
			if not stp then lam *= 10; continue end
			if stp:length() > 600 then stp:setLength(600) end
			local tryX = x:clone():add(stp)
			local r = evalC(tryX)
			if math.abs(r.f) < math.abs(cur.f) then x = tryX; cur = r; lam = math.max(1e-9, lam / 5); ok = true; break end
			lam *= 8
		end
		if onProgress then onProgress(math.min(1, it / 10)) end
		yieldFrame()
		if not ok then break end
	end
	return { dv = vec(x), d = cur.d, f = cur.f, ok = math.abs(cur.f) < tol * 20, energy = cur.energy,
		tArr = if target == MARS then cur.pr.closeMars.t else cur.pr.earthPe.t }
end

local function planDeparture(ship, from, to, label, alt, opts, onProgress)
	local rs = relState(ship, from)
	local el = elements(rs.r, rs.v, from.mu)
	if not (el.e < 1) then return nil end
	local goal = to.R + alt
	local function prog(a, b) return function(f) if onProgress then onProgress(a + (b - a) * f) end end end
	local W = I.findWindow(ship.t + 3600, from, to, { rpFrom = el.a, rpTo = goal, waitWeight = opts.waitWeight or 0, arrWeight = opts.arrWeight }, prog(0, 0.35))
	if not W then return nil end
	local dep = departureBurn(ship, from, W.vInfD, W.td)
	if not dep then return nil end
	local perf = vacPerf(ship)
	local bt = if perf then burnTime(ship, dep.dv:length()) else 0
	local base = propagate(ship.r, ship.v, ship.t, math.max(0, dep.st.t - ship.t - bt / 2 - 60))
	local ref = I.aimPlanet(dep.st, from, to, goal, dep.dv, W.ta - dep.st.t + 40 * DAY, prog(0.35, 1), if opts.finite then perf else nil, base)
	if not ref or not ref.ok then return nil end
	local node = { t = dep.st.t, dv = ref.dv, body = from, label = label, arrive = ref.tArr, window = W }
	if to == MARS then node.marsPe = ref.d - MARS.R else node.earthPe = ref.d - EARTH.R end
	if ref.energy ~= nil then node.eTarget = ref.energy end
	return node
end

-- Trans-Mars injection from Earth orbit: the next good launch window, then the departure burn
function I.planMarsTransfer(ship, onProgress, opts)
	opts = opts or {}
	if ship.env.body ~= EARTH then return nil end
	return planDeparture(ship, EARTH, MARS, "Trans-Mars injection", opts.alt or 300e3, opts, onProgress)
end

-- From Mars orbit back toward Earth
function I.planEarthReturnFromMars(ship, onProgress, opts)
	opts = opts or {}
	if ship.env.body ~= MARS then return nil end
	return planDeparture(ship, MARS, EARTH, "Trans-Earth injection", opts.alt or 250e3, { waitWeight = opts.waitWeight or 2, arrWeight = opts.arrWeight, finite = opts.finite }, onProgress)
end

-- Course correction toward a planet: the cheapest small burn (now, or days later) that puts the closest
-- approach at targetAlt
function I.planPlanetCorrection(ship, target, targetAlt, onProgress)
	local goal = target.R + targetAlt
	local now = predict(ship.r, ship.v, ship.t, predictOpts(500 * DAY))
	local tArr = if target == MARS then now.closeMars.t else now.earthPe.t
	if not isFinite(tArr) or tArr <= ship.t then return nil end
	local left = tArr - ship.t
	local leads = {}
	for _, l in ipairs({ 120, 2 * DAY, 10 * DAY, 30 * DAY }) do if l == 120 or l < left * 0.5 then table.insert(leads, l) end end
	local best = nil
	for i, lead in ipairs(leads) do
		local st = propagate(ship.r, ship.v, ship.t, lead)
		local frame = ship.env.body
		local r = I.aimPlanet(st, frame, target, goal, V3(), left - lead + 20 * DAY, function(f) if onProgress then onProgress((i - 1 + f) / #leads) end end)
		if r.ok and r.dv:length() >= 0.05 then
			if not best or r.dv:length() < best.dv:length() * 0.6 then
				best = { t = st.t, dv = r.dv, body = frame, label = "Course correction (" .. target.name .. ")" }
				if target == MARS then best.marsPe = r.d - MARS.R else best.earthPe = r.d - EARTH.R end
			end
		end
	end
	return best
end

-- Capture into a circular orbit at the next periapsis around Mars (or any body)
function I.planOrbitCapture(ship, body)
	body = body or MARS
	local rs = relState(ship, body)
	local el = elements(rs.r, rs.v, body.mu)
	local dtTo = if isFinite(el.tPe) and el.tPe > 0 then el.tPe else 60
	local st = propagate(ship.r, ship.v, ship.t, dtTo)
	local r = st.r:clone():sub(bodyPos(body, st.t, V3()))
	local v = st.v:clone():sub(bodyVelAt(body, st.t, V3()))
	local rl = r:length()
	local vc = math.sqrt(body.mu / rl)
	local horiz = v:clone():addScaledVector(r:clone():normalize(), -v:dot(r) / rl):normalize()
	return { t = st.t, dv = horiz:multiplyScalar(vc):sub(v), body = body, label = body.name .. " orbit capture" }
end

return I
