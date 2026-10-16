-- command-line test harness (mirror of work/sim.mjs)
local THREE = require("./Three")
local Craft = require("./Craft")
local Physics = require("./Physics")
local Control = require("./Control")
local Astro = require("./Astro")
local Geo = require("./Geo")
local Designs = require("./Ships")
local S = {}
S.THREE, S.Geo, S.Control, S.Astro = THREE, Geo, Control, Astro
function S.setup(key, opts)
	opts = opts or {}
	local G = opts.ground or 10
	local world = { nearBuildings = false }
	function world:groundAt(b, lat, lon) return if b == Geo.EARTH then G else (opts.moonGround or 0) end
	function world:isWater() return false end
	function world:buildingTop() return nil end
	local design
	for _, p in ipairs(Designs) do if p.key == key then design = p.design end end
	local craft = Craft.new(design)
	local eph = Astro.Ephemeris.new():update(opts.t or 845000000)
	local settings = { heatScale = 1, crashScale = 1, assist = opts.assist or "assisted" }
	local ship = Physics.Ship.new(craft, world, eph, settings)
	local C = Control.Controller.new(settings)
	if not opts.noPlace then
		if craft.vertical then ship:placeAt(Geo.EARTH, opts.lat or 28.5, opts.lon or -80.6, G + craft.box.max.z - craft.com.z + 0.05, opts.hdg or 0, math.pi / 2)
		else ship:placeAt(Geo.EARTH, opts.lat or 37.6, opts.lon or -122.38, G - craft.box.min.y + 0.05, opts.hdg or 0, 0) end
	end
	return ship, C, craft, eph
end
function S.att(ship)
	if not ship.env.up then ship:updateEnv(ship.t) end
	local up = ship.env.up
	local fwd = THREE.Vector3.new(0, 0, -1):applyQuaternion(ship.q)
	local right = THREE.Vector3.new(1, 0, 0):applyQuaternion(ship.q)
	return math.asin(fwd:dot(up)) * Geo.R2D, math.asin(right:dot(up)) * Geo.R2D
end
function S.line(ship, t)
	local E = ship.env
	local p, r = S.att(ship)
	local c = ship.craft
	return string.format("t=%ds v=%d M=%.2f h=%.2fkm agl=%d vz=%d pitch=%.1f roll=%.1f thr=%dkN g=%.1f heat=%d%% LF=%d OX=%d FU=%d body=%s%s",
		math.round(t), math.round(E.vSurf), E.mach, E.h / 1000, math.round(E.agl), math.round(E.vVert), p, r, math.round(ship.thrustNow / 1000), ship.gForce,
		math.round((c.heatFrac or 0) * 100), math.round(c:amount("LF")), math.round(c:amount("OX")), math.round(c:amount("FU")), E.body.name, if ship.parked then " PARKED" else "")
end
function S.events(ship, t)
	for _, e in ipairs(ship.events) do
		print(string.format("  [%.1f] EVENT %s %s %s %s", t, e.type, e.why or "", if e.part then e.part.def.id else "", if e.speed and e.speed ~= 0 then string.format("%.1f", e.speed) else ""))
	end
	table.clear(ship.events)
end
return S
