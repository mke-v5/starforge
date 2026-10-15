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
	local gui = make("ScreenGui", { Name = "StarforgeHud", ResetOnSpawn = false, IgnoreGuiInset = true, ZIndexBehavior = Enum.ZIndexBehavior.Sibling }, player:WaitForChild("PlayerGui"))
	self.gui = gui
	-- flight data, top left
	local info = make("Frame", { Position = UDim2.new(0, 12, 0, 52), Size = UDim2.new(0, 270, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = PANEL, BackgroundTransparency = 0.3 }, gui)
	corner(info, 10)
	make("UIPadding", { PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 12), PaddingTop = UDim.new(0, 10), PaddingBottom = UDim.new(0, 10) }, info)
	make("UIListLayout", { Padding = UDim.new(0, 2), SortOrder = Enum.SortOrder.LayoutOrder }, info)
	self.title = make("TextLabel", { Size = UDim2.new(1, 0, 0, 20), BackgroundTransparency = 1, Text = "STARFORGE", TextColor3 = AMBER, Font = FONT_B, TextSize = 15, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 0 }, info)
	self.lines = {}
	for i = 1, 7 do
		self.lines[i] = make("TextLabel", { Size = UDim2.new(1, 0, 0, 19), BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT, TextSize = 15, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = i, RichText = true }, info)
	end
	-- buttons, right
	local side = make("Frame", { AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -12, 0, 52), Size = UDim2.new(0, 170, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundTransparency = 1 }, gui)
	make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }, side)
	local shipIdx = 1
	self.shipBtn = button(side, "Ship: " .. cb.ships[1].design.name, function()
		shipIdx = shipIdx % #cb.ships + 1
		self.shipBtn.Text = "Ship: " .. cb.ships[shipIdx].design.name
		cb.onShip(cb.ships[shipIdx])
	end, 1)
	button(side, "Auto: climb to orbit", function() cb.onAuto("orbit") end, 2)
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
	-- messages, top centre
	self.msg = make("TextLabel", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 52), Size = UDim2.new(0, 560, 0, 28), BackgroundColor3 = PANEL, BackgroundTransparency = 0.3, Text = "", TextColor3 = INK, Font = FONT, TextSize = 15, Visible = false, TextWrapped = true }, gui)
	corner(self.msg, 8)
	-- controls help
	make("TextLabel", { AnchorPoint = Vector2.new(0.5, 1), Position = UDim2.new(0.5, 0, 1, -8), Size = UDim2.new(0, 700, 0, 18), BackgroundTransparency = 1, TextColor3 = DIM, Font = FONT, TextSize = 13,
		Text = "Shift/Ctrl throttle · Z full · X cut · W/S pitch · A/D roll · Q/E yaw · G gear · B brakes · , . warp · R restart · right-drag camera · wheel zoom", Visible = not UIS.TouchEnabled }, gui)
	return self
end

local function dist(m) return Geo.fmtDist(m) end

function Hud:update(ship, C, craft, warpWant, warpNow, messages)
	local E = ship.env
	local L = self.lines
	L[1].Text = string.format("<b>%s</b>  ·  %s", Geo.fmtSpeed(E.vSurf), if E.mach > 0.3 and E.rho > 1e-5 then string.format("Mach %.2f", E.mach) else E.body.name)
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
end

return Hud
