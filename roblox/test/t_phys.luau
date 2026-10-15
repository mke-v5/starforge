local THREE = require("./Three")
local Craft = require("./Craft")
local Physics = require("./Physics")
local Astro = require("./Astro")
local Geo = require("./Geo")
local D = require("./DesignsData")
local world = { groundAt = function(_, b, lat, lon) return if b == Geo.EARTH then 10 else 0 end, isWater = function() return false end, nearBuildings = false }
for _, key in ipairs({ "kestrel", "selene" }) do
	local design
	for _, p in ipairs(D) do if p.key == key then design = p.design end end
	local craft = Craft.new(design)
	local eph = Astro.Ephemeris.new():update(845000000)
	local ship = Physics.Ship.new(craft, world, eph, { heatScale = 1, crashScale = 1 })
	ship:placeAt(Geo.EARTH, 37.6, -122.38, 3000, 0.3, 0.05)
	ship.parked = nil
	ship.v:addScaledVector(THREE.Vector3.new(0, 0, -1):applyQuaternion(ship.q), 200)
	ship.ctl.throttle = 0.7; ship.ctl.gear = false
	for i = 1, 160 do eph:update(ship.t); ship:step(1 / 20, nil) end
	ship:updateEnv(ship.t)
	print(key, string.format("t=%.3f h=%.3f v=%.4f vz=%.4f lat=%.6f lon=%.6f q=%.6f,%.6f,%.6f,%.6f LF=%.3f FU=%.3f", ship.t, ship.env.h, ship.env.vSurf, ship.env.vVert, ship.env.lat, ship.env.lon, ship.q.x, ship.q.y, ship.q.z, ship.q.w, craft:amount("LF"), craft:amount("FU")))
end
