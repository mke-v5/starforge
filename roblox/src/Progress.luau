-- Missions, experience, levels and unlocks. Pure logic (no Roblox objects) so it can be tested headless.
local Geo = require(script.Parent.Geo)

local P = {}

-- ships unlock with level
P.SHIP_LEVEL = { kestrel = 1, lynx = 2, starhopper = 3, selene = 5 }

-- each mission: id, title, hint, xp, credits, ship (suggested), check(ctx) -> true when done
-- ctx = { E (env), ship, craft, key (ship key), flags = { airborne, landedRunway, ringsPassed, raceDone, hoverTime, landedBody } }
P.MISSIONS = {
	{ id = "takeoff", title = "Take off", hint = "Throttle up (Shift or the slider) and pull up (S) at about 80 m/s", xp = 60, credits = 50,
		check = function(c) return c.flags.airborne and c.E.agl > 30 end },
	{ id = "ring1", title = "Fly through a ring", hint = "Follow the glowing rings over the spaceport", xp = 60, credits = 50,
		check = function(c) return c.flags.ringsPassed >= 1 end },
	{ id = "alt3", title = "Climb to 3 km", hint = "Pull up and keep the throttle open", xp = 80, credits = 75,
		check = function(c) return c.E.h > 3000 end },
	{ id = "mach1", title = "Break the sound barrier", hint = "Full throttle (Z) in a shallow dive: Mach 1 is about 340 m/s", xp = 100, credits = 100,
		check = function(c) return c.E.mach > 1.0 and c.E.rho > 0.05 end },
	{ id = "land", title = "Land back on the runway", hint = "Line up, slow to ~70 m/s, gear down (G), touch down gently — or press Auto: land", xp = 120, credits = 150,
		check = function(c) return c.flags.landedRunway end },
	{ id = "race", title = "Finish the ring race", hint = "Fly through every ring in order — fastest times go on the board", xp = 150, credits = 200,
		check = function(c) return c.flags.raceDone end },
	{ id = "hover", title = "Hover the Lynx VTOL", hint = "Pick the Lynx (Ship button) and hold it still 20 m up for 5 s", xp = 120, credits = 150, ship = "lynx",
		check = function(c) return c.key == "lynx" and c.flags.hoverTime > 5 end },
	{ id = "alt20", title = "Climb to 20 km", hint = "High and fast: the sky turns dark blue", xp = 150, credits = 200,
		check = function(c) return c.E.h > 20000 end },
	{ id = "space", title = "Reach space (100 km)", hint = "Take the Starhopper rocket — or Auto: climb to orbit", xp = 250, credits = 400, ship = "starhopper",
		check = function(c) return c.E.body == Geo.EARTH and c.E.h > 100000 end },
	{ id = "rocketland", title = "Land a rocket upright", hint = "Come back down with the Starhopper and touch down on its legs (Auto: land helps)", xp = 250, credits = 400, ship = "starhopper",
		check = function(c) return c.key == "starhopper" and c.flags.landedBody == Geo.EARTH and c.flags.wasHigh end },
	{ id = "orbit", title = "Reach orbit", hint = "Climb above 140 km and speed up sideways to ~7.8 km/s — Auto: climb to orbit does it", xp = 400, credits = 600,
		check = function(c) return c.orbitPe ~= nil and c.orbitPe > 140000 and c.E.body == Geo.EARTH end },
	{ id = "moon", title = "Fly to the Moon", hint = "From orbit, take the Selene to the Moon", xp = 600, credits = 1000, ship = "selene",
		check = function(c) return c.E.body == Geo.MOON end },
	{ id = "moonland", title = "Land on the Moon", hint = "Auto: land brings you down on the lift thrusters", xp = 1000, credits = 2000, ship = "selene",
		check = function(c) return c.flags.landedBody == Geo.MOON end },
}

function P.xpForLevel(level) return 150 * level end

function P.newState()
	return { xp = 0, level = 1, credits = 0, done = {}, bestRace = nil, flights = 0 }
end

-- current mission (first not done), or nil when all are done
function P.current(state)
	for _, m in ipairs(P.MISSIONS) do if not state.done[m.id] then return m end end
	return nil
end

-- add xp/credits; returns list of level-ups
function P.reward(state, xp, credits)
	state.xp += xp
	state.credits += credits
	local ups = {}
	while state.xp >= P.xpForLevel(state.level) do
		state.xp -= P.xpForLevel(state.level)
		state.level += 1
		table.insert(ups, state.level)
	end
	return ups
end

-- checks the current mission; returns the mission if it was just completed
function P.check(state, ctx)
	local m = P.current(state)
	if m and m.check(ctx) then
		state.done[m.id] = true
		return m
	end
	return nil
end

function P.unlocked(state, key) return state.level >= (P.SHIP_LEVEL[key] or 1) end

return P
