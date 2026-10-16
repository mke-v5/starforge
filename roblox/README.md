# Starforge for Roblox

A Roblox version of Starforge. `src/` holds Luau modules translated line for line from the web game's
flight code (`../src`): the same physics, autopilots and orbit planners, checked against the web version
with the flight tests in `test/` (run `./build.sh` then `cd cli && luau t_orbit.luau`).

## Modules

- `Three.luau` — the small part of three.js the simulation uses, in double precision
- `Geo`, `Atmo`, `Astro` — constants, air models, Sun/Moon/planet positions
- `PartsData`, `DesignsData` — generated from the web game's data (`gen-dump.mjs`)
- `Ships` — every flyable ship: the web presets plus Roblox-only designs (the Viper)
- `Parts`, `Craft`, `Physics`, `Orbit`, `Control` — the flight model, controller and autopilots
- `Interplanetary` — Mars: launch windows (Lambert), injection, course corrections, capture
- `Progress` — missions, levels, ship unlocks, daily challenges
- `Shop`, `Hangar`, `Hud`, `ShipModel` — the Roblox side: shop, title/hangar screen, HUD, 3D ships
- `Client.client.luau` — the game loop (StarterPlayerScripts)
- `Server.server.luau` — saves (DataStore), leaderboards, redeem codes, multiplayer relay, VIP pass

## Installing into a place

In Studio the modules live in `ReplicatedStorage.Starforge`, the client script is
`StarterPlayer.StarterPlayerScripts.StarforgeClient` and the server script is
`ServerScriptService.StarforgeServer`. With HTTP requests allowed (Game Settings → Security), this
command-bar snippet pulls a given commit from GitHub:

```lua
local HS = game:GetService("HttpService")
local SHA = "<commit>"
local base = "https://raw.githubusercontent.com/mke-v5/starforge/" .. SHA .. "/roblox/src/"
local folder = game.ReplicatedStorage:FindFirstChild("Starforge") or Instance.new("Folder", game.ReplicatedStorage)
folder.Name = "Starforge"
for _, n in ipairs({ "Three", "Geo", "Atmo", "Astro", "PartsData", "Parts", "DesignsData", "Ships", "Craft", "Physics",
		"Orbit", "Interplanetary", "Control", "ShipModel", "Hud", "Progress", "Shop", "Hangar" }) do
	local m = folder:FindFirstChild(n) or Instance.new("ModuleScript", folder)
	m.Name = n
	m.Source = HS:GetAsync(base .. n .. ".luau")
end
```

## Live-ops knobs

- Redeem codes: `CODES` in `Server.server.luau`
- VIP game pass id: `GAMEPASS.VIP` in `Server.server.luau`
- Daily challenges and missions: `Progress.luau`
- Shop catalogue: `Shop.luau`
