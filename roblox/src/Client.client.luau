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
local Progress = require(SF.Progress)
local Shop = require(SF.Shop)
local Hangar = require(SF.Hangar)
local TweenService = game:GetService("TweenService")
local V3 = THREE.Vector3.new
local EARTH, MOON, D2R = Geo.EARTH, Geo.MOON, Geo.D2R
local S = ShipModel.SCALE

local player = Players.LocalPlayer
local camera = workspace.CurrentCamera

----------------------------------------------------------------- world model for the physics
local PAD = { e = 450, n = 420, r = 40, h = 3 }   -- rocket launch pad (metres from the spaceport centre)
local SITE_LAT, SITE_LON = 28.61, -80.69
-- the coastline east of the spaceport (metres east of the centre, as a function of metres north)
local function coastE(n) return 4800 + 600 * math.sin(n / 3500) + 300 * math.sin(n / 900 + 1.3) end
local function isWaterAt(e, n) return e > coastE(n) end
local world = { nearBuildings = false }
function world:groundAt(body, lat, lon)
	if body ~= EARTH then return 0 end
	local n = (lat - SITE_LAT) * 111320
	local e = (lon - SITE_LON) * 111320 * math.cos(SITE_LAT * D2R)
	if (e - PAD.e) ^ 2 + (n - PAD.n) ^ 2 < PAD.r * PAD.r then return PAD.h end
	return 0
end
function world:isWater(lat, lon)
	local n = (lat - SITE_LAT) * 111320
	local e = (lon - SITE_LON) * 111320 * math.cos(SITE_LAT * D2R)
	return isWaterAt(e, n)
end
function world:buildingTop() return nil end

local SITE = { name = "Starforge Spaceport", lat = 28.61, lon = -80.69, hdg = 90 }   -- Florida coast, runway pointing east
-- the spaceport runway in the form the runway autopilot expects
local RUNWAY = { latC = SITE.lat, lonC = SITE.lon, cosC = math.cos(SITE.lat * D2R), dx = math.sin(SITE.hdg * D2R), dy = math.cos(SITE.hdg * D2R), len = 3000, e1 = 0, e2 = 0 }
local airports = {}
function airports:localCoords(rw, lat, lon)
	local x, y = (lon - rw.lonC) * D2R * EARTH.R * rw.cosC, (lat - rw.latC) * D2R * EARTH.R
	return { along = x * rw.dx + y * rw.dy, cross = x * rw.dy - y * rw.dx }
end
function airports:elevAt(rw, along) return rw.e1 end

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
-- the spaceport, in metres from its centre: e (east, along the runway), n (north), y (centre height),
-- size, colour, material; flat things get a layer so they sit just above the ground at any scale
local props = {}
local function prop(e, n, y, sx, sy, sz, color, mat, opt)
	opt = opt or {}
	table.insert(props, { e = e, n = n, y = y, size = Vector3.new(sx, sy, sz), color = color, mat = mat, layer = opt.layer, shape = opt.shape, rot = opt.rot })
end
do
	local ASPH, WHITE, CONC = Color3.fromRGB(52, 54, 58), Color3.fromRGB(236, 236, 232), Color3.fromRGB(176, 174, 168)
	for i = 0, 5 do prop(-1250 + i * 500, 0, 0.1, 500, 0.2, 60, ASPH, Enum.Material.Asphalt, { layer = 1 }) end
	for e = -1440, 1440, 60 do prop(e, 0, 0.25, 30, 0.1, 1, WHITE, Enum.Material.SmoothPlastic, { layer = 2 }) end
	for i = 0, 5 do
		prop(-1250 + i * 500, 28.5, 0.25, 500, 0.1, 1, WHITE, Enum.Material.SmoothPlastic, { layer = 2 })
		prop(-1250 + i * 500, -28.5, 0.25, 500, 0.1, 1, WHITE, Enum.Material.SmoothPlastic, { layer = 2 })
	end
	for _, side in ipairs({ -1, 1 }) do
		for b = -3, 3 do prop(side * 1470, b * 7.5, 0.25, 30, 0.1, 2.5, WHITE, Enum.Material.SmoothPlastic, { layer = 2 }) end
		-- edge lights
		for e = 0, 1500, 100 do
			prop(side * e, 31, 0.4, 0.8, 0.8, 0.8, Color3.fromRGB(255, 236, 170), Enum.Material.Neon, { layer = 3 })
			prop(side * e, -31, 0.4, 0.8, 0.8, 0.8, Color3.fromRGB(255, 236, 170), Enum.Material.Neon, { layer = 3 })
		end
	end
	-- taxiway, apron, hangar, tower
	prop(-1100, 60, 0.1, 22, 0.2, 60, ASPH, Enum.Material.Asphalt, { layer = 1 })
	prop(-1100, 135, 0.1, 160, 0.2, 90, CONC, Enum.Material.Concrete, { layer = 1 })
	prop(-1100, 165, 11, 60, 22, 40, Color3.fromRGB(150, 156, 165), Enum.Material.DiamondPlate)
	prop(-1100, 145.2, 9, 44, 18, 0.6, Color3.fromRGB(60, 64, 72), Enum.Material.Metal)
	prop(-1100, 165, 22.5, 62, 1.2, 42, Color3.fromRGB(255, 160, 60), Enum.Material.SmoothPlastic)
	prop(-760, 150, 20, 7, 40, 7, CONC, Enum.Material.Concrete)
	prop(-760, 150, 43, 13, 6, 13, Color3.fromRGB(90, 140, 190), Enum.Material.Glass)
	prop(-760, 150, 46.6, 14, 1.2, 14, Color3.fromRGB(70, 74, 82), Enum.Material.Metal)
	-- road from the pad to the runway, the pad and its service tower
	prop(PAD.e, 200, 0.1, 14, 0.2, 340, ASPH, Enum.Material.Asphalt, { layer = 1 })
	prop(PAD.e, PAD.n, 1.5, 3, 80, 80, CONC, Enum.Material.Concrete, { shape = Enum.PartType.Cylinder, rot = CFrame.Angles(0, 0, math.pi / 2) })
	prop(PAD.e, PAD.n, 3.05, 0.1, 30, 30, Color3.fromRGB(60, 60, 62), Enum.Material.Concrete, { shape = Enum.PartType.Cylinder, rot = CFrame.Angles(0, 0, math.pi / 2), layer = 4 })
	prop(PAD.e + 28, PAD.n, 33, 7, 60, 7, Color3.fromRGB(190, 50, 40), Enum.Material.Metal)
	prop(PAD.e + 20, PAD.n, 50, 10, 1.5, 2, Color3.fromRGB(190, 50, 40), Enum.Material.Metal)
	prop(PAD.e + 28, PAD.n, 63.5, 1, 1, 1, Color3.fromRGB(255, 60, 60), Enum.Material.Neon)
end
local propParts = {}
for i, pr in ipairs(props) do
	propParts[i] = anchored("Part", { Name = "Spaceport", Size = Vector3.one, Color = pr.color, Material = pr.mat, Shape = pr.shape or Enum.PartType.Block, CastShadow = pr.layer == nil })
end
local propK = nil
local propCF = {}
local function drawProps(xe, xn, k, gy, show)
	for i, p in ipairs(propParts) do p.Transparency = if show then 0 else 1 end
	if not show then return end
	local kq = math.exp(math.floor(math.log(k) / 0.03 + 0.5) * 0.03)
	local resize = propK ~= kq
	propK = kq
	for i, pr in ipairs(props) do
		local sz = pr.size * (S * kq)
		local y
		if pr.layer then
			sz = Vector3.new(sz.X, math.max(sz.Y, 0.05), sz.Z)
			y = gy + math.max(pr.y * S * k, pr.layer * 0.12)
		else
			y = gy + pr.y * S * k
		end
		if resize then propParts[i].Size = sz end
		local cf = CFrame.new((pr.e - xe) * S * k, y, -(pr.n - xn) * S * k)
		propCF[i] = if pr.rot then cf * pr.rot else cf
	end
	workspace:BulkMoveTo(propParts, propCF, Enum.BulkMoveMode.FireCFrameChanged)
end
-- the Earth seen from high up, the Moon, the Sun, and a black dome for space
local earthBall = anchored("Part", { Name = "EarthBall", Shape = Enum.PartType.Ball, Size = Vector3.new(1, 1, 1), Material = Enum.Material.SmoothPlastic, Color = Color3.fromRGB(40, 90, 170), CastShadow = false })
local earthMesh = Instance.new("SpecialMesh"); earthMesh.MeshType = Enum.MeshType.Sphere; earthMesh.Parent = earthBall
local moonBall = anchored("Part", { Name = "MoonBall", Shape = Enum.PartType.Ball, Size = Vector3.new(1, 1, 1), Material = Enum.Material.Slate, Color = Color3.fromRGB(170, 170, 165), CastShadow = false })
local moonMesh = Instance.new("SpecialMesh"); moonMesh.MeshType = Enum.MeshType.Sphere; moonMesh.Parent = moonBall
local sunBall = anchored("Part", { Name = "SunBall", Shape = Enum.PartType.Ball, Size = Vector3.new(80, 80, 80), Material = Enum.Material.Neon, Color = Color3.fromRGB(255, 244, 214), CastShadow = false })
local dome = {}
for i = 1, 6 do dome[i] = anchored("Part", { Name = "Space", Size = Vector3.new(1, 1, 1), Material = Enum.Material.Neon, Color = Color3.new(0, 0, 0), CastShadow = false, Transparency = 1 }) end
Lighting.Brightness = 2.6
Lighting.OutdoorAmbient = Color3.fromRGB(150, 150, 158)
Lighting.Ambient = Color3.fromRGB(70, 70, 78)
Lighting.EnvironmentDiffuseScale = 0.6
Lighting.EnvironmentSpecularScale = 0.6
local cc = Lighting:FindFirstChild("StarforgeGrade") or Instance.new("ColorCorrectionEffect")
cc.Name = "StarforgeGrade"; cc.Saturation = 0.12; cc.Contrast = 0.06; cc.Parent = Lighting
local bloom = Lighting:FindFirstChildOfClass("BloomEffect") or Instance.new("BloomEffect")
bloom.Intensity = 0.6; bloom.Size = 28; bloom.Threshold = 1.4; bloom.Parent = Lighting
local atmosphere = Lighting:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")
atmosphere.Parent = Lighting

----------------------------------------------------------------- scenery: coast, fields, a town, trees and clouds
-- Everything is generated from the position (metres east/north of the spaceport), so it is the same for every
-- player and every visit. Objects come from a pool of parts that is re-assigned as you fly.
local function hash2(i, j, salt)
	local h = bit32.bxor(bit32.bxor((i * 73856093) % 4294967296, (j * 19349663) % 4294967296), (salt * 83492791) % 4294967296)
	return (h % 1000003) / 1000003
end
local FIELD = { Color3.fromRGB(86, 120, 64), Color3.fromRGB(98, 132, 70), Color3.fromRGB(110, 128, 66), Color3.fromRGB(76, 110, 60), Color3.fromRGB(124, 136, 78) }
local SEA, SAND = Color3.fromRGB(28, 82, 128), Color3.fromRGB(214, 200, 150)
local function groundStyle(e, n)
	local c = coastE(n)
	if e > c + 60 then return SEA, Enum.Material.SmoothPlastic end
	if e > c - 160 then return SAND, Enum.Material.Sand end
	local i, j = math.floor(e / 700), math.floor(n / 700)
	return FIELD[1 + math.floor(hash2(i, j, 7) * #FIELD)], Enum.Material.Grass
end

local CELL = 250
local cellCache = {}
local BUILD_COLORS = { Color3.fromRGB(200, 200, 196), Color3.fromRGB(170, 172, 176), Color3.fromRGB(214, 196, 168), Color3.fromRGB(120, 126, 136), Color3.fromRGB(230, 230, 226) }
local function cellObjects(ci, cj)
	local key = ci .. "," .. cj
	local c = cellCache[key]
	if c then return c end
	c = {}
	local rng = Random.new(ci * 100003 + cj * 7919 + 17)
	local e0, n0 = ci * CELL, cj * CELL
	local town = e0 > -5200 and e0 < -1800 and n0 > -2600 and n0 < 2600
	local function free(e, n)
		if isWaterAt(e, n) then return false end
		if math.abs(n) < 160 and math.abs(e) < 1750 then return false end   -- runway
		if e > -1300 and e < -900 and n > -60 and n < 260 then return false end -- hangar
		return true
	end
	if town then
		local downtown = math.abs(e0 + 3400) < 700 and math.abs(n0) < 700
		for _ = 1, rng:NextInteger(3, 6) do
			local e, n = e0 + rng:NextNumber(20, CELL - 20), n0 + rng:NextNumber(20, CELL - 20)
			if free(e, n) then
				local tall = downtown and rng:NextNumber() < 0.5
				local w, d = rng:NextNumber(18, 45), rng:NextNumber(18, 45)
				local h = if tall then rng:NextNumber(60, 160) else rng:NextNumber(8, 30)
				table.insert(c, { e = e, n = n, y = h / 2, size = Vector3.new(w, h, d), shape = Enum.PartType.Block,
					color = if tall then Color3.fromRGB(110, 150, 190) else BUILD_COLORS[rng:NextInteger(1, #BUILD_COLORS)],
					mat = if tall then Enum.Material.Glass else Enum.Material.Concrete, rot = rng:NextNumber(0, 0.3) })
			end
		end
	else
		local dense = hash2(math.floor(e0 / 1500), math.floor(n0 / 1500), 3)
		local count = if dense > 0.6 then rng:NextInteger(3, 6) else rng:NextInteger(0, 1)
		for _ = 1, count do
			local e, n = e0 + rng:NextNumber(0, CELL), n0 + rng:NextNumber(0, CELL)
			if free(e, n) then
				local r = rng:NextNumber(5, 9)
				table.insert(c, { e = e, n = n, y = r * 1.1, size = Vector3.new(2 * r, 2.2 * r, 2 * r), shape = Enum.PartType.Ball,
					color = Color3.fromRGB(46 + rng:NextInteger(0, 20), 84 + rng:NextInteger(0, 30), 40), mat = Enum.Material.Grass, rot = 0 })
			end
		end
	end
	cellCache[key] = c
	return c
end
local CLOUD_CELL = 2200
local cloudCache = {}
local function cloudObjects(ci, cj)
	local key = ci .. "," .. cj
	local c = cloudCache[key]
	if c then return c end
	c = {}
	local rng = Random.new(ci * 30011 + cj * 6151 + 99)
	if rng:NextNumber() < 0.55 then
		local e, n, h = (ci + rng:NextNumber()) * CLOUD_CELL, (cj + rng:NextNumber()) * CLOUD_CELL, rng:NextNumber(1100, 2600)
		local base = rng:NextNumber(120, 260)
		for b = 1, rng:NextInteger(3, 5) do
			local r = base * rng:NextNumber(0.6, 1.1)
			table.insert(c, { e = e + rng:NextNumber(-1.2, 1.2) * base, n = n + rng:NextNumber(-0.8, 0.8) * base, y = h + rng:NextNumber(-0.2, 0.3) * base,
				size = Vector3.new(2.2 * r, 1.1 * r, 1.8 * r), shape = Enum.PartType.Ball, color = Color3.fromRGB(245, 247, 250), mat = Enum.Material.SmoothPlastic, rot = 0, cloud = true })
		end
	end
	cloudCache[key] = c
	return c
end

local pool, poolUsed, poolK, poolO = {}, 0, {}, {}
local function poolPart(i)
	local p = pool[i]
	if not p then
		p = Instance.new("Part")
		p.Anchored = true; p.CanCollide = false; p.CanQuery = false; p.CanTouch = false; p.CastShadow = false
		p.TopSurface = Enum.SurfaceType.Smooth; p.BottomSurface = Enum.SurfaceType.Smooth
		p.Name = "Scenery"; p.Parent = scene
		pool[i] = p
	end
	return p
end
local bulkParts, bulkCF = {}, {}
-- draw scenery around (xe, xn); k = ground scale; gy = ground height in studs
local function drawScenery(xe, xn, agl, k, gy, show)
	table.clear(bulkParts); table.clear(bulkCF)
	local n = 0
	local kq = math.exp(math.floor(math.log(k) / 0.03 + 0.5) * 0.03)   -- sizes change in 3% steps
	local function put(o)
		n += 1
		local p = poolPart(n)
		if poolK[n] ~= kq or poolO[n] ~= o.id then
			if p.Shape ~= o.shape then p.Shape = o.shape end
			p.Size = o.size * (S * kq)
			p.Color = o.color; p.Material = o.mat
			p.Transparency = if o.cloud then 0.18 else 0
			poolK[n] = kq; poolO[n] = o.id
		end
		bulkParts[n] = p
		bulkCF[n] = CFrame.new((o.e - xe) * S * k, gy + o.y * S * k, -(o.n - xn) * S * k) * CFrame.Angles(0, o.rot, 0)
	end
	if show and agl < 2500 then
		local R = 1600
		local ci0, cj0 = math.floor((xe - R) / CELL), math.floor((xn - R) / CELL)
		local ci1, cj1 = math.floor((xe + R) / CELL), math.floor((xn + R) / CELL)
		for ci = ci0, ci1 do
			for cj = cj0, cj1 do
				local dx, dy = (ci + 0.5) * CELL - xe, (cj + 0.5) * CELL - xn
				if dx * dx + dy * dy < R * R then
					for idx, o in ipairs(cellObjects(ci, cj)) do
						o.id = o.id or (ci * 1000 + cj) * 16 + idx
						if n < 380 then put(o) end
					end
				end
			end
		end
	end
	if show then
		local R = 11000
		for ci = math.floor((xe - R) / CLOUD_CELL), math.floor((xe + R) / CLOUD_CELL) do
			for cj = math.floor((xn - R) / CLOUD_CELL), math.floor((xn + R) / CLOUD_CELL) do
				for idx, o in ipairs(cloudObjects(ci, cj)) do
					o.id = o.id or -((ci * 1000 + cj) * 16 + idx) - 1
					if n < 520 then put(o) end
				end
			end
		end
	end
	for i = n + 1, poolUsed do pool[i].Transparency = 1; poolO[i] = nil end
	poolUsed = n
	if n > 0 then workspace:BulkMoveTo(bulkParts, bulkCF, Enum.BulkMoveMode.FireCFrameChanged) end
end

----------------------------------------------------------------- flight state
-- Flights always start in the late morning at the spaceport (today's date, so the Moon and planets are
-- where they really are, within a day).
local function flightStartTime()
	local t = Astro.nowSimTime()
	local u = (t + 43200) % 86400                     -- seconds into the UTC day (J2000 starts at noon)
	local wantUTC = (10.5 - SITE.lon / 15) * 3600     -- 10:30 local solar time
	return t - u + wantUTC
end
local eph = Astro.Ephemeris.new():update(flightStartTime())
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
local airTime = 0
local deadFor = 0
local lastGood = { r = V3(), v = V3(), q = THREE.Quaternion.new() }
local dbgStick, dbgPos, dbgNoScenery = nil, { 0, 0 }, false
local dbgTimes = { sim = 0, scen = 0, ghost = 0, hud = 0, frame = 0 }

local function toast(msg)
	table.insert(messages, { text = msg, t = os.clock() })
	print("[Starforge] " .. msg)
end

----------------------------------------------------------------- progress (missions, levels, unlocks), saved on the server
local state = Progress.newState()
local remotes = RS:WaitForChild("StarforgeRemotes", 8)
if remotes then
	local ok, saved = pcall(function() return remotes.Load:InvokeServer() end)
	if ok and type(saved) == "table" then
		for k, v in pairs(saved) do state[k] = v end
		state.done = state.done or {}
	end
end
local saveDirty, lastSave = false, 0
local function save() saveDirty = true end
local function flushSave(force)
	if not remotes or not saveDirty then return end
	if not force and os.clock() - lastSave < 6 then return end
	saveDirty = false; lastSave = os.clock()
	remotes.Save:FireServer(state)
end

-- flight flags the missions look at; reset each flight
local flags
local function resetFlags()
	flags = { airborne = false, landedRunway = false, ringsPassed = 0, raceDone = false, hoverTime = 0, landedBody = nil, wasHigh = false }
end
resetFlags()

local bannerQueue = {}
local function banner(title, sub, secs) table.insert(bannerQueue, { title, sub, secs }) end
-- give xp and credits; announces level-ups and what they unlock
local function grant(xp, credits)
	local ups = Progress.reward(state, xp, credits)
	for _, lv in ipairs(ups) do
		local unlocked = {}
		for _, d in ipairs(Designs) do if Progress.SHIP_LEVEL[d.key] == lv then table.insert(unlocked, d.design.name) end end
		banner("LEVEL " .. lv .. "!", if #unlocked > 0 then "Unlocked: " .. table.concat(unlocked, ", ") .. " — tap the Ship button" else "Keep flying", 4)
	end
	save()
end

----------------------------------------------------------------- sounds and effects
local SoundService = game:GetService("SoundService")
local function sound(id, props)
	local s = Instance.new("Sound")
	s.SoundId = "rbxassetid://" .. id
	for k, v in pairs(props or {}) do s[k] = v end
	s.Parent = SoundService
	return s
end
local engineJet = sound("82496091617037", { Looped = true, Volume = 0 })
local engineRocket = sound("77862630063982", { Looped = true, Volume = 0 })
engineJet:Play(); engineRocket:Play()
local SOUND_IDS = { boom = "9120769331", chime = "85188102085028", crash = "138533090376585", ring = "138890894929151" }
local function sfx(name, vol, pitch)
	local id = SOUND_IDS[name]
	if id == "" then return end
	local s = sound(id, { Volume = vol or 0.8, PlaybackSpeed = pitch or 1 })
	s:Play()
	s.Ended:Connect(function() s:Destroy() end)
end
local shake = 0          -- camera shake amplitude (studs), decays
local function kick(a) shake = math.max(shake, a) end

----------------------------------------------------------------- ring race over the spaceport
-- ring centres in metres from the spaceport: east, north, height
local RING_POS = {
	{ 1900, 0, 70, 75 }, { 3600, 0, 160, 65 }, { 5600, 500, 300 }, { 6900, 1900, 420 }, { 6800, 3700, 520 },
	{ 5200, 5200, 600 }, { 2800, 5700, 500 }, { 700, 4800, 380 }, { -300, 3000, 260 }, { 300, 1400, 160 },
}
local RING_R, SEG = 45, 18
local rings = {}
for i, p in ipairs(RING_POS) do
	local q = RING_POS[i + 1] or RING_POS[1]
	local prev = RING_POS[i - 1]
	-- facing: along the course (from the previous ring to the next)
	local a = prev or { 0, 0, 100 }
	local nx, ny, nz = q[1] - a[1], q[3] - a[3], q[2] - a[2]
	if i == #RING_POS then nx, ny, nz = p[1] - a[1], p[3] - a[3], p[2] - a[2] end
	local L = math.sqrt(nx * nx + ny * ny + nz * nz)
	local ring = { e = p[1], n = p[2], h = p[3], r = p[4] or RING_R, nE = nx / L, nU = ny / L, nN = nz / L, parts = {}, side = nil }
	for s = 1, SEG do
		ring.parts[s] = anchored("Part", { Name = "Ring" .. i, Material = Enum.Material.Neon, Color = Color3.fromRGB(80, 220, 255), CastShadow = false, Size = Vector3.one })
	end
	rings[i] = ring
end
local race = { next = 1, startT = nil, t = 0 }
local marker = anchored("Part", { Name = "RingMarker", Size = Vector3.one, Transparency = 1 })
local markerGui = Instance.new("BillboardGui")
markerGui.Size = UDim2.new(0, 140, 0, 46); markerGui.AlwaysOnTop = true; markerGui.LightInfluence = 0
markerGui.Adornee = marker; markerGui.Parent = marker
local markerText = Instance.new("TextLabel")
markerText.Size = UDim2.new(1, 0, 1, 0); markerText.BackgroundTransparency = 1; markerText.Font = Enum.Font.GothamBold
markerText.TextSize = 16; markerText.TextColor3 = Color3.fromRGB(90, 255, 140); markerText.TextStrokeTransparency = 0.3
markerText.Parent = markerGui

-- ring position (metres, east/up/north from the ship's spot over the ground) -> world studs, given the ground scale
local function placeRing(ring, idx, xe, xn, agl, k, visible)
	local col = if idx == race.next then Color3.fromRGB(90, 255, 140) elseif idx == race.next + 1 then Color3.fromRGB(80, 220, 255) else Color3.fromRGB(60, 120, 200)
	local show = visible and idx >= race.next
	local c = Vector3.new((ring.e - xe) * S * k, (ring.h - agl) * S * k, -(ring.n - xn) * S * k)
	local n = Vector3.new(ring.nE, ring.nU, -ring.nN)
	local cf = CFrame.lookAt(c, c + n)
	local R = ring.r * S * k
	local segLen = 2 * math.pi * R / SEG * 1.08
	local thick = math.max(0.4, (if idx == race.next then 3.5 else 2.2) * S * k)
	for s, part in ipairs(ring.parts) do
		part.Transparency = if show then (if idx == race.next then 0 else 0.35) else 1
		if show then
			local ang = (s - 0.5) / SEG * 2 * math.pi
			part.Color = col
			part.Size = Vector3.new(segLen, thick, thick)
			part.CFrame = cf * CFrame.Angles(0, 0, ang) * CFrame.new(0, R, 0)
		end
	end
end

----------------------------------------------------------------- engine trail (bought in the shop)
local TRAIL_N = 90
local trailPts = {}      -- { e, n, h, t }
local trailParts = {}
for i = 1, TRAIL_N do trailParts[i] = anchored("Part", { Name = "Trail", Size = Vector3.one, Material = Enum.Material.Neon, CastShadow = false, Transparency = 1 }) end
local lastTrail = 0
local trailParts2, trailCF = {}, {}
local function drawTrail(xe, xn, agl, k, tailE, tailN, tailU, simT, active)
	local def = Shop.find(state.trail or "")
	if not def or not def.color then
		if #trailPts > 0 then table.clear(trailPts); for _, p in ipairs(trailParts) do p.Transparency = 1 end end
		return
	end
	if active and simT - lastTrail > 0.07 then
		lastTrail = simT
		table.insert(trailPts, { tailE, tailN, tailU, simT })
		if #trailPts > TRAIL_N then table.remove(trailPts, 1) end
	end
	table.clear(trailParts2); table.clear(trailCF)
	local life = 6
	local w = def.width * S * k
	for i = 1, TRAIL_N do
		local p = trailParts[i]
		local a, b = trailPts[i], trailPts[i + 1]
		if not a then p.Transparency = 1; continue end
		local bE, bN, bU = if b then b[1] else tailE, if b then b[2] else tailN, if b then b[3] else tailU
		local p0 = Vector3.new((a[1] - xe) * S * k, (a[3] - agl) * S * k, -(a[2] - xn) * S * k)
		local p1 = Vector3.new((bE - xe) * S * k, (bU - agl) * S * k, -(bN - xn) * S * k)
		local len = (p1 - p0).Magnitude
		local age = simT - a[4]
		if len < 0.01 or len > 400 * S * k or age > life then p.Transparency = 1; continue end
		local f = age / life
		p.Transparency = 0.15 + 0.85 * f
		local col
		if def.color == "rainbow" then col = Color3.fromHSV((a[4] * 0.25) % 1, 0.85, 1)
		else col = Shop.hex(def.color) end
		p.Color = col
		p.Material = if def.neon then Enum.Material.Neon else Enum.Material.SmoothPlastic
		local ww = w * (1 + f * (if def.neon then 0.3 else 2.5))
		p.Size = Vector3.new(ww, ww, len + ww * 0.5)
		table.insert(trailParts2, p)
		table.insert(trailCF, CFrame.lookAt((p0 + p1) / 2, p1))
	end
	if #trailParts2 > 0 then workspace:BulkMoveTo(trailParts2, trailCF, Enum.BulkMoveMode.FireCFrameChanged) end
end

local function fmtRace(t) return string.format("%d:%05.2f", math.floor(t / 60), t % 60) end

local function startFlight(entry)
	if view then view.model:Destroy() end
	table.clear(trailPts)
	resetFlags()
	race.next = 1; race.startT = nil
	if hud then hud:setRace(nil); hud:setShip("Ship: " .. entry.design.name) end
	state.flights = (state.flights or 0) + 1
	design = entry
	eph:update(flightStartTime())
	craft = Craft.new(entry.design)
	craft.thrustMult = Shop.thrustMult(state)
	local paint = Shop.find(state.paint or "")
	if paint and paint.hull then craft.colors = { hull = paint.hull, accent = paint.accent } end
	ship = Physics.Ship.new(craft, world, eph, settings)
	C = Control.Controller.new(settings)
	C.onApDone = function(out)
		-- after an autopilot lands us, leave the ship stopped instead of driving off on the old throttle
		if ship.contacts > 0 or ship.parked then C.input.throttle = 0; C.input.brake = true end
		if out.throttle then C.input.throttle = out.throttle end
	end
	local vert = craft.vertical
	if vert then
		ship:placeAt(EARTH, SITE.lat + PAD.n / 111320, SITE.lon + PAD.e / (111320 * math.cos(SITE.lat * D2R)), craft.box.max.z - craft.com.z + 3.15, 0, math.pi / 2)
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

local function shipCFrame(qq)
	-- rotation: body axes in frame I -> world
	local q = qq or ship.q
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

----------------------------------------------------------------- other players' ships
-- Each client sends its pose in Earth-fixed coordinates a few times a second; the server relays it.
-- Other ships are drawn where they are relative to us, with a name tag that stays visible from far away.
local ghosts = {}
local poseEvent = remotes and remotes:FindFirstChild("Pose")
local leftEvent = remotes and remotes:FindFirstChild("Left")
local lastPose = 0
local _gq, _gq2, _gv = THREE.Quaternion.new(), THREE.Quaternion.new(), V3()
local function sendPose()
	if not poseEvent or os.clock() - lastPose < 0.12 then return end
	lastPose = os.clock()
	if ship.env.body ~= EARTH then return end
	local pF = ship:toFixed(EARTH, ship.r, ship.t, V3())
	ship:bodyFrameQ(EARTH, ship.t, _gq)
	_gq2:copy(_gq):invert()
	local qF = _gq2:clone():multiply(ship.q)
	local vF = ship.v:clone():sub(ship:surfaceVel(EARTH, ship.r, ship.t, _gv)):applyQuaternion(_gq2)
	local fl, n = 0, 0
	for _, P in ipairs(craft.engines) do if P.alive then fl += P.eng.flame; n += 1 end end
	poseEvent:FireServer({ k = design.key, p = { pF.x, pF.y, pF.z }, v = { vF.x, vF.y, vF.z }, q = { qF.x, qF.y, qF.z, qF.w }, f = if n > 0 then fl / n else 0, d = ship.dead })
end
local function dropGhost(id)
	local g = ghosts[id]
	if not g then return end
	if g.view then g.view.model:Destroy() end
	if g.tag then g.tag:Destroy() end
	ghosts[id] = nil
end
if poseEvent then
	poseEvent.OnClientEvent:Connect(function(userId, pose)
		if userId == player.UserId or type(pose) ~= "table" then return end
		local g = ghosts[userId]
		if not g then
			local pl = Players:GetPlayerByUserId(userId)
			g = { name = if pl then pl.DisplayName else "Pilot" }
			local tag = anchored("Part", { Name = "PilotTag", Size = Vector3.one, Transparency = 1 })
			local bb = Instance.new("BillboardGui")
			bb.Size = UDim2.new(0, 160, 0, 40); bb.AlwaysOnTop = true; bb.LightInfluence = 0; bb.Adornee = tag; bb.Parent = tag
			local lb = Instance.new("TextLabel")
			lb.Size = UDim2.new(1, 0, 1, 0); lb.BackgroundTransparency = 1; lb.Font = Enum.Font.GothamBold; lb.TextSize = 14
			lb.TextColor3 = Color3.fromRGB(255, 200, 120); lb.TextStrokeTransparency = 0.3; lb.Parent = bb
			g.tag, g.label = tag, lb
			ghosts[userId] = g
		end
		if g.key ~= pose.k then
			for _, d in ipairs(Designs) do
				if d.key == pose.k then
					if g.view then g.view.model:Destroy() end
					g.craft = Craft.new(d.design)
					g.view = ShipModel.build(g.craft, "Pilot_" .. userId)
					g.view.model.Parent = scene
					g.key = pose.k
					g.shipName = d.design.name
				end
			end
		end
		g.pose = pose; g.at = os.clock()
	end)
end
if leftEvent then leftEvent.OnClientEvent:Connect(dropGhost) end

local function drawGhosts(simT)
	local myPF = nil
	for id, g in pairs(ghosts) do
		if os.clock() - (g.at or 0) > 10 then dropGhost(id); continue end
		if not g.pose or not g.view then continue end
		local P = g.pose
		local age = math.min(os.clock() - g.at, 1)
		local pF = V3(P.p[1] + P.v[1] * age, P.p[2] + P.v[2] * age, P.p[3] + P.v[3] * age)
		local pI = ship:toI(EARTH, pF, ship.t, V3())
		local d = pI:sub(ship.r)
		local dist = d:length()
		local show = ship.env.body == EARTH and dist < 6000 and not P.d
		g.view.model.Parent = if show then scene else nil
		if show then
			ship:bodyFrameQ(EARTH, ship.t, _gq)
			local qI = _gq:clone():multiply(THREE.Quaternion.new(P.q[1], P.q[2], P.q[3], P.q[4]))
			for _, part in ipairs(g.craft.engines) do part.eng.flame = P.f end
			ShipModel.update(g.view, g.craft, CFrame.new(toWorld(d) * S) * shipCFrame(qI), simT)
		end
		local dir = toWorld(d) / math.max(dist, 1)
		g.tag.CFrame = CFrame.new(dir * math.min(dist * S, 12000) + Vector3.new(0, 8, 0))
		g.label.Text = string.format("%s\n%s · %s", g.name, g.shipName or "", Geo.fmtDist(dist))
		g.label.Visible = ship.env.body == EARTH and dist < 200000
	end
end

----------------------------------------------------------------- HUD
local function openHangar(title)
	Hangar.open(hud.gui, {
		designs = Designs, current = design.key, state = state, title = title, scale = hud.uiScale,
		unlocked = function(key) return Progress.unlocked(state, key) end,
		needLevel = function(key) return Progress.SHIP_LEVEL[key] or 1 end,
		blurb = function(entry) return entry.blurb or "" end,
		vertical = function(entry) return entry.design.vertical == true end,
		size = function(entry) return Craft.new(entry.design).size * S end,
		build = function(entry)
			local c = Craft.new(entry.design)
			local paint = Shop.find(state.paint or "")
			if paint and paint.hull then c.colors = { hull = paint.hull, accent = paint.accent } end
			local v = ShipModel.build(c, entry.design.name)
			-- turn about the centre of mass
			v.root.PivotOffset = CFrame.new(Vector3.new(c.com.x, c.com.y, c.com.z) * S)
			return v.model
		end,
		onFly = function(entry)
			startFlight(entry)
			hud:setMission(Progress.current(state))
		end,
	})
end

local function designIndex(key) for i, d in ipairs(Designs) do if d.key == key then return i end end return 1 end
local function lockedHint()
	local best
	for _, d in ipairs(Designs) do
		if not Progress.unlocked(state, d.key) and (not best or Progress.SHIP_LEVEL[d.key] < Progress.SHIP_LEVEL[best.key]) then best = d end
	end
	return best
end
hud = require(SF.Hud).new(player, {
	ships = Designs,
	onNextShip = function() openHangar(false) end,
	_cycleShip = function()
		local i = designIndex(design.key)
		for _ = 1, #Designs do
			i = i % #Designs + 1
			if Progress.unlocked(state, Designs[i].key) then break end
		end
		if Designs[i] == design then
			local nxt = lockedHint()
			if nxt then toast(string.format("Reach level %d to unlock the %s", Progress.SHIP_LEVEL[nxt.key], nxt.design.name)) end
			return
		end
		startFlight(Designs[i])
	end,
	onAuto = function(kind)
		if not ship then return end
		if kind == "orbit" then C:engage(Control.ascentAp()); toast("Autopilot: climbing to orbit")
		elseif kind == "land" then
			local E = ship.env
			local winged = #craft.wings > 0 and not craft.vertical
			local d = Geo.gcDist(E.lat, E.lon, SITE.lat, SITE.lon)
			if E.body == EARTH and winged and d < 300000 and E.h < 30000 and ship.contacts == 0 then
				C:engage(Control.landRunwayAp(airports, RUNWAY, SITE.name)); toast("Autopilot: landing on the spaceport runway")
			else
				C:engage(Control.landAp()); toast("Autopilot: landing")
			end
		elseif kind == "off" then C:cancelAp(); toast("Autopilot off") end
	end,
	onSas = function(mode) if ship then C:setSas(mode); toast("SAS: " .. mode) end end,
	onTop = function()
		local list = {}
		if remotes and remotes:FindFirstChild("Top") then
			local ok, res = pcall(function() return remotes.Top:InvokeServer() end)
			if ok and type(res) == "table" then list = res end
		end
		hud:showTop(list, state.bestRace)
	end,
	onShop = function()
		Shop.open(hud.gui, {
			state = function() return state end,
			buy = function(kind, it)
				if state.credits < it.price then return false, string.format("You need %d more credits", it.price - state.credits) end
				state.credits -= it.price
				if kind == "tune" then state.tune = it.level; craft.thrustMult = Shop.thrustMult(state)
				else state.owned = state.owned or {}; state.owned[it.id] = true end
				sfx("chime", 0.7, 1.2)
				toast("Bought " .. it.name)
				save(); flushSave(true)
				return true
			end,
			equip = function(kind, it)
				if kind == "paint" then
					state.paint = it.id
					craft.colors = if it.hull then { hull = it.hull, accent = it.accent } else (design.design.colors or craft.colors)
					if view then view.model:Destroy() end
					view = ShipModel.build(craft, design.design.name)
					view.model.Parent = scene
				else
					state.trail = it.id
				end
				save()
			end,
		}, hud.uiScale)
	end,
	onKey = function(kind)
		if not ship then return end
		if kind == "gear" then ship.ctl.gear = not ship.ctl.gear; toast(if ship.ctl.gear then "Gear down" else "Gear up")
		elseif kind == "brake" then C.input.brake = not C.input.brake; toast(if C.input.brake then "Brakes on" else "Brakes off")
		elseif kind == "restart" then startFlight(design) end
	end,
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
local frame
local lastErr = 0
RunService.RenderStepped:Connect(function(dtRaw)
	if not ship then return end
	local ok, err = pcall(frame, dtRaw)
	if not ok and os.clock() - lastErr > 2 then lastErr = os.clock(); warn("[Starforge] frame error: " .. tostring(err)) end
end)
frame = function(dtRaw)
	local _frame0 = os.clock()
	local dt = math.min(dtRaw, 0.1)   -- keep real time even on slow devices (physics substeps internally)
	simTime += dt
	-- inputs
	C.input.pitch = axisKey(Enum.KeyCode.S, Enum.KeyCode.W) + hud.stickY
	C.input.roll = axisKey(Enum.KeyCode.D, Enum.KeyCode.A) + hud.stickX
	C.input.yaw = axisKey(Enum.KeyCode.E, Enum.KeyCode.Q)
	if dbgStick then C.input.pitch += dbgStick[1]; C.input.roll += dbgStick[2]; C.input.yaw += dbgStick[3] end
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
	local _c0 = os.clock()
	lastGood.r:copy(ship.r); lastGood.v:copy(ship.v); lastGood.q:copy(ship.q)
	ship:step(dt, C)
	-- a crash can leave the state unusable (no parts, no mass): keep the last good pose
	if ship.r.x ~= ship.r.x or ship.q.x ~= ship.q.x or ship.v.x ~= ship.v.x then
		ship.r:copy(lastGood.r); ship.v:set(0, 0, 0); ship.q:copy(lastGood.q); ship.w:set(0, 0, 0)
		ship:updateEnv(ship.t)
	end
	if ship.dead then
		deadFor += dt
		if deadFor > 4 then startFlight(design); return end
	else
		deadFor = 0
	end
	dbgTimes.sim = dbgTimes.sim * 0.9 + (os.clock() - _c0) * 100
	eph:update(ship.t)
	for _, e in ipairs(ship.events) do
		if e.type == "break" then toast(string.format("%s %s", e.part.def.name, if e.why == "overheat" then "overheated" else "broke off"))
		elseif e.type == "destroyed" then
			toast("Ship destroyed — press R to restart")
			banner("CRASHED", "Back on the runway in a moment…", 3)
			local ex = Instance.new("Explosion")
			ex.Position = Vector3.zero; ex.BlastPressure = 0; ex.BlastRadius = 30 + craft.size * S; ex.DestroyJointRadiusPercent = 0
			ex.ExplosionType = Enum.ExplosionType.NoCraters
			ex.Parent = workspace
			sfx("crash", 1)
			kick(6)
		elseif e.type == "landed" then
			toast("Landed on the " .. (if e.body == EARTH then "ground" else e.body.name))
			if flags.airborne then flags.landedBody = e.body end
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
	-- look direction: along the heading, tilted down by camPitch
	local dir = Vector3.new(math.sin(yaw) * math.cos(camPitch), -math.sin(camPitch), -math.cos(yaw) * math.cos(camPitch))
	camera.CameraType = Enum.CameraType.Scriptable
	local target = Vector3.new(0, camDist * 0.06, 0)
	local camPos = target - dir * camDist
	-- never below the ground
	local groundY = -(ship.env.agl * S) + 3
	if camPos.Y < groundY then camPos = Vector3.new(camPos.X, groundY, camPos.Z) end
	-- shake: from events, plus rumble from engines in air and transonic buffeting
	local rumble = 0
	if ship.thrustNow > 0 then rumble = 0.08 + 0.25 * ship.ctl.throttle * math.clamp(E.rho / 1.225, 0.15, 1) end
	if E.mach > 0.9 and E.mach < 1.15 and E.rho > 0.05 then rumble += 0.5 end
	if (craft.heatFrac or 0) > 0.3 then rumble += (craft.heatFrac - 0.3) * 1.5 end
	if ship.dead then rumble = 0 end
	shake = math.max(0, shake - dt * 5)
	local sh = (shake + rumble) * camDist / 60
	local jitter = Vector3.new(math.noise(simTime * 23, 1) , math.noise(simTime * 23, 2), math.noise(simTime * 23, 3)) * sh
	camera.CFrame = CFrame.lookAt(camPos + jitter, target + jitter * 0.5)
	-- wider view at speed feels faster
	camera.FieldOfView = 70 + math.clamp((E.vSurf - 100) / 600, 0, 1) * 12
	-- engine sound follows throttle; muffled when the air is thin
	local airS = math.clamp(E.rho / 1.225, 0, 1) ^ 0.5
	local on = if ship.thrustNow > 0 and not ship.dead then ship.ctl.throttle else 0
	local rocketish = craft.vertical or craft:capacity("OX") > 0 and E.h > 15000
	local vol = on * (0.25 + 0.75 * math.max(airS, 0.25))
	engineJet.Volume = if rocketish then 0 else vol * 0.9
	engineRocket.Volume = if rocketish then vol else 0
	engineJet.PlaybackSpeed = 0.7 + 0.6 * on
	engineRocket.PlaybackSpeed = 0.8 + 0.3 * on

	-- ground under the ship (near the surface), drawn uniformly scaled about the ship when high up
	local agl = E.h      -- height above the datum (the ground is flat at 0 apart from the pad)
	local depth = agl * S
	local k = if depth > 3000 then 3000 / depth else 1
	local showGround = body == EARTH and E.h < 60000
	-- ship position in the reference tangent plane (east, north metres from the spaceport)
	local rel = ship:toFixed(EARTH, ship.r, ship.t, _t1):sub(refFixed)
	local up0 = refFixed:clone():normalize()
	local east0 = V3(-math.sin(SITE.lon * D2R), 0, -math.cos(SITE.lon * D2R))
	local north0 = V3():crossVectors(up0, east0)
	local xe, xn = rel:dot(east0), rel:dot(north0)
	dbgPos[1], dbgPos[2] = xe, xn
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
				local wx, wz = (i - (NT + 1) / 2) * T - ox, (j - (NT + 1) / 2) * T - oz
				p.Size = Vector3.new(T, 4, T)
				p.CFrame = CFrame.new(wx, gy - 2, -wz)
				local col, mat = groundStyle(xe + wx / (S * k), xn + wz / (S * k))
				if p.Color ~= col then p.Color = col end
				if p.Material ~= mat then p.Material = mat end
			end
		end
	end
	-- the spaceport (runway along the site heading, centred at the site)
	local near = showGround and math.abs(xe) < 40000 and math.abs(xn) < 40000
	drawProps(xe, xn, k, gy, near)

	local _c1 = os.clock()
	drawScenery(xe, xn, agl, k, gy, showGround and E.h < 40000 and not dbgNoScenery)
	dbgTimes.scen = dbgTimes.scen * 0.9 + (os.clock() - _c1) * 100

	-- trail from the ship's tail (the end opposite the nose)
	do
		local back = -cf.LookVector * (craft.size * 0.5)
		local emitting = ship.thrustNow > 0 and not ship.dead and E.agl > 3
		drawTrail(xe, xn, agl, k, xe + back.X, xn - back.Z, E.h + back.Y, simTime, emitting)
	end

	-- ---------- rings ----------
	local ringsVisible = showGround and E.h < 8000 and math.abs(xe) < 30000 and math.abs(xn) < 30000
	for i, ring in ipairs(rings) do placeRing(ring, i, xe, xn, agl, k, ringsVisible) end
	local ringNow = rings[race.next]
	markerGui.Enabled = ringsVisible and ringNow ~= nil
	if ringNow and ringsVisible then
		marker.CFrame = CFrame.new((ringNow.e - xe) * S * k, (ringNow.h - agl + ringNow.r * 1.3) * S * k, -(ringNow.n - xn) * S * k)
		local dd = math.sqrt((ringNow.e - xe) ^ 2 + (ringNow.n - xn) ^ 2 + (ringNow.h - E.h) ^ 2)
		markerText.Text = string.format("RING %d\n%s", race.next, Geo.fmtDist(dd))
	end
	if ringNow and not ship.dead then
		local dE, dN, dU = xe - ringNow.e, xn - ringNow.n, E.h - ringNow.h
		local side = dE * ringNow.nE + dN * ringNow.nN + dU * ringNow.nU
		local lat2 = dE * dE + dN * dN + dU * dU - side * side
		if ringNow.side and ringNow.side < 0 and side >= 0 and lat2 < (ringNow.r * 1.15) ^ 2 then
			-- through the ring
			flags.ringsPassed += 1
			state.credits += 5
			if race.next == 1 then race.startT = simTime end
			race.next += 1
			sfx("ring", 0.7, 1 + race.next * 0.04)
			kick(0.6)
			if race.next > #rings then
				local t = simTime - race.startT
				flags.raceDone = true
				local best = state.bestRace
				local record = not best or t < best
				if record then state.bestRace = t end
				banner(if record then "NEW RECORD!" else "RACE COMPLETE", string.format("Time %s%s", fmtRace(t), if best then "  ·  best " .. fmtRace(math.min(best, t)) else ""), 4)
				grant(if record then 40 else 15, if record then 150 else 50)
				save()
				race.next = 1; race.startT = nil
				hud:setRace(nil)
				for _, r in ipairs(rings) do r.side = nil end
			else
				toast(string.format("Ring %d / %d", race.next - 1, #rings))
			end
		end
		ringNow.side = side
		if race.startT then
			hud:setRace(string.format("Ring %d/%d  ·  %s", race.next - 1, #rings, fmtRace(simTime - race.startT)))
		end
	end

	-- ---------- missions ----------
	if not ship.dead then
		local airborne = ship.contacts == 0 and E.agl > 5
		if airborne then
			flags.airborne = true
			airTime += dt
			if airTime > 15 then airTime -= 15; state.credits += 2; save() end
		end
		if E.h > 10000 then flags.wasHigh = true end
		if flags.airborne and ship.contacts > 0 and E.vSurf < 3 and E.body == EARTH and math.abs(xn) < 60 and math.abs(xe) < 1600 then
			flags.landedRunway = true
		end
		if design.key == "lynx" and E.agl > 10 and E.agl < 40 and E.vSurf < 3 then flags.hoverTime += dt else flags.hoverTime = 0 end
		local orbitPe = nil
		if E.h > 100000 then
			local rs = Orbit.relState(ship, E.body)
			local el = Orbit.elements(rs.r, rs.v, rs.mu)
			orbitPe = el.pe - E.body.R
		end
		-- sonic boom
		if E.rho > 0.05 and E.mach >= 1 and (ship.lastMach or 0) < 1 then
			sfx("boom", 1); kick(2.5)
			toast("Sonic boom!")
		end
		ship.lastMach = E.mach
		local m = Progress.check(state, { E = E, key = design.key, flags = flags, orbitPe = orbitPe, ship = ship, craft = craft })
		if m then
			sfx("chime", 0.9)
			banner("MISSION COMPLETE", string.format("%s   +%d XP   +%d credits", m.title, m.xp, m.credits), 3.5)
			grant(m.xp, m.credits)
			save()
			hud:setMission(Progress.current(state))
		end
	end
	local _c2 = os.clock()
	sendPose()
	drawGhosts(simTime)
	dbgTimes.ghost = dbgTimes.ghost * 0.9 + (os.clock() - _c2) * 100
	hud:setProgress(state, Progress.xpForLevel(state.level))
	if not hud.bannerUntil and #bannerQueue > 0 and not hud.gui:FindFirstChild("HangarScreen") then
		local b = table.remove(bannerQueue, 1)
		hud:showBanner(b[1], b[2], b[3])
	end
	flushSave(false)

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
	atmosphere.Density = 0.1 * airK
	atmosphere.Offset = 0.15
	atmosphere.Color = Color3.fromRGB(199, 214, 230)
	atmosphere.Decay = Color3.fromRGB(120, 150, 190)
	atmosphere.Glare = 0.4 * airK
	atmosphere.Haze = 0.8 * airK
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

	local _c3 = os.clock()
	hud:update(ship, C, craft, warpLevels[warpIdx], ship.warp, messages)
	dbgTimes.hud = dbgTimes.hud * 0.9 + (os.clock() - _c3) * 100
	dbgTimes.frame = dbgTimes.frame * 0.9 + (os.clock() - _frame0) * 100
end

-- test hook (Studio tools can call it): returns a summary, or runs a simple command
local dbg = Instance.new("BindableFunction")
dbg.Name = "StarforgeDebug"
dbg.OnInvoke = function(cmd, a, b, c)
	if cmd == "ap" then hud._cb.onAuto(a)
	elseif cmd == "ship" then for _, d in ipairs(Designs) do if d.key == a then startFlight(d) end end
	elseif cmd == "level" then state.level = a
	elseif cmd == "noscenery" then dbgNoScenery = a
	elseif cmd == "cb" then hud._cb[a](b)
	elseif cmd == "credits" and game:GetService("RunService"):IsStudio() then state.credits = a
	elseif cmd == "input" then C.input[a] = b
	elseif cmd == "stick" then dbgStick = if a then { a, b, c or 0 } else nil
	end
	local E = ship.env
	return { h = E.h, agl = E.agl, v = E.vSurf, mach = E.mach, body = E.body.name, dead = ship.dead, contacts = ship.contacts,
		flags = flags, level = state.level, xp = state.xp, credits = state.credits, mission = (Progress.current(state) or {}).id,
		raceNext = race.next, ms = dbgTimes, xe = dbgPos[1], xn = dbgPos[2], pitchDeg = math.deg(math.asin(math.clamp(V3(0,0,1):applyQuaternion(ship.q):dot(ship.r:clone():normalize()), -1, 1))), ap = C.ap and C.ap.name, apStatus = C.apStatus, ship = design.key }
end
dbg.Parent = player:WaitForChild("PlayerScripts")
startFlight(Designs[1])
hud:setMission(Progress.current(state))
hud:setProgress(state, Progress.xpForLevel(state.level))
if state.flights <= 1 then
	banner("WELCOME TO STARFORGE", "Complete missions to earn XP, level up and unlock new ships", 5)
else
	banner("WELCOME BACK", string.format("Level %d  ·  %d credits", state.level, state.credits), 3)
end
-- daily bonus, bigger for each day in a row (up to a week)
do
	local day = math.floor(os.time() / 86400)
	if state.lastDay ~= day then
		state.streak = if state.lastDay == day - 1 then (state.streak or 0) + 1 else 1
		state.lastDay = day
		local bonus = 100 + 50 * math.min(state.streak - 1, 6)
		state.credits += bonus
		banner("DAILY BONUS", string.format("Day %d in a row  ·  +%d credits — come back tomorrow for more", state.streak, bonus), 4)
		save()
	end
end
openHangar(true)
