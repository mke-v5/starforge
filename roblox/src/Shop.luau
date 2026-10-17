-- Hangar shop: spend credits on paint jobs, engine trails and engine tuning. The catalog is plain data;
-- the panel is built on demand and calls back into the client to buy and equip.
local Shop = {}

Shop.PAINT = {
	{ id = "paint_factory", name = "Factory", price = 0, hull = nil, accent = nil },
	{ id = "paint_midnight", name = "Midnight", price = 250, hull = "#1d2330", accent = "#7fd4ff" },
	{ id = "paint_racing", name = "Racing Red", price = 300, hull = "#c4232b", accent = "#f4f4f4" },
	{ id = "paint_arctic", name = "Arctic", price = 300, hull = "#f4f7fa", accent = "#2f80ff" },
	{ id = "paint_lime", name = "Neon Lime", price = 700, hull = "#2b2f33", accent = "#9dff3c" },
	{ id = "paint_sunset", name = "Sunset", price = 900, hull = "#ff7a3d", accent = "#7a2bff" },
	{ id = "paint_stealth", name = "Stealth", price = 1500, hull = "#121416", accent = "#3a3f45" },
	{ id = "paint_gold", name = "Solid Gold", price = 4000, hull = "#d4a72c", accent = "#fff1b8" },
}

Shop.TRAIL = {
	{ id = "trail_none", name = "None", price = 0, color = nil },
	{ id = "trail_smoke", name = "Smoke", price = 150, color = "#e8ecf0", width = 1.6, neon = false },
	{ id = "trail_cyan", name = "Neon Cyan", price = 600, color = "#38e8ff", width = 1.0, neon = true },
	{ id = "trail_fire", name = "Afterburner", price = 1200, color = "#ff8a2a", width = 1.3, neon = true },
	{ id = "trail_violet", name = "Plasma", price = 2000, color = "#b06bff", width = 1.1, neon = true },
	{ id = "trail_rainbow", name = "Rainbow", price = 5000, color = "rainbow", width = 1.2, neon = true },
}

-- engine tuning: thrust multiplier per level
Shop.TUNE = {
	{ level = 1, name = "Engine tune I", price = 500, mult = 1.08 },
	{ level = 2, name = "Engine tune II", price = 1500, mult = 1.16 },
	{ level = 3, name = "Engine tune III", price = 4000, mult = 1.25 },
}

-- Robux store (ids live on the server; `attr` is the player attribute a pass sets, prices match the Creator Hub)
Shop.PASSES = {
	{ attr = "SHIPS", name = "Ship Pass", sub = "Every ship, right now", robux = 349, c1 = "#1b3a7a", c2 = "#5fa8ff" },
	{ attr = "VIP", name = "VIP Pilot", sub = "2× credits forever", robux = 199, c1 = "#ffcd3c", c2 = "#ff7828" },
	{ attr = "STYLE", name = "Style Pack", sub = "All paints + trails", robux = 149, c1 = "#5a1a78", c2 = "#e070ff" },
}
Shop.PACKS = {
	{ credits = 1000, label = "1,000", sub = "Small pack", robux = 49 },
	{ credits = 5000, label = "5,000", sub = "+20% value", robux = 199 },
	{ credits = 15000, label = "15,000", sub = "Best value", robux = 449 },
}

function Shop.find(id)
	for _, list in ipairs({ Shop.PAINT, Shop.TRAIL }) do
		for _, it in ipairs(list) do if it.id == id then return it end end
	end
	return nil
end

function Shop.thrustMult(state)
	local m = 1
	for _, t in ipairs(Shop.TUNE) do if (state.tune or 0) >= t.level then m = t.mult end end
	return m
end

function Shop.hex(c)
	c = c:gsub("#", "")
	return Color3.fromRGB(tonumber(c:sub(1, 2), 16), tonumber(c:sub(3, 4), 16), tonumber(c:sub(5, 6), 16))
end

local INK = Color3.fromRGB(235, 240, 245)
local DIM = Color3.fromRGB(150, 160, 172)
local AMBER = Color3.fromRGB(255, 179, 71)
local PANEL = Color3.fromRGB(14, 18, 24)
local GREEN = Color3.fromRGB(90, 230, 140)
local FONT = Enum.Font.GothamMedium
local FONT_B = Enum.Font.GothamBold

local function make(cls, props, parent)
	local o = Instance.new(cls)
	for k, v in pairs(props) do o[k] = v end
	o.Parent = parent
	return o
end
local function corner(o, r) make("UICorner", { CornerRadius = UDim.new(0, r or 8) }, o) end

-- cb: { state = fn() -> state, buy = fn(kind, item) -> ok, msg, equip = fn(kind, item) }
function Shop.open(gui, cb, scale)
	local old = gui:FindFirstChild("ShopPanel")
	if old then old:Destroy() return end
	local panel = make("Frame", { Name = "ShopPanel", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, 0), Size = UDim2.new(0, 620, 0, 440),
		BackgroundColor3 = PANEL, BackgroundTransparency = 0.05, ZIndex = 20 }, gui)
	corner(panel, 16)
	make("UIStroke", { Color = AMBER, Thickness = 2 }, panel)
	make("UIScale", { Scale = scale or 1 }, panel)
	local title = make("TextLabel", { Position = UDim2.new(0, 20, 0, 12), Size = UDim2.new(1, -120, 0, 30), BackgroundTransparency = 1, Text = "HANGAR SHOP", TextColor3 = AMBER, Font = FONT_B, TextSize = 24, TextXAlignment = Enum.TextXAlignment.Left, ZIndex = 21 }, panel)
	local credits = make("TextLabel", { Position = UDim2.new(0, 220, 0, 14), Size = UDim2.new(0, 300, 0, 28), BackgroundTransparency = 1, Text = "", TextColor3 = INK, Font = FONT_B, TextSize = 17, TextXAlignment = Enum.TextXAlignment.Left, ZIndex = 21 }, panel)
	local close = make("TextButton", { AnchorPoint = Vector2.new(1, 0), Position = UDim2.new(1, -12, 0, 12), Size = UDim2.new(0, 36, 0, 32), BackgroundColor3 = Color3.fromRGB(60, 30, 30), Text = "✕", TextColor3 = INK, Font = FONT_B, TextSize = 18, ZIndex = 21 }, panel)
	corner(close, 8)
	close.Activated:Connect(function() panel:Destroy() end)
	local note = make("TextLabel", { Position = UDim2.new(0, 20, 1, -32), Size = UDim2.new(1, -40, 0, 22), BackgroundTransparency = 1, Text = "Earn credits by finishing missions, racing the rings and flying every day.", TextColor3 = DIM, Font = FONT, TextSize = 13, ZIndex = 21 }, panel)
	-- tabs
	local tabs = make("Frame", { Position = UDim2.new(0, 20, 0, 52), Size = UDim2.new(1, -40, 0, 32), BackgroundTransparency = 1, ZIndex = 21 }, panel)
	make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 8) }, tabs)
	local grid = make("ScrollingFrame", { Position = UDim2.new(0, 20, 0, 94), Size = UDim2.new(1, -40, 1, -134), BackgroundTransparency = 1, ScrollBarThickness = 6, CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y, ZIndex = 21 }, panel)
	make("UIGridLayout", { CellSize = UDim2.new(0, 132, 0, 128), CellPadding = UDim2.new(0, 10, 0, 10), SortOrder = Enum.SortOrder.LayoutOrder }, grid)

	local current = "paint"
	local render
	local function card(order, swatch, name, sub, btnText, btnColor, onClick)
		local c = make("Frame", { BackgroundColor3 = Color3.fromRGB(28, 34, 44), LayoutOrder = order, ZIndex = 22 }, grid)
		corner(c, 10)
		local sw = make("Frame", { Position = UDim2.new(0.5, -40, 0, 10), Size = UDim2.new(0, 80, 0, 36), BackgroundColor3 = swatch[1], ZIndex = 23 }, c)
		corner(sw, 8)
		if swatch[2] then
			local a = make("Frame", { Position = UDim2.new(0, 0, 0.62, 0), Size = UDim2.new(1, 0, 0.38, 0), BackgroundColor3 = swatch[2], ZIndex = 24 }, sw)
			corner(a, 6)
		end
		if swatch.rainbow then
			make("UIGradient", { Color = ColorSequence.new({ ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 60, 60)), ColorSequenceKeypoint.new(0.33, Color3.fromRGB(255, 230, 60)),
				ColorSequenceKeypoint.new(0.66, Color3.fromRGB(60, 220, 255)), ColorSequenceKeypoint.new(1, Color3.fromRGB(190, 80, 255)) }) }, sw)
		end
		make("TextLabel", { Position = UDim2.new(0, 4, 0, 50), Size = UDim2.new(1, -8, 0, 20), BackgroundTransparency = 1, Text = name, TextColor3 = INK, Font = FONT_B, TextSize = 14, ZIndex = 23 }, c)
		make("TextLabel", { Position = UDim2.new(0, 4, 0, 68), Size = UDim2.new(1, -8, 0, 18), BackgroundTransparency = 1, Text = sub, TextColor3 = DIM, Font = FONT, TextSize = 12, ZIndex = 23 }, c)
		local b = make("TextButton", { Position = UDim2.new(0, 10, 1, -36), Size = UDim2.new(1, -20, 0, 28), BackgroundColor3 = btnColor, Text = btnText, TextColor3 = Color3.new(0.05, 0.05, 0.05), Font = FONT_B, TextSize = 14, ZIndex = 23, AutoButtonColor = true }, c)
		corner(b, 7)
		b.Activated:Connect(function() onClick(); render() end)
	end
	render = function()
		local st = cb.state()
		credits.Text = string.format("%d credits", st.credits)
		for _, ch in ipairs(grid:GetChildren()) do if ch:IsA("Frame") then ch:Destroy() end end
		if current == "paint" or current == "trail" then
			local list = if current == "paint" then Shop.PAINT else Shop.TRAIL
			local equipped = if current == "paint" then (st.paint or "paint_factory") else (st.trail or "trail_none")
			for i, it in ipairs(list) do
				local owned = it.price == 0 or st.allStyle or (st.owned and st.owned[it.id])
				local sw
				if current == "paint" then
					sw = { if it.hull then Shop.hex(it.hull) else Color3.fromRGB(220, 225, 232), if it.accent then Shop.hex(it.accent) else AMBER }
				else
					sw = { if it.color and it.color ~= "rainbow" then Shop.hex(it.color) else Color3.fromRGB(40, 44, 52) }
					sw.rainbow = it.color == "rainbow"
				end
				local txt, col
				if equipped == it.id then txt, col = "Equipped", Color3.fromRGB(120, 130, 140)
				elseif owned then txt, col = "Equip", GREEN
				else txt, col = string.format("Buy %d", it.price), if st.credits >= it.price then AMBER else Color3.fromRGB(110, 90, 70) end
				card(i, sw, it.name, if owned then "Owned" else string.format("%d credits", it.price), txt, col, function()
					if equipped == it.id then return end
					if not owned then
						local ok, msg = cb.buy(current, it)
						if not ok then note.Text = msg or "Not enough credits"; return end
					end
					cb.equip(current, it)
				end)
			end
		elseif current == "store" then
			-- Robux: one-time passes, then credit packs (prices as set in the Creator Hub)
			local GREY = Color3.fromRGB(120, 130, 140)
			for i, p in ipairs(Shop.PASSES) do
				local owned = cb.passOwned and cb.passOwned(p.attr)
				card(i, { Shop.hex(p.c1), Shop.hex(p.c2) }, p.name, p.sub,
					if owned then "Owned ✓" else "R$ " .. p.robux, if owned then GREY else AMBER,
					function() if not owned and cb.buyPass then cb.buyPass(p.attr) end end)
			end
			for i, p in ipairs(Shop.PACKS) do
				card(10 + i, { Shop.hex("#1f6b3a"), Shop.hex("#6ee08f") }, string.format("%s credits", p.label), p.sub,
					"R$ " .. p.robux, GREEN, function() if cb.buyPack then cb.buyPack(p.credits) end end)
			end
			note.Text = "Purchases support the game. Passes are yours forever on every server."
		elseif current == "codes" then
			local c = make("Frame", { BackgroundColor3 = Color3.fromRGB(28, 34, 44), LayoutOrder = 1, ZIndex = 22 }, grid)
			corner(c, 10)
			make("TextLabel", { Position = UDim2.new(0, 10, 0, 8), Size = UDim2.new(1, -20, 0, 20), BackgroundTransparency = 1, Text = "Enter a code", TextColor3 = INK, Font = FONT_B, TextSize = 14, ZIndex = 23 }, c)
			local box = make("TextBox", { Position = UDim2.new(0, 10, 0, 34), Size = UDim2.new(1, -20, 0, 32), BackgroundColor3 = Color3.fromRGB(14, 18, 24), Text = "", PlaceholderText = "CODE", TextColor3 = INK, PlaceholderColor3 = DIM, Font = FONT_B, TextSize = 15, ClearTextOnFocus = false, ZIndex = 23 }, c)
			corner(box, 6)
			local b = make("TextButton", { Position = UDim2.new(0, 10, 1, -36), Size = UDim2.new(1, -20, 0, 28), BackgroundColor3 = AMBER, Text = "Redeem", TextColor3 = Color3.new(0.05, 0.05, 0.05), Font = FONT_B, TextSize = 14, ZIndex = 23 }, c)
			corner(b, 7)
			b.Activated:Connect(function()
				if not cb.redeem then return end
				b.Text = "…"
				local ok, msg = cb.redeem(box.Text)
				b.Text = "Redeem"
				note.Text = msg or ""
				if ok then box.Text = ""; credits.Text = string.format("%d credits", cb.state().credits) end
			end)
			note.Text = "Codes are posted with game updates — follow the group for new ones."
		else
			for i, t in ipairs(Shop.TUNE) do
				local have = (st.tune or 0) >= t.level
				local nextUp = (st.tune or 0) + 1 == t.level
				card(i, { Color3.fromRGB(255, 140, 50), Color3.fromRGB(255, 220, 120) }, t.name, string.format("+%d%% thrust, all ships", math.round((t.mult - 1) * 100)),
					if have then "Installed" elseif nextUp then string.format("Buy %d", t.price) else "Locked",
					if have then Color3.fromRGB(120, 130, 140) elseif nextUp and st.credits >= t.price then AMBER else Color3.fromRGB(110, 90, 70),
					function()
						if have or not nextUp then return end
						local ok, msg = cb.buy("tune", t)
						if not ok then note.Text = msg or "Not enough credits" end
					end)
			end
		end
	end
	local tabBtns = {}
	local tabList = { { "paint", "Paint" }, { "trail", "Trails" }, { "tune", "Engines" }, { "codes", "🎁 Codes" } }
	if cb.storeOn and cb.storeOn() then table.insert(tabList, 1, { "store", "⭐ Store" }) end
	for _, tdef in ipairs(tabList) do
		local b = make("TextButton", { Size = UDim2.new(0, 104, 1, 0), BackgroundColor3 = Color3.fromRGB(36, 42, 54), Text = tdef[2], TextColor3 = INK, Font = FONT_B, TextSize = 15, ZIndex = 22 }, tabs)
		corner(b, 8)
		tabBtns[tdef[1]] = b
		b.Activated:Connect(function()
			current = tdef[1]
			for k, bb in pairs(tabBtns) do bb.BackgroundColor3 = if k == current then Color3.fromRGB(90, 70, 40) else Color3.fromRGB(36, 42, 54) end
			render()
		end)
	end
	tabBtns.paint.BackgroundColor3 = Color3.fromRGB(90, 70, 40)
	render()
	return panel
end

return Shop
