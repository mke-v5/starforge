-- Mars trip, planning stage: from a 300 km Earth orbit find the window and the injection burn
local S = require("./Sim")
local THREE = S.THREE
local I = require("./Interplanetary")
local O = require("./Orbit")
local KEY = KEY or "selene"
local ship, C, craft, eph = S.setup(KEY, { noPlace = true, t = 845400000 })
eph:update(ship.t)
local r = S.Geo.EARTH.R + 300000
ship.r:set(r, 0, 0)
ship.v:set(0, 0, -math.sqrt(S.Geo.EARTH.mu / r))
ship.parked = nil; ship.ctl.gear = false
ship:updateEnv(ship.t)
print("start", S.line(ship, 0))
local c0 = os.clock()
local W = I.findWindow(ship.t + 3600, S.Geo.EARTH, S.Geo.MARS, { rpFrom = r })
print(string.format("window in %.0f days, flight %.0f days, dv %.0f + %.0f m/s  (%.2fs)", (W.td - ship.t) / 86400, W.tof / 86400, W.dvD, W.dvA, os.clock() - c0))
c0 = os.clock()
local node = I.planMarsTransfer(ship)
if not node then print("no node"); return end
print(string.format("TMI at +%.1f days, dv %.0f m/s, Mars pe %.0f km, arrive +%.0f days  (%.2fs)", (node.t - ship.t) / 86400, node.dv:length(), node.marsPe / 1000, (node.arrive - ship.t) / 86400, os.clock() - c0))
