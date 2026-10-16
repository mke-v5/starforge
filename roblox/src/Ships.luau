-- Every flyable ship: the web game's presets plus Roblox-only designs, in unlock order.
local Designs = require(script.Parent.DesignsData)

local Q_AX = { -0.707106781186547, 0, 0, 0.707106781186548 }   -- along the fuselage
local Q_UP = { -0.5, -0.5, 0.5, 0.5 }                            -- fin, sticking up
local Q_DN_R = { -0.5, 0.5, -0.5, 0.5 }                          -- gear, right/centre
local Q_DN_L = { -0.5, -0.5, 0.5, 0.5 }                          -- gear, left (mirrored)

local function part(id, p, q, parent, sym, mirror)
	return { id = id, p = p, q = q, mirror = mirror or false, parent = parent, sym = sym or -1 }
end

local EXTRA = {
	{
		key = "viper",
		blurb = "Twin-pod racing jet. Three engines, huge acceleration — built to win the ring race.",
		design = {
			name = "Viper",
			colors = { hull = "#c4232b", accent = "#f4f4f4" },
			vertical = false, version = 1,
			parts = {
				part("ck-kestrel", { 0, 0, 2.1 }, Q_AX, -1),                    -- 0
				part("fs-s4", { 0, 0, 6.2 }, Q_AX, 0),                          -- 1
				part("fs-s2", { 0, 0, 9.2 }, Q_AX, 1),                          -- 2
				part("en-swift", { 0, 0, 11.8 }, Q_AX, 2),                      -- 3
				part("wg-swept", { 0.6, -0.25, 6.2 }, Q_AX, 1, 5),              -- 4
				part("wg-swept", { -0.6, -0.25, 6.2 }, Q_AX, 1, 4, true),       -- 5
				part("en-pod", { 1.35, -0.55, 7.4 }, Q_AX, 4, 7),              -- 6
				part("en-pod", { -1.35, -0.55, 7.4 }, Q_AX, 5, 6, true),       -- 7
				part("wg-tailplane", { 0.55, 0.05, 11.9 }, Q_AX, 3, 9),        -- 8
				part("wg-tailplane", { -0.55, 0.05, 11.9 }, Q_AX, 3, 8, true), -- 9
				part("wg-fin", { 0, 0.6, 11.2 }, Q_UP, 3),                      -- 10
				part("gr-light", { 0, -0.46, 2.6 }, Q_DN_R, 0),                 -- 11
				part("gr-light", { 2.1, -0.3, 8.2 }, Q_DN_R, 4, 13),           -- 12
				part("gr-light", { -2.1, -0.3, 8.2 }, Q_DN_L, 5, 12, true),    -- 13
				part("ut-strobe", { 0, 0.62, 9 }, Q_UP, 2),                     -- 14
			},
		},
	},
}

local list = {}
for _, d in ipairs(Designs) do table.insert(list, d) end
-- the Viper sits between the Starhopper (level 3) and the Selene (level 5)
for _, d in ipairs(EXTRA) do
	local at = #list + 1
	for i, e in ipairs(list) do if e.key == "selene" then at = i end end
	table.insert(list, at, d)
end
-- order: kestrel, lynx, starhopper, viper, selene
local ORDER = { kestrel = 1, lynx = 2, starhopper = 3, viper = 4, selene = 5 }
table.sort(list, function(a, b) return (ORDER[a.key] or 99) < (ORDER[b.key] or 99) end)
return list
