-- Missions, experience, levels and unlocks. Pure logic (no Roblox objects) so it can be tested headless.
local Geo = require(script.Parent.Geo)

local P = {}

-- ships unlock with level
P.SHIP_LEVEL = { kestrel = 1, lynx = 2, starhopper = 3, viper = 4, selene = 5 }

-- each mission: id, title, hint, xp, credits, ship (suggested), check(ctx) -> true when done
-- ctx = { E (env), ship, craft, key (ship key), flags = { airborne, landedRunway, ringsPassed, raceDone, hoverTime, landedBody } }
P.MISSIONS = {
	{ id = "takeoff", title = "Take off", hint = "Throttle up (Shift or the slider) and pull up (S) at about 80 m/s", xp = 60, credits = 50,
		check = function(c) return c.flags.airborne and c.E.agl > 30 end },
	{ id = "ring1", title = "Fly through a ring", hint = "Follow the glowing rings over the spaceport", xp = 60, credits = 50,
		check = function(c) return c.flags.ringsPassed >= 1 end },
	{ id = "alt3", title = "Climb to 3 km", hint = "Pull up and keep the throttle open", xp = 80, credits = 75,
		check = function(c) return c.E.h > 3000 end },
	{ id = "fast", title = "Hit 250 m/s", hint = "Full throttle (Z), stay low and nose slightly down — that's 900 km/h", xp = 100, credits = 100,
		check = function(c) return c.E.vSurf > 250 and c.E.rho > 0.3 end },
	{ id = "land", title = "Land back on the runway", hint = "Line up, slow to ~70 m/s, gear down (G), touch down gently — or press Auto: land", xp = 120, credits = 150,
		check = function(c) return c.flags.landedRunway end },
	{ id = "race", title = "Finish the ring race", hint = "Fly through every ring in order — fastest times go on the board", xp = 150, credits = 200,
		check = function(c) return c.flags.raceDone end },
	{ id = "hover", title = "Hover the Lynx VTOL", hint = "Pick the Lynx (Ship button) and hold it still 20 m up for 5 s", xp = 120, credits = 150, ship = "lynx",
		check = function(c) return c.key == "lynx" and c.flags.hoverTime > 5 end },
	{ id = "alt20", title = "Climb to 20 km", hint = "Jets run out of air near 15 km: take the Starhopper rocket (level 3), or zoom-climb the Viper", xp = 150, credits = 200,
		check = function(c) return c.E.h > 20000 end },
	{ id = "space", title = "Reach space (100 km)", hint = "Take the Starhopper rocket — or Auto: climb to orbit", xp = 250, credits = 400, ship = "starhopper",
		check = function(c) return c.E.body == Geo.EARTH and c.E.h > 100000 end },
	{ id = "rocketland", title = "Land a rocket upright", hint = "Come back down with the Starhopper and touch down on its legs (Auto: land helps)", xp = 250, credits = 400, ship = "starhopper",
		check = function(c) return c.key == "starhopper" and c.flags.landedBody == Geo.EARTH and c.flags.wasHigh end },
	{ id = "mach1", title = "Break the sound barrier", hint = "Take the Viper (level 4), full throttle — Mach 1 is about 340 m/s down low", xp = 200, credits = 300, ship = "viper",
		check = function(c) return c.E.mach > 1.0 and c.E.rho > 0.05 end },
	{ id = "orbit", title = "Reach orbit", hint = "Climb above 140 km and speed up sideways to ~7.8 km/s — Auto: climb to orbit does it", xp = 400, credits = 600,
		check = function(c) return c.orbitPe ~= nil and c.orbitPe > 140000 and c.E.body == Geo.EARTH end },
	{ id = "moon", title = "Fly to the Moon", hint = "From orbit, take the Selene to the Moon", xp = 600, credits = 1000, ship = "selene",
		check = function(c) return c.E.body == Geo.MOON end },
	{ id = "moonland", title = "Land on the Moon", hint = "Auto: land brings you down on the lift thrusters", xp = 1000, credits = 2000, ship = "selene",
		check = function(c) return c.flags.landedBody == Geo.MOON end },
	{ id = "race100", title = "Race under 1:40", hint = "Finish the ring race in less than 1 min 40 s — the Viper (level 4) is built for it", xp = 300, credits = 500, ship = "viper",
		check = function(c) return c.flags.raceTime ~= nil and c.flags.raceTime < 100 end },
	{ id = "moonhome", title = "To the Moon and back", hint = "Land on the Moon, then fly home and touch down on Earth in the same flight", xp = 1500, credits = 3000, ship = "selene",
		check = function(c) return c.flags.wasMoon and c.flags.landedBody == Geo.EARTH end },
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

-- checks every unfinished mission (they can be done in any order; the card shows the first one left);
-- returns a mission if it was just completed
function P.check(state, ctx)
	for _, m in ipairs(P.MISSIONS) do
		if not state.done[m.id] and m.check(ctx) then
			state.done[m.id] = true
			return m
		end
	end
	return nil
end

-- daily challenges: three a day, picked from this pool by the date; progress counters reset each day
P.DAILY = {
	{ id = "crystals10", title = "Collect 10 star crystals", credits = 150, goal = 10, stat = "crystals" },
	{ id = "race1", title = "Finish a ring race", credits = 120, goal = 1, stat = "races" },
	{ id = "mach2", title = "Fly faster than Mach 2", credits = 120, goal = 2, stat = "maxMach" },
	{ id = "land3", title = "Land 3 times", credits = 120, goal = 3, stat = "landings" },
	{ id = "dist100", title = "Fly 100 km", credits = 150, goal = 100, stat = "km" },
	{ id = "space1", title = "Reach space", credits = 200, goal = 1, stat = "space" },
	{ id = "high10", title = "Climb above 10 km", credits = 80, goal = 10, stat = "maxKm" },
	{ id = "rings25", title = "Fly through 25 rings", credits = 120, goal = 25, stat = "rings" },
}
local function today() return math.floor(os.time() / 86400) end
function P.daily(state)
	local d = state.daily
	if not d or d.day ~= today() then
		d = { day = today(), stats = {}, done = {} }
		state.daily = d
	end
	-- three challenges for today
	local picks, used = {}, {}
	local seed = d.day
	while #picks < 3 do
		seed = (seed * 1103515245 + 12345) % 2147483648
		local i = 1 + seed % #P.DAILY
		if not used[i] then used[i] = true; table.insert(picks, P.DAILY[i]) end
	end
	return d, picks
end
-- add to (or raise) a daily counter; returns any challenges just finished
function P.dailyStat(state, stat, value, isMax)
	local d, picks = P.daily(state)
	local cur = d.stats[stat] or 0
	d.stats[stat] = if isMax then math.max(cur, value) else cur + value
	local finished = {}
	for _, c in ipairs(picks) do
		if not d.done[c.id] and (d.stats[c.stat] or 0) >= c.goal then
			d.done[c.id] = true
			state.credits += c.credits
			table.insert(finished, c)
		end
	end
	return finished
end

function P.unlocked(state, key) return state.level >= (P.SHIP_LEVEL[key] or 1) end

return P
