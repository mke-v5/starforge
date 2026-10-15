local Craft = require("./Craft")
local D = require("./DesignsData")
for _, p in ipairs(D) do
	local c = Craft.new(p.design)
	print(p.key, string.format("%.3f", c.mass), c.com, string.format("%.1f %.1f %.1f", c.Idiag.x, c.Idiag.y, c.Idiag.z), #c.engines, #c.wings, c.wheelTorque, string.format("%.3f", c.size))
end
