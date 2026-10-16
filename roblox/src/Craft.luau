--!native
-- A craft assembled from a design (port of src/ship/craft.js): mass properties, engines, aerodynamics,
-- heating and damage, all in the body frame. Visuals live in the Roblox renderer (ShipModel).
-- Body frame: -Z = nose/forward, +Y = up (dorsal), +X = right.

local THREE = require(script.Parent.Three)
local Parts = require(script.Parent.Parts)
local Geo = require(script.Parent.Geo)
local V3, Quat, M3, M4 = THREE.Vector3.new, THREE.Quaternion.new, THREE.Matrix3.new, THREE.Matrix4.new
local PART, SIZES, variantDef = Parts.PART, Parts.SIZES, Parts.variantDef
local clamp, smoothstep = Geo.clamp, Geo.smoothstep

local SIGMA = 5.670e-8
local _t, _v, _w, _r, _u, _f, _r2 = V3(), V3(), V3(), V3(), V3(), V3(), V3()

local Craft = {}
Craft.__index = Craft

local function arr3(a) return V3(a[1], a[2], a[3]) end
local function any(list, fn) for _, x in ipairs(list) do if fn(x) then return true end end return false end
local function find(list, fn) for _, x in ipairs(list) do if fn(x) then return x end end return nil end

function Craft.new(design)
	local self = setmetatable({}, Craft)
	self.design = design
	self.colors = design.colors or { hull = "#d9dee5", accent = "#ffb347" }
	self.parts = {}
	self:build()
	self:recompute()
	return self
end

function Craft:build()
	local D = self.design.parts
	for i, d in ipairs(D) do
		local def = PART[d.id]
		if def and d.w then def = variantDef(def, d.w) end
		if not def then continue end
		local T = M4():compose(arr3(d.p), Quat(d.q[1], d.q[2], d.q[3], d.q[4]), V3(if d.mirror then -1 else 1, 1, 1))
		local N = M3():setFromMatrix4(T)
		local P = {
			i = i, def = def, d = d, T = T, N = N, alive = true,
			parent = if d.parent ~= nil and d.parent >= 0 then d.parent + 1 else 0, kids = {},
			temp = 288, maxT = def.maxT, dry = def.mass, res = {},
			com = arr3(def.com):applyMatrix4(T),
		}
		for k, a in pairs(def.res or {}) do P.res[k] = { amt = a, cap = a } end
		if d.res then for k, a in pairs(d.res) do if P.res[k] then P.res[k].amt = math.min(P.res[k].cap, a) end end end
		local L = def.len or 1
		local dia = if def.size then SIZES[def.size] else 0.6
		P.axis = V3(0, 1, 0):applyMatrix3(N):normalize()
		P.len = L; P.dia = dia
		if def.wing then
			local w = def.wing
			P.wing = {
				ac = V3(w.ac[1], w.ac[2], 0):applyMatrix4(T),
				s = V3(1, 0, 0):applyMatrix3(N):normalize(),
				c = V3(0, 1, 0):applyMatrix3(N):normalize(),
				n = V3(0, 0, 1):applyMatrix3(N):normalize(),
				area = w.area, ar = w.ar, ctrl = w.ctrl, tau = clamp(1.25 * math.sqrt(w.ctrl), 0, 1), defl = 0,
				maxDefl = if w.ctrl >= 1 then 0.35 else 0.44,
				torq = V3(),
			}
			P.wing.ctrlPt = V3(w.ac[1], w.ac[2] - (if w.ctrl >= 1 then 0.1 else 0.6) * (w.mac or 1), 0):applyMatrix4(T)
			P.Asurf = w.area * 2.1
		else
			P.Asurf = math.pi * dia * L + math.pi * dia * dia / 2
		end
		P.C = math.max(4000, P.Asurf * 28000 * (if def.shield then 3 else 1))
		if def.engine then
			local e = def.engine
			local side = math.abs(def.thrustAxis[1]) > 0.5
			P.eng = {
				e = e, pos = arr3(def.nozzle):applyMatrix4(T),
				dir = arr3(def.thrustAxis):applyMatrix3(N):normalize(),
				thr = 0, mode = if e.type == "hybrid" then "air" else e.type, flame = 0, thrust = 0, active = true,
				-- gimbal axes: the two part axes across the thrust line (side-mounted lift engines thrust along x)
				gx = (if side then V3(0, 1, 0) else V3(1, 0, 0)):applyMatrix3(N):normalize(),
				gz = V3(0, 0, 1):applyMatrix3(N):normalize(),
				g1 = 0, g2 = 0, dq = 0, bal = 1,
			}
		end
		if def.gear then
			P.gear = {
				g = def.gear, mount = V3(0, 0, 0):applyMatrix4(T),
				ext = V3(1, 0, 0):applyMatrix3(N):normalize(),
				fwd = V3(0, 1, 0):applyMatrix3(N):normalize(),
				comp = 0, contact = false, deployed = 1, spin = 0, load = 0,
			}
		end
		if def.rcs then
			local dirs = {}
			for _, a in ipairs({ { 0, 1, 0 }, { 0, -1, 0 }, { 0, 0, 1 }, { 0, 0, -1 } }) do table.insert(dirs, arr3(a):applyMatrix3(N):normalize()) end
			P.rcs = { pos = V3(0.18, 0, 0):applyMatrix4(T), dirs = dirs, fire = { 0, 0, 0, 0 } }
		end
		P.contacts = self:contactPoints(def, T, N)
		table.insert(self.parts, P)
	end
	-- the parts were stored in design order; renumber in case some were skipped
	for idx, P in ipairs(self.parts) do P.i = idx end
	for _, P in ipairs(self.parts) do if P.parent > 0 and self.parts[P.parent] then table.insert(self.parts[P.parent].kids, P.i) end end
	-- exposed stack ends: a node is covered if another part's node sits on it
	local nodes = {}
	for _, P in ipairs(self.parts) do
		for _, n in ipairs(P.def.nodes or {}) do table.insert(nodes, { P = P, p = arr3(n.p):applyMatrix4(P.T), s = SIZES[n.s], top = n.n[2] > 0 }) end
	end
	for _, P in ipairs(self.parts) do
		local def = P.def
		if not def.nodes or #def.nodes == 0 or def.wing then continue end
		local r = P.dia / 2
		local front, back = V3(0, P.len / 2, 0):applyMatrix4(P.T), V3(0, -P.len / 2, 0):applyMatrix4(P.T)
		local function cover(pt)
			local s = 0
			for _, n in ipairs(nodes) do if n.P ~= P and n.p:distanceTo(pt) < 0.08 then s = math.max(s, n.s) end end
			return s
		end
		local hasTop = any(def.nodes, function(n) return n.n[2] > 0 end)
		local hasBot = any(def.nodes, function(n) return n.n[2] < 0 end)
		local rTop = if hasTop then SIZES[find(def.nodes, function(n) return n.n[2] > 0 end).s] / 2 else 0
		local rBot = if hasBot then SIZES[find(def.nodes, function(n) return n.n[2] < 0 end).s] / 2 else r
		local ct, cb = cover(front), cover(back)
		P.Af = if hasTop then math.max(0, math.pi * (rTop * rTop - (ct / 2) ^ 2)) else math.pi * r * r
		P.Ab = math.max(0, math.pi * (rBot * rBot - (cb / 2) ^ 2))
		P.CdF = if hasTop then 0.75 else def.cd
		P.CdB = if def.engine then 0.25 else 0.55
		P.As = P.dia * P.len * 0.9
	end
	for _, P in ipairs(self.parts) do
		if P.Af == nil then
			P.Af = if P.wing then 0 else 0.08 * (P.def.mass / 100) ^ 0.5
			P.Ab = P.Af; P.CdF = 0.4; P.CdB = 0.4; P.As = if P.wing then 0 else P.Af * 2
		end
	end
	self.vertical = not not self.design.vertical
end

function Craft:contactPoints(def, T, N)
	local pts = {}
	local function add(x, y, z) table.insert(pts, V3(x, y, z):applyMatrix4(T)) end
	if def.wing then
		local w = def.wing
		local t = math.tan(w.sweep)
		add(0, w.root / 2, 0); add(0, -w.root / 2, 0)
		add(w.span, w.root / 2 - t * w.span, 0); add(w.span, w.root / 2 - t * w.span - w.tip, 0)
	elseif def.gear then
		add(0, 0, 0)
	elseif def.nodes and #def.nodes > 0 then
		local r = (if def.size then SIZES[def.size] else 1) / 2
		local L = def.len
		local hasTop = any(def.nodes, function(n) return n.n[2] > 0 end)
		for _, xz in ipairs({ { r, 0 }, { -r, 0 }, { 0, r }, { 0, -r } }) do
			add(xz[1], -L / 2, xz[2])
			if hasTop then add(xz[1], L / 2, xz[2]) end
		end
		if not hasTop then add(0, L / 2, 0) end
	else
		add(def.com[1], def.com[2], def.com[3])
	end
	return pts
end

-- ---------- mass properties ----------
function Craft:recompute()
	local M = 0
	local com = V3()
	for _, P in ipairs(self.parts) do
		if not P.alive then continue end
		local m = P.dry
		for k, r in pairs(P.res) do if k ~= "EC" then m += r.amt end end
		P.massNow = m
		M += m; com:addScaledVector(P.com, m)
	end
	com:divideScalar(math.max(1, M))
	local I = { 0, 0, 0, 0, 0, 0, 0, 0, 0 }
	for _, P in ipairs(self.parts) do
		if not P.alive then continue end
		local m = P.massNow
		local r = _r:copy(P.com):sub(com)
		local own = (m / 12) * (P.len * P.len + P.dia * P.dia) + (if P.wing then m * P.def.wing.span * P.def.wing.span / 12 else 0)
		local r2 = r:lengthSq()
		I[1] += m * (r2 - r.x * r.x) + own; I[5] += m * (r2 - r.y * r.y) + own; I[9] += m * (r2 - r.z * r.z) + own
		I[2] -= m * r.x * r.y; I[3] -= m * r.x * r.z; I[6] -= m * r.y * r.z
	end
	I[4] = I[2]; I[7] = I[3]; I[8] = I[6]
	self.mass = M; self.com = com
	self.I = M3():set(I[1], I[2], I[3], I[4], I[5], I[6], I[7], I[8], I[9])
	self.Iinv = self.I:clone():invert()
	self.Idiag = V3(I[1], I[5], I[9])
	self.engines, self.wings, self.gears, self.rcsList = {}, {}, {}, {}
	local torque, rad, ec, solar = 0, 0, 0, 0
	for _, P in ipairs(self.parts) do
		if not P.alive then continue end
		if P.eng then table.insert(self.engines, P) end
		if P.wing then table.insert(self.wings, P) end
		if P.gear then table.insert(self.gears, P) end
		if P.rcs then table.insert(self.rcsList, P) end
		torque += P.def.torque or 0
		rad += P.def.radiator or 0
		ec += (P.def.ecStore or 0) + (P.def.ec or 0)
		solar += P.def.solar or 0
	end
	self.wheelTorque = torque; self.radCap = rad; self.ecCap = ec; self.solar = solar
	if self.ec == nil then self.ec = self.ecCap end
	self.ec = math.min(self.ec, self.ecCap)
	self.root = self.parts[1]
	local box = THREE.Box3.new()
	for _, P in ipairs(self.parts) do if P.alive then for _, c in ipairs(P.contacts) do box:expandByPoint(c) end end end
	for _, P in ipairs(self.gears) do box:expandByPoint(P.gear.ext:clone():multiplyScalar(P.gear.g.len + P.gear.g.wheel):add(P.gear.mount)) end
	self.box = box
	self.size = box:getSize(V3()):length()
	self.lowest = if #self.parts > 0 then box.min:clone() else V3()
end

-- ---------- resources ----------
function Craft:amount(k) local s = 0; for _, P in ipairs(self.parts) do if P.alive and P.res[k] then s += P.res[k].amt end end; return s end
function Craft:capacity(k) local s = 0; for _, P in ipairs(self.parts) do if P.alive and P.res[k] then s += P.res[k].cap end end; return s end
function Craft:draw(k, kg)
	if kg <= 0 then return 0 end
	local tanks, total = {}, 0
	for _, P in ipairs(self.parts) do if P.alive and P.res[k] and P.res[k].amt > 0 then table.insert(tanks, P); total += P.res[k].amt end end
	if total <= 0 then return 0 end
	local take = math.min(kg, total)
	for _, P in ipairs(tanks) do P.res[k].amt -= take * (P.res[k].amt / total) end
	return take
end
function Craft:refuel()
	for _, P in ipairs(self.parts) do for _, r in pairs(P.res) do r.amt = r.cap end end
	self.ec = self.ecCap
	self:recompute()
end

-- ---------- engines ----------
-- thrust (N) and isp (s) at full throttle in the engine's current mode
function Craft:engineOutput(P, env)
	local T, isp = self:engineOutputBase(P, env)
	return T * (self.thrustMult or 1), isp
end
function Craft:engineOutputBase(P, env)
	local E, e = P.eng, P.eng.e
	local sig = env.rho / 1.225
	if E.mode == "jet" or E.mode == "air" or E.mode == "scram" then
		if env.rho < 1e-4 or (env.body and env.body.id == "mars") then return 0, 0 end
	end
	if E.mode == "jet" or E.mode == "air" then
		local maxM, M = e.maxMach, env.mach
		local mf
		if e.type == "hybrid" then mf = (1 + 0.55 * math.min(M, 3.6)) * (1 - smoothstep(maxM - 1.6, maxM, M)) * 0.62
		else mf = (1 + 0.25 * M) * (1 - smoothstep(maxM - 0.7, maxM, M)) end
		local intake = 1 + self:intakeBonus()
		local T = e.thrust * math.pow(sig, 0.72) * mf * intake * (1 - smoothstep(e.ceiling * 0.8, e.ceiling, env.h))
		return math.max(0, T), e.isp * (1 - 0.2 * math.min(1, M / maxM))
	end
	if E.mode == "scram" then
		local M = env.mach
		local g = smoothstep(e.minMach, e.minMach + 1.5, M) * (1 - smoothstep(e.maxMach - 2.5, e.maxMach, M)) * (0.6 + 0.4 * math.exp(-((M - e.peakMach) ^ 2) / 8))
		local d = math.min(1, math.pow(env.rho / 0.05, 0.55)) * (1 - smoothstep(e.ceiling * 0.85, e.ceiling, env.h))
		return e.thrust * g * d * (1 + self:intakeBonus()), e.isp
	end
	local r = if e.type == "hybrid" then e.rocket else e
	local pr = math.min(1.2, env.p / 101325)
	local isp = r.ispVac - (r.ispVac - r.ispSL) * pr
	return r.thrust * isp / r.ispVac, isp
end
function Craft:fuelMix(P)
	local e = P.eng.e
	if P.eng.mode == "rocket" and e.type == "hybrid" then return e.rocket.fuel end
	return e.fuel
end

-- per-engine throttle factors (P.eng.bal) so the active engines' thrust passes through the centre of mass
function Craft:balanceEngines(env)
	local list = {}
	for _, P in ipairs(self.engines) do
		if not P.alive or not P.eng.active then P.eng.bal = 1; continue end
		local T = self:engineOutput(P, env)
		if T <= 0 then P.eng.bal = 1; continue end
		local r = P.eng.pos:clone():sub(self.com)
		table.insert(list, { P = P, T = T, tau = V3():crossVectors(r, P.eng.dir:clone():multiplyScalar(T)) })
	end
	if #list < 2 then for _, L in ipairs(list) do L.P.eng.bal = 1 end; return end
	local s = {}
	local norm, sumT = 0, 0
	for i, L in ipairs(list) do s[i] = 1; norm += L.tau:lengthSq(); sumT += L.T end
	local tol = sumT * 0.02
	local net = V3()
	for _ = 1, 60 do
		net:set(0, 0, 0)
		for i, L in ipairs(list) do net:addScaledVector(L.tau, s[i]) end
		if net:length() < tol then break end
		for i, L in ipairs(list) do s[i] = math.min(1, math.max(0, s[i] - 0.9 * net:dot(L.tau) / norm)) end
	end
	local mx = 0
	for i = 1, #s do mx = math.max(mx, s[i]) end
	for i, L in ipairs(list) do L.P.eng.bal = if mx > 0.05 then s[i] / mx else 1 end
end

function Craft:intakeBonus()
	if self._intake == nil then
		local s = 0
		for _, P in ipairs(self.parts) do if P.alive and P.def.intake then s += P.def.intake end end
		self._intake = s
	end
	return self._intake
end

-- ---------- aerodynamics ----------
-- vAir: velocity relative to the air (body frame); w: angular velocity (body). Force and torque about the COM.
function Craft:aero(vAir, w, env, F, Tq)
	F:set(0, 0, 0); Tq:set(0, 0, 0)
	if env.rho <= 0 then return end
	local M = env.mach
	local wave = if M < 0.8 then 1 elseif M < 1.08 then 1 + 1.6 * smoothstep(0.8, 1.08, M) else 2.6 - 0.9 * smoothstep(1.08, 3.5, M)
	local com = self.com
	for _, P in ipairs(self.parts) do
		if not P.alive then continue end
		if P.wing then self:wingForce(P, vAir, w, env, F, Tq); continue end
		_r:copy(P.com):sub(com)
		_v:crossVectors(w, _r):add(vAir)
		local V = _v:length()
		if V < 0.01 then continue end
		local ua = _v:dot(P.axis)
		_u:copy(P.axis):multiplyScalar(ua)
		_w:copy(_v):sub(_u)
		local cdaAx = (if ua > 0 then P.CdF * P.Af else P.CdB * P.Ab) * wave
		local cdaX = (P.As or 0) * 0.9 * (if M > 1 then 1.3 else 1)
		_f:copy(_u):multiplyScalar(-0.5 * env.rho * math.abs(ua) * cdaAx):addScaledVector(_w, -0.5 * env.rho * _w:length() * cdaX)
		if P.gear then _f:addScaledVector(_v, -0.5 * env.rho * V * 0.35 * P.gear.deployed) end
		F:add(_f)
		Tq:add(_r:cross(_f))
	end
end

-- lift and drag coefficients of a wing at angle of attack a with control deflection defl
function Craft:wingCoef(W, a, defl, M)
	local ar = W.ar
	local cla = (2 * math.pi * ar) / (ar + 2)
	if M < 0.9 then cla /= math.sqrt(1 - math.min(0.75, M * M) * 0.9)
	elseif M > 1.2 then cla = math.min(cla, 4 / math.sqrt(M * M - 1))
	else cla *= 1.05 end
	local stall = 0.30
	local sa, ca = math.sin(a), math.cos(a)
	local ad = a + defl * W.tau
	local lin = cla * math.sin(ad) * math.cos(ad)
	local plate = 1.1 * math.sin(2 * ad)
	local k = smoothstep(stall, stall + 0.25, math.abs(ad))
	local cl = lin * (1 - k) + plate * k
	local cd = 0.006 + (if M > 0.85 then 0.012 * smoothstep(0.85, 1.1, M) else 0) + (cl * cl) / (math.pi * 0.85 * ar) * (1 - k) + 1.2 * sa * sa * k + math.abs(defl) * 0.02
	local function clAt(x)
		local kk = smoothstep(stall, stall + 0.25, math.abs(x))
		return cla * math.sin(x) * math.cos(x) * (1 - kk) + 1.1 * math.sin(2 * x) * kk
	end
	local dCl = W.tau * (clAt(ad + 0.02) - clAt(ad - 0.02)) / 0.04
	local hyp = smoothstep(2.5, 5, M)
	if hyp > 0 then
		local fC = if W.ctrl > 0 then 0.3 else 0
		local function ns(x) return math.sin(x) * math.abs(math.sin(x)) end
		local af = a + defl
		local cn = 2 * ((1 - fC) * ns(a) + fC * ns(af))
		cl = cl * (1 - hyp) + cn * ca * hyp
		cd = cd * (1 - hyp) + (0.008 + 2 * ((1 - fC) * math.abs(ns(a)) + fC * math.abs(ns(af))) * math.abs(sa)) * hyp
		dCl = dCl * (1 - hyp) + 2 * fC * math.abs(math.sin(2 * af)) * math.max(0.2, ca) * hyp
	end
	return cl, cd, dCl, k
end

function Craft:wingForce(P, vAir, w, env, F, Tq)
	local W = P.wing
	_r:copy(W.ac):sub(self.com)
	_v:crossVectors(w, _r):add(vAir)
	local vc, vn = _v:dot(W.c), _v:dot(W.n)
	local V2 = vc * vc + vn * vn
	if V2 < 0.01 then return end
	local V = math.sqrt(V2)
	local alpha = math.atan2(-vn, vc)
	local M = env.mach
	local q = 0.5 * env.rho * V2 * W.area
	_u:copy(W.n):multiplyScalar(vc):addScaledVector(W.c, -vn):divideScalar(V)
	_w:copy(W.c):multiplyScalar(vc):addScaledVector(W.n, vn):divideScalar(V)
	local bcl, bcd, bdCl, bk = self:wingCoef(W, alpha, 0, M)
	_f:copy(_u):multiplyScalar(q * bcl):addScaledVector(_w, -q * bcd)
	_f:addScaledVector(W.s, -0.5 * env.rho * _v:dot(W.s) * math.abs(_v:dot(W.s)) * W.area * 0.01)
	F:add(_f)
	Tq:add(_t:copy(_r):cross(_f))
	_r2:copy(W.ctrlPt):sub(self.com)
	local fdCl, fk = bdCl, bk
	if W.ctrl > 0 and W.defl ~= 0 then
		local cl, cd, dCl, k = self:wingCoef(W, alpha, W.defl, M)
		_f:copy(_u):multiplyScalar(q * (cl - bcl)):addScaledVector(_w, -q * (cd - bcd))
		F:add(_f)
		Tq:add(_t:copy(_r2):cross(_f))
		fdCl, fk = dCl, k
	end
	W.torq:copy(_r2):cross(_u):multiplyScalar(q * fdCl)
	W.stalled = fk > 0.5
	W.alpha = alpha
end

-- ---------- heating ----------
function Craft:heat(dt, vAirBody, env, engineHeat, heatScale, inSun)
	local V = vAirBody:length()
	local vhat = _v:copy(vAirBody):divideScalar(math.max(V, 1e-6))
	local Taw = env.T * (1 + 0.18 * env.mach * env.mach)
	local q0 = 1.83e-4 * math.sqrt(math.max(env.rho, 0)) * V * V * V * heatScale
	local worst, worstP = 0, nil
	local radFrac = if engineHeat > 0 then math.min(1, self.radCap / engineHeat) else 1
	local hotDestroy = {}
	for _, P in ipairs(self.parts) do
		if not P.alive then continue end
		local exp
		if P.wing then
			local sn = math.abs(vhat:dot(P.wing.n))
			exp = P.wing.area * (0.04 + sn * 0.9)
		else
			local ua = vhat:dot(P.axis)
			exp = (if ua > 0 then P.Af else P.Ab) * math.abs(ua) + (P.As or 0) * 0.12 * math.sqrt(math.max(0, 1 - ua * ua))
			if P.gear then exp *= 0.08 + 0.92 * (P.gear.deployed or 1) end
		end
		local rn = if P.wing then 0.6 else math.max(0.3, P.dia / 2)
		local Qin = exp * q0 / math.sqrt(rn) * math.max(0, 1 - P.temp / math.max(Taw, 300))
		local hconv = (8 + 6 * math.sqrt(math.max(0, env.rho) * V)) * P.Asurf
		Qin += hconv * ((if V > 600 then math.min(Taw, 1500) else env.T) - P.temp) * 0.3
		if P.eng and engineHeat > 0 then Qin += P.eng.e.heat * P.eng.thr * (1 - radFrac) * (if P.eng.flame > 0 then 1 else 0) end
		local Tenv = if inSun then 250 else 120
		local Qout = 0.8 * SIGMA * P.Asurf * (P.temp ^ 4 - Tenv ^ 4)
		if P.def.radiator then Qout += P.def.radiator * math.min(1, engineHeat / math.max(1, self.radCap)) * 0.15 end
		P.temp += ((Qin - Qout) / P.C) * dt
		if P.temp < 3 then P.temp = 3 end
		local f = P.temp / P.maxT
		if f > worst then worst = f; worstP = P end
		if P.temp > P.maxT then table.insert(hotDestroy, P) end
	end
	self.heatFrac = worst; self.hottest = worstP
	return hotDestroy
end

-- ---------- damage ----------
-- destroy a part and everything attached beyond it; returns the removed parts
function Craft:destroy(P)
	local removed = {}
	local function rm(Q)
		if not Q.alive then return end
		Q.alive = false; table.insert(removed, Q)
		for _, k in ipairs(Q.kids) do rm(self.parts[k]) end
	end
	rm(P)
	self._intake = nil
	self:recompute()
	if self.onDestroy then self.onDestroy(removed) end
	return removed
end

return Craft
