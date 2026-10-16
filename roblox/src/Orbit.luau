--!native
-- Orbital mechanics (port of src/ship/orbit.js): elements, trajectory prediction across the Earth, Moon, Sun
-- and Mars, and the burn planners. Planners that take a while yield now and then (yieldFrame) so the game
-- keeps drawing; call them from a task/coroutine in Roblox.

local THREE = require(script.Parent.Three)
local Geo = require(script.Parent.Geo)
local Astro = require(script.Parent.Astro)
local Physics = require(script.Parent.Physics)
local Atmo = require(script.Parent.Atmo)
local V3 = THREE.Vector3.new
local EARTH, MOON, MARS, SUN, AU, clamp, llh, toLLH, isFinite, hypot = Geo.EARTH, Geo.MOON, Geo.MARS, Geo.SUN, Geo.AU, Geo.clamp, Geo.llh, Geo.toLLH, Geo.isFinite, Geo.hypot
local moonPos, moonVel, gravity, earthAngle, moonBasis, marsPos, marsVel, sunPos, sunVel =
	Astro.moonPos, Astro.moonVel, Astro.gravity, Astro.earthAngle, Astro.moonBasis, Astro.marsPos, Astro.marsVel, Astro.sunPos, Astro.sunVel
local rk4 = Physics.rk4
local atmosphere = Atmo.atmosphere
local INF, PI = math.huge, math.pi
local NaN = 0 / 0

local O = {}

local _m, _mv = V3(), V3()

local function copyTable(t) local o = {}; for k, v in pairs(t) do o[k] = v end; return o end
local function atanh(x) return 0.5 * math.log((1 + x) / (1 - x)) end

-- Keplerian elements of (r, v) relative to a body with gravitational parameter mu
function O.elements(r, v, mu)
	local rl, v2 = r:length(), v:lengthSq()
	local h = V3():crossVectors(r, v)
	local energy = v2 / 2 - mu / rl
	local a = -mu / (2 * energy)
	local ev = V3():crossVectors(v, h):divideScalar(mu):sub(r:clone():divideScalar(rl))
	local e = ev:length()
	local pe = a * (1 - e)
	local ap = if e < 1 then a * (1 + e) else INF
	local inc = math.acos(clamp(h.y / h:length(), -1, 1))
	local period = if e < 1 then 2 * PI * math.sqrt(a * a * a / mu) else INF
	local den = e * rl
	if den == 0 then den = 1 end
	local nu = math.acos(clamp(ev:dot(r) / den, -1, 1))
	if r:dot(v) < 0 then nu = 2 * PI - nu end
	local tPe, tAp = NaN, NaN
	if e < 1 and e > 1e-6 then
		local E = 2 * math.atan(math.sqrt((1 - e) / (1 + e)) * math.tan(nu / 2))
		local M = E - e * math.sin(E)
		if M < 0 then M += 2 * PI end
		local n = 2 * PI / period
		tPe = (2 * PI - M) / n
		tAp = math.fmod((PI - M) + 2 * PI, 2 * PI) / n
	elseif e >= 1 then
		local F = 2 * atanh(math.sqrt((e - 1) / (e + 1)) * math.tan(nu / 2))
		local M = e * math.sinh(F) - F
		local n = math.sqrt(mu / math.pow(-a, 3))
		tPe = if M < 0 then -M / n else NaN
	end
	return { a = a, e = e, pe = pe, ap = ap, inc = inc, period = period, energy = energy, nu = nu, tPe = tPe, tAp = tAp, h = h, ev = ev }
end

-- position and velocity of a body's centre in frame I
function O.bodyPos(body, t, out)
	out = out or V3()
	if body == EARTH then return out:set(0, 0, 0) elseif body == MOON then return moonPos(t, out) elseif body == MARS then return marsPos(t, out) end
	return sunPos(t, out)
end
function O.bodyVelAt(body, t, out)
	out = out or V3()
	if body == EARTH then return out:set(0, 0, 0) elseif body == MOON then return moonVel(t, out) elseif body == MARS then return marsVel(t, out) end
	return sunVel(t, out)
end
local bodyPos, bodyVelAt = O.bodyPos, O.bodyVelAt

-- which body's sphere of influence a point is in, and the distance to it
local _dp = V3()
function O.dominantAt(x, y, z, t)
	local de = hypot(x, y, z)
	if de < EARTH.soi then
		if de > 2.5e8 then
			moonPos(t, _dp)
			local dm = hypot(x - _dp.x, y - _dp.y, z - _dp.z)
			if dm < MOON.soi then return { body = MOON, rr = dm, de = de } end
		end
		return { body = EARTH, rr = de, de = de }
	end
	marsPos(t, _dp)
	local da = hypot(x - _dp.x, y - _dp.y, z - _dp.z)
	if da < MARS.soi then return { body = MARS, rr = da, de = de } end
	sunPos(t, _dp)
	return { body = SUN, rr = hypot(x - _dp.x, y - _dp.y, z - _dp.z), de = de, da = da }
end
local dominantAt = O.dominantAt

local function coastStep(D, k, maxStep)
	local body, rr, de = D.body, D.rr, D.de
	if body == EARTH or body == MOON then return clamp(k * math.sqrt(rr * rr * rr / body.mu), 0.5, maxStep) end
	local h = math.min(k * math.sqrt(de * de * de / EARTH.mu), k * math.sqrt(rr * rr * rr / body.mu))
	if body == SUN then h = math.min(h, k * math.sqrt(D.da ^ 3 / MARS.mu)) end
	return clamp(h, 0.5, if body == SUN then 20000 else math.max(maxStep, 1200))
end

-- Predict a trajectory. Points are relative to Earth inside its sphere of influence, to the Moon inside the
-- Moon's, to the Sun between the planets and to Mars inside its sphere. Point lists are flat {x, y, z, ...}
-- (Moon/Sun/Mars lists carry a time as a 4th value).
function O.predict(r0, v0, t0, opts)
	opts = opts or {}
	local maxT = opts.maxT or 6 * 86400
	local maxSteps = opts.maxSteps or 4000
	local s = { r0.x, r0.y, r0.z, v0.x, v0.y, v0.z }
	local t = t0
	local earthPts, moonPts, sunPts, marsPts = {}, {}, {}, {}
	local closeMoon = { d = INF, t = 0 }
	local impact, soiIn, soiOut = nil, nil, nil
	local earthPe = { d = INF, t = 0, hx = 0, hy = 0, hz = 0 }
	local closeMars = { d = INF, t = 0 }
	local earthOut, earthBack, marsIn, marsOut = nil, nil, nil, nil
	local inSoi, soiInIdx, soiOutIdx, startInSoi, earthPeIdx = nil, -1, -1, false, 0
	local lastBody, startBody = nil, nil
	local angle, lastDir, sunAngle, lastSunDir = 0, V3(s[1], s[2], s[3]):normalize(), 0, nil
	local dir, sp, ap = V3(), V3(), V3()
	local i = 0
	while i < maxSteps and t - t0 < maxT do
		local D = dominantAt(s[1], s[2], s[3], t)
		local body = D.body
		if startBody == nil then startBody = body end
		local de = D.de
		local dm, dx, dy, dz, nowSoi = INF, 0, 0, 0, false
		if de < EARTH.soi then
			moonPos(t, _m)
			dx = s[1] - _m.x; dy = s[2] - _m.y; dz = s[3] - _m.z
			dm = hypot(dx, dy, dz)
			nowSoi = dm < MOON.soi
		end
		if inSoi == nil then inSoi = nowSoi; startInSoi = nowSoi end
		if nowSoi and not inSoi and not soiIn then soiIn = t; soiInIdx = #earthPts / 3 end
		if not nowSoi and inSoi and (soiIn or startInSoi) and not soiOut then soiOut = t; soiOutIdx = #earthPts / 3 end
		inSoi = nowSoi
		if dm < closeMoon.d then closeMoon = { d = dm, t = t, r = V3(dx, dy, dz), v = nil, vI = V3(s[4], s[5], s[6]) } end
		if de < earthPe.d then
			earthPe.d = de; earthPe.t = t; earthPeIdx = #earthPts / 3
			earthPe.x, earthPe.y, earthPe.z = s[1], s[2], s[3]
			earthPe.hx = s[2] * s[6] - s[3] * s[5]; earthPe.hy = s[3] * s[4] - s[1] * s[6]; earthPe.hz = s[1] * s[5] - s[2] * s[4]
		end
		if lastBody ~= nil and body ~= lastBody then
			if (lastBody == EARTH or lastBody == MOON) and body == SUN and not earthOut then earthOut = t end
			if lastBody == SUN and (body == EARTH or body == MOON) and earthOut and not earthBack then earthBack = t end
			if body == MARS and not marsIn then marsIn = t end
			if lastBody == MARS and marsIn and not marsOut then marsOut = t end
			if body == SUN and not opts.noExtend then maxT = math.max(maxT, opts.helioT or 600 * 86400); maxSteps = math.max(maxSteps, i + 6000) end
		end
		lastBody = body
		if de < EARTH.soi * 1.05 then table.insert(earthPts, s[1]); table.insert(earthPts, s[2]); table.insert(earthPts, s[3]) end
		if nowSoi then table.insert(moonPts, dx); table.insert(moonPts, dy); table.insert(moonPts, dz); table.insert(moonPts, t) end
		if body == SUN or (body ~= MARS and de > EARTH.soi * 0.7) then
			sunPos(t, sp)
			table.insert(sunPts, s[1] - sp.x); table.insert(sunPts, s[2] - sp.y); table.insert(sunPts, s[3] - sp.z); table.insert(sunPts, t)
		end
		if body == MARS or D.da ~= nil then
			marsPos(t, ap)
			local ax, ay, az = s[1] - ap.x, s[2] - ap.y, s[3] - ap.z
			local da = hypot(ax, ay, az)
			if body == MARS then table.insert(marsPts, ax); table.insert(marsPts, ay); table.insert(marsPts, az); table.insert(marsPts, t) end
			if da < closeMars.d then closeMars = { d = da, t = t, r = V3(ax, ay, az), v = nil, vI = V3(s[4], s[5], s[6]) } end
			if da < MARS.R + (opts.marsStop or 0) then impact = { body = MARS, t = t, r = V3(ax, ay, az) }; break end
		end
		if de < EARTH.R + (opts.earthStop or 0) then impact = { body = EARTH, t = t, r = V3(s[1], s[2], s[3]) }; break end
		if opts.moonStop ~= false and dm < MOON.R + 200 then impact = { body = MOON, t = t, r = V3(dx, dy, dz) }; break end
		if body == EARTH or body == MOON then
			dir:set(s[1], s[2], s[3]):normalize()
			angle += math.acos(clamp(dir:dot(lastDir), -1, 1))
			lastDir:copy(dir)
			if not nowSoi and opts.oneRev ~= false and angle > 2 * PI + 0.05 and de < 300e6 and not soiIn and not earthOut then break end
		elseif body == SUN then
			sunPos(t, sp); dir:set(s[1] - sp.x, s[2] - sp.y, s[3] - sp.z):normalize()
			if lastSunDir then sunAngle += math.acos(clamp(dir:dot(lastSunDir), -1, 1)) else lastSunDir = V3() end
			lastSunDir:copy(dir)
			if sunAngle > 2 * PI + 0.05 then break end
		end
		local h = if body == EARTH or body == MOON then clamp(0.012 * math.sqrt(D.rr ^ 3 / body.mu), 0.5, opts.maxStep or 900) else coastStep(D, 0.012, opts.maxStep or 900)
		rk4(s, t, h)
		t += h
		i += 1
	end
	if closeMoon.r then moonVel(closeMoon.t, _mv); closeMoon.v = closeMoon.vI:clone():sub(_mv) end
	if closeMars.r then marsVel(closeMars.t, _mv); closeMars.v = closeMars.vI:clone():sub(_mv) end
	return {
		earthPts = earthPts, moonPts = moonPts, sunPts = sunPts, marsPts = marsPts, closeMoon = closeMoon, closeMars = closeMars,
		impact = impact, soiIn = soiIn, soiOut = soiOut, soiInIdx = soiInIdx, soiOutIdx = soiOutIdx, startInSoi = startInSoi,
		earthPe = earthPe, earthPeIdx = earthPeIdx, earthOut = earthOut, earthBack = earthBack, marsIn = marsIn, marsOut = marsOut,
		startBody = startBody, tEnd = t,
	}
end
local predict = O.predict

-- position and velocity of the craft (or a state {r, v, t}) relative to a body
function O.relState(ship, body)
	if body == EARTH then return { r = ship.r:clone(), v = ship.v:clone(), mu = EARTH.mu, R = EARTH.R } end
	bodyPos(body, ship.t, _m); bodyVelAt(body, ship.t, _mv)
	return { r = ship.r:clone():sub(_m), v = ship.v:clone():sub(_mv), mu = body.mu, R = body.R }
end
local relState = O.relState

-- maneuver basis at a state: prograde, normal, radial (unit vectors)
function O.basis(r, v)
	local pro = v:clone():normalize()
	local nor = V3():crossVectors(r, v):normalize()
	local rad = V3():crossVectors(nor, pro):normalize()
	return { pro = pro, nor = nor, rad = rad }
end
local basis = O.basis

-- propagate a state forward by dt (gravity only)
function O.propagate(r, v, t, dt)
	local s = { r.x, r.y, r.z, v.x, v.y, v.z }
	local left, tt = dt, t
	while left > 1e-6 do
		local D = dominantAt(s[1], s[2], s[3], tt)
		local h = math.min(left, if D.body == EARTH or D.body == MOON then clamp(0.01 * math.sqrt(D.rr ^ 3 / D.body.mu), 0.5, 300) else coastStep(D, 0.01, 300))
		rk4(s, tt, h); tt += h; left -= h
	end
	return { r = V3(s[1], s[2], s[3]), v = V3(s[4], s[5], s[6]), t = tt }
end
local propagate = O.propagate

-- Long planners pause now and then so the game keeps drawing (only after ~25 ms of work since the last pause)
local _lastYield = os.clock()
function O.yieldFrame()
	if os.clock() - _lastYield < 0.025 then return end
	if task and coroutine.isyieldable() then task.wait() end
	_lastYield = os.clock()
end
local yieldFrame = O.yieldFrame

-- ---------- planners: each returns a node {t, dv (frame I), body, label} or nil ----------

-- time until the apsis nearest the two-body estimate dt0, found on the real trajectory
function O.refineApsis(ship, body, dt0, peri)
	if peri == nil then peri = true end
	local function rv(st)
		if body == EARTH then return st.r:dot(st.v) end
		bodyPos(body, st.t, _m); bodyVelAt(body, st.t, _mv)
		return st.r:clone():sub(_m):dot(st.v:clone():sub(_mv))
	end
	local W, N = clamp(dt0 * 0.25, 600, 6 * 3600), 48
	local t0 = math.max(1, dt0 - W)
	local step = (dt0 + W - t0) / N
	local st = propagate(ship.r, ship.v, ship.t, t0)
	local f, best = rv(st), nil
	for _ = 1, N do
		local nx = propagate(st.r, st.v, st.t, step)
		local fn = rv(nx)
		if (if peri then f < 0 and fn >= 0 else f > 0 and fn <= 0) then
			local a, b = st, nx
			local k = 0
			while k < 30 and b.t - a.t > 0.05 do
				local m = propagate(a.r, a.v, a.t, (b.t - a.t) / 2)
				if (rv(m) < 0) == peri then a = m else b = m end
				k += 1
			end
			local tt = (a.t + b.t) / 2 - ship.t
			if best == nil or math.abs(tt - dt0) < math.abs(best - dt0) then best = tt end
		end
		st = nx; f = fn
	end
	return best or dt0
end

function O.planCircularize(ship, atApo)
	if atApo == nil then atApo = true end
	local body = ship.env.body
	local rs = relState(ship, body)
	local el = O.elements(rs.r, rs.v, rs.mu)
	if el.e >= 1 then return nil end
	local dtTo = if atApo then el.tAp else el.tPe
	if not isFinite(dtTo) then return nil end
	if el.e > 0.02 and dtTo > 300 then dtTo = O.refineApsis(ship, body, dtTo, not atApo) end
	local st = propagate(ship.r, ship.v, ship.t, dtTo)
	local rel = relState(st, body)
	local rl = rel.r:length()
	local vc = math.sqrt(rs.mu / rl)
	local horiz = rel.v:clone():addScaledVector(rel.r:clone():normalize(), -rel.v:dot(rel.r) / rl):normalize()
	local dv = horiz:multiplyScalar(vc):sub(rel.v)
	return { t = st.t, dv = dv, body = body, label = if atApo then "Circularize at apoapsis" else "Circularize at periapsis" }
end

-- change the periapsis with a burn at apoapsis (or now)
function O.planPeriapsis(ship, targetAlt, now)
	local body = ship.env.body
	local rs = relState(ship, body)
	local el = O.elements(rs.r, rs.v, rs.mu)
	local dtTo = if now or el.e >= 1 or not isFinite(el.tAp) then 30 else el.tAp
	if dtTo > 300 and el.e > 0.02 and el.e < 1 then dtTo = O.refineApsis(ship, body, dtTo, false) end
	local st = propagate(ship.r, ship.v, ship.t, dtTo)
	local rel = relState(st, body)
	local r, v = rel.r, rel.v
	local pro = basis(r, v).pro
	local target = rs.R + targetAlt
	local lo, hi = -v:length(), v:length() * 0.5
	for _ = 1, 50 do
		local mid = (lo + hi) / 2
		local e2 = O.elements(r, v:clone():addScaledVector(pro, mid), rs.mu)
		if e2.pe > target then hi = mid else lo = mid end
	end
	return { t = st.t, dv = pro:clone():multiplyScalar((lo + hi) / 2), body = body, label = string.format("Set periapsis %d km", math.round(targetAlt / 1000)) }
end

-- thrust and mass flow of the active engines in vacuum (with thrust trim)
local VAC = { rho = 0, p = 0, mach = 0, h = 1e6, a = 300 }
function O.vacPerf(ship)
	local craft = ship.craft
	local T, mdot = 0, 0
	for _, P in ipairs(craft.engines) do
		if not P.eng.active then continue end
		local t, isp = craft:engineOutput(P, VAC)
		local tb = t * (P.eng.bal or 1)
		if tb > 0 then T += tb; mdot += tb / (isp * 9.80665) end
	end
	return if T > 0 then { T = T, mdot = mdot, m0 = craft.mass } else nil
end

-- a finite burn following prograde (+1) or retrograde (-1) relative to `body`, centred on tNode
local function simBurn(ship, perf, tNode, dv, body, sign)
	sign = sign or 1
	local ve = perf.T / perf.mdot
	local bt = (perf.m0 - perf.m0 / math.exp(math.abs(dv) / ve)) / perf.mdot
	local t0 = tNode - bt / 2
	local st0 = if t0 > ship.t then propagate(ship.r, ship.v, ship.t, t0 - ship.t) else { r = ship.r:clone(), v = ship.v:clone(), t = ship.t }
	local s = { st0.r.x, st0.r.y, st0.r.z, st0.v.x, st0.v.y, st0.v.z }
	local t, m = st0.t, perf.m0
	local n = math.max(4, math.ceil(bt / 2))
	local h = bt / n
	local vr = V3()
	for _ = 1, n do
		rk4(s, t, h)
		t += h
		vr:set(s[4], s[5], s[6])
		if body ~= EARTH then vr:sub(bodyVelAt(body, t, _mv)) end
		vr:normalize():multiplyScalar(sign * perf.T / m * h)
		s[4] += vr.x; s[5] += vr.y; s[6] += vr.z
		m -= perf.mdot * h
	end
	local r, v = V3(s[1], s[2], s[3]), V3(s[4], s[5], s[6])
	local rr = if body ~= EARTH then r:clone():sub(bodyPos(body, t, _m)) else r
	local vv = if body ~= EARTH then v:clone():sub(bodyVelAt(body, t, _mv)) else v
	return { r = r, v = v, t = t, energy = vv:lengthSq() / 2 - body.mu / rr:length(), bt = bt }
end

-- trans-lunar injection from Earth orbit
function O.planMoonTransfer(ship, targetAlt, onProgress)
	targetAlt = targetAlt or 120000
	if ship.env.body ~= EARTH then return nil end
	local el = O.elements(ship.r, ship.v, EARTH.mu)
	if el.e >= 1 then return nil end
	local period = el.period
	local rp = ship.r:length()
	local vNow = ship.v:length()
	local aT = (rp + 384400e3) / 2
	local vT = math.sqrt(EARTH.mu * (2 / rp - 1 / aT))
	local dv0 = clamp(vT - vNow, 2800, 3400)
	local perf = O.vacPerf(ship)
	local POPTS = { maxT = 7 * 86400, maxSteps = 2500, oneRev = false, maxStep = 1800 }
	local function tryNode(tOff, dv)
		local st = propagate(ship.r, ship.v, ship.t, tOff)
		local pro = basis(st.r, st.v).pro
		local pr, eTarget
		if perf then
			local b = simBurn(ship, perf, st.t, dv, EARTH, 1)
			pr = predict(b.r, b.v, b.t, POPTS)
			eTarget = b.energy
		else
			pr = predict(st.r, st.v:clone():addScaledVector(pro, dv), st.t, POPTS)
		end
		return { st = st, pro = pro, pr = pr, d = pr.closeMoon.d, tHit = pr.closeMoon.t, eTarget = eTarget }
	end
	local best = nil
	local N = 36
	for i = 0, N - 1 do
		local tOff = 60 + (period * i) / N
		for _, dv in ipairs({ dv0 - 40, dv0, dv0 + 40 }) do
			local r = tryNode(tOff, dv)
			local score = math.abs(r.d - (MOON.R + targetAlt))
			if not best or score < best.score then best = r; best.score = score; best.tOff = tOff; best.dv = dv end
		end
		if onProgress then onProgress(i / N * 0.6) end
		if i % 3 == 0 then yieldFrame() end
	end
	if not best then return nil end
	local tOff, dv = best.tOff, best.dv
	local stepT, stepV = period / N / 2, 20
	for it = 0, 23 do
		local improved = false
		for _, d in ipairs({ { stepT, 0 }, { -stepT, 0 }, { 0, stepV }, { 0, -stepV } }) do
			local t2, v2 = math.max(30, tOff + d[1]), dv + d[2]
			local r = tryNode(t2, v2)
			local score = math.abs(r.d - (MOON.R + targetAlt))
			if score < best.score then best = r; best.score = score; best.tOff = t2; best.dv = v2; tOff = t2; dv = v2; improved = true end
		end
		if not improved then stepT /= 2; stepV /= 2 end
		if onProgress then onProgress(0.6 + (it / 24) * 0.4) end
		yieldFrame()
	end
	if best.d > MOON.soi then return nil end
	return { t = best.st.t, dv = best.pro:clone():multiplyScalar(best.dv), body = EARTH, eTarget = best.eTarget, label = "Trans-lunar injection", arrive = best.tHit, moonPe = best.d - MOON.R }
end

-- velocity at position r on the two-body hyperbola (about mu) whose outgoing asymptote is vInf
function O.hyperbolaVel(r, vInf, mu)
	local rl, vi = r:length(), vInf:length()
	local rh, u = r:clone():divideScalar(rl), vInf:clone():divideScalar(vi)
	local cphi = clamp(rh:dot(u), -1, 1)
	local w = u:clone():addScaledVector(rh, -cphi)
	if w:lengthSq() < 1e-8 then return nil end
	w:normalize()
	local sphi = math.sqrt(1 - cphi * cphi)
	local k = rl * vi * vi / mu
	local s = (k * sphi + math.sqrt(k * k * sphi * sphi + 4 * k * (1 - cphi))) / 2
	local e, h = math.sqrt(1 + s * s), math.sqrt(mu * mu * s * s / (vi * vi))
	local thR = math.acos(-1 / e) - math.acos(cphi)
	return rh:multiplyScalar((mu / h) * e * math.sin(thR)):addScaledVector(w, h / rl)
end
local hyperbolaVel = O.hyperbolaVel

-- Earth-relative departure from the Moon's distance that falls back to periapsis `goal`
local function returnAim(t, goal, psi, vr)
	moonPos(t, _m); moonVel(t, _mv)
	local R, rh = _m:length(), _m:clone():normalize()
	local t0 = _mv:clone():addScaledVector(rh, -_mv:dot(rh)):normalize()
	local side = V3():crossVectors(rh, t0)
	local Vt = 190
	for _ = 1, 5 do
		local eps = (vr * vr + Vt * Vt) / 2 - EARTH.mu / R
		Vt = goal * math.sqrt(2 * (eps + EARTH.mu / goal)) / R
	end
	local n = side:multiplyScalar(math.cos(psi)):addScaledVector(t0, -math.sin(psi))
	local tv = V3():crossVectors(n, rh)
	local V = rh:clone():multiplyScalar(vr):addScaledVector(tv, Vt)
	return { vInf = V:sub(_mv), n = n, inc = math.acos(clamp(n.y, -1, 1)) }
end

-- a finite burn held fixed in the orbital frame (prograde/normal/radial components `comp`) about `body`
function O.simBurnComp(base, perf, tNode, comp, dv, body)
	local ve = perf.T / perf.mdot
	local bt = (perf.m0 - perf.m0 / math.exp(math.abs(dv) / ve)) / perf.mdot
	local st0 = propagate(base.r, base.v, base.t, math.max(0, tNode - bt / 2 - base.t))
	local s = { st0.r.x, st0.r.y, st0.r.z, st0.v.x, st0.v.y, st0.v.z }
	local t, m = st0.t, perf.m0
	local n = math.max(4, math.ceil(bt / 2))
	local h = bt / n
	local r, v, nor, rad, d = V3(), V3(), V3(), V3(), V3()
	for _ = 1, n do
		rk4(s, t, h)
		t += h
		r:set(s[1], s[2], s[3]); v:set(s[4], s[5], s[6])
		if body ~= EARTH then r:sub(bodyPos(body, t, _m)); v:sub(bodyVelAt(body, t, _mv)) end
		nor:crossVectors(r, v):normalize(); v:normalize(); rad:crossVectors(nor, v)
		d:copy(v):multiplyScalar(comp.x):addScaledVector(nor, comp.y):addScaledVector(rad, comp.z):normalize():multiplyScalar(perf.T / m * h)
		s[4] += d.x; s[5] += d.y; s[6] += d.z
		m -= perf.mdot * h
	end
	local R, Vv = V3(s[1], s[2], s[3]), V3(s[4], s[5], s[6])
	local rr = if body ~= EARTH then R:clone():sub(bodyPos(body, t, _m)) else R
	local vv = if body ~= EARTH then Vv:clone():sub(bodyVelAt(body, t, _mv)) else Vv
	return { r = R, v = Vv, t = t, energy = vv:lengthSq() / 2 - body.mu / rr:length(), bt = bt }
end

-- 3x3 linear solve (rows of M, right-hand side g)
function O.solve3(M, g)
	local a, b, c = M[1], M[2], M[3]
	local function det3(r0, r1, r2)
		return r0[1] * (r1[2] * r2[3] - r1[3] * r2[2]) - r0[2] * (r1[1] * r2[3] - r1[3] * r2[1]) + r0[3] * (r1[1] * r2[2] - r1[2] * r2[1])
	end
	local det = det3(a, b, c)
	if not isFinite(det) or math.abs(det) < 1e-30 then return nil end
	local function col(k)
		local out = {}
		for i = 1, 3 do out[i] = {}; for j = 1, 3 do out[i][j] = if j == k then g[i] else M[i][j] end end
		return out
	end
	local c1, c2, c3 = col(1), col(2), col(3)
	return V3(det3(c1[1], c1[2], c1[3]) / det, det3(c2[1], c2[2], c2[3]) / det, det3(c3[1], c3[2], c3[3]) / det)
end
local solve3 = O.solve3

local E3 = { V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1) }
local function lmMatrix(cols, R)
	local A, g = { { 0, 0, 0 }, { 0, 0, 0 }, { 0, 0, 0 } }, { 0, 0, 0 }
	for i = 1, 3 do
		g[i] = -cols[i]:dot(R)
		for j = 1, 3 do A[i][j] = cols[i]:dot(cols[j]) end
	end
	return A, g, A[1][1] + A[2][2] + A[3][3]
end
local function damped(A, add)
	local M = {}
	for i = 1, 3 do M[i] = {}; for j = 1, 3 do M[i][j] = A[i][j] + (if i == j then add else 0) end end
	return M
end
O._lmMatrix, O._damped = lmMatrix, damped

-- aim a burn at state st so the craft arrives at Earth with periapsis radius `goal` (and inclination iT)
local function aimEarth(st, frameBody, goal, iT, dv0, onProgress, perf, base)
	local m, mv = moonPos(st.t, V3()), moonVel(st.t, V3())
	local rel = frameBody == MOON
	local b = basis(if rel then st.r:clone():sub(m) else st.r, if rel then st.v:clone():sub(mv) else st.v)
	local function vec(c) return b.pro:clone():multiplyScalar(c.x):addScaledVector(b.nor, c.y):addScaledVector(b.rad, c.z) end
	local cosT = if iT == nil then 0 else math.cos(iT)
	local POPTS = { maxT = 7 * 86400, maxSteps = 3000, oneRev = false, maxStep = 1800, earthStop = -EARTH.R * 0.9, moonStop = false }
	local function evalC(c)
		local r0, v0, t0, energy = st.r, nil, st.t, nil
		if perf and c:length() > 5 and math.abs(c.x) > 0.8 * c:length() then
			local bs = O.simBurnComp(base, perf, st.t, c:clone():normalize(), c:length(), frameBody)
			r0 = bs.r; v0 = bs.v; t0 = bs.t; energy = bs.energy
		else
			v0 = st.v:clone():add(vec(c))
		end
		local pr = predict(r0, v0, t0, POPTS)
		local pe = pr.earthPe
		local d = math.max(1, pe.d)
		local h = V3(pe.hx, pe.hy, pe.hz)
		local hl = math.max(1, h:length())
		local vp = hl / d
		local hG = goal * math.sqrt(math.max(0, vp * vp + 2 * EARTH.mu / goal - 2 * EARTH.mu / d))
		local ok = pe.t < pr.tEnd - 600 and not (pr.impact and pr.impact.body == MOON)
		local res = V3(hl - hG, if iT == nil then 0 else h.y - hl * cosT, 0)
		return { res = res, d = d, h = h, ok = ok, energy = energy, inc = math.acos(clamp(h.y / hl, -1, 1)) }
	end
	local function incOk(r) return iT == nil or math.abs(r.inc - iT) < 0.0035 end
	local function done(r) return r.ok and math.abs(r.d - goal) < math.max(2000, (goal - EARTH.R) * 0.01) and incOk(r) end
	local x = V3(dv0:dot(b.pro), dv0:dot(b.nor), dv0:dot(b.rad))
	local cur = evalC(x)
	local dlt = 0.3
	local lam = 1e-3
	local it = 0
	while it < 20 and not done(cur) do
		local cols = {}
		for k = 1, 3 do cols[k] = evalC(x:clone():addScaledVector(E3[k], dlt)).res:sub(evalC(x:clone():addScaledVector(E3[k], -dlt)).res):divideScalar(2 * dlt) end
		local A, g, tr = lmMatrix(cols, cur.res)
		local ok = false
		for _ = 1, 10 do
			local step = solve3(damped(A, lam * tr + 1e-9 * tr), g)
			if not step then lam *= 10; continue end
			if step:length() > 300 then step:setLength(300) end
			local tryX = x:clone():add(step)
			local r = evalC(tryX)
			if r.res:length() < cur.res:length() then x = tryX; cur = r; lam = math.max(1e-9, lam / 5); ok = true; break end
			lam *= 8
		end
		if onProgress then onProgress(math.min(1, (it + 1) / 8)) end
		yieldFrame()
		it += 1
		if not ok then break end
	end
	if not cur.ok or math.abs(cur.d - goal) > 40000 or (iT ~= nil and math.abs(cur.inc - iT) > 0.02) then return nil end
	return { dv = vec(x), d = cur.d, inc = cur.inc, energy = cur.energy }
end

-- trans-Earth injection from lunar orbit (periapsis at targetAlt, orbit tilted at least opts.iMin)
function O.planReturn(ship, targetAlt, onProgress, opts)
	targetAlt = targetAlt or 45000
	opts = opts or {}
	if ship.env.body ~= MOON then return nil end
	local rs = relState(ship, MOON)
	local el = O.elements(rs.r, rs.v, MOON.mu)
	if not (el.e < 1) then return nil end
	local goal, iMin = EARTH.R + targetAlt, opts.iMin or 0
	local perf = O.vacPerf(ship)
	local lead = math.max(120, (if perf then O.burnTime(ship, 900) / 2 else 0) + 90)
	local function okInc(i) return i >= iMin and i <= PI - iMin end
	local PSI, VR = {}, { -750, -550, -400, -250 }
	for d = -90, 90, 6 do table.insert(PSI, d * PI / 180) end
	local K = 72
	local span = math.min(24 * 3600, math.max(el.period, 12 * el.period))
	local nPts = math.ceil(span / (el.period / K))
	local best = nil
	local opts2 = {}
	local st = propagate(ship.r, ship.v, ship.t, lead)
	local r, v = V3(), V3()
	for k = 0, nPts - 1 do
		if k > 0 then st = propagate(st.r, st.v, st.t, el.period / K) end
		moonPos(st.t, _m); moonVel(st.t, _mv)
		r:copy(st.r):sub(_m); v:copy(st.v):sub(_mv)
		local bk = nil
		for _, psi in ipairs(PSI) do
			for _, vr in ipairs(VR) do
				local aim = returnAim(st.t + 8 * 3600, goal, psi, vr)
				if not okInc(aim.inc) then continue end
				local vb = hyperbolaVel(r, aim.vInf, MOON.mu)
				if not vb then continue end
				local dv = vb:sub(v)
				local cost = dv:length() + math.abs(psi) * 20 + (if aim.inc > PI / 2 then 250 else 0)
				if not bk or cost < bk.cost then bk = { cost = cost, st = st, dv = dv, aim = aim, tOff = st.t - ship.t, psi = psi, vr = vr } end
			end
		end
		if bk then table.insert(opts2, bk) end
		if k % 8 == 0 then yieldFrame(); if onProgress then onProgress((k / nPts) * 0.3) end end
	end
	for _, o in ipairs(opts2) do if not best or o.cost < best.cost then best = o end end
	if best then
		local lim = best.cost + math.max(40, best.cost * 0.04)
		for _, o in ipairs(opts2) do if o.cost < lim then best = o; break end end
	end
	if not best then return nil end
	local base = propagate(ship.r, ship.v, ship.t, math.max(0, best.tOff - (if perf then O.burnTime(ship, best.cost) else 0) / 2 - 30))
	local iT = if iMin > 0 then clamp(best.aim.inc, iMin + 0.005, PI - iMin - 0.005) else nil
	local ref = aimEarth(best.st, MOON, goal, iT, best.dv, function(f) if onProgress then onProgress(0.3 + 0.7 * f) end end, perf, base)
	if not ref then return nil end
	local node = { t = best.st.t, dv = ref.dv, body = MOON, label = "Return to Earth", earthPe = ref.d - EARTH.R, inc = ref.inc }
	if ref.energy ~= nil then node.eTarget = ref.energy end
	return node
end

local function solveCorrection(ship, lead, target, goal, targetAlt, onProgress)
	local st = propagate(ship.r, ship.v, ship.t, lead)
	local m, mv = moonPos(st.t, V3()), moonVel(st.t, V3())
	local inMoon = st.r:distanceTo(m) < MOON.soi
	local b = basis(if inMoon then st.r:clone():sub(m) else st.r, if inMoon then st.v:clone():sub(mv) else st.v)
	local function vec(c) return b.pro:clone():multiplyScalar(c.x):addScaledVector(b.nor, c.y):addScaledVector(b.rad, c.z) end
	local POPTS = { maxT = 7 * 86400, maxSteps = 3000, oneRev = false, maxStep = 1800, earthStop = -EARTH.R * 0.9, moonStop = false }
	local function evalC(c)
		local pr = predict(st.r, st.v:clone():add(vec(c)), st.t, POPTS)
		local p
		if target == MOON then p = if pr.closeMoon.r then pr.closeMoon.r:clone() else V3(1e12, 0, 0)
		else
			local s3, i = pr.earthPts, pr.earthPeIdx or 0
			p = V3(s3[i * 3 + 1], s3[i * 3 + 2], s3[i * 3 + 3])
		end
		local d = if target == MOON then p:length() else pr.earthPe.d
		return { p = p, d = d, f = d - goal, pr = pr }
	end
	local x = V3()
	local cur = evalC(x)
	local f0 = math.abs(cur.f)
	local tol = math.max(500, targetAlt * 0.02)
	local dlt = 0.25
	local lam = 1e-3
	local it = 0
	while it < 14 and math.abs(cur.f) > tol do
		local ok = false
		if target == EARTH then
			local J = V3()
			for k = 0, 2 do
				J:setComponent(k, (evalC(x:clone():addScaledVector(E3[k + 1], dlt)).f - evalC(x:clone():addScaledVector(E3[k + 1], -dlt)).f) / (2 * dlt))
			end
			local jj = J:lengthSq()
			if jj < 1e-9 then break end
			local step = J:clone():multiplyScalar(-cur.f / jj)
			if step:length() > 400 then step:setLength(400) end
			for _ = 1, 6 do
				local tryX = x:clone():add(step)
				local r = evalC(tryX)
				if math.abs(r.f) < math.abs(cur.f) then x = tryX; cur = r; ok = true; break end
				step:multiplyScalar(0.4)
			end
		else
			local R = cur.p:clone():sub(cur.p:clone():setLength(goal))
			local cols = {}
			for k = 1, 3 do cols[k] = evalC(x:clone():addScaledVector(E3[k], dlt)).p:sub(evalC(x:clone():addScaledVector(E3[k], -dlt)).p):divideScalar(2 * dlt) end
			local A, g, tr = lmMatrix(cols, R)
			for _ = 1, 8 do
				local step = solve3(damped(A, lam * tr), g)
				if not step then lam *= 10; continue end
				if step:length() > 400 then step:setLength(400) end
				local tryX = x:clone():add(step)
				local r = evalC(tryX)
				if math.abs(r.f) < math.abs(cur.f) then x = tryX; cur = r; lam = math.max(1e-7, lam / 5); ok = true; break end
				lam *= 8
			end
		end
		if onProgress then onProgress(math.min(1, (it + 1) / 6)) end
		yieldFrame()
		it += 1
		if not ok then break end
	end
	if math.abs(cur.f) > math.max(tol * 40, 30000) and math.abs(cur.f) >= f0 * 0.5 then return nil end
	if math.abs(cur.f) > tol * 10 then return nil end
	if x:length() < 0.05 then return nil end
	local node = { t = st.t, dv = vec(x), body = if inMoon then MOON else EARTH, label = if target == MOON then "Course correction (Moon)" else "Course correction (Earth)" }
	if target == MOON then node.moonPe = cur.d - MOON.R else node.earthPe = cur.d - EARTH.R end
	return node
end

-- mid-course correction toward `target` (Moon or Earth) with closest approach at targetAlt
function O.planCorrection(ship, target, targetAlt, onProgress, opts)
	opts = opts or {}
	local goal = (if target == MOON then MOON.R else EARTH.R) + targetAlt
	local now = predict(ship.r, ship.v, ship.t, { maxT = 7 * 86400, maxSteps = 3000, oneRev = false, maxStep = 1800, earthStop = -EARTH.R * 0.9, moonStop = false })
	local function leadsFor(tArr)
		local out = {}
		for _, l in ipairs({ 120, 3 * 3600, 8 * 3600, 16 * 3600, 30 * 3600 }) do if l == 120 or l < tArr * 0.6 then table.insert(out, l) end end
		return out
	end
	if target == EARTH and opts.iMin and opts.iMin > 0 then
		local h = V3(now.earthPe.hx, now.earthPe.hy, now.earthPe.hz)
		local inc = math.acos(clamp(h.y / math.max(1, h:length()), -1, 1))
		local iT = clamp(inc, opts.iMin + 0.005, PI - opts.iMin - 0.005)
		local leads = leadsFor(now.earthPe.t - ship.t)
		local best = nil
		for i, l in ipairs(leads) do
			local st = propagate(ship.r, ship.v, ship.t, l)
			moonPos(st.t, _m)
			local frame = if st.r:distanceTo(_m) < MOON.soi then MOON else EARTH
			local r = aimEarth(st, frame, goal, iT, V3(), function(f) if onProgress then onProgress((i - 1 + f) / #leads) end end)
			if r and r.dv:length() > 0.05 and (not best or r.dv:length() < best.dv:length() * 0.6) then
				best = { t = st.t, dv = r.dv, body = frame, label = "Course correction (Earth)", earthPe = r.d - EARTH.R, inc = r.inc }
			end
		end
		return best
	end
	local tArr = (if target == MOON then now.closeMoon.t else now.earthPe.t) - ship.t
	local leads = leadsFor(tArr)
	local best = nil
	for i, l in ipairs(leads) do
		local r = solveCorrection(ship, l, target, goal, targetAlt, function(f) if onProgress then onProgress((i - 1 + f) / #leads) end end)
		if r and (not best or r.dv:length() < best.dv:length() * 0.6) then best = r end
	end
	return best
end

-- capture into lunar orbit at the next periapsis
function O.planCapture(ship, targetAlt)
	local rs = relState(ship, MOON)
	local el = O.elements(rs.r, rs.v, MOON.mu)
	local dtTo = if isFinite(el.tPe) and el.tPe > 0 then el.tPe else 60
	if dtTo > 600 then
		local pr = predict(ship.r, ship.v, ship.t, { maxT = dtTo * 1.5 + 3600, maxSteps = 3000, oneRev = false, maxStep = 600, earthStop = -EARTH.R * 0.9, moonStop = false })
		if pr.closeMoon.r then dtTo = pr.closeMoon.t - ship.t end
		local function radial(st) moonPos(st.t, _m); moonVel(st.t, _mv); return st.r:clone():sub(_m):dot(st.v:clone():sub(_mv)) end
		local a = math.max(1, dtTo - 1200)
		local base = propagate(ship.r, ship.v, ship.t, a)
		if radial(base) < 0 and radial(propagate(base.r, base.v, base.t, 2400)) > 0 then
			local lo, hi = 0, 2400
			for _ = 1, 24 do
				local mid = (lo + hi) / 2
				if radial(propagate(base.r, base.v, base.t, mid)) < 0 then lo = mid else hi = mid end
			end
			dtTo = a + (lo + hi) / 2
		end
	end
	local st = propagate(ship.r, ship.v, ship.t, dtTo)
	moonPos(st.t, _m); moonVel(st.t, _mv)
	local r, v = st.r:clone():sub(_m), st.v:clone():sub(_mv)
	local rl = r:length()
	local vc = math.sqrt(MOON.mu / rl)
	local horiz = v:clone():addScaledVector(r:clone():normalize(), -v:dot(r) / rl):normalize()
	return { t = st.t, dv = horiz:multiplyScalar(vc):sub(v), body = MOON, label = "Lunar orbit capture" }
end

-- ---- returning to a place on Earth ----
local _Y = V3(0, 1, 0)
-- Earth-fixed position and surface-relative velocity of an inertial state
function O.groundState(r, v, t)
	local a = -earthAngle(t)
	local vs = v:clone():sub(V3(0, EARTH.omega, 0):cross(r))
	return { p = r:clone():applyAxisAngle(_Y, a), v = vs:applyAxisAngle(_Y, a) }
end
local groundState = O.groundState

-- remaining ground range of the belly-first glide below orbital speed (km/s -> km)
local GLIDE_TABLE = { { 0.95, 15 }, { 1.12, 50 }, { 1.26, 86 }, { 1.38, 125 }, { 1.5, 168 }, { 1.64, 215 }, { 1.81, 266 }, { 2.04, 323 }, { 2.35, 384 }, { 2.76, 451 }, { 3.34, 521 }, { 4.13, 597 }, { 4.94, 681 }, { 5.7, 776 }, { 6.4, 887 }, { 6.97, 1016 } }
O.ENTRY_GLIDE = 1016e3
function O.glideRange(V)
	local v, T = V / 1000, GLIDE_TABLE
	if v <= T[1][1] then return T[1][2] * 1000 end
	for i = 2, #T do
		if v <= T[i][1] then
			local f = (v - T[i - 1][1]) / (T[i][1] - T[i - 1][1])
			return (T[i - 1][2] + f * (T[i][2] - T[i - 1][2])) * 1000
		end
	end
	return T[#T][2] * 1000
end

-- ground point, track direction and ground distance while coasting (no drag) from (r, v, t) down to `alt`
function O.coastGround(r, v, t, alt)
	local c = { r = r:clone(), v = v:clone(), t = t }
	local g0 = groundState(c.r, c.v, c.t).p:normalize()
	local last, arc = g0:clone(), 0
	local k = 0
	while k < 2000 and c.r:length() - EARTH.R > alt do
		local step = clamp((c.r:length() - EARTH.R - alt) / math.max(50, -c.v:dot(c.r) / c.r:length()) * 0.5, 2, 30)
		c = propagate(c.r, c.v, c.t, step)
		local p = groundState(c.r, c.v, c.t).p:normalize()
		arc += math.acos(clamp(p:dot(last), -1, 1)) * EARTH.R
		last = p
		k += 1
	end
	local g = groundState(c.r, c.v, c.t)
	local p = g.p:normalize()
	local d = g.v:addScaledVector(p, -g.v:dot(p)):normalize()
	return { p = p, d = d, arc = arc, state = c }
end
local coastGround = O.coastGround

-- 2-D braking simulation over flat ground (see orbit.js): height above ground where the craft comes to rest
-- (negative = still moving at the ground). drag = { k(M), ground, tScale(p), air(h) }; out gets x and t.
function O.brakeSim(h, vz, vh, a, g, Rb, drag, out)
	local z, w, u, x, t = h, vz, math.max(0, vh), 0, 0
	for _ = 1, 3000 do
		local sp = math.sqrt(u * u + w * w)
		if sp < 1.5 or (w > 0 and u < 2) then if out then out.x = x; out.t = t end; return z end
		local ad = a
		if drag then
			local atm = if drag.air then drag.air(drag.ground + z) else atmosphere(drag.ground + z)
			if drag.tScale then ad *= drag.tScale(atm.p) end
			ad += 0.5 * atm.rho * sp * sp * drag.k(sp / atm.a)
		end
		local dtS = clamp(sp / (ad * 40), 0.02, 2)
		local ax = -ad * u / sp
		local az = -ad * w / sp - g + (u * u) / (Rb + z)
		x += u * dtS; t += dtS
		u = math.max(0, u + ax * dtS); w += az * dtS
		z += w * dtS
		if z <= 0 then if out then out.x = x; out.t = t end; return -math.sqrt(u * u + w * w) end
	end
	if out then out.x = x; out.t = t end
	return z
end
local brakeSim = O.brakeSim

-- rocket thrust of the active engines at pressure p as a fraction of vacuum thrust
function O.thrustScale(craft)
	local function at(p)
		local T = 0
		for _, P in ipairs(craft.engines) do
			if not P.eng.active or P.alive == false then continue end
			local e = P.eng.e
			local r = if e.type == "hybrid" then e.rocket else e
			if not r or not r.ispVac or P.eng.mode == "jet" or P.eng.mode == "air" or P.eng.mode == "scram" then continue end
			T += r.thrust * (1 - (1 - r.ispSL / r.ispVac) * math.min(1.2, p / 101325)) * (P.eng.bal or 1)
		end
		return T
	end
	local T0 = math.max(1, at(0))
	return function(p) return math.max(0.05, at(p) / T0) end
end

-- drag area (Cd·A) vs Mach of a craft falling with its thrust axis (body frame) into the flow
function O.fallDrag(craft, axisBody)
	local F, Tq, w = V3(), V3(), V3()
	local flow = axisBody:clone():normalize():negate()
	local MS = { 0.2, 0.6, 0.9, 1.1, 1.4, 2, 3, 5, 10, 30 }
	local dep = {}
	for i, P in ipairs(craft.gears) do dep[i] = P.gear.deployed; P.gear.deployed = 0 end
	local tab = {}
	for i, m in ipairs(MS) do craft:aero(flow, w, { rho = 2, mach = m, a = 300, p = 1e5, h = 0, q = 1, T = 250 }, F, Tq); tab[i] = F:length() end
	for i, P in ipairs(craft.gears) do P.gear.deployed = dep[i] end
	return function(M)
		if M <= MS[1] then return tab[1] end
		for i = 2, #MS do
			if M <= MS[i] then return tab[i - 1] + ((M - MS[i - 1]) / (MS[i] - MS[i - 1])) * (tab[i] - tab[i - 1]) end
		end
		return tab[#tab]
	end
end

-- where a falling craft (no lift) meets the ground: point-mass flight through the rotating atmosphere
function O.ballisticEnd(r0, v0, t0, mass, cda, ground)
	ground = ground or 0
	local r, v, t = r0:clone(), v0:clone(), t0
	local W = V3(0, EARTH.omega, 0)
	local va, a, rm, vm, rp = V3(), V3(), V3(), V3(), V3()
	local function accel(rr, vv, out)
		local rl = rr:length()
		local h = rl - EARTH.R
		out:copy(rr):multiplyScalar(-EARTH.mu / (rl * rl * rl))
		if h < EARTH.atmoTop then
			local atm = atmosphere(h)
			va:crossVectors(W, rr):negate():add(vv)
			local V = va:length()
			if V > 0.1 and atm.rho > 0 then out:addScaledVector(va, (-0.5 * atm.rho * V * cda(V / atm.a)) / mass) end
		end
		return out
	end
	for _ = 1, 20000 do
		local h = r:length() - EARTH.R - ground
		if h <= 0 then break end
		local dt = if h > 40000 then 2 elseif h > 5000 then 1 else 0.5
		accel(r, v, a)
		rm:copy(r):addScaledVector(v, dt / 2); vm:copy(v):addScaledVector(a, dt / 2)
		accel(rm, vm, a)
		rp:copy(r)
		r:addScaledVector(vm, dt); v:addScaledVector(a, dt); t += dt
		local h2 = r:length() - EARTH.R - ground
		if h2 <= 0 then
			local f = h / math.max(1e-6, h - h2)
			r:lerpVectors(rp, r, f); t -= dt * (1 - f)
			break
		end
	end
	return { r = r, v = v, t = t }
end

-- retrograde deorbit burn timed so the reentry glide (or the ballistic fall, with `fall`) ends near (lat, lon)
function O.planDeorbitTo(ship, lat, lon, name, onProgress, peAlt, hours, fall)
	name = name or ""; peAlt = peAlt or 40000; hours = hours or 24
	if ship.env.body ~= EARTH then return nil end
	local el = O.elements(ship.r, ship.v, EARTH.mu)
	if el.e >= 1 or el.pe - EARTH.R < 125000 then return nil end
	local tgt = llh(lat, lon, 0, 1, V3())
	local function evalAt(tOff, from)
		local st = if from then propagate(from.r, from.v, from.t, tOff - (from.t - ship.t)) else propagate(ship.r, ship.v, ship.t, tOff)
		local pro = st.v:clone():normalize()
		local lo, hi = 0, 800
		for _ = 1, 26 do
			local m = (lo + hi) / 2
			local e2 = O.elements(st.r, st.v:clone():addScaledVector(pro, -m), EARTH.mu)
			if e2.pe - EARTH.R > peAlt then lo = m else hi = m end
		end
		local dv = (lo + hi) / 2
		local c = { r = st.r, v = st.v:clone():addScaledVector(pro, -dv), t = st.t }
		for _ = 1, 400 do
			if c.r:length() - EARTH.R <= 125000 then break end
			local nx = propagate(c.r, c.v, c.t, 30)
			if nx.r:length() - EARTH.R < 125000 then break end
			c = nx
		end
		local cg = coastGround(c.r, c.v, c.t, if fall then 85000 else 55000)
		local en
		if fall then
			local b = O.ballisticEnd(cg.state.r, cg.state.v, cg.state.t, fall.mass, fall.cda, fall.ground or 0)
			en = groundState(b.r, b.v, b.t).p:normalize()
		else
			local th = O.ENTRY_GLIDE / EARTH.R
			en = cg.p:clone():multiplyScalar(math.cos(th)):addScaledVector(cg.d, math.sin(th))
		end
		local miss = math.acos(clamp(en:dot(tgt), -1, 1)) * EARTH.R
		return { tOff = tOff, dv = dv, pro = pro, st = st, miss = miss, en = en, entryP = cg.p:clone(), entryT = cg.state.t }
	end
	local span = hours * 3600
	local best = nil
	local N = math.ceil(span / 60)
	local cur = { r = ship.r:clone(), v = ship.v:clone(), t = ship.t }
	for i = 0, N - 1 do
		local tOff = 120 + i * 60
		local prev = cur
		local r = evalAt(tOff, cur)
		cur = r.st
		if not best or r.miss < best.miss then best = r; best.prev = prev end
		if i % 25 == 0 then if onProgress then onProgress(i / N * 0.9) end; yieldFrame() end
	end
	local step = 20
	while step >= 2 do
		for _, dt in ipairs({ -step, step }) do
			local r = evalAt(math.max(60, best.tOff + dt), best.prev)
			if r.miss < best.miss then r.prev = best.prev; best = r end
		end
		step /= 2
	end
	if onProgress then onProgress(1) end
	local endLL = toLLH(best.en, 1)
	return {
		t = best.st.t, dv = best.pro:clone():multiplyScalar(-best.dv), body = EARTH, label = "Deorbit to " .. (if name ~= "" then name else "target"),
		target = { lat = lat, lon = lon, name = name }, miss = best.miss, endLat = endLL.lat, endLon = endLL.lon,
	}
end

-- where a craft falling engines-first comes down after its braking burn (see orbit.js)
function O.fallLanding(r0, v0, t0, model)
	local r, v, t = r0:clone(), v0:clone(), t0
	if r:length() - EARTH.R > 126000 then
		local cg = coastGround(r, v, t, 125000)
		r = cg.state.r:clone(); v = cg.state.v:clone(); t = cg.state.t
	end
	local W = V3(0, EARTH.omega, 0)
	local va, a, rm, vm, up = V3(), V3(), V3(), V3(), V3()
	local function k(M) return model.cda(M) / model.mass end
	local function accel(rr, vv, out)
		local rl = rr:length()
		local h = rl - EARTH.R
		out:copy(rr):multiplyScalar(-EARTH.mu / (rl * rl * rl))
		if h < EARTH.atmoTop then
			local atm = atmosphere(h)
			va:crossVectors(W, rr):negate():add(vv)
			local V = va:length()
			if V > 0.1 and atm.rho > 0 then out:addScaledVector(va, -0.5 * atm.rho * V * k(V / atm.a)) end
		end
		return out
	end
	local drag = { k = k, ground = model.ground, tScale = model.tScale }
	local res = { x = 0, t = 0 }
	local nextCheck, brakeX = 0, 0
	for _ = 1, 20000 do
		local rl = r:length()
		local h = rl - EARTH.R
		local agl = h - model.ground
		if agl <= 0 then break end
		if model.aVac and agl < 30000 and t >= nextCheck then
			nextCheck = t + 0.5
			up:copy(r):divideScalar(rl)
			va:crossVectors(W, r):negate():add(v)
			local vz = va:dot(up)
			local vh = math.sqrt(math.max(0, va:lengthSq() - vz * vz))
			if brakeSim(agl, vz, vh, model.aVac, EARTH.mu / (rl * rl), EARTH.R, drag, res) <= model.hTarget + 0.03 * agl then brakeX = res.x; break end
		end
		local dt = if h > 30000 then 1 else 0.5
		accel(r, v, a)
		rm:copy(r):addScaledVector(v, dt / 2); vm:copy(v):addScaledVector(a, dt / 2)
		accel(rm, vm, a)
		r:addScaledVector(vm, dt); v:addScaledVector(a, dt); t += dt
	end
	local gs = groundState(r, v, t)
	local p = gs.p:normalize()
	local d = gs.v:addScaledVector(p, -gs.v:dot(p)):normalize()
	if brakeX ~= 0 then p:addScaledVector(d, brakeX / EARTH.R):normalize() end
	return { p = p, d = d, t = t + (if brakeX ~= 0 then res.t else 0) }
end

-- engine classes: 'lift' (thrust across the nose axis), 'jets' (air-breathing), 'main' (rockets and fusion)
function O.engineClass(P)
	local e = P.eng.e
	if e.lift or math.abs(P.eng.dir.z) < 0.5 then return "lift" end
	if e.type == "jet" or e.type == "scram" then return "jets" end
	return "main"
end
local engineClass = O.engineClass

-- everything the landing predictions need to know about a craft falling with its thrust axis into the flow
function O.landingModel(craft, axisBody, ground)
	ground = ground or 0
	local cda, tScale = O.fallDrag(craft, axisBody), O.thrustScale(craft)
	local hasMain, hasLift = false, false
	for _, P in ipairs(craft.engines) do
		if P.alive == false then continue end
		local c = engineClass(P)
		if c == "main" then hasMain = true elseif c == "lift" then hasLift = true end
	end
	local T = 0
	for _, P in ipairs(craft.engines) do
		if P.alive == false then continue end
		if not hasMain or engineClass(P) == "main" then T += (craft:engineOutput(P, VAC)) end
	end
	return { mass = craft.mass, cda = cda, ground = ground, aVac = (T / craft.mass) * 0.85, tScale = tScale, hTarget = if hasMain and hasLift then 650 else 120 }
end

-- ---- landing on a chosen spot on the Moon ----
local _mx, _my, _mz = V3(), V3(), V3()
function O.moonFixed(v, t, pos, out)
	if pos == nil then pos = true end
	out = out or V3()
	moonPos(t, _m); moonBasis(t, _m, _mx, _my, _mz)
	local d = if pos then v:clone():sub(_m) else v
	return out:set(d:dot(_mx), d:dot(_my), d:dot(_mz))
end
local moonFixed = O.moonFixed
function O.moonToI(pF, t, out)
	out = out or V3()
	moonPos(t, _m); moonBasis(t, _m, _mx, _my, _mz)
	return out:copy(_m):addScaledVector(_mx, pF.x):addScaledVector(_my, pF.y):addScaledVector(_mz, pF.z)
end
local moonToI = O.moonToI

-- where a craft coasting toward the Moon comes down after its braking burn (vacuum)
function O.moonLanding(r0, v0, t0, model)
	local st = { r = r0:clone(), v = v0:clone(), t = t0 }
	local res = { x = 0, t = 0 }
	local rr, vv = V3(), V3()
	for _ = 1, 5000 do
		moonPos(st.t, _m); moonVel(st.t, _mv)
		rr:copy(st.r):sub(_m); vv:copy(st.v):sub(_mv)
		local rl = rr:length()
		local h = rl - MOON.R - model.ground
		local vz = vv:dot(rr) / rl
		local vh = math.sqrt(math.max(0, vv:lengthSq() - vz * vz))
		local done, margin = h <= 0, INF
		if not done and h < 40000 and vz < 0 then
			margin = brakeSim(h, vz, vh, model.aVac, MOON.mu / (rl * rl), MOON.R, nil, res) - (model.hTarget + 0.03 * h)
			if margin <= 0 then done = true end
		end
		if done then
			local p = moonFixed(st.r, st.t):normalize()
			local d = moonFixed(vv, st.t, false); d:addScaledVector(p, -d:dot(p)):normalize()
			if h > 0 then p:addScaledVector(d, res.x / MOON.R):normalize() end
			return { p = p, d = d, t = st.t + (if h > 0 then res.t else 0) }
		end
		local step
		if h > 45000 then step = clamp(((h - 40000) / math.max(1, -vz)) * 0.3, 1, 120)
		elseif isFinite(margin) then step = clamp((margin / math.max(1, -vz)) * 0.4, 1, 60)
		else step = if vz >= 0 then 10 else 1 end
		st = propagate(st.r, st.v, st.t, step)
	end
	return { p = moonFixed(st.r, st.t):normalize(), d = V3(1, 0, 0), t = st.t }
end

-- descent from lunar orbit to land at (lat, lon) on the Moon (searches the next days for a good pass)
function O.planMoonLandingTo(ship, lat, lon, name, onProgress, model, hours)
	hours = hours or 14 * 24
	if ship.env.body ~= MOON then return nil end
	local rs0 = relState(ship, MOON)
	local el = O.elements(rs0.r, rs0.v, MOON.mu)
	if not (el.e < 1) or el.pe - MOON.R < 8000 then return nil end
	local tgt = llh(lat, lon, 0, 1, V3())
	local peTarget = model.ground - 25000
	local function evalAt(st, dvN)
		moonPos(st.t, _m); moonVel(st.t, _mv)
		local r, v = st.r:clone():sub(_m), st.v:clone():sub(_mv)
		local b = basis(r, v)
		local vN = v:clone():addScaledVector(b.nor, dvN)
		local lo, hi = 0, 1500
		for _ = 1, 24 do
			local m = (lo + hi) / 2
			local e2 = O.elements(r, vN:clone():addScaledVector(b.pro, -m), MOON.mu)
			if e2.pe - MOON.R > peTarget then lo = m else hi = m end
		end
		local dv = (lo + hi) / 2
		local vec = b.pro:clone():multiplyScalar(-dv):addScaledVector(b.nor, dvN)
		local L = O.moonLanding(st.r, st.v:clone():add(vec), st.t, model)
		local off = tgt:clone():sub(L.p)
		return { st = st, dv = dv, dvN = dvN, vec = vec, en = L.p, along = off:dot(L.d) * MOON.R, cross = off:dot(V3():crossVectors(L.p, L.d)) * MOON.R, miss = math.acos(clamp(L.p:dot(tgt), -1, 1)) * MOON.R, tLand = L.t }
	end
	local st = propagate(ship.r, ship.v, ship.t, 180)
	local ref = evalAt(st, 0)
	local fallT = ref.tLand - st.t
	local rI = st.r:clone():sub(moonPos(st.t, V3()))
	local landI = moonToI(ref.en:clone():multiplyScalar(MOON.R), ref.tLand):sub(moonPos(ref.tLand, V3()))
	local arc = math.acos(clamp(rI:clone():normalize():dot(landI:clone():normalize()), -1, 1))
	local scan = {}
	local N = math.ceil((hours * 3600) / 60)
	for i = 0, N - 1 do
		if i > 0 then st = propagate(st.r, st.v, st.t, 60) end
		moonPos(st.t, _m); moonVel(st.t, _mv)
		local r, v = st.r:clone():sub(_m), st.v:clone():sub(_mv)
		local nrm = V3():crossVectors(r, v):normalize()
		local pI = r:clone():normalize():applyAxisAngle(nrm, arc)
		local pF = moonFixed(pI, st.t + fallT, false):normalize()
		table.insert(scan, { st = st, miss = math.acos(clamp(pF:dot(tgt), -1, 1)) * MOON.R })
		if i % 120 == 0 then if onProgress then onProgress((i / N) * 0.5) end; yieldFrame() end
	end
	local cands = {}
	for i = 2, #scan - 1 do
		if scan[i].miss <= scan[i - 1].miss and scan[i].miss <= scan[i + 1].miss then
			local c = copyTable(scan[i]); c.base = scan[math.max(1, i - 40)].st
			table.insert(cands, c)
		end
	end
	table.sort(cands, function(a, b) return a.miss < b.miss end)
	local sols = {}
	local top, seen = {}, {}
	local function addTop(c) if not seen[c] then seen[c] = true; table.insert(top, c) end end
	for i = 1, math.min(6, #cands) do addTop(cands[i]) end
	local nSoon = 0
	for _, c in ipairs(cands) do if c.st.t - ship.t < 86400 and nSoon < 2 then nSoon += 1; addTop(c) end end
	for ci, c0 in ipairs(top) do
		local base = c0.base
		local tOff, n = c0.st.t - base.t, 0
		local function at(dt, dn) return evalAt(propagate(base.r, base.v, base.t, math.max(0, dt)), dn) end
		local cur = at(tOff, 0)
		local it = 0
		while it < 12 and cur.miss > 150 do
			local a, b = at(tOff + 1, n), at(tOff, n + 5)
			local J = { { a.along - cur.along, (b.along - cur.along) / 5 }, { a.cross - cur.cross, (b.cross - cur.cross) / 5 } }
			local det = J[1][1] * J[2][2] - J[1][2] * J[2][1]
			if not isFinite(det) or math.abs(det) < 1e-9 then break end
			local dt = clamp((-cur.along * J[2][2] + cur.cross * J[1][2]) / det, -900, 900)
			local dn = clamp((-cur.cross * J[1][1] + cur.along * J[2][1]) / det, -300, 300)
			local nx = at(tOff + dt, n + dn)
			for _ = 1, 4 do if nx.miss <= cur.miss then break end; dt /= 2; dn /= 2; nx = at(tOff + dt, n + dn) end
			if nx.miss > cur.miss then break end
			tOff += dt; n += dn; cur = nx
			yieldFrame()
			it += 1
		end
		if cur.miss < 1500 and math.abs(n) < 1200 then table.insert(sols, cur) end
		if onProgress then onProgress(0.5 + (0.5 * ci) / #top) end
	end
	if onProgress then onProgress(1) end
	local function cost(r) return r.vec:length() + ((r.st.t - ship.t) / 3600) * 1.5 end
	table.sort(sols, function(a, b) return cost(a) < cost(b) end)
	local best = sols[1]
	if not best then return nil end
	return { t = best.st.t, dv = best.vec, body = MOON, label = "Descent to " .. (name or "target"), target = { lat = lat, lon = lon, name = name, elev = model.ground, body = "moon" }, miss = best.miss, vertical = true }
end

-- deorbit for a vertical lander that falls engines-first and lands propulsively at (lat, lon) on Earth
function O.planLandingTo(ship, lat, lon, name, onProgress, fall, hours)
	hours = hours or 48
	if ship.env.body ~= EARTH then return nil end
	local el = O.elements(ship.r, ship.v, EARTH.mu)
	if el.e >= 1 or el.pe - EARTH.R < 125000 then return nil end
	local tgt = llh(lat, lon, 0, 1, V3())
	local peAlt = 20000
	local fallArc = nil
	local function evalAt(st, dvN, quick)
		local b = basis(st.r, st.v)
		local vN = st.v:clone():addScaledVector(b.nor, dvN)
		local lo, hi = 0, 900
		for _ = 1, 24 do
			local m = (lo + hi) / 2
			local e2 = O.elements(st.r, vN:clone():addScaledVector(b.pro, -m), EARTH.mu)
			if e2.pe - EARTH.R > peAlt then lo = m else hi = m end
		end
		local dv = (lo + hi) / 2
		local c = { r = st.r, v = vN:clone():addScaledVector(b.pro, -dv), t = st.t }
		for _ = 1, 400 do
			if c.r:length() - EARTH.R <= 140000 then break end
			local nx = propagate(c.r, c.v, c.t, 30)
			if nx.r:length() - EARTH.R < 140000 then break end
			c = nx
		end
		local en, d, tL
		if quick and fallArc ~= nil then
			local cg = coastGround(c.r, c.v, c.t, 125000)
			en = cg.p:clone():multiplyScalar(math.cos(fallArc)):addScaledVector(cg.d, math.sin(fallArc))
			d = cg.d; tL = cg.state.t
		else
			local L = O.fallLanding(c.r, c.v, c.t, fall)
			en = L.p; d = L.d; tL = L.t
			if quick then local cg = coastGround(c.r, c.v, c.t, 125000); fallArc = math.acos(clamp(cg.p:dot(en), -1, 1)) end
		end
		local off = tgt:clone():sub(en)
		return { st = st, dv = dv, dvN = dvN, vec = b.pro:clone():multiplyScalar(-dv):addScaledVector(b.nor, dvN), en = en, along = off:dot(d) * EARTH.R, cross = off:dot(V3():crossVectors(en, d)) * EARTH.R, miss = math.acos(clamp(en:dot(tgt), -1, 1)) * EARTH.R, tLand = tL }
	end
	local scan = {}
	local N = math.ceil((hours * 3600) / 60)
	local st = propagate(ship.r, ship.v, ship.t, 120)
	for i = 0, N - 1 do
		if i > 0 then st = propagate(st.r, st.v, st.t, 60) end
		table.insert(scan, evalAt(st, 0, true))
		if i % 20 == 0 then if onProgress then onProgress((i / N) * 0.6) end; yieldFrame() end
	end
	local cands = {}
	for i = 2, #scan - 1 do
		if scan[i].miss <= scan[i - 1].miss and scan[i].miss <= scan[i + 1].miss then
			local c = copyTable(scan[i]); c.base = scan[math.max(1, i - 3)].st
			table.insert(cands, c)
		end
	end
	table.sort(cands, function(a, b) return a.miss < b.miss end)
	for i = 1, math.min(5, #cands) do
		local c = cands[i]
		for k, v in pairs(evalAt(c.st, 0)) do c[k] = v end
	end
	local sols = {}
	for ci = 1, math.min(6, #cands) do
		local c0 = cands[ci]
		local base = c0.base
		local tOff, n, cur = c0.st.t - base.t, 0, c0
		local function at(dt, dn) return evalAt(propagate(base.r, base.v, base.t, math.max(0, dt)), dn) end
		local it = 0
		while it < 12 and cur.miss > 300 do
			local a, b = at(tOff + 1, n), at(tOff, n + 10)
			local J = { { a.along - cur.along, (b.along - cur.along) / 10 }, { a.cross - cur.cross, (b.cross - cur.cross) / 10 } }
			local det = J[1][1] * J[2][2] - J[1][2] * J[2][1]
			if not isFinite(det) or math.abs(det) < 1e-9 then break end
			local dt = clamp((-cur.along * J[2][2] + cur.cross * J[1][2]) / det, -90, 90)
			local dn = clamp((-cur.cross * J[1][1] + cur.along * J[2][1]) / det, -400, 400)
			local nx = at(tOff + dt, n + dn)
			for _ = 1, 4 do if nx.miss <= cur.miss then break end; dt /= 2; dn /= 2; nx = at(tOff + dt, n + dn) end
			if nx.miss > cur.miss then break end
			tOff += dt; n += dn; cur = nx
			yieldFrame()
			it += 1
		end
		if cur.miss < 3000 and math.abs(n) < 1500 then table.insert(sols, cur) end
		if onProgress then onProgress(math.min(0.98, 0.6 + 0.065 * ci)) end
	end
	if onProgress then onProgress(1) end
	local function cost(r) return r.vec:length() + (r.st.t - ship.t) / 3600 * 8 end
	table.sort(sols, function(a, b) return cost(a) < cost(b) end)
	local best = sols[1] or cands[1]
	if not best then return nil end
	return { t = best.st.t, dv = best.vec, body = EARTH, label = "Deorbit to " .. (name or "target"), target = { lat = lat, lon = lon, name = name }, miss = best.miss, vertical = true }
end

function O.burnTime(ship, dv)
	local craft = ship.craft
	local T, mdot = 0, 0
	local env = if ship.env.rho > 1e-4 then ship.env else { body = ship.env.body, rho = 0, p = 0, mach = 0, h = 1e6, a = ship.env.a }
	for _, P in ipairs(craft.engines) do
		if not P.eng.active then continue end
		local t, isp = craft:engineOutput(P, env)
		local tb = t * (P.eng.bal or 1)
		if tb > 0 then T += tb; mdot += tb / (isp * 9.80665) end
	end
	if T <= 0 then return INF end
	local ve, m0 = T / mdot, craft.mass
	local m1 = m0 / math.exp(dv / ve)
	return (m0 - m1) / mdot
end

-- delta-v available (vacuum by default) from the propellant on board
function O.deltaV(craft, atm, filter)
	local T, mdot = 0, 0
	local env = if atm then { rho = 1.225, p = 101325, mach = 0, h = 0, a = 340 } else VAC
	local use = {}
	if not filter then
		local cls, hybrid = {}, false
		for i, P in ipairs(craft.engines) do cls[i] = engineClass(P); if P.eng.e.type == "hybrid" then hybrid = true end end
		local want
		if atm then
			local jets = false
			for _, c in ipairs(cls) do if c == "jets" then jets = true end end
			want = if jets or hybrid then { jets = true, main = true } else { main = true }
		else want = { main = true } end
		local anyWanted = false
		for _, c in ipairs(cls) do if want[c] then anyWanted = true end end
		filter = if anyWanted then function(P) return want[engineClass(P)] == true end else function() return true end
	end
	for _, P in ipairs(craft.engines) do
		if not P.alive or not filter(P) then continue end
		local saveMode = P.eng.mode
		if P.eng.e.type == "hybrid" and not atm then P.eng.mode = "rocket" end
		local t, isp = craft:engineOutput(P, env)
		if t > 0 then
			T += t; mdot += t / (isp * 9.80665)
			for k, share in pairs(craft:fuelMix(P)) do use[k] = (use[k] or 0) + share * t / (isp * 9.80665) end
		end
		P.eng.mode = saveMode
	end
	if mdot <= 0 then return 0 end
	local ve = T / mdot
	local tMax = INF
	for k, u in pairs(use) do tMax = math.min(tMax, craft:amount(k) / u) end
	if not isFinite(tMax) then return 0 end
	local m0 = craft.mass
	local m1 = m0 - mdot * tMax
	return ve * math.log(m0 / math.max(1, m1))
end


return O
