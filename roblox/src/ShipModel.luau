-- Builds a Roblox model of a Starforge craft from its parts (cylinders for the hull and tanks, wedge
-- triangles for wings and fins, blocks for gear and gadgets) and animates it: engine flames, control
-- surfaces, landing gear, broken-off parts. Built in the craft's body frame (metres) and drawn at SCALE
-- studs per metre; one anchored root part carries everything through welds.

local THREE = require(script.Parent.Three)
local Parts = require(script.Parent.Parts)
local V3 = THREE.Vector3.new

local M = {}
M.SCALE = 1 / 0.28          -- studs per metre (a Roblox avatar is ~5 studs ≈ 1.8 m)

local function hex(c)
	c = c:gsub("#", "")
	return Color3.fromRGB(tonumber(c:sub(1, 2), 16), tonumber(c:sub(3, 4), 16), tonumber(c:sub(5, 6), 16))
end

local function rv(v) return Vector3.new(v.x, v.y, v.z) end   -- double Vector3 -> Roblox Vector3

local function part(cls, props, parent)
	local p = Instance.new(cls)
	p.Anchored = false
	p.CanCollide = false
	p.CanQuery = false
	p.CanTouch = false
	p.CastShadow = true
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	for k, v in pairs(props) do p[k] = v end
	p.Parent = parent
	return p
end

-- a solid triangle (a, b, c in studs, body frame) of the given thickness from two wedges
local function triangle(a, b, c, thick, color, material, parent, list)
	local ab, ac, bc = b - a, c - a, c - b
	local abd, acd, bcd = ab:Dot(ab), ac:Dot(ac), bc:Dot(bc)
	if abd > acd and abd > bcd then c, a = a, c
	elseif acd > bcd and acd > abd then a, b = b, a end
	ab, ac, bc = b - a, c - a, c - b
	local right = ac:Cross(ab)
	if right.Magnitude < 1e-6 then return end
	right = right.Unit
	local up = bc:Cross(right).Unit
	local back = bc.Unit
	local height = math.abs(ab:Dot(up))
	local w1 = math.abs(ab:Dot(back))
	local w2 = math.abs(ac:Dot(back))
	local function wedge(size, cf)
		if size.Y < 0.01 or size.Z < 0.01 then return end
		local w = part("WedgePart", { Size = size, CFrame = cf, Color = color, Material = material }, parent)
		table.insert(list, w)
	end
	wedge(Vector3.new(thick, height, w1), CFrame.fromMatrix((a + b) / 2, right, up, back))
	wedge(Vector3.new(thick, height, w2), CFrame.fromMatrix((a + c) / 2, -right, up, -back))
end

-- part-local point (metres) -> body frame (studs)
local function bodyPt(P, x, y, z, S) return rv(V3(x, y, z):applyMatrix4(P.T)) * S end
local function bodyDir(P, x, y, z) return rv(V3(x, y, z):applyMatrix3(P.N):normalize()) end

-- a cylinder between two body-frame points (studs)
local function cylinder(p0, p1, dia, color, material, parent, list)
	local axis = p1 - p0
	local len = axis.Magnitude
	if len < 0.05 then return nil end
	local x = axis.Unit
	local ref = if math.abs(x.Y) < 0.9 then Vector3.yAxis else Vector3.xAxis
	local z = x:Cross(ref).Unit
	local y = z:Cross(x)
	local c = part("Part", { Shape = Enum.PartType.Cylinder, Size = Vector3.new(len, dia, dia), CFrame = CFrame.fromMatrix((p0 + p1) / 2, x, y, z), Color = color, Material = material }, parent)
	if list then table.insert(list, c) end
	return c
end

local function block(center, x, y, size, color, material, parent, list)
	local z = x:Cross(y).Unit
	y = z:Cross(x).Unit
	local b = part("Part", { Size = size, CFrame = CFrame.fromMatrix(center, x.Unit, y, z), Color = color, Material = material }, parent)
	if list then table.insert(list, b) end
	return b
end

-- Build the model. Returns { model, root, parts = {[i] = {instances}}, flames = {[i] = flame}, ... }
function M.build(craft, name)
	local S = M.SCALE
	local model = Instance.new("Model")
	model.Name = name or "Ship"
	local root = part("Part", { Name = "Root", Size = Vector3.new(1, 1, 1), Transparency = 1, Anchored = true }, model)
	model.PrimaryPart = root
	local hull = hex(craft.colors.hull or "#d9dee5")
	local accent = hex(craft.colors.accent or "#ffb347")
	local dark = Color3.fromRGB(52, 56, 64)
	local black = Color3.fromRGB(22, 24, 28)
	local glass = Color3.fromRGB(40, 70, 110)
	local view = { model = model, root = root, parts = {}, flames = {}, gear = {}, surfaces = {} }
	for _, P in ipairs(craft.parts) do
		local def = P.def
		local list = {}
		view.parts[P.i] = list
		local mesh = def.mesh
		local L, dia = P.len, P.dia
		if def.wing then
			local w = def.wing
			local t = math.tan(w.sweep)
			local A = bodyPt(P, 0, w.root / 2, 0, S)
			local B = bodyPt(P, 0, -w.root / 2, 0, S)
			local Ct = bodyPt(P, w.span, w.root / 2 - t * w.span - w.tip, 0, S)
			local D = bodyPt(P, w.span, w.root / 2 - t * w.span, 0, S)
			local thick = math.max(0.4, w.thick * 0.35 * S)
			local col = if def.heatTiles then hull else hull
			local mat = Enum.Material.SmoothPlastic
			if w.ctrl >= 1 then col = accent end
			triangle(A, B, Ct, thick, col, mat, model, list)
			triangle(A, Ct, D, thick, col, mat, model, list)
			if def.heatTiles then
				-- dark heat tiles on the underside
				local n = bodyDir(P, 0, 0, -1) * (thick * 0.5)
				triangle(A + n, B + n, Ct + n, thick * 0.3, black, Enum.Material.Slate, model, list)
				triangle(A + n, Ct + n, D + n, thick * 0.3, black, Enum.Material.Slate, model, list)
			end
			if w.ctrl > 0 and w.ctrl < 1 then
				-- the control surface strip along the trailing edge
				local f = math.min(0.35, w.ctrl * 1.3)
				local B2 = B + (A - B) * f
				local C2 = Ct + (D - Ct) * f
				local n = bodyDir(P, 0, 0, 1) * (thick * 0.5 + 0.05)
				triangle(B + n, B2 + n, C2 + n, 0.15, accent, mat, model, list)
				triangle(B + n, C2 + n, Ct + n, 0.15, accent, mat, model, list)
			end
		elseif def.gear then
			local g = def.gear
			local top = bodyPt(P, 0, 0, 0, S)
			local bot = bodyPt(P, g.len, 0, 0, S)
			local strut = cylinder(top, bot, math.max(0.6, 0.12 * S), dark, Enum.Material.Metal, model, list)
			if g.wheel and g.wheel > 0 then
				local axle = bodyDir(P, 0, 0, 1)
				local c = bot
				local wheel = part("Part", { Shape = Enum.PartType.Cylinder, Size = Vector3.new(g.wheel * 0.7 * S, g.wheel * 2 * S, g.wheel * 2 * S), Color = black, Material = Enum.Material.Rubber }, model)
				local x = axle
				local ref = if math.abs(x.Y) < 0.9 then Vector3.yAxis else Vector3.xAxis
				local z = x:Cross(ref).Unit
				wheel.CFrame = CFrame.fromMatrix(c, x, z:Cross(x), z)
				table.insert(list, wheel)
			else
				local foot = part("Part", { Shape = Enum.PartType.Cylinder, Size = Vector3.new(0.15 * S, 0.9 * S, 0.9 * S), Color = dark, Material = Enum.Material.Metal }, model)
				local x = bodyDir(P, 1, 0, 0)
				local ref = if math.abs(x.Y) < 0.9 then Vector3.yAxis else Vector3.xAxis
				local z = x:Cross(ref).Unit
				foot.CFrame = CFrame.fromMatrix(bot, x, z:Cross(x), z)
				table.insert(list, foot)
			end
			view.gear[P.i] = list
		elseif def.engine and (mesh == "plasma" or mesh == "liftfan") then
			-- belly lift thruster: a short pod along its thrust axis
			local p0 = bodyPt(P, 0, 0, 0, S)
			local p1 = bodyPt(P, L, 0, 0, S)
			cylinder(p0, p1, 1.1 * S, dark, Enum.Material.Metal, model, list)
			local ring = cylinder(p1 - (p1 - p0).Unit * 0.1, p1, 0.9 * S, if mesh == "plasma" then Color3.fromRGB(160, 120, 255) else black, Enum.Material.Neon, model, list)
			view.flames[P.i] = { base = p1, dir = (p1 - p0).Unit, dia = 0.8 * S, color = if mesh == "plasma" then Color3.fromRGB(170, 140, 255) else Color3.fromRGB(220, 230, 255), glow = ring }
		elseif def.engine and mesh == "pod" then
			local p0 = bodyPt(P, 0.5, 1.7, 0, S)
			local p1 = bodyPt(P, 0.5, -1.7, 0, S)
			local c0 = bodyPt(P, 1.0, 1.7, 0, S)
			local c1 = bodyPt(P, 1.0, -1.7, 0, S)
			cylinder(c0, c1, 1.1 * S, hull, Enum.Material.SmoothPlastic, model, list)
			block((p0 + p1) / 2, (p1 - p0).Unit, bodyDir(P, 1, 0, 0), Vector3.new(L * S * 0.6, 0.15 * S, 0.5 * S), hull, Enum.Material.SmoothPlastic, model, list)
			view.flames[P.i] = { base = c1, dir = (c1 - c0).Unit, dia = 0.8 * S, color = Color3.fromRGB(255, 170, 90) }
		elseif def.nodes and #def.nodes > 0 and def.size then
			-- stack part along its +Y axis
			local top = bodyPt(P, 0, L / 2, 0, S)
			local bot = bodyPt(P, 0, -L / 2, 0, S)
			local axis = (top - bot).Unit
			local d = dia * S
			local col, mat = hull, Enum.Material.SmoothPlastic
			if mesh == "tank" then col = Color3.fromRGB(235, 236, 238) end
			if mesh == "fusionTank" then col = Color3.fromRGB(205, 200, 230); mat = Enum.Material.Metal end
			if mesh == "shield" then col = Color3.fromRGB(70, 50, 40); mat = Enum.Material.Slate end
			if mesh == "battery" or mesh == "wheelS" or mesh == "wheelM" then col = dark; mat = Enum.Material.Metal end
			local hasTop = false
			local topSize = def.size
			for _, n in ipairs(def.nodes) do if n.n[2] > 0 then hasTop = true; topSize = n.s end end
			if def.engine then
				-- engine: a housing, a nozzle bell and a glowing throat
				local nozzleLen = math.min(L * 0.55, 2.2) * S
				local housingEnd = bot + axis * nozzleLen
				cylinder(housingEnd, top, d * 0.92, dark, Enum.Material.Metal, model, list)
				local bellD = d * (if mesh == "rocketVac" then 1.0 else 0.8)
				local steps = 4
				for k = 0, steps - 1 do
					local a0 = housingEnd - axis * (nozzleLen * k / steps)
					local a1 = housingEnd - axis * (nozzleLen * (k + 1) / steps)
					local dk = bellD * (0.45 + 0.55 * (k + 1) / steps)
					cylinder(a0, a1, dk, if mesh == "fusion" then Color3.fromRGB(90, 80, 120) else black, Enum.Material.Metal, model, list)
				end
				local glow = cylinder(bot + axis * 0.2, bot + axis * 0.05, bellD * 0.9, Color3.fromRGB(60, 40, 30), Enum.Material.Neon, model, list)
				view.flames[P.i] = {
					base = bot, dir = -axis, dia = bellD * 0.85, glow = glow,
					color = if def.engine.fusion then Color3.fromRGB(150, 170, 255) elseif def.engine.type == "jet" or def.engine.type == "scram" or def.engine.type == "hybrid" then Color3.fromRGB(255, 160, 80) else Color3.fromRGB(255, 200, 120),
				}
			elseif not hasTop then
				-- nose cones, cockpits and capsules: a stepped taper
				local rounded = mesh == "capsule"
				local steps = if rounded then 3 else 5
				for k = 0, steps - 1 do
					local f0, f1 = k / steps, (k + 1) / steps
					local a0 = bot + axis * (L * S * f0)
					local a1 = bot + axis * (L * S * f1)
					local frac = if rounded then 1 - 0.35 * f0 else math.cos(f0 * math.pi / 2) ^ 0.8
					local dk = math.max(0.25 * d, d * frac)
					cylinder(a0, a1, dk, col, mat, model, list)
				end
				if def.cat == "cockpit" then
					-- canopy
					local up = bodyDir(P, 0, 0, 1)
					local c = bot + axis * (L * S * 0.55) + up * (d * 0.32)
					block(c, axis, up, Vector3.new(L * S * 0.35, d * 0.28, d * 0.55), glass, Enum.Material.Glass, model, list)
				end
			else
				local dTop = (Parts.SIZES[topSize] or dia) * S
				if math.abs(dTop - d) > 0.1 then
					-- adapters: a few rings stepping between the two sizes
					for k = 0, 3 do
						local a0 = bot + axis * (L * S * k / 4)
						local a1 = bot + axis * (L * S * (k + 1) / 4)
						cylinder(a0, a1, d + (dTop - d) * (k + 0.5) / 4, col, mat, model, list)
					end
				else
					cylinder(bot, top, d, col, mat, model, list)
				end
				if mesh == "tank" then
					-- accent bands
					cylinder(bot + axis * (L * S * 0.48), bot + axis * (L * S * 0.52), d * 1.02, accent, Enum.Material.SmoothPlastic, model, list)
				end
			end
		else
			-- small surface gadgets: a box at the part's centre of mass
			local c = rv(P.com) * S
			local x = bodyDir(P, 1, 0, 0)
			local y = bodyDir(P, 0, 1, 0)
			local size, col, mat = Vector3.new(0.5 * S, 0.5 * S, 0.5 * S), dark, Enum.Material.Metal
			if mesh == "radiator" then size = Vector3.new(4 * S, 1.6 * S, 0.06 * S); col = Color3.fromRGB(200, 205, 210) end
			if mesh == "solar" then size = Vector3.new(5 * S, 1.2 * S, 0.05 * S); col = Color3.fromRGB(30, 50, 110); mat = Enum.Material.Glass end
			if mesh == "strobe" or mesh == "lamp" then size = Vector3.new(0.2 * S, 0.2 * S, 0.2 * S); col = Color3.fromRGB(255, 80, 80); mat = Enum.Material.Neon end
			block(c, x, y, size, col, mat, model, list)
		end
	end
	-- weld everything to the root (the root alone is moved each frame)
	for _, list in pairs(view.parts) do
		for _, p in ipairs(list) do
			local w = Instance.new("WeldConstraint")
			w.Part0 = root; w.Part1 = p; w.Parent = p
		end
	end
	-- engine flames (shown with throttle)
	for i, f in pairs(view.flames) do
		local fl = part("Part", { Name = "Flame", Anchored = true, Shape = Enum.PartType.Cylinder, Material = Enum.Material.Neon, Color = f.color, Transparency = 1, CastShadow = false, Size = Vector3.new(1, f.dia, f.dia) }, model)
		local light = Instance.new("PointLight")
		light.Color = f.color; light.Range = 30; light.Brightness = 0; light.Parent = fl
		f.part = fl; f.light = light
	end
	return view
end

-- Place the model: cf = CFrame of the craft's body origin in the world (studs). Hides lost parts, sizes flames.
function M.update(view, craft, cf, t)
	local S = M.SCALE
	local rootCF = cf * CFrame.new(rv(craft.com) * -S)
	view.root.CFrame = rootCF
	for _, P in ipairs(craft.parts) do
		local list = view.parts[P.i]
		if list and not P.alive and not list.hidden then
			list.hidden = true
			for _, p in ipairs(list) do p.Transparency = 1 end
		end
	end
	for i, f in pairs(view.flames) do
		local P = craft.parts[i]
		local k = if P and P.alive and P.eng then math.clamp(P.eng.flame, 0, 1.5) else 0
		if k > 0.02 then
			local len = f.dia * (1.2 + 3.5 * k) * (0.92 + 0.08 * math.sin(t * 40 + i))
			local base = rootCF * f.base
			local dir = rootCF:VectorToWorldSpace(f.dir)
			local ref = if math.abs(dir.Y) < 0.9 then Vector3.yAxis else Vector3.xAxis
			local z = dir:Cross(ref).Unit
			f.part.Size = Vector3.new(len, f.dia * (0.7 + 0.3 * k), f.dia * (0.7 + 0.3 * k))
			f.part.CFrame = CFrame.fromMatrix(base + dir * (len / 2), dir, z:Cross(dir), z)
			f.part.Transparency = 0.15 + 0.5 * (1 - math.min(1, k))
			f.light.Brightness = 2 + 4 * k
			if f.glow then f.glow.Color = f.color:Lerp(Color3.new(1, 1, 1), 0.3 * k) end
		else
			f.part.Transparency = 1
			f.light.Brightness = 0
			if f.glow then f.glow.Color = Color3.fromRGB(60, 40, 30) end
		end
	end
end

return M
