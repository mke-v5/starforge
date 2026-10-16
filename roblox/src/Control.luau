--!native
-- Flight control computer (port of src/ship/control.js): fly-by-wire rate control, SAS pointing modes,
-- actuator mixing and the autopilots.
-- Autopilots are tables { name, update = function(ship, dt, C) -> out, wakeAt = number?, railsDir = function? };
-- out = { dir, axis, up, throttle, engines, status, done, msg, fail, gear, brake, trans, pitchCmd }.

local THREE = require(script.Parent.Three)
local Geo = require(script.Parent.Geo)
local Orbit = require(script.Parent.Orbit)
local Astro = require(script.Parent.Astro)
local Atmo = require(script.Parent.Atmo)
local V3, Quat, M3 = THREE.Vector3.new, THREE.Quaternion.new, THREE.Matrix3.new
local EARTH, MOON, MARS, SUN, G0, clamp, smoothstep, D2R, fmtTime, gcDist, gcBearing, llh, isFinite =
	Geo.EARTH, Geo.MOON, Geo.MARS, Geo.SUN, Geo.G0, Geo.clamp, Geo.smoothstep, Geo.D2R, Geo.fmtTime, Geo.gcDist, Geo.gcBearing, Geo.llh, Geo.isFinite
local elements, relState, burnTime, planCircularize, propagate, engineClass = Orbit.elements, Orbit.relState, Orbit.burnTime, Orbit.planCircularize, Orbit.propagate, Orbit.engineClass
local glideRange, coastGround, predict, planReturn, planCorrection, planDeorbitTo, planLandingTo, landingModel = Orbit.glideRange, Orbit.coastGround, Orbit.predict, Orbit.planReturn, Orbit.planCorrection, Orbit.planDeorbitTo, Orbit.planLandingTo, Orbit.landingModel
local fallDrag, brakeSim, thrustScale, fallLanding, basis, moonLanding, moonToI, deltaV, bodyPos, bodyVelAt = Orbit.fallDrag, Orbit.brakeSim, Orbit.thrustScale, Orbit.fallLanding, Orbit.basis, Orbit.moonLanding, Orbit.moonToI, Orbit.deltaV, Orbit.bodyPos, Orbit.bodyVelAt
local moonPos, earthAngle = Astro.moonPos, Astro.earthAngle
local airAt = Atmo.airAt
local PI = math.pi
local warn = warn or print

local C = {}

local _a, _b, _c, _d = V3(), V3(), V3(), V3()
local _q, _qi = Quat(), Quat()
local _e, _remR = V3(), V3()
local DQ_MAX, DQ_SPOOL = 0.3, 0.8   -- differential throttle: trim range and the slowest engine that can use it
local _t1, _M, _y, _rq = V3(), M3(), V3(), V3()
local _err, _treq, _ga, _gb, _gc = V3(), V3(), V3(), V3(), V3()
local NOSE, UPB = V3(0, 0, -1), V3(0, 1, 0)
C.NOSE = NOSE

local function copyTable(t) local o = {}; for k, v in pairs(t) do o[k] = v end; return o end
local function anyOf(list, fn) for _, x in ipairs(list) do if fn(x) then return true end end; return false end

-- Torque allocation over actuators giving torque ts[i] at full command: least squares with the request
-- clipped per axis to what the set can give on that axis, scaled down as a whole if any command passes ±1.
local function solveAlloc(ts, req)
	local cx, cy, cz = 0, 0, 0
	local a, b, c, d, e, f = 0, 0, 0, 0, 0, 0
	for _, t in ipairs(ts) do
		cx += math.abs(t.x); cy += math.abs(t.y); cz += math.abs(t.z)
		a += t.x * t.x; b += t.y * t.y; c += t.z * t.z; d += t.x * t.y; e += t.x * t.z; f += t.y * t.z
	end
	local out = table.create(#ts, 0)
	local tr = a + b + c
	if not (tr > 1e-12) then return out end
	_rq:set(clamp(req.x, -cx, cx), clamp(req.y, -cy, cy), clamp(req.z, -cz, cz))
	local l = tr * 1e-6
	_M:set(a + l, d, e, d, b + l, f, e, f, c + l):invert()
	_y:copy(_rq):applyMatrix3(_M)
	local m = 1
	for i, t in ipairs(ts) do out[i] = t:dot(_y); m = math.max(m, math.abs(out[i])) end
	if m > 1 then for i = 1, #out do out[i] /= m end end
	return out
end

C.SAS_MODES = { "off", "hold", "prograde", "retrograde", "normal", "antinormal", "radialOut", "radialIn", "target" }

local Controller = {}
Controller.__index = Controller
C.Controller = Controller

function Controller.new(settings)
	local self = setmetatable({}, Controller)
	self.settings = settings or { assist = "assisted" }
	self.input = { pitch = 0, roll = 0, yaw = 0, throttle = 0, brake = false, tx = 0, ty = 0, tz = 0 }
	self.sas = "hold"
	self.ap = nil
	self.integ = V3()
	self.holdQ = nil
	self.node = nil
	self.status = ""
	self.apStatus = ""
	self.wd = V3()
	self.airTime = 0
	self.engGroup = nil
	return self
end

function Controller:setSas(m) self.sas = m; self.holdQ = nil; self.integ:set(0, 0, 0) end
function Controller:engage(ap) self.ap = ap; self.integ:set(0, 0, 0); self.holdQ = nil end
function Controller:cancelAp() self.ap = nil; self.holdQ = nil end

-- ----- reference directions (world) -----
function Controller:refVel(ship)
	local E = ship.env
	if (E.body == EARTH or E.body == MARS) and E.h < 50000 then return E.vAir:clone() end
	if E.body == MOON and E.agl < 20000 then return E.vAir:clone() end
	if E.body == EARTH then return ship.v:clone() end
	return ship.v:clone():sub(bodyVelAt(E.body, ship.t, _a))
end
function Controller:refPos(ship)
	if ship.env.body == EARTH then return ship.r:clone() end
	return ship.r:clone():sub(bodyPos(ship.env.body, ship.t, _a))
end
function Controller:modeDir(ship, mode)
	local v, r = self:refVel(ship), self:refPos(ship)
	if mode == "prograde" then return v:normalize()
	elseif mode == "retrograde" then return v:normalize():negate()
	elseif mode == "normal" then return V3():crossVectors(r, v):normalize()
	elseif mode == "antinormal" then return V3():crossVectors(v, r):normalize()
	elseif mode == "radialOut" then local n = V3():crossVectors(r, v); return V3():crossVectors(v, n):normalize()
	elseif mode == "radialIn" then local n = V3():crossVectors(r, v); return V3():crossVectors(n, v):normalize()
	elseif mode == "target" then moonPos(ship.t, _a); return _a:clone():sub(ship.r):normalize() end
	return nil
end

-- which engines fire ('all' | 'main' | 'jets' | 'lift'); the game listens through onEngineGroup
function Controller:setEngineGroup(craft, g)
	if g ~= "all" and not anyOf(craft.engines, function(P) return engineClass(P) == g end) then g = "all" end
	for _, P in ipairs(craft.engines) do P.eng.active = g == "all" or engineClass(P) == g end
	self.engGroup = g
	if self.onEngineGroup then self.onEngineGroup(g) end
end

-- thrust axis of the craft in body coordinates (thrust-weighted)
function Controller:thrustAxis(craft, env)
	local ax = V3()
	for _, P in ipairs(craft.engines) do
		if P.eng.active then
			local T = if env then (craft:engineOutput(P, env)) else P.def.engine.thrust
			ax:addScaledVector(P.eng.dir, T * (P.eng.bal or 1))
		end
	end
	if ax:lengthSq() < 1e-6 then for _, P in ipairs(craft.engines) do if P.eng.active then ax:addScaledVector(P.eng.dir, P.def.engine.thrust) end end end
	if ax:lengthSq() < 1e-6 then return NOSE:clone() end
	return ax:normalize()
end

-- ----- main update (called from physics substeps) -----
function Controller:update(ship, dt)
	local craft, ctl, E, inp = ship.craft, ship.ctl, ship.env, self.input
	local assisted = self.settings.assist ~= "realistic"
	local stick = math.abs(inp.pitch) + math.abs(inp.roll) + math.abs(inp.yaw) > 0.04
	local touching = ship.contacts > 0
	self.airTime = if touching then 0 else (self.airTime or 0) + dt
	local onGround = touching or (self.airTime < 1.0 and E.agl < 25)
	ctl.steer = clamp(inp.yaw + (if onGround and assisted then inp.roll * 0.8 else 0), -1, 1)
	-- autopilot
	local apOut = nil
	if self.ap then
		if stick and self.ap.cancelOnStick ~= false then
			self.status = self.ap.name .. " cancelled"; self.ap = nil
		else
			apOut = self.ap.update(ship, dt, self)
			if apOut and apOut.done then
				self.status = apOut.msg or (self.ap.name .. " complete")
				if self.onApDone then self.onApDone(apOut) end
				self.ap = nil; apOut = nil
			end
		end
	end
	self.apStatus = (apOut and apOut.status) or ""
	if apOut and apOut.engines and apOut.engines ~= self.engGroup then self:setEngineGroup(craft, apOut.engines) end
	ctl.throttle = if apOut and apOut.throttle ~= nil then apOut.throttle else inp.throttle
	ctl.brake = if inp.brake then 1 elseif assisted and onGround and ctl.throttle < 0.02 and not apOut then 1 else 0
	if apOut and apOut.brake ~= nil then ctl.brake = apOut.brake end
	if apOut and apOut.gear ~= nil then ctl.gear = apOut.gear end
	if apOut then
		local tr = apOut.trans
		ctl.tx = if tr then tr.x else 0; ctl.ty = if tr then tr.y else 0; ctl.tz = if tr then tr.z else 0
	end
	-- -------- desired angular rates (body) --------
	local w = ship.w
	local wd = self.wd:set(0, 0, 0)
	local atmo = E.q > 150
	local vb = ship:dirToBody(E.vAir, _d)
	local V = vb:length()
	local alpha = if V > 5 then math.atan2(-vb.y, -vb.z) else 0
	local beta = if V > 5 then math.atan2(vb.x, -vb.z) else 0
	local pointing = false
	local isLocal = (E.body == EARTH and E.h < 100000) or (E.body == MOON and E.agl < 30000) or (E.body == MARS and E.h < 100000)
	local wRef = V3()
	if isLocal then
		if E.body == EARTH then wRef:set(0, EARTH.omega, 0) else wRef:copy(if E.body == MARS then ship.eph.aY else ship.eph.mY):multiplyScalar(E.body.omega) end
		ship:dirToBody(wRef, wRef)
	end
	local frameQ = if isLocal then ship:bodyFrameQ(E.body, ship.t, Quat()) else nil
	local flightLaw = assisted and atmo and not onGround and V > 30 and not (apOut and apOut.dir) and (self.sas == "hold" or self.sas == "off")
	if flightLaw then
		-- fighter-style law: pitch stick commands load factor; neutral stick holds flight-path angle and bank
		local upW, vW = E.up, E.vAir
		local rightW, upBW = _a:set(1, 0, 0):applyQuaternion(ship.q), _b:set(0, 1, 0):applyQuaternion(ship.q)
		local gamma = math.asin(clamp(vW:dot(upW) / V, -1, 1))
		local bank = math.atan2(-rightW:dot(upW), upBW:dot(upW))
		local g = E.body.mu / (E.body.R + E.h) ^ 2
		local bc = clamp(bank, -1.2, 1.2)
		local level = math.cos(gamma) / math.max(0.36, math.cos(bc))
		local nCmd
		if math.abs(inp.pitch) > 0.03 then
			self.gammaHold = nil
			nCmd = level + (if inp.pitch > 0 then inp.pitch * 6 else inp.pitch * 2.8)
		else
			if self.gammaHold == nil then self.gammaHold = gamma end
			if alpha > 0.22 and self.gammaHold > -0.05 then self.gammaHold -= dt * 0.1 * clamp((alpha - 0.22) / 0.06, 0, 1) end
			nCmd = level + clamp((self.gammaHold - gamma) * V / g * 0.7, -1.5, 2)
		end
		nCmd = clamp(nCmd, -2.5, 7.5)
		local q = (nCmd - math.cos(gamma) * math.cos(bank)) * g / V
		if alpha > 0.30 and q > 0 then q *= clamp((0.42 - alpha) / 0.12, 0, 1) end
		if alpha < -0.22 and q < 0 then q *= clamp((alpha + 0.34) / 0.12, 0, 1) end
		local p
		if math.abs(inp.roll) > 0.03 then
			self.bankHold = nil
			p = inp.roll * math.abs(inp.roll) * 2.2 + inp.roll * 0.25
			if bank > 1.17 and p > 0 then p = math.min(p, (1.17 - bank) * 2.2) end
			if bank < -1.17 and p < 0 then p = math.max(p, (-1.17 - bank) * 2.2) end
		else
			if self.bankHold == nil then self.bankHold = if math.abs(bank) < 0.18 then 0 else clamp(bank, -0.61, 0.61) end
			if alpha > 0.26 then self.bankHold = clamp(self.bankHold, -0.2, 0.2) end
			p = clamp((self.bankHold - bank) * 2.2, -1.2, 1.2)
		end
		local turn = g * math.tan(bc) / V
		local upBody = ship:dirToBody(upW, _c)
		wd:set(q, turn * upBody.y - beta * 2.0 - inp.yaw * 0.3, -p)
		self.holdQ = nil
	elseif stick or (not apOut and self.sas == "off") then
		self.gammaHold = nil; self.bankHold = nil
		self.holdQ = nil
		if assisted then
			local mp = if atmo then 0.75 else 0.45
			local my = if atmo then 0.3 else 0.4
			local mr = if atmo then 2.2 else 0.8
			wd:set(inp.pitch * math.abs(inp.pitch) * mp + inp.pitch * 0.15, -inp.yaw * my, -(inp.roll * math.abs(inp.roll) * mr + inp.roll * 0.2))
			if atmo and V > 40 and not onGround then
				if alpha > 0.30 and wd.x > 0 then wd.x *= clamp((0.42 - alpha) / 0.12, 0, 1) end
				if alpha < -0.25 and wd.x < 0 then wd.x *= clamp((alpha + 0.37) / 0.12, 0, 1) end
				if ship.gForce > 8.5 and wd.x > 0 then wd.x *= 0.3 end
				wd.y += -beta * 2.0
			end
			if onGround then wd.z *= 0.2 end
		end
	else
		self.gammaHold = nil; self.bankHold = nil
		local D, upRef, axis = nil, nil, NOSE
		if apOut and apOut.dir then D = apOut.dir; upRef = apOut.up; axis = apOut.axis or NOSE
		elseif self.sas ~= "hold" then D = self:modeDir(ship, self.sas) end
		if D then
			pointing = true
			self:pointRates(ship, D, axis, upRef, wd)
		else
			-- attitude hold, stored relative to the planet near the surface
			if not self.holdQ or self.holdLocal ~= isLocal then
				self.holdQ = if isLocal then frameQ:clone():invert():multiply(ship.q) else ship.q:clone()
				self.holdLocal = isLocal
			end
			local target = if isLocal then frameQ:clone():multiply(self.holdQ) else self.holdQ
			_q:copy(ship.q):invert():multiply(target)
			if _q.w < 0 then _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w end
			local ang = 2 * math.acos(clamp(_q.w, -1, 1))
			local s = math.sqrt(math.max(1e-9, 1 - _q.w * _q.w))
			_a:set(_q.x / s, _q.y / s, _q.z / s)
			local k = if atmo then 1.6 else 1.0
			if ang > 1e-4 then wd:copy(_a):multiplyScalar(math.min(ang * k, 0.6)) end
			if onGround then wd:set(0, 0, 0); self.holdQ = nil end
		end
	end
	wd:add(wRef)
	-- -------- rate loop -> normalized command -> torque request --------
	local err = _err:copy(wd):sub(w)
	if not assisted and not pointing and self.sas == "off" then err:set(0, 0, 0) end
	local auth = self:authority(ship)
	local I = craft.Idiag
	local kp = if atmo then 3.5 else 2.6
	local integrate = not onGround and (atmo or pointing or self.sas ~= "off")
	if integrate then self.integ:addScaledVector(err, dt * (if atmo then 1.6 else 0.6)):clampScalar(-0.7, 0.7) else self.integ:multiplyScalar(0.9) end
	local cx = clamp(err.x * kp * I.x / auth.x + self.integ.x, -1, 1)
	local cy = clamp(err.y * kp * I.y / auth.y + self.integ.y, -1, 1)
	local cz = clamp(err.z * kp * I.z / auth.z + self.integ.z, -1, 1)
	local tReq = _treq:set(cx * auth.x, cy * auth.y, cz * auth.z)
	if assisted and onGround and atmo then
		-- on the ground: direct law for pitch, plus runway heading hold and wing levelling
		local upW = E.up
		local fw = _a:set(0, 0, -1):applyQuaternion(ship.q)
		local rw = _b:set(1, 0, 0):applyQuaternion(ship.q)
		local ub = _d:set(0, 1, 0):applyQuaternion(ship.q)
		local bank = math.atan2(-rw:dot(upW), ub:dot(upW))
		local north = V3(0, 1, 0):addScaledVector(upW, -upW.y):normalize()
		local east = V3():crossVectors(north, upW)
		local hdg = math.atan2(fw:dot(east), fw:dot(north))
		local yawRate = ship.w:clone():applyQuaternion(ship.q):dot(upW) - (if E.body == EARTH then EARTH.omega * upW.y elseif E.body == MARS then MARS.omega * ship.eph.aY:dot(upW) else 0)
		if math.abs(inp.yaw) > 0.05 or math.abs(inp.roll) > 0.05 or E.vSurf < 3 then self.gHeading = hdg end
		if self.gHeading == nil then self.gHeading = hdg end
		local he = self.gHeading - hdg
		he = math.atan2(math.sin(he), math.cos(he))
		local yawCmd = clamp(-inp.yaw * 0.7 + clamp(-he * 3 - yawRate * 2.5, -1, 1) * (if math.abs(inp.yaw) > 0.05 then 0 else 1), -1, 1)
		ctl.steer = clamp(inp.yaw + inp.roll * 0.8 + (if math.abs(inp.yaw) + math.abs(inp.roll) > 0.05 then 0 else clamp(he * 2.5 + yawRate * 1.5, -0.6, 0.6)), -1, 1)
		local pitchIn = if apOut and apOut.pitchCmd ~= nil then apOut.pitchCmd else inp.pitch
		tReq:set((pitchIn + clamp(-w.x * 2, -0.3, 0.3)) * auth.x, yawCmd * auth.y, clamp(-inp.roll * 0.5 + bank * 4, -1, 1) * auth.z)
	else
		self.gHeading = nil
	end
	if not assisted and (stick or self.sas == "off") then
		tReq:set(inp.pitch * auth.x, -inp.yaw * auth.y, -inp.roll * auth.z)
		if self.sas ~= "off" and not stick then
			tReq:set(clamp(-w.x * I.x * 2, -auth.x, auth.x), clamp(-w.y * I.y * 2, -auth.y, auth.y), clamp(-w.z * I.z * 2, -auth.z, auth.z))
		end
	end
	self:allocate(ship, tReq, dt)
end

-- desired body rates to bring body axis onto world direction D (and optionally body up toward upRef)
function Controller:pointRates(ship, D, axis, upRef, out)
	local craft = ship.craft
	local db = ship:dirToBody(D, _a):normalize()
	local cross = V3():crossVectors(axis, db)
	local s, c = cross:length(), axis:dot(db)
	local ang = math.atan2(s, c)
	local auth = self:authority(ship)
	local I = craft.Idiag
	local amax = math.max(0.02, math.min(auth.x / I.x, auth.y / I.y))
	local rate = math.min(math.sqrt(2 * amax * ang) * 0.55, ang * 2.0, 0.8)
	if s > 1e-6 then out:copy(cross):divideScalar(s):multiplyScalar(rate) elseif c < 0 then out:set(rate, 0, 0) else out:set(0, 0, 0) end
	if upRef then
		local ub = ship:dirToBody(upRef, _b)
		ub:addScaledVector(axis, -ub:dot(axis)):normalize()
		local ref = if math.abs(axis.y) < 0.9 then UPB:clone() else V3(0, 0, -1)
		ref:addScaledVector(axis, -ref:dot(axis)):normalize()
		local rc = V3():crossVectors(ref, ub)
		local rang = math.atan2(rc:dot(axis), ref:dot(ub))
		out:addScaledVector(axis, clamp(rang * 1.2, -0.6, 0.6))
	end
end

-- available torque per body axis (N·m)
function Controller:authority(ship)
	local craft = ship.craft
	local W = if craft.ec > 0 then craft.wheelTorque else 0
	local a = V3(W, W, W)
	for _, P in ipairs(craft.wings) do
		if P.wing.ctrl <= 0 then continue end
		local t = P.wing.torq
		a.x += math.abs(t.x) * P.wing.maxDefl; a.y += math.abs(t.y) * P.wing.maxDefl; a.z += math.abs(t.z) * P.wing.maxDefl
	end
	for _, P in ipairs(craft.engines) do
		local gm = (P.eng.e.gimbal or 0) * D2R
		if gm == 0 or P.eng.thrust <= 0 then continue end
		_ga:copy(P.eng.pos):sub(craft.com)
		local T = P.eng.thrust * gm
		_gb:crossVectors(_ga, _gc:copy(P.eng.gx):multiplyScalar(T)); a.x += math.abs(_gb.x); a.y += math.abs(_gb.y); a.z += math.abs(_gb.z)
		_gb:crossVectors(_ga, _gc:copy(P.eng.gz):multiplyScalar(T)); a.x += math.abs(_gb.x); a.y += math.abs(_gb.y); a.z += math.abs(_gb.z)
	end
	for _, P in ipairs(craft.engines) do
		if not (P.eng.thrust > 0) or not (P.eng.e.spool <= DQ_SPOOL) then continue end
		local lvl = math.max(0.05, P.eng.thr * (P.eng.bal or 1))
		local span = (math.min(DQ_MAX, math.max(0, 1 / lvl - 1)) + DQ_MAX) * 0.5
		_ga:copy(P.eng.pos):sub(craft.com)
		_gb:crossVectors(_ga, _gc:copy(P.eng.dir):multiplyScalar(P.eng.thrust / (1 + (P.eng.dq or 0)) * span))
		a.x += math.abs(_gb.x); a.y += math.abs(_gb.y); a.z += math.abs(_gb.z)
	end
	if ship.ctl.rcs and ship.env.rho < 0.05 then
		for _, P in ipairs(craft.rcsList) do
			local l = P.rcs.pos:distanceTo(craft.com) * P.def.rcs.thrust * 2
			a.x += l; a.y += l; a.z += l
		end
	end
	return a:addScalar(1)
end

function Controller:allocate(ship, tReq, dt)
	local craft = ship.craft
	-- 1. reaction wheels
	local W = if craft.ec > 0 then craft.wheelTorque else 0
	local uw = _a:set(clamp(tReq.x, -W, W), clamp(tReq.y, -W, W), clamp(tReq.z, -W, W))
	ship.cmdT:set(if W > 0 then uw.x / W else 0, if W > 0 then uw.y / W else 0, if W > 0 then uw.z / W else 0)
	local rem = _b:copy(tReq):sub(uw)
	-- 2. control surfaces (rate limited)
	local wl = {}
	for _, P in ipairs(craft.wings) do
		local Wg = P.wing
		if Wg.ctrl <= 0 then Wg.defl = 0; continue end
		table.insert(wl, Wg.torq:clone():multiplyScalar(Wg.maxDefl))
	end
	local got = _c:set(0, 0, 0)
	if #wl > 0 then
		local k = solveAlloc(wl, rem)
		local rateLim = 3.0 * dt
		local i = 0
		for _, P in ipairs(craft.wings) do
			local Wg = P.wing
			if Wg.ctrl <= 0 then continue end
			i += 1
			Wg.defl += clamp(k[i] * Wg.maxDefl - Wg.defl, -rateLim, rateLim)
			got:addScaledVector(Wg.torq, Wg.defl)
		end
		rem:sub(got)
	end
	-- 3. engine gimbal
	local gl, gt = {}, {}
	for _, P in ipairs(craft.engines) do
		local gm = (P.eng.e.gimbal or 0) * D2R
		if gm == 0 or P.eng.thrust <= 0 then P.eng.g1 = 0; P.eng.g2 = 0; continue end
		local r = _d:copy(P.eng.pos):sub(craft.com)
		local T = P.eng.thrust * gm
		table.insert(gl, P)
		table.insert(gt, V3():crossVectors(r, _e:copy(P.eng.gx):multiplyScalar(T)))
		table.insert(gt, V3():crossVectors(r, _e:copy(P.eng.gz):multiplyScalar(T)))
	end
	_remR:copy(rem)
	if #gl > 0 then
		local k = solveAlloc(gt, rem)
		for i, P in ipairs(gl) do
			P.eng.g1 = k[2 * i - 1]; P.eng.g2 = k[2 * i]
			rem:addScaledVector(gt[2 * i - 1], -k[2 * i - 1]):addScaledVector(gt[2 * i], -k[2 * i])
		end
	end
	-- 3b. differential throttle
	local dl, dtl = {}, {}
	for _, P in ipairs(craft.engines) do
		local e = P.eng
		if not (e.thrust > 0) or not (e.e.spool <= DQ_SPOOL) then e.dq += clamp(-e.dq, -dt * 2, dt * 2); continue end
		local r = _d:copy(e.pos):sub(craft.com)
		table.insert(dl, e)
		table.insert(dtl, V3():crossVectors(r, _e:copy(e.dir):multiplyScalar(e.thrust / (1 + e.dq) * DQ_MAX)))
	end
	if #dl > 0 then
		local k = solveAlloc(dtl, rem)
		for i, e in ipairs(dl) do
			local rate = dt / math.max(0.1, e.e.spool)
			e.dq += clamp(k[i] * DQ_MAX - e.dq, -rate, rate)
		end
	end
	-- 4. RCS gets the rest (as a direction)
	local rl = _remR:length()
	ship.rcsT = ship.rcsT or V3()
	if rl > 1 then ship.rcsT:copy(_remR):divideScalar(math.max(rl, craft.mass * 20)) else ship.rcsT:set(0, 0, 0) end
end

-- during time warp: snap attitude to the SAS/AP direction
function Controller:railsAttitude(ship)
	local D, axis = nil, NOSE
	if self.ap and self.ap.railsDir then
		local o = self.ap.railsDir(ship, self)
		if o then D = o.dir; axis = o.axis or NOSE end
	elseif self.sas ~= "off" and self.sas ~= "hold" then
		D = self:modeDir(ship, self.sas)
	end
	if not D then return end
	local cur = _a:copy(axis):applyQuaternion(ship.q)
	_q:setFromUnitVectors(cur, D:clone():normalize())
	ship.q:premultiply(_q):normalize()
	self.holdQ = nil
end

local function maxAccel(ship)
	local craft = ship.craft
	local T = 0
	for _, P in ipairs(craft.engines) do if P.eng.active then T += (craft:engineOutput(P, ship.env)) * (P.eng.bal or 1) end end
	return T / craft.mass
end
C.maxAccel = maxAccel

-- ======================= autopilots =======================

local function nodeCopy(node, extra)
	local o = copyTable(node)
	for k, v in pairs(extra) do o[k] = v end
	return o
end
local function maxSpool(craft, floor)
	local m = floor
	for _, P in ipairs(craft.engines) do if P.eng.active then m = math.max(m, P.eng.e.spool or 1) end end
	return m
end

-- Execute a planned burn {t, dv}. The direction is held in the orbital frame (prograde / normal / radial)
-- so long burns follow the orbit instead of drifting off in a fixed inertial direction.
function C.nodeExec(node)
	local left = node.dv:length()
	local started, startedAt, comp, body, eTarget, eSign = false, 0, nil, node.body, nil, 1
	local dvVec, frozenDir = node.dv:clone(), nil
	local function basisNow(ship)
		local b = body or ship.env.body
		local rs = relState(ship, b)
		local pro = rs.v:clone():normalize()
		local nor = V3():crossVectors(rs.r, rs.v):normalize()
		local rad = V3():crossVectors(nor, pro):normalize()
		return { pro = pro, nor = nor, rad = rad }
	end
	local function dirNow(ship)
		if not comp or eTarget == nil then return (frozenDir or dvVec):clone():normalize() end
		local B = basisNow(ship)
		return B.pro:multiplyScalar(comp.x):addScaledVector(B.nor, comp.y):addScaledVector(B.rad, comp.z):normalize()
	end
	local wake = node.t - 120
	local rcsMode, prevV, prevT = nil, nil, 0
	local _g, _qInv = V3(), Quat()
	local ap
	local function body_(ship, dt, Ctl)
		local craft = ship.craft
		if not comp then
			if not body then body = ship.env.body end
			local st = if node.t > ship.t + 1 then propagate(ship.r, ship.v, ship.t, node.t - ship.t) else { r = ship.r, v = ship.v, t = ship.t }
			local rs = relState({ r = st.r, v = st.v, t = st.t }, body)
			local pro = rs.v:clone():normalize()
			local nor = V3():crossVectors(rs.r, rs.v):normalize()
			local rad = V3():crossVectors(nor, pro):normalize()
			local d = node.dv:clone():normalize()
			comp = V3(d:dot(pro), d:dot(nor), d:dot(rad))
			if math.abs(comp.x) > 0.8 and node.dv:length() > 5 then
				local v2 = rs.v:clone():add(node.dv)
				eTarget = node.eTarget or (v2:lengthSq() / 2 - body.mu / rs.r:length())
				eSign = if comp.x > 0 then 1 else -1
			end
		end
		if rcsMode == nil then
			rcsMode = false
			local dvl = node.dv:length()
			if dvl < 3 and #craft.rcsList > 0 and ship.env.rho < 0.05 and craft:amount("GAS") + craft:amount("LF") > 1 then
				local u = node.dv:clone():normalize():applyQuaternion(_qInv:copy(ship.q):invert())
				local F = 0
				for _, P in ipairs(craft.rcsList) do for _, d in ipairs(P.rcs.dirs) do F += math.max(0, -d:dot(u)) * P.def.rcs.thrust end end
				local a = F / craft.mass
				if a > 0.02 and dvl / a < 90 then rcsMode = { a = a, dur = dvl / a } end
			end
		end
		if rcsMode then
			if prevV and started then
				Astro.gravity(ship.r, ship.t, _g)
				dvVec:sub(ship.v:clone():sub(prevV):addScaledVector(_g, -(ship.t - prevT)))
			end
			prevV = ship.v:clone(); prevT = ship.t
			local tS = node.t - rcsMode.dur / 2
			wake = tS - 30
			if not started and ship.t < tS then
				Ctl.node = nodeCopy(node, { dvLeft = dvVec:clone(), started = started, tStart = tS })
				return { throttle = 0, status = string.format("RCS burn in %d s", math.round(tS - ship.t)) }
			end
			started = true
			left = if dvVec:dot(node.dv) > 0 then dvVec:length() else 0
			Ctl.node = nodeCopy(node, { dvLeft = dvVec:clone(), started = started, tStart = tS })
			if left < 0.01 or ship.t > node.t + rcsMode.dur * 2 + 30 then Ctl.node = nil; return { done = true, throttle = 0, trans = V3(), msg = "Burn complete" } end
			local b = dvVec:clone():applyQuaternion(_qInv:copy(ship.q):invert()):normalize()
			return { throttle = 0, trans = b:multiplyScalar(clamp(left / (rcsMode.a * 0.4), 0.05, 1)), status = string.format("RCS · %.2f m/s", left) }
		end
		local firing = ship.thrustNow > 0 and ship.thrustB and ship.thrustB:lengthSq() > 1
		local axis = if firing then ship.thrustB:clone():normalize() else Ctl:thrustAxis(craft, ship.env)
		local bt = burnTime(ship, left)
		local tStart = node.t - bt / 2
		wake = tStart - 45
		if not started and ship.t > node.t + math.max(30, bt * 0.3) then Ctl.node = nil; return { done = true, fail = true, throttle = 0, msg = "Missed the burn window — plan it again in the map" } end
		local dir = dirNow(ship)
		local fwd = axis:clone():applyQuaternion(ship.q)
		local aligned = fwd:dot(dir)
		local thr = 0
		if ship.t >= tStart or started then
			local late = ship.t - tStart > 40
			local need = if bt < 15 and not late then 0.99985 else 0.998
			local steady = ship.w:length() < (if bt < 15 and not late then 0.01 else 0.05)
			if (aligned > need and steady) or (started and aligned > 0.9) then
				if not started then startedAt = ship.t end
				started = true
				local maxAcc = maxAccel(ship)
				local spoolT = maxSpool(craft, 0.2)
				thr = clamp(math.sqrt(2 * math.max(0, left) / math.max(0.05, maxAcc * spoolT)) * 0.92, 0.01, 1)
			end
		end
		if eTarget ~= nil then
			local rs = relState(ship, body)
			local vl = rs.v:length()
			local eNow = vl * vl / 2 - body.mu / rs.r:length()
			left = (eTarget - eNow) * eSign / math.max(1, vl)
		else
			if firing then dvVec:addScaledVector(ship.thrustB:clone():applyQuaternion(ship.q), -dt / craft.mass) end
			left = if dvVec:dot(node.dv) > 0 then dvVec:length() else 0
			if not frozenDir and started and left < maxAccel(ship) * 2.5 then frozenDir = dvVec:clone():normalize() end
			if frozenDir then left = math.max(0, dvVec:dot(frozenDir)) end
		end
		Ctl.node = nodeCopy(node, { dvLeft = dir:clone():multiplyScalar(math.max(0, left)), started = started, tStart = tStart })
		if started and left < 0.03 then Ctl.node = nil; return { done = true, throttle = 0, msg = "Burn complete" } end
		local spool = maxSpool(craft, 1)
		local noFlame = true
		for _, P in ipairs(craft.engines) do if P.eng.active and P.eng.flame ~= 0 then noFlame = false end end
		if started and thr > 0 and noFlame and ship.t - startedAt > spool + 4 then
			local anyActive = anyOf(craft.engines, function(P) return P.eng.active end)
			return { done = true, fail = true, throttle = 0, msg = if anyActive then "Engines not producing thrust (out of fuel or wrong engine group?)" else "No active engines" }
		end
		local engines = node.engines
		if not engines and ship.env.rho < 0.01 and anyOf(craft.engines, function(P) return P.alive ~= false and engineClass(P) == "main" end) then engines = "main" end
		return { dir = dir, axis = axis, throttle = thr, engines = engines }
	end
	ap = {
		name = "Burn", node = node, wakeAt = wake,
		railsDir = function(ship, Ctl) return { dir = dirNow(ship), axis = Ctl:thrustAxis(ship.craft, ship.env) } end,
		update = function(ship, dt, Ctl)
			local o = body_(ship, dt, Ctl)
			ap.wakeAt = if started then nil else wake
			return o
		end,
	}
	return ap
end
local nodeExec = C.nodeExec

-- fall model of a craft for landing predictions: drag per unit mass (engines-first), thrust vs air pressure
local function fallModel(craft, axis, ground, hTarget)
	local k = fallDrag(craft, axis)
	return { cda = k, k = function(M) return k(M) / craft.mass end, tScale = thrustScale(craft), ground = ground, hTarget = hTarget }
end

-- when the craft will be down to altitude `alt` above `body` (vacuum coast)
local function timeToAlt(ship, alt, body)
	body = body or EARTH
	local st = { r = ship.r:clone(), v = ship.v:clone(), t = ship.t }
	local c = V3()
	for _ = 1, 400 do
		local n = propagate(st.r, st.v, st.t, 15)
		if n.r:distanceTo(bodyPos(body, n.t, c)) - body.R < alt then return st.t end
		st = n
	end
	return st.t
end

local LONG_AIM = 2500
-- a small burn (in 25 s) that moves the end of the fall onto the target
local function landingCorrection(ship, target, model, body)
	body = body or EARTH
	local st = propagate(ship.r, ship.v, ship.t, 25)
	local moon = body == MOON
	local rel = if moon then relState({ r = st.r, v = st.v, t = st.t }, MOON) else st
	local b = basis(rel.r, rel.v)
	local tgt = llh(target.lat, target.lon, 0, 1, V3())
	local function evalC(x, y)
		local v = st.v:clone():addScaledVector(b.pro, x):addScaledVector(b.nor, y)
		local L = if moon then moonLanding(st.r, v, st.t, model) else fallLanding(st.r, v, st.t, model)
		local off = tgt:clone():sub(L.p)
		return { along = off:dot(L.d) * body.R + (if moon then 0 else LONG_AIM), cross = off:dot(V3():crossVectors(L.p, L.d)) * body.R }
	end
	local x, y = 0, 0
	local cur = evalC(0, 0)
	local miss0 = Geo.hypot(cur.along, cur.cross)
	for _ = 1, 6 do
		if Geo.hypot(cur.along, cur.cross) <= 150 then break end
		local a, c = evalC(x + 0.5, y), evalC(x, y + 0.5)
		local J = { { (a.along - cur.along) / 0.5, (c.along - cur.along) / 0.5 }, { (a.cross - cur.cross) / 0.5, (c.cross - cur.cross) / 0.5 } }
		local det = J[1][1] * J[2][2] - J[1][2] * J[2][1]
		if not isFinite(det) or math.abs(det) < 1e-6 then break end
		local dx = clamp((-cur.along * J[2][2] + cur.cross * J[1][2]) / det, -60, 60)
		local dy = clamp((-cur.cross * J[1][1] + cur.along * J[2][1]) / det, -60, 60)
		x += dx; y += dy; cur = evalC(x, y)
	end
	if Geo.hypot(cur.along, cur.cross) > 20000 then return nil end
	return { dv = b.pro:clone():multiplyScalar(x):addScaledVector(b.nor, y), miss = Geo.hypot(cur.along, cur.cross), miss0 = miss0 }
end

-- when will a braking burn have to start? (propagates the coast along the orbit)
local function estimateBrakeStart(ship, amax, groundRef)
	local body = ship.env.body
	local st = { r = ship.r:clone(), v = ship.v:clone(), t = ship.t }
	local m, mv = V3(), V3()
	for _ = 1, 400 do
		local r, v = st.r, st.v
		if body == MOON then
			Astro.moonPos(st.t, m); Astro.moonVel(st.t, mv); r = st.r:clone():sub(m); v = st.v:clone():sub(mv)
		elseif body == MARS then
			bodyPos(MARS, st.t, m); bodyVelAt(MARS, st.t, mv); r = st.r:clone():sub(m)
			v = st.v:clone():sub(mv):sub(ship.eph.aY:clone():multiplyScalar(MARS.omega):cross(r))
		else
			v = v:clone():sub(V3(0, EARTH.omega, 0):cross(r))
		end
		local rl = r:length()
		local upv = r:clone():divideScalar(rl)
		local vz = v:dot(upv)
		local vh = math.sqrt(math.max(0, v:lengthSq() - vz * vz))
		local h = rl - body.R - groundRef
		local g = body.mu / (rl * rl)
		if h < 0 or brakeSim(h, vz, vh, amax * 0.85, g, body.R) <= 200 + 0.03 * h then return st.t end
		st = propagate(st.r, st.v, st.t, 20)
	end
	return st.t
end

local _Y = V3(0, 1, 0)
-- Powered landing for rockets, VTOLs and landers: deorbit, coast, a braking burn timed to stop just above
-- the ground, then a gentle vertical touchdown (and, with a target, a hover across to the exact spot).
C.SWAP_H = 650
local SWAP_H = C.SWAP_H
function C.landAp(target)
	local phase, lastWake, hasMain, hasLift, model, sub, corr, trimT, trimLeft, giveUp = nil, -1e9, false, false, nil, nil, 0, 0, 0, false
	local onMoon = target ~= nil and target.body == "moon"
	local function aimAt(t, hAbove)
		if onMoon then return moonToI(llh(target.lat, target.lon, (target.elev or 0) + hAbove, MOON.R, V3()), t) end
		return llh(target.lat, target.lon, (target.elev or 0) + hAbove, EARTH.R, V3()):applyAxisAngle(_Y, earthAngle(t))
	end
	local coastStart = nil
	local ap
	ap = { name = "Auto-land", wakeAt = nil }
	ap.railsDir = function(ship, Ctl) if sub and sub.railsDir then return sub.railsDir(ship, Ctl) end; return nil end
	ap.update = function(ship, dt, Ctl)
		local craft, E = ship.craft, ship.env
		local body = E.body
		if sub then
			local o = sub.update(ship, dt, Ctl)
			if o and o.done then sub = nil; Ctl.node = nil
			else if o then o.status = "Course correction" end; return o end
		end
		local up = E.up:clone()
		local axis = Ctl:thrustAxis(craft, E)
		local g = body.mu / math.pow(body.R + E.h, 2)
		local amax = math.max(0.01, maxAccel(ship))
		local agl = math.max(0, E.agl - math.max(0, -craft.box.min.y) - 1)
		local vS = E.vAir:clone()
		local vz = vS:dot(up)
		local vH = vS:clone():addScaledVector(up, -vz)
		local vh = vH:length()
		local landed = ship.parked or (ship.contacts > 0 and E.vSurf < 0.6)
		local guided = target ~= nil and (body == EARTH) ~= onMoon and not giveUp
		if landed then
			ap.wakeAt = nil
			return { done = true, throttle = 0, msg = if body == MOON then "Touchdown on the Moon" elseif guided then "Touchdown at " .. (target.name or "the target") else "Touchdown" }
		end
		local fwd = axis:clone():applyQuaternion(ship.q)
		local rs = relState(ship, body)
		local el = elements(rs.r, rs.v, body.mu)
		local ground = E.h - E.agl
		local vac = E.rho < (if body == MARS then 0.05 else 0.01)
		local brakeEng = if hasMain and (vac or not hasLift) then "main" elseif hasLift then "lift" else "all"
		local finalEng = if hasLift then "lift" elseif hasMain then "main" else "all"
		local swap = brakeEng ~= finalEng
		local hTarget = if body == MARS then 5000 + 0.03 * agl elseif body == MOON and not swap then (if ship.craft.vertical then 1600 else 450) + 0.05 * agl else (if swap then SWAP_H else 120) + 0.03 * agl
		if not phase then
			for _, P in ipairs(craft.engines) do
				if P.alive == false then continue end
				local c = engineClass(P)
				if c == "main" then hasMain = true elseif c == "lift" then hasLift = true end
			end
			local peGround = el.pe - body.R - math.max(0, ground)
			if vh > 150 and agl > 8000 and peGround > (if body == EARTH then 25000 else -8000) then phase = "deorbit"
			elseif vh > 60 and agl > 1500 then phase = "coast"
			else phase = "final" end
		end
		local airy = body == EARTH or body == MARS
		if airy and not model then model = fallModel(craft, axis, if body == MARS then ground else math.max(0, ground), if swap then SWAP_H else 120) end
		local aVac = if airy then amax / model.tScale(E.p) else amax
		local air = nil
		if airy and E.h < body.atmoTop then
			air = { k = model.k, ground = if body == MARS then ground else math.max(0, ground), tScale = model.tScale, air = if body == MARS then function(h) return airAt(MARS, h) end else nil }
		end
		if amax < g * 1.05 and agl < 20000 and phase ~= "deorbit" then return { done = true, throttle = 0, msg = "Not enough thrust to land" } end

		if phase == "deorbit" then
			local peTarget = if body == EARTH then 20000 else math.max(0, ground) - 25000
			local dir = rs.v:clone():normalize():negate()
			local al = fwd:dot(dir)
			local peAlt = el.pe - body.R
			if peAlt < peTarget then phase = "coast"; return { dir = dir, axis = axis, throttle = 0 } end
			local dvNeed = math.max(1, (peAlt - peTarget) / 5000)
			return { dir = dir, axis = axis, throttle = if al > 0.99 then clamp(dvNeed / (amax * 0.5), 0.05, 1) else 0, status = "Deorbit burn", engines = brakeEng }
		end

		if phase == "coast" then
			local dir = vS:clone():normalize():negate()
			if coastStart == nil then coastStart = ship.t end
			if guided and onMoon and corr == 0 and ship.t - coastStart > 240 and E.agl > 15000 then
				corr += 1
				local fix = landingCorrection(ship, target, { aVac = amax * 0.85, hTarget = if swap then SWAP_H else 120, ground = target.elev or 0 }, MOON)
				if fix and fix.dv:length() > (if #craft.rcsList > 0 then 0.04 else 0.2) then
					local node = { t = ship.t + 25, dv = fix.dv, body = MOON, label = "Landing correction" }
					Ctl.node = node; sub = nodeExec(node)
					return { dir = dir, axis = axis, throttle = 0, status = "Course correction" }
				end
			end
			if guided and not onMoon and vz < 0 and ((corr == 0 and (ship.t - coastStart > 300 or E.h < 150000)) or (corr == 1 and E.h < 128000)) then
				corr += 1
				local M = copyTable(model); M.mass = craft.mass; M.aVac = aVac * 0.85
				local fix = landingCorrection(ship, target, M)
				if fix and fix.dv:length() > (if #craft.rcsList > 0 then 0.04 else 0.3) then
					local node = { t = ship.t + 25, dv = fix.dv, body = EARTH, label = "Landing correction" }
					Ctl.node = node; sub = nodeExec(node)
					return { dir = dir, axis = axis, throttle = 0, status = "Course correction" }
				end
			end
			if guided and not onMoon and E.h < 45000 and E.h > 9000 and ship.t >= trimT then
				trimT = ship.t + 1
				local M = copyTable(model); M.mass = craft.mass; M.aVac = aVac * 0.85
				local tgtP = llh(target.lat, target.lon, 0, 1, V3())
				local L0 = fallLanding(ship.r, ship.v, ship.t, M)
				local along = tgtP:clone():sub(L0.p):dot(L0.d) * EARTH.R
				if along < -250 then
					local L1 = fallLanding(ship.r, ship.v:clone():addScaledVector(vS:clone():normalize(), -2), ship.t, M)
					local sens = (tgtP:clone():sub(L1.p):dot(L1.d) * EARTH.R - along) / 2
					trimLeft = if sens > 1 then math.min(150, -along / sens) else 0
				else
					trimLeft = 0
				end
			end
			if trimLeft > 0.2 then
				local thr = clamp(trimLeft / (amax * dt), 0, 1) * smoothstep(0.9, 0.98, fwd:dot(dir))
				trimLeft -= amax * thr * dt
				return { dir = dir, axis = axis, throttle = thr, status = "Trim burn", engines = brakeEng }
			end
			local stop = brakeSim(agl, vz, vh, aVac * 0.85, g, body.R, air)
			if stop <= hTarget or (body == MARS and E.h < 95000 and vz < 0) then
				phase = "brake"
			else
				if ship.t - lastWake > 20 then
					lastWake = ship.t
					local est = estimateBrakeStart(ship, amax, math.max(0, ground) + (if body == MOON then 3000 else 500)) - 60
					-- wake halfway there and estimate again, so a long coast can't drift past the real brake point
					ap.wakeAt = math.min(est, ship.t + math.max(30, (est - ship.t) * 0.5))
					if guided and not onMoon and corr == 0 then ap.wakeAt = math.min(ap.wakeAt, coastStart + 290, timeToAlt(ship, 152000)) end
					if guided and not onMoon and corr == 1 then ap.wakeAt = math.min(ap.wakeAt, timeToAlt(ship, 130000)) end
					if guided and onMoon and corr == 0 then ap.wakeAt = math.min(ap.wakeAt, coastStart + 250) end
					if body == MARS then ap.wakeAt = math.min(ap.wakeAt, timeToAlt(ship, 100000, MARS) - 30) end
				end
				local st = if ap.wakeAt then "Coasting · braking in " .. fmtTime(math.max(0, ap.wakeAt + 60 - ship.t)) else "Coasting to braking burn"
				if guided then
					local d = if onMoon then aimAt(ship.t, 0):distanceTo(ship.r) else gcDist(E.lat, E.lon, target.lat, target.lon)
					st = string.format("%s to %s · %s", if onMoon then "Descending" else "Falling", target.name or "target", if d > 1000 then string.format("%d km", math.round(d / 1000)) else string.format("%d m", math.round(d)))
				end
				return { dir = dir, axis = axis, throttle = 0, status = st, engines = brakeEng }
			end
		end
		ap.wakeAt = nil

		if phase == "brake" then
			local sp = vS:length()
			if sp < (if swap then 25 else 18) or agl < (if swap then SWAP_H - 150 else 150) or (vz > 0 and vh < 10) then
				phase = "final"
			else
				local dir = vS:clone():normalize():negate()
				local thr
				local aRef = if air then aVac else amax
				if brakeSim(agl, vz, vh, aRef * 0.97, g, body.R, air) <= hTarget or (body == MARS and sp > 700) then
					thr = 1
				else
					local lo, hi = 0, 0.97
					for _ = 1, 8 do
						local m = (lo + hi) / 2
						if brakeSim(agl, vz, vh, aRef * m, g, body.R, air) > hTarget then hi = m else lo = m end
					end
					thr = hi
				end
				local al = fwd:dot(dir)
				return { dir = dir, axis = axis, throttle = thr * smoothstep(0.7, 0.95, al), gear = if agl < 3000 then true else nil, status = "Braking burn", engines = brakeEng }
			end
		end

		-- final: vertical descent, kill horizontal drift, land upright
		local anet = math.max(0.6, amax * 0.85 - g)
		local vzT = -clamp(math.sqrt(2 * anet * agl) * (if body == MOON then 0.35 else 0.5), 1.3, if body == MARS then (if E.rho > 0.003 and #craft.wings > 0 then 28 else 140) elseif body == MOON then 40 else 80)
		local hor = vH:clone():multiplyScalar(if agl < 30 then -1.0 else -0.6)
		local maxTilt = if agl < 30 then 0.18 elseif agl < 300 then 0.3 else 0.6
		local status = if agl > 100 then "Descending" else string.format("Touchdown in %.0f s", math.max(0, agl / math.max(1, -vz)))
		if guided then
			local d = aimAt(ship.t, 0):sub(ship.r)
			d:addScaledVector(up, -d:dot(up))
			local dist = d:length()
			if dist > 6000 then giveUp = true; Ctl.status = string.format("%s is %d km away — too far to hover; landing here", target.name or "The target", math.round(dist / 1000)) end
			if ship.t >= (ap._fuelT or 0) then
				ap._fuelT = ship.t + 1
				if dist > 60 and deltaV(craft, E.rho > 0.01, function(P) return P.eng.active end) < 120 then giveUp = true; Ctl.status = "Fuel low — landing here" end
			end
			if agl > 45 then maxTilt = 0.45 end
			local aLat = g * math.tan(maxTilt) * 0.5
			local vMax = math.min(if agl < 30 then 1.5 elseif agl < 45 then 8 else 35, 0.1 * dist, math.sqrt(2 * aLat * math.max(0, dist - 15)))
			local vCmd = d:normalize():multiplyScalar(vMax)
			if agl < 20 then vCmd:set(0, 0, 0) end
			hor = vCmd:sub(vH):multiplyScalar(if agl < 30 then 1.0 else 0.6)
			local hHold = clamp(dist * 0.4, 50, 150)
			if (dist > 60 or vh > 2.5) and agl < hHold + 40 then vzT = clamp((hHold - agl) * 0.3, -4, 4) end
			if dist > 60 then status = string.format("Flying to %s · %d m", target.name or "target", math.round(dist)) end
		end
		local vert = 1.5 * (vzT - vz) + g
		local vb = math.max(vert, 0.3 * g)
		local hl = hor:length()
		if hl > math.tan(maxTilt) * vb then hor:multiplyScalar(math.tan(maxTilt) * vb / hl) end
		-- point along (up * vb + hor) so a rocket stays upright even while it lets itself fall
		-- (vert < 0); the thrust it needs is the real, possibly zero, vertical demand plus the sideways one
		local need = up:clone():multiplyScalar(math.max(vert, 0)):add(hor):length()
		local dir = up:clone():multiplyScalar(vb):add(hor)
		dir:normalize()
		local al = fwd:dot(dir)
		local thr = clamp(need / amax, 0, 1) * smoothstep(0.6, 0.95, al)
		-- far off upright (a rocket coming out of its braking burn on its side): a trickle of thrust lets the
		-- engine gimbal swing the nose up much faster than the RCS alone
		if al < 0.95 and al > -0.2 and agl > 60 and craft.vertical then thr = math.max(thr, 0.1 * (1 - smoothstep(0.85, 0.97, al))) end
		if vz > 3 and agl > 20 then thr = 0 end
		return { dir = dir, axis = axis, throttle = thr, gear = if agl < 1500 then true else nil, engines = finalEng, status = status }
	end
	return ap
end
local landAp = C.landAp

local function angDiff(a, b) local d = a - b; return math.atan2(math.sin(d), math.cos(d)) end

-- Automatic landing on a runway through the fly-by-wire (flight-path angle and bank holds).
-- `A` provides local(rw, lat, lon) -> {along, cross} and elevAt(rw, along); `rw` is a runway record
-- { latC, lonC, dx, dy, cosC, len }.
function C.landRunwayAp(A, rw, label, terrain)
	label = label or ""
	local s, phase, integ, thrPrev, Vref, hasJets = 0, "enroute", 0, 0.4, nil, false
	local tanGs, floorT, floorH = math.tan(3 * D2R), -1e9, 0
	local R = EARTH.R
	local function rwLL(along, cross)
		local x, y = along * rw.dx + cross * rw.dy, along * rw.dy - cross * rw.dx
		return rw.latC + (y / R) / D2R, rw.lonC + (x / (R * rw.cosC)) / D2R
	end
	return {
		name = "Auto-land", cancelOnStick = true,
		update = function(ship, dt, Ctl)
			local craft, E = ship.craft, ship.env
			if E.body ~= EARTH then return { done = true, fail = true, msg = "Runway landing works on Earth" } end
			local up = E.up
			local north = V3(0, 1, 0):addScaledVector(up, -up.y):normalize()
			local east = V3():crossVectors(north, up)
			local v = E.vAir
			local ve, vn = v:dot(east), v:dot(north)
			local L = A:localCoords(rw, E.lat, E.lon)
			if s == 0 then
				s = if L.along < 0 then 1 else -1
				if terrain then
					local uA = -rw.len / 2 + math.min(350, rw.len * 0.15)
					local el0 = A:elevAt(rw, 0)
					local function need(d) return clamp(d * 0.04, 30, 150) end
					local function check(dir)
						local worst, needTan = 0, math.tan(3 * D2R)
						for d = 600, 15000, 400 do
							local la, lo = rwLL(dir * (uA - d), 0)
							local g = terrain(la, lo)
							worst = math.max(worst, need(d) - (el0 + d * math.tan(3 * D2R) + 15 - g))
							needTan = math.max(needTan, (g + need(d) - el0 - 15) / d)
						end
						return { worst = worst, needTan = needTan }
					end
					local here, other = check(s), check(-s)
					if here.worst > 0 and other.worst < here.worst - 30 then s = -s; tanGs = math.min(math.tan(6 * D2R), other.needTan)
					else tanGs = math.min(math.tan(6 * D2R), here.needTan) end
				end
				local S = 0
				for _, P in ipairs(craft.wings) do if P.alive ~= false then S += P.wing.area end end
				local vs = math.sqrt((2 * craft.mass * 9.81) / (1.225 * math.max(5, S) * 1.25))
				Vref = clamp(vs * 1.3, 55, 110)
				hasJets = anyOf(craft.engines, function(P) return P.alive ~= false and engineClass(P) == "jets" end)
			end
			local u, x = s * L.along, s * L.cross
			local vu, vx = s * (ve * rw.dx + vn * rw.dy), s * (ve * rw.dy - vn * rw.dx)
			local uAim = -rw.len / 2 + math.min(350, rw.len * 0.15)
			local dist = uAim - u
			local elev = A:elevAt(rw, clamp(L.along, -rw.len / 2, rw.len / 2))
			local hAgl = E.h - elev - math.max(0, -craft.box.min.y)
			local rwHdg = if s > 0 then math.atan2(rw.dx, rw.dy) else math.atan2(-rw.dx, -rw.dy)
			local track = math.atan2(ve, vn)
			local V = v:length()
			local onGround = ship.contacts > 0
			local wantTrack, hT, Vt, gear, toFix = 0, 0, Vref, nil, 0
			if phase == "rollout" or (onGround and phase == "flare") then
				phase = "rollout"
				Ctl.gHeading = rwHdg + clamp(-x * 0.02 - vx * 0.05, -0.2, 0.2)
				if E.vSurf < 2 then return { done = true, throttle = 0, brake = 1, msg = "Landed" .. (if label ~= "" then " at " .. label else "") } end
				return { throttle = 0, brake = if E.vSurf > 25 then 0.7 else 1, gear = true, status = string.format("Rollout · %d m/s", math.round(E.vSurf)) }
			end
			if onGround and phase == "enroute" then return { done = true, msg = "Already on the ground" } end
			local onFinal = dist > 0 and math.abs(x) < math.max(400, dist * 0.35) and math.abs(angDiff(track, rwHdg)) < 1.0
			if phase == "enroute" and onFinal and dist < 22000 then phase = "final" end
			if phase == "final" and (dist < -rw.len * 0.6 or math.abs(x) > math.max(800, dist * 0.6)) then phase = "enroute" end
			if phase == "enroute" then
				local faf = math.max(9000, math.min(16000, V * 90))
				local pu = uAim - faf
				local du, dx = pu - u, -x
				local dPt = Geo.hypot(du, dx)
				toFix = dPt
				if dPt < 2500 then phase = "final" end
				wantTrack = rwHdg + math.atan2(dx, du)
				hT = elev + clamp(800 + (dPt - 2500) * 0.06, 800, 4500)
				if terrain and ship.t - floorT > 2 then
					floorT = ship.t; floorH = 0
					local la1, lo1 = rwLL(s * pu, 0)
					for k = 1, 6 do local f = k / 6; floorH = math.max(floorH, terrain(E.lat + (la1 - E.lat) * f, E.lon + (lo1 - E.lon) * f)) end
				end
				hT = math.max(hT, floorH + 450)
				Vt = math.max(Vref * 1.45, math.min(V, 160))
				gear = false
			end
			if phase == "final" or phase == "flare" then
				local lead = clamp(dist * 0.25, 600, 3000)
				wantTrack = rwHdg + clamp(math.atan2(-x - vx * 4, lead), -0.6, 0.6)
				hT = elev + math.max(0, dist) * tanGs + 15
				Vt = Vref + clamp(dist / 1000, 0, 25)
				gear = if hAgl < 700 then true else nil
			end
			if phase == "final" and hAgl < 14 and dist < 800 then phase = "flare" end
			local gamma
			if phase == "flare" then
				local vzT = -clamp(hAgl * 0.12, 0.5, 2.5)
				gamma = math.asin(clamp(vzT / math.max(V, 1), -0.3, 0.3))
				Vt = 0
			else
				local k = if phase == "final" then 1 / 300 else 1 / 2500
				gamma = clamp((if phase == "final" then -tanGs else 0) + (hT - E.h) * k * (if phase == "final" then 0.18 else 1), -0.2, 0.15)
				if phase == "enroute" and E.agl < 350 then gamma = math.max(gamma, 0.08) end
				if phase == "final" and dist > 1500 and E.agl < math.min(120, hAgl * 0.6) then gamma = math.max(gamma, 0.02) end
			end
			Ctl.gammaHold = gamma
			local te = angDiff(wantTrack, track)
			local bankLim = if hAgl < 60 then 0.1 elseif phase == "final" then 0.35 else 0.5
			Ctl.bankHold = clamp(te * 1.6, -bankLim, bankLim)
			if Ctl.sas ~= "hold" and Ctl.sas ~= "off" then Ctl.sas = "hold" end
			local err = Vt - V
			if Vt > 0 then integ = clamp(integ + err * dt * 0.02, -0.4, 0.6) else integ = 0 end
			local thr = if Vt > 0 then clamp(0.35 + err * 0.05 + integ, 0, 1) else 0
			thr = thrPrev + clamp(thr - thrPrev, -dt * 0.8, dt * 0.8)
			thrPrev = thr
			local st
			if phase == "enroute" then st = string.format("%s · lining up in %.1f km", if label ~= "" then label else "Runway", toFix / 1000)
			elseif phase == "final" then st = string.format("Final · %.1f km · %d m", math.max(0, dist) / 1000, math.round(hAgl))
			else st = "Flare" end
			local _ = vu
			return { throttle = thr, gear = gear, brake = 0, engines = if hasJets then "jets" else nil, status = st }
		end,
	}
end

-- coast (time-warping) until below `alt`, nose forward and belly down, ready for reentry
function C.coastToAp(alt)
	alt = alt or 140000
	local ap
	ap = {
		name = "Coast", wakeAt = nil, cancelOnStick = true,
		railsDir = function(ship) return { dir = ship.env.vAir:clone():normalize(), axis = NOSE } end,
		update = function(ship, dt, Ctl)
			local E = ship.env
			if E.h < alt then ap.wakeAt = nil; return { done = true, msg = "Entry interface" } end
			if ap.wakeAt == nil or ship.t > ap.wakeAt then
				local st = { r = ship.r:clone(), v = ship.v:clone(), t = ship.t }
				local tCross = nil
				for _ = 1, 600 do
					st = propagate(st.r, st.v, st.t, 30)
					if st.r:length() - EARTH.R < alt then tCross = st.t; break end
				end
				ap.wakeAt = if tCross then math.max(ship.t + 1, tCross - 120) else ship.t + 600
			end
			return { dir = E.vAir:clone():normalize(), axis = NOSE, up = E.up:clone(), throttle = 0, status = "entry in " .. fmtTime(math.max(0, ap.wakeAt + 120 - ship.t)) }
		end,
	}
	return ap
end
local coastToAp = C.coastToAp

-- runs a planner off the physics step (a task in Roblox; inline in the command-line tests)
local function runAsync(fn)
	if task and task.spawn then task.spawn(fn) else fn() end
end
C.runAsync = runAsync

-- plan a burn when this step starts and fly it; an optional step that finds nothing to do moves on
function C.planBurnAp(name, planFn, optional)
	local state, node, exec = "idle", nil, nil
	local ap
	ap = {
		name = name, cancelOnStick = true, wakeAt = nil,
		railsDir = function(ship, Ctl) if exec then return exec.railsDir(ship, Ctl) end; return nil end,
		update = function(ship, dt, Ctl)
			if not exec then
				if state == "idle" then
					state = "planning"
					ap.wakeAt = -1          -- (while planning, keep time warp off)
					runAsync(function()
						local ok, res = pcall(planFn, ship)
						if not ok then warn(res) end
						node = if ok then res else nil
						state = "ready"
					end)
				end
				if state == "planning" then return { throttle = 0, status = "planning…" } end
				if not node then
					ap.wakeAt = nil
					if optional then return { done = true } end
					return { done = true, fail = true, msg = name .. ": no solution found from here" }
				end
				Ctl.node = node
				exec = nodeExec(node)
			end
			local o = exec.update(ship, dt, Ctl)
			ap.wakeAt = exec.wakeAt
			return o
		end,
	}
	return ap
end
local planBurnAp = C.planBurnAp

-- coast (time warp allowed) until untilFn(ship); wakeFn(ship) estimates when that will be
function C.waitAp(name, untilFn, wakeFn)
	local ap
	ap = {
		name = name, cancelOnStick = true, wakeAt = nil,
		railsDir = function(ship) return { dir = ship.env.vAir:clone():normalize(), axis = NOSE } end,
		update = function(ship, dt, Ctl)
			if untilFn(ship) then return { done = true } end
			if ap.wakeAt == nil or ship.t > ap.wakeAt then ap.wakeAt = math.max(ship.t + 1, wakeFn(ship) or ship.t + 600) end
			return { dir = ship.env.vAir:clone():normalize(), axis = NOSE, up = ship.env.up:clone(), throttle = 0, status = fmtTime(math.max(0, ap.wakeAt - ship.t)) }
		end,
	}
	return ap
end
local waitAp = C.waitAp

-- run autopilots one after another (each step is a factory (ship, C) -> autopilot); a failed step stops it
function C.sequenceAp(name, steps)
	local i, cur = 0, nil
	local seq
	seq = {
		name = name, cancelOnStick = true, wakeAt = nil,
		railsDir = function(ship, Ctl) if cur and cur.railsDir then return cur.railsDir(ship, Ctl) end; return nil end,
		update = function(ship, dt, Ctl)
			if not cur then
				i += 1
				if i > #steps then seq.wakeAt = nil; return { done = true, msg = name .. " complete" } end
				cur = steps[i](ship, Ctl)
				if not cur then return { done = true, fail = true, msg = string.format("%s: step %d not possible", name, i) } end
			end
			local o = cur.update(ship, dt, Ctl)
			seq.wakeAt = cur.wakeAt
			if o and o.done then
				if o.fail or i == #steps then local r = copyTable(o); r.done = true; return r end
				if o.msg then Ctl.status = o.msg end
				cur = nil
				seq.wakeAt = nil
				return { throttle = 0 }
			end
			if o then o.status = cur.name .. (if o.status and o.status ~= "" then " · " .. o.status else "") end
			return o
		end,
	}
	return seq
end
local sequenceAp = C.sequenceAp

-- Reentry, Shuttle style: belly first at a high angle of attack, steering lift with the bank angle; levels
-- the wings and hands back control around Mach 3
function C.reentryAp(target, opts)
	opts = opts or {}
	local bank, liftAcc, side, rangeT, ballistic = 0, 0, 1, -1e9, 0
	return {
		name = "Reentry", cancelOnStick = true,
		update = function(ship, dt, Ctl)
			local craft, E = ship.craft, ship.env
			if E.body ~= EARTH then return { done = true, fail = true, msg = "Reentry works at Earth" } end
			local up = E.up:clone()
			local vS = E.vAir:clone()
			local V = vS:length()
			if (E.mach < 3 and E.h < 32000) or E.h < 15000 then
				Ctl.gammaHold = -0.03; Ctl.bankHold = 0
				if Ctl.sas ~= "hold" and Ctl.sas ~= "off" then Ctl.sas = "hold" end
				return { done = true, throttle = 0, msg = if opts["then"] then "Reentry complete — " .. opts["then"] else "Reentry complete — you have control" }
			end
			local vh = vS:clone():normalize()
			local r = ship.r:length()
			local g = EARTH.mu / (r * r)
			local vz = vS:dot(up)
			local vHor = vS:clone():addScaledVector(up, -vz):length()
			local centrif = (vHor * vHor) / r
			local aero = if ship.aeroB then ship.aeroB:clone():applyQuaternion(ship.q):divideScalar(craft.mass) else V3()
			local lift = aero:clone():addScaledVector(vh, -aero:dot(vh))
			liftAcc += (lift:length() - liftAcc) * math.min(1, dt * 2)
			local aoa = clamp(8 + (E.mach - 3) / 9 * 32, 8, 40) * D2R
			local hTgt = 22000 + 4000 * (V / 1000)
			local tgtInfo = ""
			if target then
				local north = V3(0, 1, 0):addScaledVector(up, -up.y):normalize()
				local east = V3():crossVectors(north, up)
				local track = math.atan2(vS:dot(east), vS:dot(north))
				local brg = gcBearing(E.lat, E.lon, target.lat, target.lon)
				local rel = math.atan2(math.sin(brg - track), math.cos(brg - track))
				if math.abs(rel) > 0.1 and math.sign(rel) ~= side then side = math.sign(rel) end
				local dist = gcDist(E.lat, E.lon, target.lat, target.lon)
				if V > 6900 and E.h > 56000 then
					if ship.t - rangeT > 3 then rangeT = ship.t; ballistic = coastGround(ship.r, ship.v, ship.t, 55000).arc end
				else
					ballistic = 0
				end
				local rNom = ballistic + glideRange(math.min(V, 6970))
				local rErr = dist - rNom
				hTgt += clamp(rErr * 0.006, -9000, 9000)
				if rErr > 0 and aoa > 22 * D2R then aoa += (22 * D2R - aoa) * clamp(rErr / 300e3, 0, 1) end
				if rErr < 0 and E.mach > 6 then aoa += (48 * D2R - aoa) * clamp(-rErr / 300e3, 0, 1) end
				tgtInfo = string.format(" · %s %d km", target.name or "target", math.round(dist / 1000))
			end
			local aReq = 0.004 * (hTgt - E.h) - 0.13 * vz + g - centrif
			if E.mach < 6 then aReq = math.max(aReq, 0.15 * (-40 - (E.mach - 3) * 40 - vz) + g - centrif) end
			local want = if liftAcc > 0.3 then math.acos(clamp(aReq / liftAcc, -1, 1)) elseif aReq < 0 then PI else 0
			if E.mach < 5 then want = math.min(want, (E.mach - 3) / 2 * PI / 3) end
			bank += clamp(want - bank, -0.35 * dt, 0.35 * dt)
			local l0 = up:clone():addScaledVector(vh, -up:dot(vh)):normalize()
			local sd = V3():crossVectors(vh, l0):multiplyScalar(side)
			local lphi = l0:clone():multiplyScalar(math.cos(bank)):addScaledVector(sd, math.sin(bank))
			local dir = vh:clone():multiplyScalar(math.cos(aoa)):addScaledVector(lphi, math.sin(aoa))
			local upRef = lphi:clone():multiplyScalar(math.cos(aoa)):addScaledVector(vh, -math.sin(aoa))
			local deg = math.round(bank / D2R)
			local st = if E.h > 100000 then "Entry interface" else string.format("Bank %d° · AoA %d°", deg, math.round(aoa / D2R))
			return { dir = dir, axis = NOSE, up = upRef, throttle = 0, gear = false, status = st .. tgtInfo }
		end,
	}
end
local reentryAp = C.reentryAp

-- Ascent to orbit: vertical rockets and spaceplanes from Earth, and landers from the Moon or Mars
-- (lift thrusters for the first few hundred metres, then the main engine).
function C.ascentAp(targetAlt, heading)
	heading = heading or PI / 2
	local phase, plane, hasMain, hasLift, hasJets, mainOn, hybrid, wasPlane = "init", false, false, false, false, false, false, false
	local sub = nil
	local function orbitMsg(ship)
		local b = ship.env.body
		local rs = relState(ship, b)
		local el = elements(rs.r, rs.v, b.mu)
		return string.format("Orbit reached: %d × %d km", math.round((el.ap - b.R) / 1000), math.round((el.pe - b.R) / 1000))
	end
	local function circularize(ship, Ctl)
		local circ = planCircularize(ship, true)
		if not circ then return false end
		Ctl.node = circ; sub = nodeExec(circ)
		return true
	end
	local ap
	ap = { name = "Ascent", cancelOnStick = true, wakeAt = nil }
	ap.railsDir = function(ship, Ctl) if sub then return sub.railsDir(ship, Ctl) end; return nil end
	local function upd(ship, dt, Ctl)
		if sub then
			local o = sub.update(ship, dt, Ctl)
			if o and o.done then
				if o.fail then return o end
				return { done = true, throttle = 0, msg = orbitMsg(ship) }
			end
			if o then o.status = if sub.node and (o.throttle == nil or o.throttle == 0) then "coasting to apoapsis" else "circularizing" end
			return o
		end
		local craft, E = ship.craft, ship.env
		local body = E.body
		local moon, mars = body == MOON, body == MARS
		local lowG = moon or mars
		local tAlt = targetAlt or (if moon then 40000 elseif mars then 180000 else 160000)
		local up = E.up:clone()
		local spin = if moon then V3(0, math.cos(0.4091), math.sin(0.4091)) elseif mars then ship.eph.aY:clone() else V3(0, 1, 0)
		local east = spin:clone():cross(up):normalize()
		local north = up:clone():cross(east):normalize()
		local hdg = north:clone():multiplyScalar(math.cos(heading)):addScaledVector(east, math.sin(heading))
		local rs = relState(ship, body)
		local el = elements(rs.r, rs.v, body.mu)
		local apAlt, peAlt = el.ap - body.R, el.pe - body.R
		local safePe = if moon then 15000 else body.atmoTop + 5000
		if phase == "init" then
			local S = 0
			for _, P in ipairs(craft.wings) do S += P.wing.area end
			plane = body == EARTH and S > craft.mass / 1500 and not craft.vertical
			for _, P in ipairs(craft.engines) do
				if P.alive == false then continue end
				local c = engineClass(P)
				if c == "main" then hasMain = true elseif c == "lift" then hasLift = true elseif c == "jets" then hasJets = true end
				if P.eng.e.type == "hybrid" then hybrid = true end
			end
			phase = "climb"
			ship.ctl.gear = true
		end
		local axis = Ctl:thrustAxis(craft, E)
		if phase == "coast" then
			if E.h > EARTH.atmoTop + 1000 then
				if circularize(ship, Ctl) then return { throttle = 0, dir = ship.v:clone():normalize() } end
				return { done = true, msg = "Coasting — plan circularization in the map" }
			end
			return { dir = Ctl:refVel(ship):normalize(), throttle = if apAlt < tAlt - 1000 then 0.3 else 0 }
		end
		if plane and apAlt > tAlt then phase = "coast"; return { throttle = 0, dir = Ctl:refVel(ship):normalize() } end
		local pitch
		local thr = 1
		if not plane then
			if peAlt > safePe then return { done = true, throttle = 0, msg = string.format("Orbit reached: %d × %d km", math.round(apAlt / 1000), math.round(peAlt / 1000)) } end
			local coastOk
			if moon then coastOk = (mainOn or not hasLift) and E.agl > 3000
			elseif mars then coastOk = (mainOn or not hasLift) and E.h > 40000
			else coastOk = E.h > 100000 end
			if coastOk and apAlt > tAlt - 500 then
				if circularize(ship, Ctl) then return { throttle = 0, dir = rs.v:clone():normalize(), axis = axis, status = "coasting to apoapsis" } end
			end
			local engines
			if lowG and hasLift and hasMain then
				if not mainOn and E.agl > 400 and E.vVert > 5 then mainOn = true end
				engines = if mainOn then "main" else "lift"
			elseif hasMain then
				engines = "main"
			end
			local h = E.h
			local r = rs.r:length()
			local vI = rs.v:clone()
			local vz = vI:dot(up)
			local vh = vI:clone():addScaledVector(up, -vz):length()
			local g = body.mu / (r * r)
			local aT = math.max(0.1, maxAccel(ship))
			local vzT
			if moon then vzT = math.min(150, math.sqrt(2 * 0.8 * math.max(0, tAlt - h))) * (if apAlt > tAlt then 0 else 1)
			elseif mars then vzT = math.min(450, math.sqrt(2 * 1.2 * math.max(0, tAlt - h))) * (if apAlt > tAlt then 0 else 1)
			else vzT = clamp((tAlt - h) / 80, 0, 900) end
			local aVert = g - (vh * vh) / r + (vzT - vz) / 6
			local s = clamp(aVert / aT, -0.25, 1)
			pitch = math.asin(s) / D2R
			if moon then
				if E.agl < 400 or (not mainOn and hasLift and hasMain) then pitch = 90 else pitch = math.max(pitch, if E.agl < 3000 then 20 elseif E.agl < 8000 then 3 else -15) end
			elseif mars then
				if E.agl < 400 or (not mainOn and hasLift and hasMain) then pitch = 90 else pitch = math.max(pitch, if E.agl < 3000 then 40 elseif E.agl < 15000 then 12 else -10) end
			elseif wasPlane then pitch = clamp(pitch, 3, 70)
			elseif h < 1500 or E.vSurf < 80 then pitch = 90
			elseif h < 12000 then pitch = math.max(pitch, 90 - (h - 1500) / 10500 * 35) end
			local dir = up:clone():multiplyScalar(math.sin(pitch * D2R)):addScaledVector(hdg, math.cos(pitch * D2R)):normalize()
			if E.q > 35000 then thr = 0.7 end
			if lowG then thr = math.min(thr, (2.5 * G0) / aT) end
			local vCirc = math.sqrt(body.mu / r)
			if vh > vCirc * 0.95 then thr = math.min(thr, clamp((safePe + 3000 - peAlt) / (if moon then 15000 elseif mars then 30000 else 60000), 0.06, 1)) end
			local upRef = hdg:clone():negate()
			if not lowG or E.agl > 30 then ship.ctl.gear = E.agl < 200 end
			return { dir = dir, axis = axis, up = upRef, throttle = thr, engines = engines, status = if lowG then (if mainOn or not hasLift then "Climbing to orbit" else "Lift-off") else nil }
		end
		-- spaceplane profile: take off and climb on the jets, then light the rocket / fusion engines
		ship.ctl.engineMode = "auto"
		local onGround = ship.contacts > 0
		local S = 0
		for _, P in ipairs(craft.wings) do S += P.wing.area end
		local vRot = math.sqrt((2 * craft.mass * 9.81) / (1.225 * S * 1.1)) * 1.15
		local mach, h = E.mach, E.h
		local engines
		if hybrid then engines = "all"
		elseif hasJets and hasMain then
			if not mainOn and (h > 6000 or (not onGround and E.rho < 0.6)) then mainOn = true end
			engines = if mainOn then "main" else "jets"
		elseif hasMain then engines = "main"
		elseif hasJets then engines = "jets" end
		local rocket = anyOf(craft.engines, function(P) return P.eng.active and P.eng.mode == "rocket" and P.eng.flame > 0 end)
		if rocket and not onGround then
			local vI, Vv = rs.v:length(), math.max(1, E.vSurf)
			local twr = maxAccel(ship) / (body.mu / (rs.r:length() ^ 2))
			if vI > 6300 or E.h > 62000 or (E.q < 500 and E.h > 30000) or twr > 1.0 then
				plane = false; wasPlane = true
				return { throttle = 1, engines = engines, dir = rs.v:clone():normalize(), axis = NOSE, status = "Pull-up to orbit" }
			end
			local qT = clamp(20000 - (Vv - 1000) * 3.4, 3000, 20000)
			local rhoT = (2 * qT) / (Vv * Vv)
			local hT = -7200 * math.log(math.max(1e-7, rhoT) / 1.225)
			local vzT = clamp((hT - E.h) / 30, -60, 250)
			Ctl.gammaHold = math.asin(clamp(vzT / Vv, -0.15, 0.4))
			local northL = V3(0, 1, 0):addScaledVector(up, -up.y):normalize()
			local eastL = V3():crossVectors(northL, up)
			local track = math.atan2(E.vAir:dot(eastL), E.vAir:dot(northL))
			local want = math.atan2(hdg:dot(eastL), hdg:dot(northL))
			Ctl.bankHold = clamp(math.atan2(math.sin(want - track), math.cos(want - track)) * 1.2, -0.35, 0.35)
			if Ctl.sas ~= "hold" and Ctl.sas ~= "off" then Ctl.sas = "hold" end
			if E.agl > 50 then ship.ctl.gear = false end
			return { throttle = 1, engines = engines, gear = false, status = string.format("Lifting climb · Mach %.1f · %d km", mach, math.round(E.h / 1000)) }
		end
		if onGround then pitch = if E.vSurf > vRot then 10 else 0
		elseif h < 9000 and not rocket then pitch = 14
		elseif not rocket and mach < 4.6 then pitch = if h < 21000 then 6 elseif h < 25000 then 2 else 0
		else pitch = clamp(22 - (h - 30000) / 4000, 8, 25) end
		if onGround then
			local pitchNow = math.asin(clamp(V3(0, 0, -1):applyQuaternion(ship.q):dot(up), -1, 1)) / D2R
			return { throttle = 1, gear = true, engines = engines, pitchCmd = if E.vSurf > vRot then clamp((10 - pitchNow) * 0.12, -0.3, 0.6) else 0, status = if E.vSurf > vRot then "Rotate" else "Take-off roll" }
		end
		if not onGround and E.agl > 50 then ship.ctl.gear = false end
		local dir = up:clone():multiplyScalar(math.sin(pitch * D2R)):addScaledVector(hdg, math.cos(pitch * D2R)):normalize()
		return { dir = dir, axis = NOSE, up = up, throttle = 1, engines = engines, status = if rocket then string.format("Rocket climb · Ap %d km", math.round(apAlt / 1000)) else string.format("Jet climb · Mach %.1f", mach) }
	end
	ap.update = function(ship, dt, Ctl)
		local o = upd(ship, dt, Ctl)
		ap.wakeAt = if sub then sub.wakeAt else nil
		return o
	end
	return ap
end
local ascentAp = C.ascentAp

-- The whole way home from the Moon (or a return trajectory) to a runway (see control.js flyHomeAp).
-- o = { A, rw, airport, name, iMin, terrain, vertical }
function C.flyHomeAp(ship, o)
	local A, rw, name, iMin = o.A, o.rw, o.name, o.iMin
	local deorbit, tFinal = nil, nil
	local P7 = { maxT = 7 * 86400, maxSteps = 3000, oneRev = false, maxStep = 1800, earthStop = -EARTH.R * 0.9, moonStop = false }
	local steps = {}
	if ship.env.body == MOON then
		local rs = relState(ship, MOON)
		local el = elements(rs.r, rs.v, MOON.mu)
		if ship.env.agl < 50 or not (el.pe - MOON.R > 10000) then table.insert(steps, function() return ascentAp() end) end
		table.insert(steps, function() return planBurnAp("Leave the Moon", function(s) return planReturn(s, 250000, nil, { iMin = iMin }) end) end)
		table.insert(steps, function()
			return waitAp("Leaving the Moon", function(s) return s.env.body == EARTH end, function(s)
				local p = predict(s.r, s.v, s.t, P7)
				return if p.soiOut then p.soiOut + 60 else s.t + 3600
			end)
		end)
	end
	local eEl = if ship.env.body == EARTH then elements(ship.r, ship.v, EARTH.mu) else nil
	local transit = not eEl or eEl.e >= 1 or eEl.ap - EARTH.R > 5e6
	if transit then
		table.insert(steps, function() return planBurnAp("Course correction", function(s) return planCorrection(s, EARTH, 250000, nil, { iMin = iMin }) end, true) end)
		table.insert(steps, function()
			return waitAp("Coast to Earth", function(s) return tFinal ~= nil and s.t >= tFinal - 1 end, function(s)
				if tFinal == nil then tFinal = predict(s.r, s.v, s.t, P7).earthPe.t - 8 * 3600 end
				return tFinal
			end)
		end)
		table.insert(steps, function() return planBurnAp("Final correction", function(s) return planCorrection(s, EARTH, 250000, nil, { iMin = iMin }) end, true) end)
		table.insert(steps, function() return planBurnAp("Brake into orbit", function(s) return planCircularize(s, false) end) end)
	end
	if o.vertical then
		local target = { lat = rw.latC, lon = rw.lonC, elev = ((rw.e1 or 0) + (rw.e2 or 0)) / 2, name = name }
		table.insert(steps, function(s0, Ctl)
			return planBurnAp("Deorbit to " .. name, function(s) return planLandingTo(s, target.lat, target.lon, name, nil, landingModel(s.craft, Ctl:thrustAxis(s.craft, s.env), target.elev)) end)
		end)
		table.insert(steps, function() return landAp(target) end)
		local seq = sequenceAp("Home to " .. name, steps)
		seq.home = if o.airport then o.airport.ident else nil
		return seq
	end
	table.insert(steps, function()
		return planBurnAp("Deorbit to " .. name, function(s)
			deorbit = planDeorbitTo(s, rw.latC, rw.lonC, name)
			if deorbit then deorbit.runway = rw; deorbit.airport = o.airport end
			return deorbit
		end)
	end)
	table.insert(steps, function() return coastToAp() end)
	table.insert(steps, function() return reentryAp(deorbit and deorbit.target, { ["then"] = "lining up for " .. name }) end)
	table.insert(steps, function() return C.landRunwayAp(A, rw, name, o.terrain) end)
	local seq = sequenceAp("Home to " .. name, steps)
	seq.home = if o.airport then o.airport.ident else nil
	return seq
end


return C
