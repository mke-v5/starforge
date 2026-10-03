export const HELP_HTML = `
<p>Starforge is a 1:1 Earth and Moon with real orbital mechanics. Build a ship in the hangar, take off from any real airport, reach orbit, fly to the Moon, land, and come home.</p>
<h3>First flight</h3>
<p>Pick the <b>Kestrel</b> jet, choose any airport and a runway, then push the throttle all the way up. At about 75 m/s (150 kt) pull back on the stick to lift off. Raise the gear. Fly anywhere — the whole planet is real satellite imagery with real terrain and buildings.</p>
<h3>Flying</h3>
<p><b>Assisted</b> flight (default) is fly-by-wire: the stick commands g-load and roll rate; let go and the ship holds its climb angle and bank. Turns are coordinated automatically and the computer won't let you stall. <b>Realistic</b> (Settings) gives you raw control surfaces.</p>
<p>Touch: left stick = pitch and roll, the bar under it = rudder / nose-wheel steering, right slider = throttle. Drag the sky to look around, pinch to zoom.</p>
<p>Keyboard: <kbd>W</kbd>/<kbd>S</kbd> pitch, <kbd>A</kbd>/<kbd>D</kbd> roll, <kbd>Q</kbd>/<kbd>E</kbd> yaw, <kbd>Shift</kbd>/<kbd>Ctrl</kbd> throttle, <kbd>Z</kbd> full, <kbd>X</kbd> cut, <kbd>G</kbd> gear, <kbd>B</kbd> brakes (hold), <kbd>T</kbd> SAS on/off, <kbd>1</kbd>–<kbd>8</kbd> SAS modes, <kbd>R</kbd> RCS, <kbd>V</kbd> engine group, <kbd>F</kbd> hybrid mode, <kbd>M</kbd> map, <kbd>C</kbd> camera, <kbd>,</kbd>/<kbd>.</kbd> time warp, <kbd>P</kbd> autopilot, <kbd>Esc</kbd> pause. Gamepads work too.</p>
<h3>Going to space</h3>
<p>Air-breathing jets stop working high up. Spaceplanes like <b>Selene</b> take off on jets, then light the fusion torch. Watch the <b>navball</b>: the yellow circle is where you're moving (prograde). To make orbit you need about 7.8 km/s sideways above 140 km. Easiest: open <b>Autopilot → Ascend to orbit</b>.</p>
<h3>The Moon</h3>
<p>In orbit, open the <b>map</b> (◍) and tap <b>Go to the Moon</b>. The computer simulates the real burn and finds a transfer; tap <b>Autopilot</b> (or <b>Warp to it</b>) to fly it. On the way, <b>Fine-tune Moon approach</b> plans a small correction — it picks the cheapest moment, which may be hours later. Near the Moon tap <b>Capture into lunar orbit</b>, then <b>Autopilot: land on the Moon</b>: it deorbits, coasts (warping automatically), fires a braking burn and touches down on the belly thrusters.</p>
<p>To leave, <b>Autopilot → Take off to lunar orbit</b>, then <b>Return to Earth orbit</b> in the map. Spaceplanes come back into Earth orbit with a braking burn at periapsis — a straight dive in at 11 km/s is right at the limit of what wings survive. Ships with a heat shield can go direct.</p>
<h3>Coming home</h3>
<p>From Earth orbit, open the map and tap <b>Fly home to an airport…</b>, pick a city, then <b>Fly me home</b>. The autopilot waits for the right pass, burns, flies a belly-first reentry steering toward the airport, then lines up and lands on the runway. Any time you're flying a plane, <b>Autopilot → Land at …</b> lands on the nearest big runway. Move the stick to take over at any moment.</p>
<h3>Heat and damage</h3>
<p>Coming back from space at 7–11 km/s heats your ship. Fly belly-first at a high angle of attack so the heat-tiled underside and heat shields take it. Parts that overheat burn away. Landing too hard breaks gear; hitting the ground or a building destroys the ship. Fusion drives also run hot — bring radiators.</p>
<h3>Building</h3>
<p>In the hangar, pick a part and tap on your ship to attach it. Parts snap to the ends of other parts or stick to their surfaces; symmetry mirrors them to the other side. Keep the centre of lift (blue) just behind the centre of mass (yellow) and your plane will be stable. Put the main wheels a little behind the centre of mass and spread them wide.</p>
<h3>Data</h3>
<p>Satellite imagery © EOX IT Services (Sentinel-2 cloudless, CC BY-NC-SA 4.0) and NASA GIBS. Terrain: Mapzen Terrarium / AWS Open Data. Buildings © OpenStreetMap contributors via OpenFreeMap. Airports: OurAirports (public domain). Moon imagery: NASA/LRO via Moon Trek; Moon elevation: NASA LRO/LOLA. Cities: GeoNames (CC BY).</p>
`;
