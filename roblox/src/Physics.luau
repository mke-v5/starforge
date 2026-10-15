--!native
-- Rigid-body flight physics in the geocentric inertial frame I, doubles throughout (port of src/ship/physics.js).
-- `world` supplies the ground: groundAt(body, lat, lon), isWater(lat, lon), buildingTop(lat, lon, h), nearBuildings.

local THREE = require(script.Parent.Three)
local Geo = require(script.Parent.Geo)
local Atmo = require(script.Parent.Atmo)
local Astro = require(script.Parent.Astro)
local V3, Quat, M4 = THREE.Vector3.new, THREE.Quaternion.new, THREE.Matrix4.new
local EARTH, MOON, MARS, SUN, G0, clamp, toLLH, llh, enu, D2R = Geo.EARTH, Geo.MOON, Geo.MARS, Geo.SUN, Geo.G0, Geo.clamp, Geo.toLLH, Geo.llh, Geo.enu, Geo.D2R
local airAt = Atmo.airAt
local gravity, moonPos, moonVel, marsPos, marsVel, sunPos, sunVel, marsBasis, earthAngle =
	Astro.gravity, Astro.moonPos, Astro.moonVel, Astro.marsPos, Astro.marsVel, Astro.sunPos, Astro.sunVel, Astro.marsBasis, Astro.earthAngle

local Y = V3(0, 1, 0)
local _rF, _rT = V3(), V3()
local _a, _b, _c, _d = V3(), V3(), V3(), V3()
local _F, _T, _Fa, _Ta = V3(), V3(), V3(), V3()
local _q, _qi = Quat(), Quat()
local _p, _vp, _vg, _fx = V3(), V3(), V3(), V3()
local _e, _no, _up = V3(), V3(), V3()
local _gq = Quat()
local _cf = V3()
local _qShipInv = Quat()
local _mx, _my, _mz, _m4, _sd = V3(), V3(), V3(), M4(), V3()

local Physics = {}

local Ship = {}
Ship.__index = Ship
Physics.Ship = Ship

function Ship.new(craft, world, eph, settings)
	local self = setmetatable({}, Ship)
	self.craft = craft
	self.world = world
	self.eph = eph
	self.settings = settings or { heatScale = 1, crashScale = 1 }
	self.r = V3(); self.v = V3(); self.q = Quat(); self.w = V3()
	self.t = eph.t
	self.ctl = { pitch = 0, yaw = 0, roll = 0, throttle = 0, brake = 1, gear = true, rcs = true, tx = 0, ty = 0, tz = 0, engineMode = "auto", steer = 0 }
	self.cmdT = V3()
	self.rcsT = nil
	self.parked = nil
	self.parkTimer = 0
	self.warp = 1
	self.events = {}
	self.dead = false
	self.env = { body = EARTH, h = 0, agl = 0, rho = 0, p = 0, T = 288, a = 340, mach = 0, lat = 0, lon = 0, vAir = V3(), vSurf = 0, vVert = 0, ground = 0, q = 0, inSun = true, water = false, up = V3(0, 1, 0) }
	self.contacts = 0
	self.gForce = 1
	self.lastV = V3()
	self.lastT = 0
	self.thrustNow = 0
	self.thrustB = V3()
	self.aeroB = V3()
	self.heatOn = true
	self.maxQ = 0
	return self
end

-- --------- frames ---------
function Ship:bodyFrameQ(body, t, out)
	if body == EARTH then return out:setFromAxisAngle(Y, earthAngle(t)) end
	if body == SUN then return out:identity() end
	if body == MARS then
		local dt = t - self.eph.t
		if math.abs(dt) > 600 then marsBasis(t, _mx, _my, _mz); return out:setFromRotationMatrix(_m4:makeBasis(_mx, _my, _mz)) end
		return out:setFromAxisAngle(self.eph.aY, MARS.omega * dt):multiply(self.eph.marsQ)
	end
	return out:copy(self.eph.moonQ)
end
function Ship:bodyCenter(body, t, out)
	if body == EARTH then return out:set(0, 0, 0) end
	local dt, E = t - self.eph.t, self.eph
	if math.abs(dt) > 2 then
		if body == MARS then return marsPos(t, out) elseif body == SUN then return sunPos(t, out) end
		return moonPos(t, out)
	end
	if body == MARS then return out:copy(E.mars):addScaledVector(E.marsV, dt) end
	if body == SUN then return out:copy(E.sunP):addScaledVector(E.sunV, dt) end
	return out:copy(E.moon):addScaledVector(E.moonV, dt)
end
function Ship:bodyVel(body, t, out)
	if body == EARTH then return out:set(0, 0, 0) end
	local dt, E = t - self.eph.t, self.eph
	if math.abs(dt) > 2 then
		if body == MARS then return marsVel(t, out) elseif body == SUN then return sunVel(t, out) end
		return moonVel(t, out)
	end
	return out:copy(if body == MARS then E.marsV elseif body == SUN then E.sunV else E.moonV)
end
function Ship:toFixed(body, pI, t, out)
	self:bodyCenter(body, t, _a)
	self:bodyFrameQ(body, t, _q)
	return out:copy(pI):sub(_a):applyQuaternion(_qi:copy(_q):invert())
end
function Ship:toI(body, pF, t, out)
	self:bodyCenter(body, t, _a)
	self:bodyFrameQ(body, t, _q)
	return out:copy(pF):applyQuaternion(_q):add(_a)
end
function Ship:surfaceVel(body, pI, t, out)
	if body == EARTH then return out:set(EARTH.omega * pI.z, 0, -EARTH.omega * pI.x) end
	if body == SUN then return self:bodyVel(SUN, t, out) end
	self:bodyCenter(body, t, _a)
	_b:copy(pI):sub(_a)
	out:crossVectors(if body == MARS then self.eph.aY else self.eph.mY, _b):multiplyScalar(body.omega)
	return out:add(self:bodyVel(body, t, _a))
end
function Ship:dominant(pI, t)
	local de = pI:length()
	if de < EARTH.soi then
		if de > 2.5e8 then self:bodyCenter(MOON, t, _c); if pI:distanceTo(_c) < MOON.soi then return MOON end end
		return EARTH
	end
	self:bodyCenter(MARS, t, _c)
	return if pI:distanceTo(_c) < MARS.soi then MARS else SUN
end

-- place the ship at rest on a body: lat/lon/height of the COM, heading (rad from north), pitch (rad)
function Ship:placeAt(body, lat, lon, hCom, heading, pitch, roll)
	local pF = llh(lat, lon, hCom, body.R, V3())
	local up, east, north = V3(), V3(), V3()
	enu(pF, up, east, north)
	local fwd = north:clone():multiplyScalar(math.cos(heading)):add(east:clone():multiplyScalar(math.sin(heading)))
	local zB = fwd:clone():negate()
	local m = M4():makeBasis(V3():crossVectors(up, zB):normalize(), up, zB)
	local qF = Quat():setFromRotationMatrix(m)
	if pitch and pitch ~= 0 then qF:multiply(Quat():setFromAxisAngle(V3(1, 0, 0), pitch)) end
	if roll and roll ~= 0 then qF:multiply(Quat():setFromAxisAngle(V3(0, 0, -1), roll)) end
	self:bodyFrameQ(body, self.t, _q)
	self.q:copy(_q):multiply(qF)
	self:toI(body, pF, self.t, self.r)
	self:surfaceVel(body, self.r, self.t, self.v)
	self.w:set(0, 0, 0)
	self.parked = { body = body, pF = pF:clone(), qF = qF:clone() }
	self.parkTimer = 0
end

function Ship:bodyToWorld(b, out) return out:copy(b):sub(self.craft.com):applyQuaternion(self.q):add(self.r) end
function Ship:dirToWorld(b, out) return out:copy(b):applyQuaternion(self.q) end
function Ship:dirToBody(w, out) return out:copy(w):applyQuaternion(_qi:copy(self.q):invert()) end

local function shadowed(p, sun, c, R)
	local dx, dy, dz = p.x - c.x, p.y - c.y, p.z - c.z
	local along = dx * sun.x + dy * sun.y + dz * sun.z
	if along > 0 then return false end
	local d2 = dx * dx + dy * dy + dz * dz - along * along
	return d2 < R * R
end

-- --------- environment ---------
function Ship:updateEnv(t)
	local E = self.env
	local body = self:dominant(self.r, t)
	E.body = body
	self:toFixed(body, self.r, t, _fx)
	local ll = toLLH(_fx, body.R)
	E.lat = ll.lat; E.lon = ll.lon; E.h = ll.h
	E.ground = if body == SUN then 0 else self.world:groundAt(body, ll.lat, ll.lon)
	E.agl = E.h - E.ground
	E.water = body == EARTH and E.ground <= 0.3 and self.world:isWater(ll.lat, ll.lon)
	local atm = airAt(body, E.h)
	E.rho = atm.rho; E.p = atm.p; E.T = atm.T; E.a = atm.a
	self:surfaceVel(body, self.r, t, _vg)
	E.vAir:copy(self.v):sub(_vg)
	local vs = E.vAir:length()
	E.vSurf = vs; E.mach = vs / atm.a
	E.q = 0.5 * E.rho * vs * vs
	_up:copy(self.r):sub(self:bodyCenter(body, t, _a)):normalize()
	E.vVert = E.vAir:dot(_up)
	E.up = _up:clone()
	local sun = self:bodyCenter(SUN, t, _sd):sub(self.r):normalize()
	E.inSun = not shadowed(self.r, sun, _a:set(0, 0, 0), EARTH.R) and not shadowed(self.r, sun, self:bodyCenter(MOON, t, _b), MOON.R)
		and (body ~= MARS or not shadowed(self.r, sun, self:bodyCenter(MARS, t, _b), MARS.R))
	return E
end

-- --------- main step ---------
function Ship:step(dtFrame, controller)
	if self.dead then return end
	local craft = self.craft
	local warp = self.warp
	local rails = warp > 4
	if self.parked then self:stepParked(dtFrame * warp, controller); return end
	if rails then self:stepRails(dtFrame * warp, controller); return end
	local total = dtFrame * warp
	local contactish = self.contacts > 0 or self.env.agl < 50
	local h = if contactish then 1 / 240 else 1 / 120
	local n = math.min(64, math.max(1, math.ceil(total / h)))
	local dt = total / n
	self.lastV:copy(self.v)
	craft:balanceEngines(self.env)
	for i = 0, n - 1 do
		self:updateEnv(self.t)
		if controller and i % 2 == 0 then controller:update(self, dt * 2) end
		self:substep(dt)
		self.t += dt
		if self.dead then break end
	end
	craft:recompute()
	if self.heatOn then
		local vb = self:dirToBody(self.env.vAir, _d)
		local engHeat = 0
		for _, P in ipairs(craft.engines) do engHeat += P.eng.e.heat * P.eng.thr * (if P.eng.flame > 0 then 1 else 0) end
		craft.radLoad = if craft.radCap > 0 then engHeat / craft.radCap else 0
		local hot = craft:heat(total, vb, self.env, engHeat, self.settings.heatScale or 1, self.env.inSun)
		for _, P in ipairs(hot) do self:breakPart(P, "overheat") end
	end
	gravity(self.r, self.t, _a)
	local acc = _c:copy(self.v):sub(self.lastV):divideScalar(math.max(1e-6, total)):sub(_a)
	self.gForce = self.gForce * 0.85 + (acc:length() / G0) * 0.15
	self.maxQ = math.max(self.maxQ, self.env.q)
	self:checkBuildings()
	self:checkPark(total)
	if craft.solar > 0 and self.env.inSun then craft.ec = math.min(craft.ecCap, craft.ec + craft.solar * total / 3600 * 10) end
	if self.thrustNow > 0 then craft.ec = math.min(craft.ecCap, craft.ec + total / 3600 * 50) end
end

function Ship:substep(dt)
	local craft, ctl, E = self.craft, self.ctl, self.env
	local com = craft.com
	_F:set(0, 0, 0); _T:set(0, 0, 0)
	local thrustTotal = 0
	for _, P in ipairs(craft.engines) do
		local eng, e = P.eng, P.eng.e
		if e.type == "hybrid" then
			if ctl.engineMode == "air" then eng.mode = "air"
			elseif ctl.engineMode == "rocket" then eng.mode = "rocket"
			else
				eng.mode = "air"
				local air = craft:engineOutput(P, E)
				local hasOx = craft:amount("OX") > 1
				eng.mode = if hasOx and air < e.rocket.thrust * 0.45 then "rocket" else "air"
			end
		end
		local cmd = if eng.active then ctl.throttle else 0
		local rate = 1 / math.max(0.05, e.spool)
		eng.thr += clamp(cmd - eng.thr, -rate * dt, rate * dt)
		if eng.thr < 1e-4 then eng.flame = 0; eng.thrust = 0; continue end
		local Tmax, isp = craft:engineOutput(P, E)
		local T = Tmax * math.min(1, eng.thr * (eng.bal or 1) * (1 + (eng.dq or 0)))
		if T <= 0 or isp <= 0 then eng.flame = 0; eng.thrust = 0; continue end
		local mdot = T / (isp * G0)
		local mix = craft:fuelMix(P)
		local frac = 1
		for k, share in pairs(mix) do
			local want = mdot * share * dt
			local got = craft:draw(k, want)
			if want > 0 then frac = math.min(frac, got / want) end
		end
		T *= frac
		eng.thrust = T
		eng.flame = T / math.max(1, (if e.type == "hybrid" and eng.mode == "rocket" then e.rocket.thrust else e.thrust))
		if T <= 0 then continue end
		thrustTotal += T
		local gm = (e.gimbal or 0) * D2R
		_a:copy(eng.dir)
		if gm > 0 then _a:addScaledVector(eng.gx, eng.g1 * gm):addScaledVector(eng.gz, eng.g2 * gm):normalize() end
		_a:multiplyScalar(T)
		_F:add(_a)
		_b:copy(eng.pos):sub(com)
		_T:add(_c:crossVectors(_b, _a))
	end
	self.thrustNow = thrustTotal
	self.thrustB:copy(_F)
	if self.dbg then self.dbg.eng:copy(_T) end
	self.aeroB:set(0, 0, 0)
	if E.rho > 0 then
		local vb = self:dirToBody(E.vAir, _d)
		craft:aero(vb, self.w, E, _Fa, _Ta)
		_F:add(_Fa); _T:add(_Ta)
		self.aeroB:copy(_Fa)
		if self.dbg then self.dbg.aero:copy(_Ta) end
	end
	if craft.wheelTorque > 0 and craft.ec > 0 then
		_a:copy(self.cmdT):multiplyScalar(craft.wheelTorque)
		_T:add(_a)
		craft.ec = math.max(0, craft.ec - (math.abs(self.cmdT.x) + math.abs(self.cmdT.y) + math.abs(self.cmdT.z)) * craft.wheelTorque * dt / 3.6e9)
	end
	if ctl.rcs and #craft.rcsList > 0 and E.rho < 0.05 then self:rcs(dt, _F, _T) end
	local Fw = _F:applyQuaternion(self.q)
	if self.dbg then self.dbg.pre:copy(_T) end
	self:contactForces(dt, Fw, _T)
	gravity(self.r, self.t, _a)
	local m = craft.mass
	self.v:addScaledVector(Fw, dt / m):addScaledVector(_a, dt)
	self.r:addScaledVector(self.v, dt)
	local Iw = _b:copy(self.w):applyMatrix3(craft.I)
	_c:crossVectors(self.w, Iw)
	_T:sub(_c)
	_T:applyMatrix3(craft.Iinv)
	self.w:addScaledVector(_T, dt)
	local wl = self.w:length()
	if wl > 12 then self.w:multiplyScalar(12 / wl) end
	if wl > 1e-9 then
		_gq:setFromAxisAngle(_a:copy(self.w):divideScalar(wl), wl * dt)
		self.q:multiply(_gq):normalize()
	end
end

function Ship:rcs(dt, F, T)
	local craft, ctl = self.craft, self.ctl
	local com = craft.com
	local trans = _e:set(ctl.tx, ctl.ty, ctl.tz)
	local cmd = self.rcsT or self.cmdT
	local fuel = 0
	_rF:set(0, 0, 0); _rT:set(0, 0, 0)
	for _, P in ipairs(craft.rcsList) do
		local R = P.rcs
		_b:copy(R.pos):sub(com)
		for i = 1, 4 do
			local d = R.dirs[i]
			_a:copy(d):multiplyScalar(-1)
			_c:crossVectors(_b, _a)
			local cl = _c:length()
			local fr = 0
			if cl > 1e-3 then fr = math.max(0, _c:dot(cmd) / cl) end
			local ft = math.max(0, _a:dot(trans))
			local f = math.min(1, fr + ft)
			R.fire[i] = f
			if f < 0.02 then continue end
			local thrust = P.def.rcs.thrust * f
			_rF:addScaledVector(_a, P.def.rcs.thrust * math.min(ft, f))
			_rT:add(_c:multiplyScalar(thrust))
			fuel += thrust / (P.def.rcs.isp * G0) * dt
		end
	end
	if fuel > 0 then
		local gas = craft:draw("GAS", fuel)
		local got = (gas + (if gas < fuel then craft:draw("LF", fuel - gas) else 0)) / fuel
		if got < 0.999 then for _, P in ipairs(craft.rcsList) do for i = 1, 4 do P.rcs.fire[i] *= got end end end
		F:addScaledVector(_rF, got); T:addScaledVector(_rT, got)
	end
end

function Ship:contactForces(dt, Fw, Tb)
	local craft, E, ctl = self.craft, self.env, self.ctl
	local com = craft.com
	local body = E.body
	for _, P in ipairs(craft.gears) do local G = P.gear; G.deployed += clamp((if ctl.gear then 1 else 0) - G.deployed, -dt / 3, dt / 3) end
	if E.agl > craft.size + 30 and not self.world.nearBuildings then
		self.contacts = 0
		for _, P in ipairs(craft.gears) do P.gear.contact = false; P.gear.comp = 0 end
		return
	end
	local contacts = 0
	local m = craft.mass
	local qInv = _qShipInv:copy(self.q):invert()
	for _, P in ipairs(craft.gears) do
		local G = P.gear
		local g = G.g
		if G.deployed < 0.95 then G.contact = false; G.comp = 0; continue end
		_p:copy(G.ext):multiplyScalar(g.len + g.wheel):add(G.mount)
		local res = self:probe(_p, body)
		if not res then G.contact = false; G.comp = 0; G.spin *= 0.99; continue end
		local depth, n, vrel, pw = res.depth, res.n, res.vrel, res.pw
		local stroke = g.stroke or g.len * 0.3
		local vn = vrel:dot(n)
		if not G.contact and -vn > (P.def.crash or 8) * (self.settings.crashScale or 1) then self:breakPart(P, "impact", -vn); continue end
		G.contact = true
		contacts += 1
		G.comp = math.min(depth, stroke)
		local Fn = g.k * math.min(depth, stroke) - g.c * vn
		if depth > stroke then Fn += g.k * 10 * (depth - stroke) - g.c * 2 * vn end
		Fn = math.max(0, math.min(Fn, g.load * G0 * 6))
		G.load = Fn
		local fwdW = _a:copy(G.fwd):applyQuaternion(self.q)
		fwdW:addScaledVector(n, -fwdW:dot(n)):normalize()
		if g.steer and P.com.z < com.z - 0.5 then
			local steer = clamp(-ctl.steer, -1, 1) * 0.6 * clamp(1 - E.vSurf / 60, 0.08, 1)
			fwdW:applyAxisAngle(n, steer)
		end
		local latW = _b:crossVectors(n, fwdW):normalize()
		local vlong, vlat = vrel:dot(fwdW), vrel:dot(latW)
		G.spin = vlong / math.max(0.1, if g.wheel and g.wheel > 0 then g.wheel else 0.3)
		local muL = if g.leg then 0.9 else 0.02 + 0.75 * ctl.brake
		local muS = 0.9
		local fl = -clamp(vlong * Fn * 3, -muL * Fn, muL * Fn)
		local fs = -clamp(vlat * Fn * 4, -muS * Fn, muS * Fn)
		_cf:copy(n):multiplyScalar(Fn):addScaledVector(fwdW, fl):addScaledVector(latW, fs)
		self:applyWorld(_cf, pw, Fw, Tb, qInv)
	end
	for _, P in ipairs(craft.parts) do
		if not P.alive or P.gear then continue end
		for _, cp in ipairs(P.contacts) do
			local res = self:probe(cp, body)
			if not res then continue end
			local depth, n, vrel, pw, water = res.depth, res.n, res.vrel, res.pw, res.water
			local vn = vrel:dot(n)
			contacts += 1
			local tol = (P.def.crash or 8) * (self.settings.crashScale or 1) * (if water then 2 else 1)
			if -vn > tol then self:breakPart(P, if water then "splash" else "impact", -vn); break end
			local k = m * (if water then 30 else 600) / math.max(1, #craft.parts * 0.4)
			local c = 2 * math.sqrt(k * m / math.max(1, #craft.parts)) * 0.8
			local Fn = math.max(0, k * depth - c * vn)
			local vt = _c:copy(vrel):addScaledVector(n, -vn)
			local vts = vt:length()
			local mu = if water then 0.15 else 0.55
			local ff = math.min(mu * Fn, vts * Fn * 3)
			_cf:copy(n):multiplyScalar(Fn)
			if vts > 1e-3 then _cf:addScaledVector(vt, -ff / vts) end
			if water then _cf:addScaledVector(vrel, -m * 0.08) end
			if not water and vts > 5 then P.temp += (ff * vts * dt) / P.C * 0.5 end
			self:applyWorld(_cf, pw, Fw, Tb, qInv)
		end
	end
	self.contacts = contacts
end

-- ground probe for a body-frame point: depth below ground, normal, relative velocity, world point
function Ship:probe(bp, body)
	local pw = self:bodyToWorld(bp, V3())
	self:toFixed(body, pw, self.t, _fx)
	local r = _fx:length()
	local lat, lon = math.asin(clamp(_fx.y / r, -1, 1)) / D2R, math.atan2(-_fx.z, _fx.x) / D2R
	local g = self.world:groundAt(body, lat, lon)
	local hgt = r - body.R
	local depth = g - hgt
	local water = false
	if body == EARTH and g <= 0.3 and self.world:isWater(lat, lon) then water = true; depth = -hgt end
	if depth <= 0 then return nil end
	local dl = 3 / (body.R * D2R)
	local hN = self.world:groundAt(body, lat + dl, lon)
	local hE = self.world:groundAt(body, lat, lon + dl / math.max(0.05, math.cos(lat * D2R)))
	enu(_fx, _up, _e, _no)
	local n = V3():copy(_up):addScaledVector(_no, -(hN - g) / 3):addScaledVector(_e, -(hE - g) / 3):normalize()
	if water then n:copy(_up) end
	self:bodyFrameQ(body, self.t, _q)
	n:applyQuaternion(_q)
	local rb = _b:copy(bp):sub(self.craft.com)
	local vp = _vp:crossVectors(self.w, rb):applyQuaternion(self.q):add(self.v)
	self:surfaceVel(body, pw, self.t, _vg)
	local vrel = vp:sub(_vg):clone()
	return { depth = depth * math.max(0.2, n:dot(_up:applyQuaternion(_q))), n = n, vrel = vrel, pw = pw, water = water }
end

function Ship:applyWorld(F, pw, Fw, Tb, qInv)
	Fw:add(F)
	_b:copy(pw):sub(self.r):applyQuaternion(qInv)
	_c:copy(F):applyQuaternion(qInv)
	Tb:add(_a:crossVectors(_b, _c))
end

function Ship:breakPart(P, why, speed)
	if not P.alive then return end
	local removed = self.craft:destroy(P)
	table.insert(self.events, { type = "break", part = P, removed = removed, why = why, speed = speed or 0 })
	if not self.craft.root.alive or self.craft.mass < 1 then
		self.dead = true
		table.insert(self.events, { type = "destroyed", why = why, part = P })
	end
end

function Ship:checkBuildings()
	local E = self.env
	if E.body ~= EARTH or E.agl > 700 or not self.world.buildingTop then self.world.nearBuildings = false; return end
	local craft = self.craft
	for _, b in ipairs({ craft.com, craft.box.min, craft.box.max }) do
		local pw = self:bodyToWorld(b, _p)
		self:toFixed(EARTH, pw, self.t, _fx)
		local ll = toLLH(_fx, EARTH.R)
		local top = self.world:buildingTop(ll.lat, ll.lon, ll.h)
		if top ~= nil then
			table.insert(self.events, { type = "building" })
			self:breakPart(craft.root, "building", self.env.vSurf)
			return
		end
	end
end

-- ---- parking: lock to the surface when stopped so we can sit still on a rotating planet ----
function Ship:checkPark(dt)
	local E = self.env
	local craft = self.craft
	local legs = false
	for _, P in ipairs(craft.gears) do if P.def.gear.leg then legs = true end end
	local still = self.contacts > 0 and E.vSurf < 0.25 and self.w:length() < 0.03 and self.ctl.throttle < 0.01 and self.thrustNow < 1
		and (self.ctl.brake > 0.5 or #craft.gears == 0 or legs)
	self.parkTimer = if still then self.parkTimer + dt else 0
	if self.parkTimer > 1.0 then
		local body = E.body
		local pF = self:toFixed(body, self.r, self.t, V3())
		self:bodyFrameQ(body, self.t, _q)
		local qF = _qi:copy(_q):invert():multiply(self.q):clone()
		self.parked = { body = body, pF = pF, qF = qF }
		self.parkTimer = 0
		table.insert(self.events, { type = "landed", body = body })
	end
end
function Ship:stepParked(dt, controller)
	local P = self.parked
	self.t += dt
	self:toI(P.body, P.pF, self.t, self.r)
	self:bodyFrameQ(P.body, self.t, _q)
	self.q:copy(_q):multiply(P.qF)
	self:surfaceVel(P.body, self.r, self.t, self.v)
	self.w:set(0, 0, 0)
	self:updateEnv(self.t)
	if controller then controller:update(self, dt) end
	self.contacts = math.max(1, self.contacts)
	for _, G in ipairs(self.craft.gears) do G.gear.contact = true; G.gear.deployed = 1 end
	self.gForce = 1
	self.craft:recompute()
	local c = self.ctl
	local wheels = false
	for _, Q in ipairs(self.craft.gears) do if not Q.def.gear.leg then wheels = true end end
	if c.throttle > 0.01 or math.abs(c.pitch) + math.abs(c.roll) + math.abs(c.yaw) > 0.15 or (wheels and c.brake < 0.5 and self.warp <= 1) then
		self.parked = nil
		self.warp = 1
	end
end

-- ---- time-warp "on rails": gravity only, RK4 ----
function Ship:stepRails(total, controller)
	local t, left = self.t, total
	local s = { self.r.x, self.r.y, self.r.z, self.v.x, self.v.y, self.v.z }
	while left > 0 do
		local body = self:dominant(self.r, t)
		local c = self:bodyCenter(body, t, _c)
		local rr = Geo.hypot(s[1] - c.x, s[2] - c.y, s[3] - c.z)
		local h = math.min(left, Physics.railStep(s, t, body, rr))
		Physics.rk4(s, t, h)
		t += h; left -= h
		self.r:set(s[1], s[2], s[3]); self.v:set(s[4], s[5], s[6])
		local alt = rr - body.R
		local air = body.atmoTop > 0 and alt < body.atmoTop + 2000
		if air or alt < 3000 + (if body == MOON then 8000 elseif body == MARS then 22000 else 0) then
			self.warp = 1
			table.insert(self.events, { type = "warpStop", why = if air then "atmosphere" else "surface" })
			break
		end
	end
	local dt = t - self.t
	self.t = t
	self.w:set(0, 0, 0)
	self:updateEnv(t)
	if controller then controller:railsAttitude(self) end
	for _, P in ipairs(self.craft.engines) do P.eng.thr = 0; P.eng.flame = 0 end
	self.thrustNow = 0
	if self.heatOn then
		local vb = self:dirToBody(self.env.vAir, _d)
		self.craft:heat(math.min(dt, 60), vb, self.env, 0, self.settings.heatScale or 1, self.env.inSun)
	end
	if self.craft.solar > 0 and self.env.inSun then self.craft.ec = math.min(self.craft.ecCap, self.craft.ec + self.craft.solar * dt / 3600 * 10) end
end

-- RK4 step size for coasting: a small fraction of the local orbital time scale about every body that matters
local _rs = V3()
function Physics.railStep(s, t, body, rr)
	if body == EARTH or body == MOON then return clamp(0.01 * math.sqrt(rr * rr * rr / body.mu), 0.5, 300) end
	local de = Geo.hypot(s[1], s[2], s[3])
	local h = math.min(0.01 * math.sqrt(de * de * de / EARTH.mu), 0.01 * math.sqrt(rr * rr * rr / body.mu))
	if body == SUN then
		marsPos(t, _rs)
		local dm = Geo.hypot(s[1] - _rs.x, s[2] - _rs.y, s[3] - _rs.z)
		h = math.min(h, 0.01 * math.sqrt(dm * dm * dm / MARS.mu))
	end
	return clamp(h, 0.5, if body == SUN then 20000 else 1200)
end

-- gravity-only RK4 on {x,y,z,vx,vy,vz}
local _pp, _acc = V3(), V3()
local function deriv(s, t, out)
	_pp:set(s[1], s[2], s[3])
	gravity(_pp, t, _acc)
	out[1] = s[4]; out[2] = s[5]; out[3] = s[6]; out[4] = _acc.x; out[5] = _acc.y; out[6] = _acc.z
end
local k1, k2, k3, k4, tmp = table.create(6, 0), table.create(6, 0), table.create(6, 0), table.create(6, 0), table.create(6, 0)
function Physics.rk4(s, t, h)
	deriv(s, t, k1)
	for i = 1, 6 do tmp[i] = s[i] + k1[i] * h / 2 end
	deriv(tmp, t + h / 2, k2)
	for i = 1, 6 do tmp[i] = s[i] + k2[i] * h / 2 end
	deriv(tmp, t + h / 2, k3)
	for i = 1, 6 do tmp[i] = s[i] + k3[i] * h end
	deriv(tmp, t + h, k4)
	for i = 1, 6 do s[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) end
end

return Physics
