-- Starforge for Roblox — client prototype. The ship is simulated on this device with the same flight
-- physics and autopilots as the web game (ReplicatedStorage.Starforge), in double precision, and drawn
-- ship-centred: the ship's centre of mass sits at the world origin and everything else is placed relative
-- to it, in a frame where +Y is local up, +X east and -Z north.

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UIS = game:GetService("UserInputService")
local Lighting = game:GetService("Lighting")
local RS = game:GetService("ReplicatedStorage")

local SF = RS:WaitForChild("Starforge")
local THREE = require(SF.Three)
local Geo = require(SF.Geo)
local Astro = require(SF.Astro)
local Craft = require(SF.Craft)
local Physics = require(SF.Physics)
local Control = require(SF.Control)
local Orbit = require(SF.Orbit)
local Designs = require(SF.DesignsData)
local ShipModel = require(SF.ShipModel)
local V3 = THREE.Vector3.new
local EARTH, MOON, D2R = Geo.EARTH, Geo.MOON, Geo.D2R
local S = ShipModel.SCALE

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera

----------------------------------------------------------------- world model for the physics
local world = { nearBuildings = false }
function world:groundAt(body, lat, lon) return 0 end
function world:isWater(lat, lon) return false end
function world:buildingTop() return nil end

local SITE = { name = "Starforge Spaceport", lat = 28.61, lon = -80.69, hdg = 90 }   -- Florida coast, runway pointing east

----------------------------------------------------------------- scene
local scene = workspace:FindFirstChild("StarforgeScene") or Instance.new("Folder")
scene.Name = "StarforgeScene"
scene.Parent = workspace
for _, c in ipairs(scene:GetChildren()) do c:Destroy() end

local function anchored(cls, props)
	local p = Instance.new(cls)
	p.Anchored = true; p.CanCollide = false; p.CanQuery = false; p.CanTouch = false
	p.TopSurface = Enum.SurfaceType.Smooth; p.BottomSurface = Enum.SurfaceType.Smooth
	for k, v in pairs(props) do p[k] = v end
	p.Parent = scene
	return p
end

-- ground tiles (a grid that recentres under the ship) and the spaceport
local TILE, NT = 2048, 7
local tiles = {}
for i = 1, NT * NT do
	tiles[i] = anchored("Part", { Name = "Ground", Size = Vector3.new(TILE, 4, TILE), Material = Enum.Material.Grass, Color = Color3.fromRGB(86, 120, 64), CastShadow = false })
end
local runway = anchored("Part", { Name = "Runway", Size = Vector3.new(3000 * S, 1, 60 * S), Material = Enum.Material.Asphalt, Color = Color3.fromRGB(58, 60, 64) })
local stripe = anchored("Part", { Name = "Stripe", Size = Vector3.new(2900 * S, 1.2, 1 * S), Material = Enum.Material.SmoothPlastic, Color = Color3.fromRGB(235, 235, 235) })
local hangar = anchored("Part", { Name = "Hangar", Size = Vector3.new(60 * S, 22 * S, 50 * S), Material = Enum.Material.DiamondPlate, Color = Color3.fromRGB(150, 156, 165) })
-- the Earth seen from high up, the Moon, the Sun, and a black dome for space
local earthBall = anchored("Part", { Name = "EarthBall", Shape = Enum.PartType.Ball, Size = Vector3.new(1, 1, 1), Material = Enum.Material.SmoothPlastic, Color = Color3.fromRGB(40, 90, 170), CastShadow = false })
local earthMesh = Instance.new("SpecialMesh"); earthMesh.MeshType = Enum.MeshType.Sphere; earthMesh.Parent = earthBall
local moonBall = anchored("Part", { Name = "MoonBall", Shape = Enum.PartType.Ball, Size = Vector3.new(1, 1, 1), Material = Enum.Material.Slate, Color = Color3.fromRGB(170, 170, 165), CastShadow = false })
local moonMesh = Instance.new("SpecialMesh"); moonMesh.MeshType = Enum.MeshType.Sphere; moonMesh.Parent = moonBall
local sunBall = anchored("Part", { Name = "SunBall", Shape = Enum.PartType.Ball, Size = Vector3.new(80, 80, 80), Material = Enum.Material.Neon, Color = Color3.fromRGB(255, 244, 214), CastShadow = false })
local dome = {}
for i = 1, 6 do dome[i] = anchored("Part", { Name = "Space", Size = Vector3.new(1, 1, 1), Material = Enum.Material.Neon, Color = Color3.new(0, 0, 0), CastShadow = false, Transparency = 1 }) end
local atmosphere = Lighting:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")
atmosphere.Parent = Lighting

----------------------------------------------------------------- flight state
local eph = Astro.Ephemeris.new():update(Astro.nowSimTime())
local settings = { heatScale = 1, crashScale = 1, assist = "assisted" }
local craft, ship, C, view
local design = Designs[1]
local refFixed = nil      -- body-fixed reference point for the ground frame
local refBody = EARTH
local camYaw, camPitch, camDist = 0, 0.18, 60
local messages = {}
local warpLevels = { 1, 2, 4, 10, 50, 100, 1000, 10000, 100000 }
local warpIdx = 1

local hud -- forward

local function toast(msg)
	table.insert(messages, { text = msg, t = os.clock() })
	print("[Starforge] " .. msg)
end

local function startFlight(entry)
	if view then view.model:Destroy() end
	design = entry
	eph:update(Astro.nowSimTime())
	craft = Craft.new(entry.design)
	ship = Physics.Ship.new(craft, world, eph, settings)
	C = Control.Controller.new(settings)
	local vert = craft.vertical
	if vert then
		ship:placeAt(EARTH, SITE.lat, SITE.lon + 0.004, craft.box.max.z - craft.com.z + 0.15, 0, math.pi / 2)
	else
		ship:placeAt(EARTH, SITE.lat, SITE.lon - 0.012, -craft.box.min.y + 0.15, SITE.hdg * D2R, 0)
	end
	ship.ctl.gear = true
	ship:updateEnv(ship.t)
	refBody = EARTH
	refFixed = Geo.llh(SITE.lat, SITE.lon, 0, EARTH.R, V3())
	view = ShipModel.build(craft, entry.design.name)
	view.model.Parent = scene
	camDist = math.max(40, craft.size * S * 1.6)
	camYaw, camPitch = 0, 0.18
	warpIdx = 1
	toast("Ready on the runway: " .. entry.design.name .. ". Shift/Ctrl throttle, W/S pitch, A/D roll, Q/E yaw.")
end

----------------------------------------------------------------- frames
-- render frame: east / up / north at a point of the dominant body, as unit vectors in frame I
local fE, fU, fN = V3(), V3(), V3()
local _t1, _t2, _q = V3(), V3(), THREE.Quaternion.new()
local function setFrame(pI)
	local body = ship.env.body
	local c = ship:bodyCenter(body, ship.t, _t1)
	fU:copy(pI):sub(c):normalize()
	local axis = eph:axis(body)
	fE:crossVectors(axis, fU)
	if fE:lengthSq() < 1e-12 then fE:set(1, 0, 0) end
	fE:normalize()
	fN:crossVectors(fU, fE):normalize()
end
-- frame-I vector -> world (studs)
local function toWorld(v) return Vector3.new(v:dot(fE), v:dot(fU), -v:dot(fN)) end
local function toWorldScaled(v, k) return Vector3.new(v:dot(fE) * k, v:dot(fU) * k, -v:dot(fN) * k) end

local function shipCFrame()
	-- rotation: body axes in frame I -> world
	local q = ship.q
	local bx = V3(1, 0, 0):applyQuaternion(q)
	local by = V3(0, 1, 0):applyQuaternion(q)
	local bz = V3(0, 0, 1):applyQuaternion(q)
	return CFrame.fromMatrix(Vector3.zero, toWorld(bx), toWorld(by), toWorld(bz))
end

----------------------------------------------------------------- input
local keys = {}
UIS.InputBegan:Connect(function(io, gp)
	if gp then return end
	keys[io.KeyCode] = true
	if not ship then return end
	local k = io.KeyCode
	if k == Enum.KeyCode.Z then C.input.throttle = 1
	elseif k == Enum.KeyCode.X then C.input.throttle = 0
	elseif k == Enum.KeyCode.G then ship.ctl.gear = not ship.ctl.gear; toast(if ship.ctl.gear then "Gear down" else "Gear up")
	elseif k == Enum.KeyCode.B then C.input.brake = not C.input.brake
	elseif k == Enum.KeyCode.Period then warpIdx = math.min(#warpLevels, warpIdx + 1)
	elseif k == Enum.KeyCode.Comma then warpIdx = math.max(1, warpIdx - 1)
	elseif k == Enum.KeyCode.R then startFlight(design)
	end
end)
UIS.InputEnded:Connect(function(io) keys[io.KeyCode] = nil end)
local dragging = false
UIS.InputBegan:Connect(function(io) if io.UserInputType == Enum.UserInputType.MouseButton2 then dragging = true end end)
UIS.InputEnded:Connect(function(io) if io.UserInputType == Enum.UserInputType.MouseButton2 then dragging = false end end)
UIS.InputChanged:Connect(function(io)
	if io.UserInputType == Enum.UserInputType.MouseMovement and dragging then
		camYaw -= io.Delta.X * 0.006
		camPitch = math.clamp(camPitch + io.Delta.Y * 0.004, -1.2, 1.4)
	elseif io.UserInputType == Enum.UserInputType.MouseWheel then
		camDist = math.clamp(camDist * (1 - io.Position.Z * 0.12), 15, 4000)
	end
end)
local function axisKey(pos, neg) return (if keys[pos] then 1 else 0) - (if keys[neg] then 1 else 0) end

----------------------------------------------------------------- HUD
hud = require(SF.Hud).new(player, {
	ships = Designs,
	onShip = function(entry) startFlight(entry) end,
	onAuto = function(kind)
		if not ship then return end
		if kind == "orbit" then C:engage(Control.ascentAp()); toast("Autopilot: climbing to orbit")
		elseif kind == "land" then C:engage(Control.landAp()); toast("Autopilot: landing")
		elseif kind == "off" then C:cancelAp(); toast("Autopilot off") end
	end,
	onSas = function(mode) if ship then C:setSas(mode); toast("SAS: " .. mode) end end,
	onWarp = function(d) warpIdx = math.clamp(warpIdx + d, 1, #warpLevels) end,
	onThrottle = function(v) if C then C.input.throttle = v end end,
	onStick = function(x, y) if C then C.input.roll = x; C.input.pitch = y end end,
})

----------------------------------------------------------------- per-frame
local function canWarp(level)
	local E = ship.env
	if level <= 4 then return true end
	if ship.parked then return true end
	if ship.thrustNow > 0 or ship.ctl.throttle > 0 then return false end
	if E.body.atmoTop > 0 and E.h < E.body.atmoTop + 2000 then return false end
	if E.agl < 10000 then return false end
	return true
end

local simTime = 0
RunService.RenderStepped:Connect(function(dtRaw)
	if not ship then return end
	local dt = math.min(dtRaw, 0.05)
	simTime += dt
	-- inputs
	C.input.pitch = axisKey(Enum.KeyCode.S, Enum.KeyCode.W) + hud.stickY
	C.input.roll = axisKey(Enum.KeyCode.D, Enum.KeyCode.A) + hud.stickX
	C.input.yaw = axisKey(Enum.KeyCode.E, Enum.KeyCode.Q)
	local thr = axisKey(Enum.KeyCode.LeftShift, Enum.KeyCode.LeftControl)
	if thr ~= 0 then C.input.throttle = math.clamp(C.input.throttle + thr * dt * 0.6, 0, 1) end
	-- time warp (automatic up to the autopilot's next action)
	local want = warpLevels[warpIdx]
	if C.ap and C.ap.wakeAt then
		local left = C.ap.wakeAt - ship.t
		local best = 1
		for _, lv in ipairs(warpLevels) do if lv * dt * 3 < left and canWarp(lv) then best = lv end end
		if left > 30 then want = math.max(want, best) end
		while want > 1 and want * dt * 3 > left do want = want / 10 end
	end
	if not canWarp(want) then want = 1; if warpIdx > 3 then warpIdx = 1 end end
	ship.warp = math.max(1, want)
	-- simulate
	eph:update(ship.t)
	ship:step(dt, C)
	eph:update(ship.t)
	for _, e in ipairs(ship.events) do
		if e.type == "break" then toast(string.format("%s %s", e.part.def.name, if e.why == "overheat" then "overheated" else "broke off"))
		elseif e.type == "destroyed" then toast("Ship destroyed — press R to restart")
		elseif e.type == "landed" then toast("Landed on the " .. (if e.body == EARTH then "ground" else e.body.name))
		elseif e.type == "warpStop" then warpIdx = 1 end
	end
	table.clear(ship.events)
	if C.status ~= "" then toast(C.status); C.status = "" end

	-- ---------- render ----------
	local E = ship.env
	local body = E.body
	setFrame(ship.r)
	local cf = shipCFrame()
	ShipModel.update(view, craft, cf, simTime)

	-- camera: chase view behind the ship's heading, levelled to the horizon
	local fwd = cf.LookVector
	local hdg = math.atan2(fwd.X, -fwd.Z)
	local yaw = hdg + camYaw
	local dir = Vector3.new(math.sin(yaw) * math.cos(camPitch), math.sin(camPitch), -math.cos(yaw) * math.cos(camPitch))
	camera.CameraType = Enum.CameraType.Scriptable
	local camPos = -dir * camDist + Vector3.new(0, camDist * 0.08, 0)
	camera.CFrame = CFrame.lookAt(camPos, Vector3.new(0, camDist * 0.05, 0))
	camera.FieldOfView = 70

	-- ground under the ship (near the surface), drawn uniformly scaled about the ship when high up
	local agl = E.agl
	local depth = agl * S
	local k = if depth > 3000 then 3000 / depth else 1
	local showGround = body == EARTH and E.h < 60000
	-- ship position in the reference tangent plane (east, north metres from the spaceport)
	local rel = ship:toFixed(EARTH, ship.r, ship.t, _t1):sub(refFixed)
	local up0 = refFixed:clone():normalize()
	local east0 = V3(-math.sin(SITE.lon * D2R), 0, -math.cos(SITE.lon * D2R))
	local north0 = V3():crossVectors(up0, east0)
	local xe, xn = rel:dot(east0), rel:dot(north0)
	local gy = -(depth * k)
	local T = TILE
	local ox = (xe * S * k) % T
	local oz = (xn * S * k) % T
	local idx = 0
	for i = 1, NT do
		for j = 1, NT do
			idx += 1
			local p = tiles[idx]
			p.Transparency = if showGround then 0 else 1
			if showGround then
				p.Size = Vector3.new(T, 4, T)
				p.CFrame = CFrame.new((i - (NT + 1) / 2) * T - ox, gy - 2, -((j - (NT + 1) / 2) * T - oz))
			end
		end
	end
	-- the spaceport (runway along the site heading, centred at the site)
	local near = showGround and math.abs(xe) < 40000 and math.abs(xn) < 40000
	for _, p in ipairs({ runway, stripe, hangar }) do p.Transparency = if near then 0 else 1 end
	if near then
		local hd = SITE.hdg * D2R
		local rot = CFrame.Angles(0, -(hd - math.pi / 2), 0)
		local base = CFrame.new(-xe * S * k, gy, xn * S * k) * rot
		runway.Size = Vector3.new(3000 * S * k, 1, 60 * S * k)
		runway.CFrame = base * CFrame.new(0, 0.5, 0)
		stripe.Size = Vector3.new(2900 * S * k, 1.2, 1 * S * k)
		stripe.CFrame = base * CFrame.new(0, 0.6, 0)
		hangar.Size = Vector3.new(60 * S * k, 22 * S * k, 50 * S * k)
		hangar.CFrame = base * CFrame.new(-1100 * S * k, 11 * S * k, -120 * S * k)
	end

	-- planets: drawn scaled about the ship so their angular size is right and they stay in front of space
	local function drawBall(part, mesh, bodyB, R, maxD)
		local c = ship:bodyCenter(bodyB, ship.t, _t2)
		local d = c:clone():sub(ship.r)
		local dist = d:length()
		local kk = maxD / dist
		local pos = toWorldScaled(d, kk)
		part.CFrame = CFrame.new(pos)
		mesh.Scale = Vector3.new(2, 2, 2) * (R * kk)
	end
	local alt = E.h
	-- the Earth: shown above the near ground, fading in as it gets high
	local hEarth = ship.r:length() - EARTH.R
	if hEarth > 20000 or body ~= EARTH then
		local maxD = math.clamp(hEarth * S * 0.02 + 3000 + (EARTH.R * 0.0), 3000, 60000)
		-- keep the surface at least 2500 studs below the ship
		local dist = ship.r:length()
		local kk = math.max(2500, maxD) / (dist - EARTH.R) * (1)
		local c = V3(0, 0, 0):sub(ship.r)
		earthBall.CFrame = CFrame.new(toWorldScaled(c, kk))
		earthMesh.Scale = Vector3.new(2, 2, 2) * (EARTH.R * kk)
		earthBall.Transparency = if body == EARTH then math.clamp(1 - (hEarth - 20000) / 30000, 0, 1) else 0
	else
		earthBall.Transparency = 1
	end
	drawBall(moonBall, moonMesh, MOON, MOON.R, 50000)
	-- the Sun
	local sunW = toWorld(eph.sunP:clone():sub(ship.r):normalize())
	sunBall.CFrame = CFrame.new(sunW * 6000)
	sunBall.Size = Vector3.new(1, 1, 1) * (6000 * 2 * math.tan(0.267 * D2R) * 2)
	-- sky: thin air fades to black space
	local airK = math.clamp((E.rho / 1.225) ^ 0.35, 0, 1)
	if body ~= EARTH then airK = 0 end
	atmosphere.Density = 0.3 * airK
	atmosphere.Haze = 2 * airK
	local spaceA = 1 - math.clamp((alt - 30000) / 40000, 0, 1)
	if body ~= EARTH then spaceA = 0 end
	local R0 = 70000
	local faces = { { Vector3.new(R0, 0, 0), Vector3.new(10, 2 * R0, 2 * R0) }, { Vector3.new(-R0, 0, 0), Vector3.new(10, 2 * R0, 2 * R0) },
		{ Vector3.new(0, R0, 0), Vector3.new(2 * R0, 10, 2 * R0) }, { Vector3.new(0, -R0, 0), Vector3.new(2 * R0, 10, 2 * R0) },
		{ Vector3.new(0, 0, R0), Vector3.new(2 * R0, 2 * R0, 10) }, { Vector3.new(0, 0, -R0), Vector3.new(2 * R0, 2 * R0, 10) } }
	for i = 1, 6 do
		dome[i].Size = faces[i][2]; dome[i].CFrame = CFrame.new(faces[i][1]); dome[i].Transparency = spaceA
	end
	-- the Sun's height sets the time of day for Roblox's lighting
	local sunUp = math.asin(math.clamp(sunW.Y, -1, 1))
	Lighting.ClockTime = 12 - (math.pi / 2 - sunUp) / (math.pi / 2) * 6 * (if sunW.X >= 0 then 1 else -1)

	hud:update(ship, C, craft, warpLevels[warpIdx], ship.warp, messages)
end)

startFlight(Designs[1])
