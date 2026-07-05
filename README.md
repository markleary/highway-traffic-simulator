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
- The panel (top right) changes the simulation live:
  - **Units** — imperial (mph, default) or metric (km/h)
  - **Simulation** — pause, time scale, number of cars seeded on reset
  - **Road** — number of lanes (2–4)
  - **Drivers** — desired speed, per-car speed spread, time headway (following
    distance), minimum gap, acceleration, comfortable braking
  - **Lane changing** — politeness, incentive threshold, safety braking limit
  - **Ramps** — cars/minute entering at each on-ramp, % of traffic taking each exit.
    The map label at each ramp shows its *measured* flow over the last minute:
    on-ramps show achieved vs. requested (they fall behind when the merge queue
    backs up), exits show what their share % currently amounts to in cars/min.
  - **View** — color cars by speed (red = stopped → green = at desired speed) or
    give each car a fixed color; overhead vs. perspective camera

Try it: crank both on-ramps to 30+ cars/min with exits low and watch the jam grow
backwards from the merge points. Or lower the time headway to 0.6 s and see how
dense-but-fragile the flow becomes.

## How it works

Each car runs the [Intelligent Driver Model](https://en.wikipedia.org/wiki/Intelligent_driver_model)
(IDM) for acceleration/braking and a simplified [MOBIL](https://traffic-simulation.de)
rule for lane changes. On-ramp cars queue on the ramp and merge into gaps in the
outer lane; cars roll a die upstream of each exit to decide whether to leave, then
work their way to the outer lane in time. Everything is rendered with three.js
(instanced meshes), so thousands of cars stay smooth.

## Roadmap

- Events: breakdowns and accidents that block lanes for a while
- Live flow/density/speed charts and a space-time diagram
- Chase camera, ramp metering, trucks
