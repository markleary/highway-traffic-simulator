# Highway Traffic Simulator

A web-based highway traffic simulator: cars drive around a closed-loop freeway with
on-/off-ramps, and you watch traffic dynamics (waves, phantom jams, merge friction)
emerge in real time while turning knobs. A 30-year-old childhood idea, finally built.

## Hard constraints

- **No build step, no bundler, no framework.** Plain ES modules served as static
  files. `index.html` + `src/` must run directly on GitHub Pages.
- Runtime dependencies (three.js, lil-gui) load from CDN via the import map in
  `index.html` — pin exact versions there and keep them in sync with `package.json`.
- `package.json` / `node_modules` exist **only** for the headless smoke test
  (`npm test`); nothing in `src/` may depend on Node APIs.

## Run

```sh
python3 -m http.server 8000    # any static server; file:// won't work (ES modules)
open http://localhost:8000
```

Headless physics check (no browser needed): `npm install && npm test`

## Workflow

- **Never commit directly to `main`.** Every change goes on a feature branch and
  through a PR; PRs are reviewed by Codex before merge. GitHub Pages deploys
  from `main`, so nothing is live until the PR merges.
- Run `npm test` before opening a PR, and note any manual browser verification
  in the PR description.

## Review guidelines

- Treat changes that add a build step, bundler, framework, or Node-only runtime
  dependency in `src/` as high-priority regressions.
- Check that CDN import-map versions in `index.html` stay in sync with
  `package.json` when runtime dependencies change.
- For simulation changes, verify SI-unit conventions, lane numbering, ramp
  geometry, wrapped `s` coordinates, and no-overlap/stability behavior.
- For rendering/UI changes, confirm the app still runs as static GitHub Pages
  content and that controls update `params` live.
- Expect `npm test` to pass for PRs that touch `src/sim/`, `src/params.js`, or
  traffic-control behavior.

## Architecture

```
index.html             import map, HUD overlay (stats, legend), CSS
src/main.js            bootstrap + fixed-timestep loop (h = 1/60 s of sim time)
src/params.js          single mutable `params` object — the GUI writes it, the sim
                       reads it every step; that is how every knob applies live —
                       plus DEFAULTS, a frozen factory snapshot
src/presets.js         scenario presets: curated param regimes applied over
                       DEFAULTS (user display prefs kept unless the preset says
                       otherwise) + sim.reset() + an optional `after` hook (spawn
                       an ambulance, trigger wrecks); the panel's Scenario
                       dropdown drives it and every preset is smoke-tested
src/sim/road.js        loop shapes (SHAPES catalog) + ramp geometry, s-coordinate
                       helpers; LOOP/RAMPS are live bindings updated by setShape()
src/sim/car.js         Car state record
src/sim/simulation.js  all traffic logic: IDM, lane changes, ramp merge/exit logic
src/render/renderer.js three.js scene; cars are two InstancedMeshes (body + cabin)
src/ui/panel.js        lil-gui control panel
src/ui/charts.js       rolling 5-min speed/flow/cars-on-road charts + space-time diagram
                       + fundamental diagram (hand-rolled canvas 2D; heatmap columns
                       come from the per-10 m speed bins sampled into sim.history at
                       1 Hz; the fundamental diagram scatters flow vs mainline
                       density — history's `m`, ramp queues excluded — accumulated
                       since reset into its own trace (2 h cap; the 5-min window
                       would only ever show a patch of the curve), speed-colored
                       dots fading to a dim floor so the run's curve persists
                       under the bright head, with a dashed free-flow diagonal
                       q = k·desiredSpeed; hidden by default on viewports under
                       800 px tall so the grown panel can't cover the HUD)
src/ui/speedo.js       speedometer gauge shown while the chase camera is active
test/smoke.js          runs the sim headless under several parameter regimes
                       (Math.random is seeded → runs are deterministic; checks
                       on emergent behavior can be tight without seed-lottery
                       flakes)
```

## Model & conventions

- SI units internally (m, s, m/s, m/s²) — everything in `params` is SI. Units are
  a display-only concern: `params.units` ('imperial' default | 'metric') drives the
  HUD formatting and the panel, which binds unit-labeled sliders to a proxy object
  and writes converted SI back (see `panel.js`; toggling units rebuilds the panel).
  Conversion factors (`KMH`, `MPH`, `FT`) live in `params.js`.
- Longitudinal control: **IDM** (Intelligent Driver Model). Lane changes:
  simplified **MOBIL** (incentive + safety criterion, mild keep-right bias, forced
  drift toward lane 0 when the car has chosen an upcoming exit).
- `s` = arc length along lane 0's centerline; wraps at `LOOP` (shape- and
  scale-dependent, ~1050–4000 m). All lanes share `s` — the model treats the loop
  as a straight road that wraps; curvature is purely cosmetic.
- The loop's centerline is a closed path of straight + circular-arc segments
  (`road.js` SHAPES: circle, speedway, beltway, gp), so arc length, tangents and
  lateral offsets are exact. Every closed shape must turn a net −2π (left-handed);
  `setShape()` throws if a shape doesn't close. `params.roadShape` and
  `params.roadScale` (1–3×; builders scale radii and straights, while ramp
  anchors stay a fixed distance from their segment ends) are applied by
  `Simulation.reset()` (a geometry change requires a reset — `s` doesn't map
  across shapes or sizes); the panel then calls `renderer.onRoadChanged()`.
  Cameras frame the road from `bounds()`, never from hardcoded positions; fog,
  zoom range, and the far clip plane follow the fitted height in `buildRoad()`.
- Lane 0 = **outermost** lane (ramps attach to it); higher index = further inside.
  Outward = driver's right = `cross(forward, up)`: positive lateral offsets are
  outside the centerline, `laneOffset()` is negative. The outer pavement edge is
  fixed; changing the lane count grows the road *inward*, so ramp geometry never
  moves. Ramp anchors must sit on straights (or the circle) — and an off-ramp tip
  and on-ramp tip on the *same* straight point at each other, so interchanges on
  straight-sided shapes straddle a corner/cap instead (exit before the bend,
  entrance after).
- 2–4 diamond interchanges (lettered A–D in driving order), each an off-ramp
  followed by an on-ramp with its own params sliders (`onRampA`–`D`,
  `offRampA`–`D`). `params.interchanges` is the *requested* count; each shape's
  `interchanges(len, count)` clamps to what its geometry fits (circle: 3 at 1×,
  4 from ~1.15×; beltway: one per corner, always 4; speedway/gp: 2 until the
  straights reach 480 m ≈ scale 1.6, then mid-straight diamonds fit). Changing
  the count rebuilds the panel so the Ramps folder lists exactly the ramps that
  exist. On-ramp cars queue on the ramp and merge into gaps in lane 0; with no
  gap they wait at the ramp end — ramp queues backing up are a feature, not a
  bug. Exit choice is rolled per car when it crosses a decision marker ~220 m
  before each off-ramp.
- `car.renderLane` is the smoothed lateral position used only for rendering;
  physics switches lanes discretely. Negative values are outside lane 0 — used
  by merging ramp cars and the breakdown shoulder (`SHOULDER_LANE`).
- Vehicle lights (`sim.updateLights`, cosmetic): brake lights are EV-regen
  style — lit past a deceleration threshold with hysteresis; below a ~5 mph
  crawl any slowing lights them, and a standstill holds them even while the
  blocked car's commanded `a` breathes slightly positive — so jam waves read
  as red pulses running upstream. Blinkers
  (`car.signal`, +1 = inward/driver's left) show *desire*: a maneuver in
  progress, a ramp merge, drifting toward a chosen exit, or a MOBIL lane
  change that passed the incentive test but was blocked by the gap/safety
  gates (`signalWant`, expires ~1 s unless re-affirmed). Hazards (incident
  amber body-blink) take precedence over both. Rendered as two extra
  InstancedMeshes with per-kind mount points (`LIGHT_DIMS`).
- Incidents (`sim.incidents`): breakdowns pull over to the shoulder, park with
  hazards, then re-merge (with growing desperation, forced after a timeout);
  accidents pin 1–2 cars in-lane as wrecks that vanish when their timer ends.
  Both project a "rubbernecking" zone ~200 m upstream that caps passing cars'
  desired speed, strongest in adjacent lanes (see `effectiveV0`). Click a car
  on the map to crash it (`renderer.onRoadClick` → `sim.carNear` →
  `sim.triggerAccident`); the Events panel folder has the rest.
- Per-car desired speed = global desired speed × `car.v0Factor` (sampled at spawn
  from the speed-variation knob), so the speed slider retunes every car live.
- Emergency vehicle (`sim.spawnAmbulance`, Events panel): an 'ambulance'-kind
  white Type-I-style rig (hood + cab + taller patient module, dark cab glass,
  red module stripe, red/blue strobes on the module's front roof) that
  spawns into the widest inner-lane gap,
  runs at 1.55× the desired-speed knob with hair-trigger MOBIL (no politeness,
  holds the innermost lane so the corridor stays predictable), and despawns
  after ~1.6 laps. Cars with the siren within ~220 m behind (`ambBehind`) and
  in its lane bleed speed as it closes (0.65–1.0× — matching the receiving
  lane is what makes the merge out feasible, the exit-drift trick), get a
  strong bias out of that lane plus relaxed merge gates, and nobody merges
  into it; receiving lanes are deliberately NOT slowed — a cap that travels
  with the ambulance compresses them into a clot that walls everyone in. The
  corridor is emergent, and it degrades honestly with density (near capacity
  there is nowhere to move over to). Ambulances never take exits, skip
  rubbernecking, and are excluded from `randomEligibleCar`.
- Work zone (`sim.workZone()`, Events panel; `workZone`/`workZonePos`/
  `workZoneLen` params): cones close the INNERMOST lane over a stretch —
  ramps attach to lane 0 and exits drift there, so the inner lane is the only
  closable one. Applies live from params (no reset; position is a % of the
  loop so it survives shape changes). Closed-lane cars within 250 m of the
  cones (`WZ_WARN`) get exit-strength MOBIL urgency outward and bleed speed
  like exit cars; the cones themselves are an IDM wall (`accelWorkZone`) —
  a car that can't merge stops at the taper and noses in, which is the
  zipper and the capacity drop. Nobody merges into the closed lane on
  approach or inside; all lanes get a 0.7× posted speed through the zone.
  Cars caught inside by a live toggle escape outward at full urgency.
- Hovering a car shows a nameplate readout — kind + id, current speed with
  desired speed in parens (`renderer.setHoverCar`, a CSS2D label like the ramp
  labels). Same pick path as click-to-crash but re-run every frame from the
  resting pointer position (`pointerGround` → `carNear(pt, 12, true)`, the
  `any` flag adding ramp/shoulder/incident cars), so the label tracks traffic
  flowing under the cursor; the chase speedometer caption also shows the
  chased car's desired speed.
- Vehicle kinds: `car.kind` is 'car', 'truck', or 'acc' (shares set by the
  Trucks and Adaptive-cruise knobs at spawn/reset). Trucks are 16.5 m, ~20%
  slower with less spread, and scale the global IDM knobs via per-car factors
  (`accelK`/`headwayK`/`brakeK` — see `idm(car, …)`). They need 2.5× the
  lane-change incentive and never enter the innermost lane on 3+ lane roads.
- 'acc' cars (adaptive cruise control; never trucks — the knob is a share of
  cars) are car-sized and keep the human speed spread, but follow with IDM
  tempered by the Constant-Acceleration Heuristic (`accACC`, Treiber & Kesting):
  they refuse to brake much harder than a constant-acceleration prediction of
  the leader actually requires, so they absorb stop-and-go waves instead of
  amplifying them (mainline only; ramp queues keep plain IDM). Rendered as an
  angular stainless wedge. The wave-damping is regression-tested by comparing
  stop-and-go exposure at 0% vs 100% ACC in a flood regime.

## Roadmap

- Weather events: a rain storm lowers desired speeds and grip (longer
  headways, gentler comfortable braking) road-wide, with a visual mood shift;
  watch a stable regime tip into jams as the rain starts.
- Improve the vehicle visual models (still low-poly: wheels, beveled bodies,
  maybe a couple of car body varieties).
- Mobile view optimizations: hide the space-time diagram by default on small
  screens, audit the panel/charts layout for phones.
- Figure-eight road shape: needs an overpass, but elevation can be cosmetic
  exactly like curvature is (the model still drives a straight wrapped line) —
  give pointAt a y component from a per-segment elevation profile and render
  the crossing as a bridge; no intersection logic needed since it's
  grade-separated. The self-intersection guard in the smoke test would need a
  crossing-aware exemption.
- Ramp metering signals (deprioritized: not used around Boston, foreign concept
  to Mark — though with 2–4 meterable on-ramps it now has a stage)
