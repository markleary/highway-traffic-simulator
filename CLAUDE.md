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
                       reads it every step; that is how every knob applies live
src/sim/road.js        loop shapes (SHAPES catalog) + ramp geometry, s-coordinate
                       helpers; LOOP/RAMPS are live bindings updated by setShape()
src/sim/car.js         Car state record
src/sim/simulation.js  all traffic logic: IDM, lane changes, ramp merge/exit logic
src/render/renderer.js three.js scene; cars are two InstancedMeshes (body + cabin)
src/ui/panel.js        lil-gui control panel
src/ui/charts.js       rolling 5-min speed/flow/cars-on-road charts + space-time diagram
                       (hand-rolled canvas 2D; heatmap columns come from the
                       per-10 m speed bins sampled into sim.history at 1 Hz)
src/ui/speedo.js       speedometer gauge shown while the chase camera is active
test/smoke.js          runs the sim headless under several parameter regimes
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
- `s` = arc length along lane 0's centerline; wraps at `LOOP` (shape-dependent,
  ~1050–1350 m). All lanes share `s` — the model treats the loop as a straight road
  that wraps; curvature is purely cosmetic.
- The loop's centerline is a closed path of straight + circular-arc segments
  (`road.js` SHAPES: circle, speedway, beltway, gp), so arc length, tangents and
  lateral offsets are exact. Every closed shape must turn a net −2π (left-handed);
  `setShape()` throws if a shape doesn't close. `params.roadShape` is applied by
  `Simulation.reset()` (a shape change requires a reset — `s` doesn't map across
  shapes); the panel then calls `renderer.onRoadChanged()`. Cameras frame the
  road from `bounds()`, never from hardcoded positions.
- Lane 0 = **outermost** lane (ramps attach to it); higher index = further inside.
  Outward = driver's right = `cross(forward, up)`: positive lateral offsets are
  outside the centerline, `laneOffset()` is negative. The outer pavement edge is
  fixed; changing the lane count grows the road *inward*, so ramp geometry never
  moves. Ramp anchors must sit on straights (or the circle) — and an off-ramp tip
  and on-ramp tip on the *same* straight point at each other, so interchanges on
  straight-sided shapes straddle a corner/cap instead (exit before the bend,
  entrance after).
- Two diamond interchanges (A and B) on opposite sides of the loop, each an
  off-ramp followed by an on-ramp. On-ramp cars queue on the ramp and merge into
  gaps in lane 0; with no gap they wait at the ramp end — ramp queues backing up
  are a feature, not a bug. Exit choice is rolled per car when it crosses a
  decision marker ~220 m before each off-ramp.
- `car.renderLane` is the smoothed lateral position used only for rendering;
  physics switches lanes discretely. Negative values are outside lane 0 — used
  by merging ramp cars and the breakdown shoulder (`SHOULDER_LANE`).
- Incidents (`sim.incidents`): breakdowns pull over to the shoulder, park with
  hazards, then re-merge (with growing desperation, forced after a timeout);
  accidents pin 1–2 cars in-lane as wrecks that vanish when their timer ends.
  Both project a "rubbernecking" zone ~200 m upstream that caps passing cars'
  desired speed, strongest in adjacent lanes (see `effectiveV0`). Click a car
  on the map to crash it (`renderer.onRoadClick` → `sim.carNear` →
  `sim.triggerAccident`); the Events panel folder has the rest.
- Per-car desired speed = global desired speed × `car.v0Factor` (sampled at spawn
  from the speed-variation knob), so the speed slider retunes every car live.
- Vehicle kinds: `car.kind` is 'car' or 'truck' (share set by the Trucks knob at
  spawn/reset). Trucks are 16.5 m, ~20% slower with less spread, and scale the
  global IDM knobs via per-car factors (`accelK`/`headwayK`/`brakeK` — see
  `idm(car, …)`). They need 2.5× the lane-change incentive and never enter the
  innermost lane on 3+ lane roads.

## Roadmap

- Ramp metering signals (deprioritized: not used around Boston, foreign concept to Mark)
