-- Starforge server: saves each player's progress (missions, level, credits, best race) and shows their
-- level and best race time on the player list.
local Players = game:GetService("Players")
local RS = game:GetService("ReplicatedStorage")
local DataStoreService = game:GetService("DataStoreService")

local remotes = RS:FindFirstChild("StarforgeRemotes") or Instance.new("Folder")
remotes.Name = "StarforgeRemotes"
local Load = remotes:FindFirstChild("Load") or Instance.new("RemoteFunction")
Load.Name = "Load"; Load.Parent = remotes
local Save = remotes:FindFirstChild("Save") or Instance.new("RemoteEvent")
Save.Name = "Save"; Save.Parent = remotes
local Pose = remotes:FindFirstChild("Pose") or Instance.new("UnreliableRemoteEvent")
Pose.Name = "Pose"; Pose.Parent = remotes
local Left = remotes:FindFirstChild("Left") or Instance.new("RemoteEvent")
Left.Name = "Left"; Left.Parent = remotes
remotes.Parent = RS

-- relay ship poses to everyone else (light checks so a bad client can't send junk)
local function num3(t, n)
	if type(t) ~= "table" then return false end
	for i = 1, n do if type(t[i]) ~= "number" or t[i] ~= t[i] or math.abs(t[i]) > 1e10 then return false end end
	return true
end
Pose.OnServerEvent:Connect(function(player, pose)
	if type(pose) ~= "table" or type(pose.k) ~= "string" or #pose.k > 24 then return end
	if not (num3(pose.p, 3) and num3(pose.v, 3) and num3(pose.q, 4)) then return end
	local clean = { k = pose.k, p = pose.p, v = pose.v, q = pose.q, f = math.clamp(tonumber(pose.f) or 0, 0, 2), d = pose.d == true }
	for _, other in ipairs(Players:GetPlayers()) do
		if other ~= player then Pose:FireClient(other, player.UserId, clean) end
	end
end)

local store
pcall(function() store = DataStoreService:GetDataStore("StarforgeV1") end)

local cache = {}     -- userId -> state
local loaded = {}

local function clean(s)
	-- only keep plain fields of the right types and sane ranges
	if type(s) ~= "table" then return nil end
	local out = { done = {} }
	out.xp = math.clamp(tonumber(s.xp) or 0, 0, 1e7)
	out.level = math.clamp(math.floor(tonumber(s.level) or 1), 1, 1000)
	out.credits = math.clamp(math.floor(tonumber(s.credits) or 0), 0, 1e9)
	out.flights = math.clamp(math.floor(tonumber(s.flights) or 0), 0, 1e7)
	local br = tonumber(s.bestRace)
	if br and br > 20 and br < 36000 then out.bestRace = br end
	if type(s.done) == "table" then
		for k, v in pairs(s.done) do if type(k) == "string" and #k < 32 and v == true then out.done[k] = true end end
	end
	return out
end

local function stats(player, s)
	local ls = player:FindFirstChild("leaderstats")
	if not ls then
		ls = Instance.new("Folder"); ls.Name = "leaderstats"; ls.Parent = player
		local lv = Instance.new("IntValue"); lv.Name = "Level"; lv.Parent = ls
		local rc = Instance.new("StringValue"); rc.Name = "Best race"; rc.Parent = ls
	end
	ls.Level.Value = s.level
	ls["Best race"].Value = if s.bestRace then string.format("%d:%05.2f", math.floor(s.bestRace / 60), s.bestRace % 60) else "—"
end

local function loadPlayer(player)
	local s
	if store then
		local ok, data = pcall(function() return store:GetAsync("u" .. player.UserId) end)
		if ok then s = clean(data) else warn("[Starforge] load failed: " .. tostring(data)) end
	end
	s = s or { xp = 0, level = 1, credits = 0, done = {}, flights = 0 }
	cache[player.UserId] = s
	loaded[player.UserId] = true
	stats(player, s)
	return s
end

local function savePlayer(player)
	local s = cache[player.UserId]
	if not s or not store then return end
	local ok, err = pcall(function() store:SetAsync("u" .. player.UserId, s) end)
	if not ok then warn("[Starforge] save failed: " .. tostring(err)) end
end

Load.OnServerInvoke = function(player)
	while not loaded[player.UserId] do task.wait(0.1) end
	return cache[player.UserId]
end

local lastWrite = {}
Save.OnServerEvent:Connect(function(player, s)
	s = clean(s)
	if not s then return end
	cache[player.UserId] = s
	stats(player, s)
	-- write at most every 30 s per player; the rest goes out when they leave
	local now = os.clock()
	if not lastWrite[player.UserId] or now - lastWrite[player.UserId] > 30 then
		lastWrite[player.UserId] = now
		task.spawn(savePlayer, player)
	end
end)

Players.PlayerAdded:Connect(loadPlayer)
for _, p in ipairs(Players:GetPlayers()) do task.spawn(loadPlayer, p) end
Players.PlayerRemoving:Connect(function(p)
	Left:FireAllClients(p.UserId)
	savePlayer(p)
	cache[p.UserId] = nil; loaded[p.UserId] = nil; lastWrite[p.UserId] = nil
end)
game:BindToClose(function()
	for _, p in ipairs(Players:GetPlayers()) do savePlayer(p) end
end)
