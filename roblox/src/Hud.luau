-- On-screen flight display and touch controls for the Roblox prototype.
local Geo = require(script.Parent.Geo)

local Hud = {}
Hud.__index = Hud

local FONT = Enum.Font.GothamMedium
local FONT_B = Enum.Font.GothamBold
local INK = Color3.fromRGB(235, 240, 245)
local DIM = Color3.fromRGB(150, 160, 172)
local AMBER = Color3.fromRGB(255, 179, 71)
local PANEL = Color3.fromRGB(14, 18, 24)

local function make(cls, props, parent)
	local o = Instance.new(cls)
	for k, v in pairs(props) do o[k] = v end
	o.Parent = parent
	return o
end
local function corner(o, r) make("UICorner", { CornerRadius = UDim.new(0, r or 8) }, o) end

local function button(parent, text, cb, order)
	local b = make("TextButton", {
		Size = UDim2.new(1, 0, 0, 34), BackgroundColor3 = PANEL, BackgroundTransparency = 0.25, AutoButtonColor = true,
		Text = text, TextColor3 = INK, Font = FONT, TextSize = 15, LayoutOrder = order or 0,
	}, parent)
	corner(b, 8)
	b.Activated:Connect(cb)
	return b
end

function Hud.new(player, cb)
	local self = setmetatable({}, Hud)
	self.stickX, self.stickY = 0, 0
	self._cb = cb
	local gui = make("ScreenGui", { Name = "StarforgeHud", ResetOnSpawn = false, IgnoreGuiInset = false, ZIndexBehavior = Enum.ZIndexBehavior.Sibling }, player:WaitForChild("PlayerGui"))
	self.gui = gui
	-- flight data, top left
	local info = make("Frame", { Position = UDim2.new(0, 12, 0, 12), Size = UDim2.new(0, 270, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = PANEL, BackgroundTransparency = 0.3 }, gui)
	corner(info, 10)
	make("UIPadding", { PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 12), PaddingTop = UDim.new(0, 10), PaddingBottom = UDim.new(0, 10) }, info)
	make("UIListLayout", { Padding = UDim.new(0, 2), SortOrder = Enum.SortOrder.LayoutOrder }, info)
	self.title = make("TextLabel", { Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1, Text = "STARFORGE", TextColor3 = AMBER, Font = FONT_B, TextSize = 15, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 0 }, info)
	self.lines = {}
	for i = 1, 7 do
		self.lines[i] = make("TextLabel", { Size = UDim2.new(1, 0, 0, 19), BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT, TextSize = 15, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = i, RichText = true }, info)
	end
	-- buttons, right
	local side = make("Frame", { AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -12, 0, 12), Size = UDim2.new(0, 170, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundTransparency = 1 }, gui)
	make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }, side)
	button(side, "🛒 Shop", function() if cb.onShop then cb.onShop() end end, -2).BackgroundColor3 = Color3.fromRGB(70, 52, 24)
	button(side, "🏆 Top pilots", function() if cb.onTop then cb.onTop() end end, -1)
	self.shipBtn = button(side, "Ship: " .. cb.ships[1].design.name, function() cb.onNextShip() end, 1)
	-- the main autopilot button offers the next sensible step (climb to orbit, go to the Moon, fly home…)
	self.autoKind = "orbit"
	self.autoBtn = button(side, "Auto: climb to orbit", function() cb.onAuto(self.autoKind) end, 2)
	self.autoBtn.BackgroundColor3 = Color3.fromRGB(28, 52, 40)
	button(side, "Auto: land", function() cb.onAuto("land") end, 3)
	button(side, "Autopilot off", function() cb.onAuto("off") end, 4)
	local sasRow = make("Frame", { Size = UDim2.new(1, 0, 0, 34), BackgroundTransparency = 1, LayoutOrder = 5 }, side)
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 4) }, sasRow)
	for _, m in ipairs({ { "Hold", "hold" }, { "Pro", "prograde" }, { "Retro", "retrograde" } }) do
		local b = button(sasRow, m[1], function() cb.onSas(m[2]) end)
		b.Size = UDim2.new(1 / 3, -3, 1, 0)
	end
	local warpRow = make("Frame", { Size = UDim2.new(1, 0, 0, 34), BackgroundTransparency = 1, LayoutOrder = 6 }, side)
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 4) }, warpRow)
	local keyRow = make("Frame", { Size = UDim2.new(1, 0, 0, 34), BackgroundTransparency = 1, LayoutOrder = 7 }, side)
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 4) }, keyRow)
	for _, m in ipairs({ { "Gear", "gear" }, { "Brake", "brake" }, { "Retry", "restart" } }) do
		local b = button(keyRow, m[1], function() if cb.onKey then cb.onKey(m[2]) end end)
		b.Size = UDim2.new(1 / 3, -3, 1, 0)
	end
	local wd = button(warpRow, "◀ warp", function() cb.onWarp(-1) end); wd.Size = UDim2.new(0.5, -2, 1, 0)
	local wu = button(warpRow, "warp ▶", function() cb.onWarp(1) end); wu.Size = UDim2.new(0.5, -2, 1, 0)
	-- throttle slider, bottom right
	local thrFrame = make("Frame", { AnchorPoint = Vector2.new(1, 1), Position = UDim2.new(1, -24, 1, -24), Size = UDim2.new(0, 56, 0, 220), BackgroundColor3 = PANEL, BackgroundTransparency = 0.3 }, gui)
	corner(thrFrame, 12)
	self.thrFill = make("Frame", { AnchorPoint = Vector2.new(0, 1), Position = UDim2.new(0, 0, 1, 0), Size = UDim2.new(1, 0, 0, 0), BackgroundColor3 = AMBER, BackgroundTransparency = 0.1 }, thrFrame)
	corner(self.thrFill, 12)
	self.thrText = make("TextLabel", { Size = UDim2.new(1, 0, 0, 20), Position = UDim2.new(0, 0, 0, -24), BackgroundTransparency = 1, Text = "0%", TextColor3 = INK, Font = FONT_B, TextSize = 14 }, thrFrame)
	local UIS = game:GetService("UserInputService")
	local thrDrag = false
	local function setThr(y)
		local f = 1 - math.clamp((y - thrFrame.AbsolutePosition.Y) / thrFrame.AbsoluteSize.Y, 0, 1)
		cb.onThrottle(f)
	end
	thrFrame.InputBegan:Connect(function(io)
		if io.UserInputType == Enum.UserInputType.MouseButton1 or io.UserInputType == Enum.UserInputType.Touch then thrDrag = true; setThr(io.Position.Y) end
	end)
	UIS.InputChanged:Connect(function(io)
		if thrDrag and (io.UserInputType == Enum.UserInputType.MouseMovement or io.UserInputType == Enum.UserInputType.Touch) then setThr(io.Position.Y) end
	end)
	UIS.InputEnded:Connect(function(io)
		if io.UserInputType == Enum.UserInputType.MouseButton1 or io.UserInputType == Enum.UserInputType.Touch then thrDrag = false end
	end)
	-- touch stick, bottom left (phones and tablets)
	local pad = make("Frame", { AnchorPoint = Vector2.new(0, 1), Position = UDim2.new(0, 24, 1, -24), Size = UDim2.new(0, 160, 0, 160), BackgroundColor3 = PANEL, BackgroundTransparency = 0.5, Visible = UIS.TouchEnabled }, gui)
	corner(pad, 80)
	local knob = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(0, 60, 0, 60), BackgroundColor3 = INK, BackgroundTransparency = 0.4 }, pad)
	corner(knob, 30)
	local stickTouch = nil
	pad.InputBegan:Connect(function(io) if io.UserInputType == Enum.UserInputType.Touch then stickTouch = io end end)
	UIS.TouchMoved:Connect(function(io)
		if io ~= stickTouch then return end
		local c = pad.AbsolutePosition + pad.AbsoluteSize / 2
		local d = (Vector2.new(io.Position.X, io.Position.Y) - c) / 70
		if d.Magnitude > 1 then d = d.Unit end
		self.stickX, self.stickY = d.X, d.Y
		knob.Position = UDim2.new(0.5, d.X * 50, 0.5, d.Y * 50)
	end)
	UIS.TouchEnded:Connect(function(io)
		if io ~= stickTouch then return end
		stickTouch = nil; self.stickX, self.stickY = 0, 0
		knob.Position = UDim2.new(0.5, 0, 0.5, 0)
	end)
	-- mission card, top centre
	local card = make("Frame", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 8), Size = UDim2.new(0, 420, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = PANEL, BackgroundTransparency = 0.2 }, gui)
	corner(card, 12)
	make("UIStroke", { Color = AMBER, Thickness = 1.5, Transparency = 0.3 }, card)
	make("UIPadding", { PaddingLeft = UDim.new(0, 14), PaddingRight = UDim.new(0, 14), PaddingTop = UDim.new(0, 8), PaddingBottom = UDim.new(0, 10) }, card)
	make("UIListLayout", { Padding = UDim.new(0, 2), SortOrder = Enum.SortOrder.LayoutOrder, HorizontalAlignment = Enum.HorizontalAlignment.Center }, card)
	self.cardTitle = make("TextLabel", { Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, Text = "", TextColor3 = AMBER, Font = FONT_B, TextSize = 18, LayoutOrder = 1, TextWrapped = true }, card)
	self.cardHint = make("TextLabel", { Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT, TextSize = 14, LayoutOrder = 2, TextWrapped = true }, card)
	self.cardReward = make("TextLabel", { Size = UDim2.new(1, 0, 0, 18), BackgroundTransparency = 1, Text = "", TextColor3 = DIM, Font = FONT, TextSize = 13, LayoutOrder = 3 }, card)
	self.dailyText = make("TextLabel", { Size = UDim2.new(1, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT, TextSize = 13, LayoutOrder = 4, TextWrapped = true, RichText = true }, card)
	self.card = card
	-- level, xp and credits under the title
	self.levelText = make("TextLabel", { Size = UDim2.new(1, 0, 0, 18), BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT_B, TextSize = 14, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 0, RichText = true }, info)
	local xpBar = make("Frame", { Size = UDim2.new(1, 0, 0, 6), BackgroundColor3 = Color3.fromRGB(40, 46, 56), LayoutOrder = 0 }, info)
	corner(xpBar, 3)
	self.xpFill = make("Frame", { Size = UDim2.new(0, 0, 1, 0), BackgroundColor3 = AMBER }, xpBar)
	corner(self.xpFill, 3)
	self.title.LayoutOrder = -1
	-- race timer
	self.race = make("TextLabel", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 120), Size = UDim2.new(0, 260, 0, 34), BackgroundColor3 = PANEL, BackgroundTransparency = 0.25, Text = "", TextColor3 = Color3.fromRGB(120, 255, 170), Font = FONT_B, TextSize = 20, Visible = false }, gui)
	corner(self.race, 8)
	-- big banner for achievements
	self.banner = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.38, 0), Size = UDim2.new(0, 460, 0, 110), BackgroundColor3 = PANEL, BackgroundTransparency = 0.1, Visible = false }, gui)
	corner(self.banner, 16)
	make("UIStroke", { Color = AMBER, Thickness = 3 }, self.banner)
	self.bannerTitle = make("TextLabel", { Position = UDim2.new(0, 0, 0, 14), Size = UDim2.new(1, 0, 0, 40), BackgroundTransparency = 1, Text = "", TextColor3 = AMBER, Font = FONT_B, TextSize = 32 }, self.banner)
	self.bannerSub = make("TextLabel", { Position = UDim2.new(0, 10, 0, 58), Size = UDim2.new(1, -20, 0, 40), BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT, TextSize = 17, TextWrapped = true }, self.banner)
	self.bannerScale = make("UIScale", { Scale = 1 }, self.banner)
	-- messages
	self.msg = make("TextLabel", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 160), Size = UDim2.new(0, 560, 0, 28), BackgroundColor3 = PANEL, BackgroundTransparency = 0.3, Text = "", TextColor3 = INK, Font = FONT, TextSize = 15, Visible = false, TextWrapped = true }, gui)
	corner(self.msg, 8)
	-- controls help
	make("TextLabel", { AnchorPoint = Vector2.new(0.5, 1), Position = UDim2.new(0.5, 0, 1, -8), Size = UDim2.new(0, 700, 0, 18), BackgroundTransparency = 1, TextColor3 = DIM, Font = FONT, TextSize = 13,
		Text = "Shift/Ctrl throttle · Z full · X cut · W/S pitch · A/D roll · Q/E yaw · G gear · B brakes · , . warp · R restart · right-drag camera · wheel zoom", Visible = not UIS.TouchEnabled }, gui)
	-- shrink everything on small screens (phones). UIScale shrinks about an object's centre, which would
	-- slide corner-anchored panels off the screen, so the whole HUD lives in one full-screen frame that is
	-- made 1/scale times larger and then scaled down: every panel keeps its corner.
	self.uiScale = 1
	local root = make("Frame", { Name = "HudRoot", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(1, 0, 1, 0), BackgroundTransparency = 1 }, gui)
	local rootScale = make("UIScale", { Scale = 1 }, root)
	for _, c in ipairs(gui:GetChildren()) do
		if c:IsA("GuiObject") and c ~= root then c.Parent = root end
	end
	local function rescale()
		-- (the area below Roblox's top bar, so the panels never sit under its menu buttons)
		local vp = gui.AbsoluteSize
		if vp.X < 10 then vp = workspace.CurrentCamera.ViewportSize end
		local sc = math.clamp(math.min(vp.X / 1300, vp.Y / 700), if UIS.TouchEnabled then 0.5 else 0.4, 1)
		self.uiScale = sc
		root.Size = UDim2.new(1 / sc, 0, 1 / sc, 0)
		rootScale.Scale = sc
	end
	rescale()
	gui:GetPropertyChangedSignal("AbsoluteSize"):Connect(rescale)
	return self
end

local function dist(m) return Geo.fmtDist(m) end

function Hud:setShip(text) self.shipBtn.Text = text end

function Hud:setAuto(kind, label)
	if self.autoKind == kind then return end
	self.autoKind = kind
	self.autoBtn.Text = label
end

function Hud:setMission(m, extra)
	if not m then
		self.cardTitle.Text = "All missions complete!"
		self.cardHint.Text = extra or "Race the rings for a better time, or explore the Moon."
		self.cardReward.Text = ""
		return
	end
	self.cardTitle.Text = "MISSION · " .. m.title
	self.cardHint.Text = m.hint
	self.cardReward.Text = string.format("Reward  %d XP  ·  %d credits", m.xp, m.credits)
end

-- big animated announcement
function Hud:showBanner(title, sub, secs)
	self.banner.Visible = true
	self.bannerTitle.Text = title
	self.bannerSub.Text = sub or ""
	self.bannerScale.Scale = 0.6
	game:GetService("TweenService"):Create(self.bannerScale, TweenInfo.new(0.35, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale = 1 }):Play()
	self.bannerUntil = os.clock() + (secs or 3.5)
end

function Hud:setProgress(state, xpNeed, crystals, crystalTotal)
	self.levelText.Text = string.format('Level %d  ·  <font color="#ffb347">%d credits</font>%s', state.level, state.credits,
		if crystals then string.format('  ·  <font color="#ffd23c">◆ %d/%d</font>', crystals, crystalTotal) else "")
	self.xpFill.Size = UDim2.new(math.clamp(state.xp / xpNeed, 0, 1), 0, 1, 0)
end

-- leaderboard panel: list of { name, t }
function Hud:showTop(list, mine)
	local old = self.gui:FindFirstChild("TopPanel")
	if old then old:Destroy() return end
	local p = make("Frame", { Name = "TopPanel", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(0, 360, 0, 0), AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = PANEL, BackgroundTransparency = 0.05, ZIndex = 20 }, self.gui)
	corner(p, 14)
	make("UIStroke", { Color = AMBER, Thickness = 2 }, p)
	make("UIScale", { Scale = self.uiScale or 1 }, p)
	make("UIPadding", { PaddingLeft = UDim.new(0, 18), PaddingRight = UDim.new(0, 18), PaddingTop = UDim.new(0, 14), PaddingBottom = UDim.new(0, 16) }, p)
	make("UIListLayout", { Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder }, p)
	make("TextLabel", { Size = UDim2.new(1, 0, 0, 30), BackgroundTransparency = 1, Text = "🏆 FASTEST RING RACE", TextColor3 = AMBER, Font = FONT_B, TextSize = 20, LayoutOrder = 0, ZIndex = 21 }, p)
	if #list == 0 then
		make("TextLabel", { Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, Text = "No times yet — be the first!", TextColor3 = DIM, Font = FONT, TextSize = 15, LayoutOrder = 1, ZIndex = 21 }, p)
	end
	for i, e in ipairs(list) do
		local medal = if i == 1 then "🥇" elseif i == 2 then "🥈" elseif i == 3 then "🥉" else tostring(i) .. "."
		make("TextLabel", { Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, RichText = true, LayoutOrder = i, ZIndex = 21, TextXAlignment = Enum.TextXAlignment.Left,
			Text = string.format("%s  %s  <font color=\"#9dffb0\">%d:%05.2f</font>", medal, e.name, math.floor(e.t / 60), e.t % 60), TextColor3 = INK, Font = FONT, TextSize = 16 }, p)
	end
	make("TextLabel", { Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, LayoutOrder = 99, ZIndex = 21,
		Text = if mine then string.format("Your best: %d:%05.2f", math.floor(mine / 60), mine % 60) else "Fly the glowing rings over the spaceport to set a time", TextColor3 = DIM, Font = FONT, TextSize = 14, TextWrapped = true }, p)
	local close = make("TextButton", { Size = UDim2.new(1, 0, 0, 32), BackgroundColor3 = Color3.fromRGB(36, 42, 54), Text = "Close", TextColor3 = INK, Font = FONT_B, TextSize = 15, LayoutOrder = 100, ZIndex = 21 }, p)
	corner(close, 8)
	close.Activated:Connect(function() p:Destroy() end)
end

function Hud:setDaily(text) if self.dailyText.Text ~= text then self.dailyText.Text = text end end

function Hud:setRace(text)
	self.race.Visible = text ~= nil
	if text then self.race.Text = text end
end

function Hud:update(ship, C, craft, warpWant, warpNow, messages)
	local E = ship.env
	local L = self.lines
	-- low down: speed over the ground; in space: orbital speed around the body
	local spd = E.vSurf
	if E.h > 60000 or E.body ~= Geo.EARTH then spd = require(script.Parent.Orbit).relState(ship, E.body).v:length() end
	L[1].Text = string.format("<b>%s</b>  ·  %s", Geo.fmtSpeed(spd), if E.mach > 0.3 and E.rho > 1e-5 then string.format("Mach %.2f", E.mach) else E.body.name)
	L[2].Text = string.format("Altitude <b>%s</b>  ·  above ground %s", dist(E.h), dist(E.agl))
	L[3].Text = string.format("Climb %+d m/s  ·  g %.1f", math.round(E.vVert), ship.gForce)
	local rs = require(script.Parent.Orbit).relState(ship, E.body)
	local el = require(script.Parent.Orbit).elements(rs.r, rs.v, rs.mu)
	if E.h > 30000 or E.body ~= Geo.EARTH then
		L[4].Text = string.format("Ap %s  ·  Pe %s", if Geo.isFinite(el.ap) then dist(el.ap - E.body.R) else "escape", if el.pe < E.body.R then "below ground" else dist(el.pe - E.body.R))
	else
		L[4].Text = string.format("Hull heat %d%%", math.round((craft.heatFrac or 0) * 100))
	end
	local fuel = {}
	for _, k in ipairs({ "LF", "OX", "FU" }) do
		local cap = craft:capacity(k)
		if cap > 0 then table.insert(fuel, string.format("%s %d%%", if k == "LF" then "Fuel" elseif k == "OX" then "Oxidizer" else "Fusion", math.round(craft:amount(k) / cap * 100))) end
	end
	L[5].Text = table.concat(fuel, "  ·  ")
	L[6].Text = if C.ap then string.format('<font color="#ffb347">%s</font>%s', C.ap.name, if C.apStatus ~= "" then " · " .. C.apStatus else "") else ("SAS " .. C.sas)
	L[7].Text = string.format("Time warp %s%s", if warpNow > 1 then tostring(warpNow) .. "×" else "1×", if ship.parked then "  ·  parked" else "")
	local thr = ship.ctl.throttle
	self.thrFill.Size = UDim2.new(1, 0, thr, 0)
	self.thrText.Text = string.format("%d%%", math.round(thr * 100))
	-- latest message for 5 s
	local last = messages[#messages]
	if last and os.clock() - last.t < 5 then self.msg.Visible = true; self.msg.Text = last.text else self.msg.Visible = false end
	if self.bannerUntil and os.clock() > self.bannerUntil then self.banner.Visible = false; self.bannerUntil = nil end
end

return Hud
