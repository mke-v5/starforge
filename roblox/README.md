# Starforge for Roblox

A Roblox version of Starforge. `src/` holds Luau modules translated line for line from the web game's
flight code (`../src`): the same physics, autopilots and orbit planners, checked against the web version
with the flight tests in `test/` (run `./build.sh` then `cd cli && luau t_orbit.luau`).

- `Three.luau` — the small part of three.js the simulation uses, in double precision
- `Geo`, `Atmo`, `Astro` — constants, air models, Sun/Moon/planet positions
- `PartsData`, `DesignsData` — generated from the web game's data (`gen-dump.mjs`)
- `Parts`, `Craft`, `Physics`, `Orbit`, `Control` — the flight model, controller and autopilots
- `ShipModel`, `Hud`, `Client.client.luau` — the Roblox side: 3D ship, on-screen display, game loop

In Studio the modules live in `ReplicatedStorage.Starforge`; the client script goes in
`StarterPlayer.StarterPlayerScripts`.
