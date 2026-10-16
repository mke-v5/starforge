-- Title screen and hangar: pick a ship (3D previews that turn slowly), see what's locked, press FLY.
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local Hangar = {}

local INK = Color3.fromRGB(235, 240, 245)
local DIM = Color3.fromRGB(150, 160, 172)
local AMBER = Color3.fromRGB(255, 179, 71)
local PANEL = Color3.fromRGB(14, 18, 24)
local FONT = Enum.Font.GothamMedium
local FONT_B = Enum.Font.GothamBold

local function make(cls, props, parent)
	local o = Instance.new(cls)
	for k, v in pairs(props) do o[k] = v end
	o.Parent = parent
	return o
end
local function corner(o, r) make("UICorner", { CornerRadius = UDim.new(0, r or 8) }, o) end

-- opts: { designs, current (key), state, unlocked(key) -> bool, needLevel(key) -> n, build(entry) -> Model, size(entry) -> studs,
--         blurb(entry) -> text, onFly(entry), title (bool: show the big logo), scale }
function Hangar.open(gui, opts)
	local old = gui:FindFirstChild("HangarScreen")
	if old then old:Destroy() end
	local root = make("Frame", { Name = "HangarScreen", Size = UDim2.new(1, 0, 1, 0), BackgroundColor3 = Color3.fromRGB(6, 8, 12), BackgroundTransparency = if opts.title then 0 else 0.15, ZIndex = 30 }, gui)
	make("UIGradient", { Rotation = 90, Transparency = NumberSequence.new({ NumberSequenceKeypoint.new(0, 0), NumberSequenceKeypoint.new(1, if opts.title then 0.1 else 0.35) }) }, root)
	local body = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(0, 900, 0, 560), BackgroundTransparency = 1, ZIndex = 31 }, root)
	local sc = make("UIScale", { Scale = 1 }, body)
	local function fit()
		local vp = workspace.CurrentCamera.ViewportSize
		sc.Scale = math.min(vp.X / 940, vp.Y / 600, 1.15)
	end
	fit()
	local fitConn = workspace.CurrentCamera:GetPropertyChangedSignal("ViewportSize"):Connect(fit)
	local y = 0
	if opts.title then
		local logo = make("TextLabel", { Position = UDim2.new(0, 0, 0, 0), Size = UDim2.new(1, 0, 0, 84), BackgroundTransparency = 1, Text = "STARFORGE", TextColor3 = AMBER, Font = Enum.Font.GothamBlack, TextSize = 76, ZIndex = 32 }, body)
		make("UIGradient", { Color = ColorSequence.new(Color3.fromRGB(255, 220, 140), Color3.fromRGB(255, 120, 40)), Rotation = 90 }, logo)
		make("TextLabel", { Position = UDim2.new(0, 0, 0, 80), Size = UDim2.new(1, 0, 0, 26), BackgroundTransparency = 1, Text = "Fly jets and rockets from a real spaceport to orbit and the Moon", TextColor3 = INK, Font = FONT, TextSize = 19, ZIndex = 32 }, body)
		y = 122
	else
		make("TextLabel", { Position = UDim2.new(0, 0, 0, 0), Size = UDim2.new(1, 0, 0, 44), BackgroundTransparency = 1, Text = "HANGAR", TextColor3 = AMBER, Font = Enum.Font.GothamBlack, TextSize = 38, ZIndex = 32 }, body)
		y = 56
	end
	local st = opts.state
	make("TextLabel", { Position = UDim2.new(0, 0, 0, y), Size = UDim2.new(1, 0, 0, 22), BackgroundTransparency = 1, RichText = true,
		Text = string.format('Level <b>%d</b>   ·   <font color="#ffb347">%d credits</font>   ·   Day streak %d', st.level, st.credits, st.streak or 0), TextColor3 = INK, Font = FONT, TextSize = 17, ZIndex = 32 }, body)
	y += 34

	-- ship cards
	local row = make("Frame", { Position = UDim2.new(0, 0, 0, y), Size = UDim2.new(1, 0, 0, 300), BackgroundTransparency = 1, ZIndex = 31 }, body)
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, HorizontalAlignment = Enum.HorizontalAlignment.Center, Padding = UDim.new(0, 14) }, row)
	local selected = opts.current
	local cards = {}
	local spinners = {}
	local function refresh()
		for key, c in pairs(cards) do
			local on = key == selected
			c.stroke.Color = if on then AMBER else Color3.fromRGB(60, 70, 84)
			c.stroke.Thickness = if on then 3 else 1
		end
	end
	local order = table.clone(opts.designs)
	table.sort(order, function(a, b) return opts.needLevel(a.key) < opts.needLevel(b.key) end)
	for i, entry in ipairs(order) do
		local key = entry.key
		local unlocked = opts.unlocked(key)
		local card = make("TextButton", { Size = UDim2.new(0, 205, 1, 0), BackgroundColor3 = Color3.fromRGB(22, 28, 38), AutoButtonColor = unlocked, Text = "", LayoutOrder = i, ZIndex = 32 }, row)
		corner(card, 14)
		local stroke = make("UIStroke", { Thickness = 1, Color = Color3.fromRGB(60, 70, 84), ApplyStrokeMode = Enum.ApplyStrokeMode.Border }, card)
		local vp = make("ViewportFrame", { Position = UDim2.new(0, 6, 0, 6), Size = UDim2.new(1, -12, 0, 170), BackgroundColor3 = Color3.fromRGB(46, 58, 78), BackgroundTransparency = 0,
			Ambient = Color3.fromRGB(205, 205, 215), LightColor = Color3.fromRGB(255, 245, 230), LightDirection = Vector3.new(-1, -1.5, -0.6), ZIndex = 33 }, card)
		corner(vp, 10)
		local model = opts.build(entry)
		model.Parent = vp
		local cam = make("Camera", { FieldOfView = 40 }, vp)
		vp.CurrentCamera = cam
		local sz = opts.size(entry)
		local dist = sz * 1.25 + 3
		cam.CFrame = CFrame.lookAt(Vector3.new(dist * 0.75, dist * 0.42, dist * 0.6), Vector3.zero)
		table.insert(spinners, { model = model, phase = i * 1.3, tilt = if opts.vertical and opts.vertical(entry) then CFrame.Angles(math.pi / 2, 0, 0) else CFrame.identity })
		if not unlocked then vp.ImageColor3 = Color3.fromRGB(70, 70, 80) end
		make("TextLabel", { Position = UDim2.new(0, 10, 0, 180), Size = UDim2.new(1, -20, 0, 24), BackgroundTransparency = 1, Text = entry.design.name, TextColor3 = if unlocked then INK else DIM, Font = FONT_B, TextSize = 19, ZIndex = 33 }, card)
		make("TextLabel", { Position = UDim2.new(0, 10, 0, 206), Size = UDim2.new(1, -20, 0, 54), BackgroundTransparency = 1, Text = opts.blurb(entry), TextColor3 = DIM, Font = FONT, TextSize = 13, TextWrapped = true, TextYAlignment = Enum.TextYAlignment.Top, ZIndex = 33 }, card)
		make("TextLabel", { Position = UDim2.new(0, 10, 1, -32), Size = UDim2.new(1, -20, 0, 24), BackgroundTransparency = 1,
			Text = if unlocked then "Ready" else string.format("🔒 Unlocks at level %d", opts.needLevel(key)), TextColor3 = if unlocked then Color3.fromRGB(110, 230, 150) else Color3.fromRGB(255, 140, 110), Font = FONT_B, TextSize = 14, ZIndex = 33 }, card)
		cards[key] = { stroke = stroke }
		card.Activated:Connect(function()
			if not unlocked then return end
			selected = key
			refresh()
		end)
	end
	refresh()
	y += 316

	local fly = make("TextButton", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, y), Size = UDim2.new(0, 280, 0, 60), BackgroundColor3 = AMBER, Text = "FLY  ▶", TextColor3 = Color3.fromRGB(20, 16, 10), Font = Enum.Font.GothamBlack, TextSize = 28, ZIndex = 32 }, body)
	corner(fly, 14)
	local pulse = make("UIScale", { Scale = 1 }, fly)
	TweenService:Create(pulse, TweenInfo.new(0.8, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true), { Scale = 1.06 }):Play()

	local conn
	conn = RunService.RenderStepped:Connect(function()
		local t = os.clock()
		for _, s in ipairs(spinners) do s.model:PivotTo(CFrame.Angles(0, t * 0.5 + s.phase, 0) * s.tilt) end
	end)
	local function close()
		if conn then conn:Disconnect(); conn = nil end
		fitConn:Disconnect()
		root:Destroy()
	end
	fly.Activated:Connect(function()
		for _, e in ipairs(opts.designs) do if e.key == selected then close(); opts.onFly(e); return end end
	end)
	if not opts.title then
		local x = make("TextButton", { AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, 0, 0, 0), Size = UDim2.new(0, 44, 0, 40), BackgroundColor3 = Color3.fromRGB(60, 30, 30), Text = "✕", TextColor3 = INK, Font = FONT_B, TextSize = 20, ZIndex = 33 }, body)
		corner(x, 10)
		x.Activated:Connect(close)
	end
	return root, close
end

return Hangar
