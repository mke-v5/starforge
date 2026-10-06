# Starforge

Build a spaceplane from snap-together parts and fly it from any airport on a 1:1 Earth to orbit, Meridian Station and the Moon and back, with real physics. Streamed satellite imagery and terrain, ~16,000 cities, every airport.
No build step, no account, no keys. Serve this folder with any static host (GitHub Pages, Netlify Drop) and open index.html.

- **Fly**: fly-by-wire jets and spaceplanes, flight school, auto-land on any runway.
- **Space**: orbital mechanics with the Moon's pull, map view burn planning, time warp, reentry heating.
- **Meridian Station**: a station in a 420 km, 51.6° orbit. Launch-window ascent into its plane, Lambert transfers, closest-approach planning, RCS docking (by hand or autopilot) and free refuelling.
- **The Moon**: transfers, captures, landings at famous sites over the real lunar terrain, a one-tap "fly me to the Moon" trip from any runway or pad, and a fly-me-home autopilot back to the runway you left from.
- **Hangar**: build and reshape your own ships, see at a glance what each can do (orbit, station, Moon and back), and share them as a short code or link. Wings have structural limits; electric drives need power.
- **Fly anywhere**: pick any of 16,000 cities or every airport and the autopilot flies you there and lands.

Data: EOX Sentinel-2 cloudless (CC BY-NC-SA, non-commercial), NASA GIBS, AWS/Mapzen terrain tiles, OpenStreetMap buildings, OurAirports, GeoNames cities, NASA LRO Moon imagery and elevation.
Controls: thumbstick steers, slider sets speed. Keys: WASD pitch and roll, Q/E yaw, Shift/Ctrl throttle, M map, P autopilot; in space H/N J/L I/K translate on RCS, Y docks. Full list under How to play.

Tests: `npm install` (Playwright) then `npm test` plays the game headlessly — menus, physics, docking, auto-land, a phone layout, flying SFO → LAX, the hangar, parts — and `npm run test:fast` skips the long flights (ascent, rendezvous, Moon and back). `node tests/run.mjs <name> --verbose --shots` runs one scenario and saves screenshots to tests/shots.
