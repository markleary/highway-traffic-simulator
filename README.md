# Highway Traffic Simulator

A real-time, browser-based highway traffic simulator. Cars drive around a closed
loop of freeway with two interchanges (off-ramp + on-ramp each). You control the
knobs — inflow at each on-ramp, share of cars taking each exit, desired speed,
following distance, driver aggressiveness — and watch traffic flow respond live:
merge friction, stop-and-go waves, and full-blown phantom jams.

Based on an idea from childhood: *what actually causes highway traffic?* Now
answerable by turning a slider instead of writing Pascal.

## Running

It's a fully static site — no build step. Serve the directory with anything:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` via `file://` won't work because the app uses ES modules.)

## Deploying to GitHub Pages

Push this repository to GitHub, then: **Settings → Pages → Source: Deploy from a
branch → `main` / root**. That's it — there is nothing to build.

## Controls

- **Drag** to orbit, **scroll** to zoom, **Space** to pause.
- **Click any car to crash it** — it blocks its lane (optionally dragging a
  neighbor into a 2-lane pileup) until cleared. The **Events** folder also has
  random breakdowns: a car pulls onto the shoulder, parks with hazards, and
  merges back later, while passing traffic slows down to rubberneck.
- Cars talk with their lights: **brake lights** come on past an EV-regen-style
  deceleration threshold (or while held stopped), so a jam wave reads as a red
  pulse sweeping upstream; **blinkers** show intent — merging in from a ramp,
  working over toward an exit, or wanting a lane change that isn't safe yet
  (that car blinks without moving until a gap opens).
- The panel (top right) changes the simulation live:
  - **Units** — imperial (mph, default) or metric (km/h)
  - **Simulation** — pause, time scale, number of cars seeded on reset
  - **Road** — loop shape (circle, speedway oval, beltway square, or a pinched
    grand-prix circuit), road scale (1–3×: longer stretches between interchanges
    give jam waves room to develop and travel), number of interchanges (2–4 —
    each shape fits what its geometry allows; bigger roads unlock more), and
    number of lanes (2–4)
  - **Drivers** — percentage of semi trucks in the mix (long, slow, gentle,
    keep right), percentage of cars on **adaptive cruise control** (the angular
    wedge-shaped ones — they never brake harder than physics requires, so they
    absorb stop-and-go waves instead of amplifying them), desired speed, per-car
    speed spread, time headway (following distance), minimum gap, acceleration,
    comfortable braking
  - **Lane changing** — politeness, incentive threshold, safety braking limit
  - **Ramps** — cars/minute entering at each on-ramp, % of traffic taking each exit.
    The map label at each ramp shows its *measured* flow over the last minute:
    on-ramps show achieved vs. requested (they fall behind when the merge queue
    backs up), exits show what their share % currently amounts to in cars/min.
  - **View** — color cars by speed (red = stopped → green = at desired speed) or
    give each car a fixed color; overhead vs. perspective camera; live charts
    and **space-time diagram** toggles; and a **chase camera** that rides along
    behind a random car with a working speedometer (Esc to exit)
- The space-time diagram (bottom left) is the classic traffic-flow plot: each
  column is one second, bottom-to-top is one lap of the loop, color is speed.
  Individual cars trace bright diagonal lines; jams appear as red bands that
  drift *down-right* — the wave rolls upstream even though every car in it
  drives forward. Ticks on the left edge mark the ramps, dark red lines mark
  each incident's start, and hovering highlights the matching spot on the road.

Try it: crank both on-ramps to 30+ cars/min with exits low and watch the jam grow
backwards from the merge points. Or lower the time headway to 0.6 s and see how
dense-but-fragile the flow becomes. Then, once the space-time diagram is full of
jam stripes, raise the adaptive-cruise share and watch the stripes dissolve —
the 2018 Stern experiment, reproducible from your couch.

## How it works

Each car runs the [Intelligent Driver Model](https://en.wikipedia.org/wiki/Intelligent_driver_model)
(IDM) for acceleration/braking and a simplified [MOBIL](https://traffic-simulation.de)
rule for lane changes. On-ramp cars queue on the ramp and merge into gaps in the
outer lane; cars roll a die upstream of each exit to decide whether to leave, then
work their way to the outer lane in time. Everything is rendered with three.js
(instanced meshes), so thousands of cars stay smooth.

## Roadmap

- Scenario presets — one-click setups that stage the good demos: "rush hour"
  (heavy inflow, watch jams grow from the merges), "accident storm" (tailgating
  plus wrecks), and "ACC demo" (a jam-striped diagram, then raise the
  adaptive-cruise share and watch the stripes dissolve)
- Hover a car to read its current speed (and desired speed); chase view shows
  the chased car's desired speed
- Emergency vehicle button — spawn an ambulance and watch traffic make room
- Weather — rain slows everyone down and tips fragile flow into jams
- Better-looking vehicle models
- Mobile view optimizations (e.g. no space-time diagram by default on phones)
- A "By type" car-color mode (human / adaptive cruise / truck)
- Fundamental diagram — a live flow-vs-density scatter tracing the classic
  inverted-U as traffic builds and collapses
- Work zone / lane closure — cone off a lane and watch zipper merges and the
  capacity drop emerge
- Figure-eight road shape with an overpass
- Ramp metering
