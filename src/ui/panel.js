import GUI from 'lil-gui';
import { params, KMH, MPH, FT } from '../params.js';
import { SHAPES } from '../sim/road.js';

// params holds SI values only. Sliders with units bind to a proxy object in
// display units and write converted SI back on change; toggling units tears
// the panel down and rebuilds it with new labels, ranges and proxy values.
export function buildPanel({ sim, renderer }) {
  let gui = null;
  const rebuild = () => {
    if (gui) gui.destroy();
    // defer: destroying the GUI from inside its own onChange handler
    gui = makeGui({ sim, renderer, onUnitsChange: () => setTimeout(rebuild, 0) });
  };
  rebuild();
}

// Hover tooltip on a controller's whole row (name + widget).
function tip(ctrl, text) {
  ctrl.domElement.title = text;
  return ctrl;
}

function makeGui({ sim, renderer, onUnitsChange }) {
  const imp = params.units === 'imperial';
  const spd = imp ? MPH : KMH; // speed display unit → m/s
  const spdU = imp ? 'mph' : 'km/h';
  const acc = imp ? FT : 1;    // length/accel display unit → m
  const lenU = imp ? 'ft' : 'm';
  const accU = imp ? 'ft/s²' : 'm/s²';

  const ui = {
    desiredSpeed: Math.round(params.desiredSpeed / spd),
    rampSpeed: Math.round(params.rampSpeed / spd),
    minGap: Number((params.minGap / acc).toFixed(1)),
    maxAccel: Number((params.maxAccel / acc).toFixed(1)),
    comfortBrake: Number((params.comfortBrake / acc).toFixed(1)),
    laneChangeThreshold: Number((params.laneChangeThreshold / acc).toFixed(2)),
    safeBrake: Number((params.safeBrake / acc).toFixed(1)),
  };

  const gui = new GUI({ title: 'Traffic Controls' });
  tip(
    gui
      .add(params, 'units', { 'Imperial (mph)': 'imperial', 'Metric (km/h)': 'metric' })
      .name('Units')
      .onChange(onUnitsChange),
    'Display units for speeds, gaps and accelerations. The simulation itself always runs in SI internally.'
  );

  const fSim = gui.addFolder('Simulation');
  tip(fSim.add(params, 'paused').name('Paused').listen(), 'Freeze the simulation. The spacebar toggles this too.');
  tip(
    fSim.add(params, 'timeScale', 0.1, 8, 0.1).name('Time scale'),
    'Simulation speed multiplier: 2 runs at twice real time, 0.5 at half.'
  );
  tip(
    fSim.add(params, 'initialCars', 0, 300, 5).name('Cars on reset'),
    'How many cars are seeded around the loop when you press Reset.'
  );
  tip(
    fSim.add({ reset: () => sim.reset() }, 'reset').name('↻ Reset simulation'),
    'Remove all cars and reseed the loop with "Cars on reset" cars.'
  );

  const fRoad = gui.addFolder('Road');
  const shapeOptions = Object.fromEntries(
    Object.entries(SHAPES).map(([id, shape]) => [shape.label, id])
  );
  tip(
    fRoad
      .add(params, 'roadShape', shapeOptions)
      .name('Shape')
      .onChange(() => {
        sim.reset(); // reads params.roadShape; car positions don't map across shapes
        renderer.onRoadChanged();
      }),
    'Shape of the highway loop. Changing it rebuilds the road and reseeds traffic — the physics is identical on every shape; only the scenery bends.'
  );
  tip(
    fRoad
      .add(params, 'lanes', 2, 4, 1)
      .name('Lanes')
      .onChange(() => {
        sim.onLaneCountChanged();
        renderer.buildRoad();
      }),
    'Number of lanes. The outer edge stays fixed and lanes grow inward; cars in a removed lane move to the innermost remaining one.'
  );

  const fDrv = gui.addFolder('Drivers');
  tip(
    fDrv.add(params, 'truckShare', 0, 40, 1).name('Trucks (%)'),
    'Share of vehicles that are semi trucks: long, ~20% slower, lazy acceleration, bigger following gaps, rare lane changes, and they stay out of the leftmost lane. Applies to newly entering vehicles and on reset.'
  );
  tip(
    fDrv.add(params, 'accShare', 0, 100, 5).name('Adaptive cruise (%)'),
    'Share of cars (never trucks) driving on adaptive cruise control — the angular wedge-shaped ones. They never brake harder than physics actually requires, so they absorb stop-and-go waves instead of amplifying them: crank the on-ramps until the space-time diagram striping appears, then raise this and watch the stripes dissolve. Applies to new spawns and on reset.'
  );
  tip(
    fDrv
      .add(ui, 'desiredSpeed', ...(imp ? [25, 90, 1] : [40, 145, 1]))
      .name(`Desired speed (${spdU})`)
      .onChange((v) => (params.desiredSpeed = v * spd)),
    'Speed drivers aim for on an open road. Each car gets a personal offset around this (see Speed spread).'
  );
  tip(
    fDrv.add(params, 'speedVariation', 0, 0.4, 0.01).name('Speed spread'),
    'Per-car variation around the desired speed, sampled when a car spawns: 0.15 means ±15%. More spread = more overtaking.'
  );
  tip(
    fDrv.add(params, 'timeHeadway', 0.6, 3, 0.1).name('Time headway (s)'),
    'Following distance measured in time: the gap each driver keeps to the car ahead. Lower = tailgating — denser flow, but fragile and jam-prone.'
  );
  tip(
    fDrv
      .add(ui, 'minGap', ...(imp ? [2, 20, 0.5] : [0.5, 6, 0.1]))
      .name(`Min gap (${lenU})`)
      .onChange((v) => (params.minGap = v * acc)),
    'Bumper-to-bumper distance drivers keep when stopped, e.g. queued in a jam.'
  );
  tip(
    fDrv
      .add(ui, 'maxAccel', ...(imp ? [1.5, 10, 0.5] : [0.5, 3, 0.1]))
      .name(`Max accel (${accU})`)
      .onChange((v) => (params.maxAccel = v * acc)),
    'How hard cars accelerate toward their desired speed. Higher helps jams recover faster.'
  );
  tip(
    fDrv
      .add(ui, 'comfortBrake', ...(imp ? [1.5, 13, 0.5] : [0.5, 4, 0.1]))
      .name(`Comfort brake (${accU})`)
      .onChange((v) => (params.comfortBrake = v * acc)),
    'Deceleration drivers consider comfortable. They plan their approach to slower traffic so they rarely have to brake harder than this.'
  );

  const fLc = gui.addFolder('Lane changing');
  tip(
    fLc.add(params, 'politeness', 0, 1, 0.05).name('Politeness'),
    'How much a driver weighs the braking they would force on the car they cut in front of. 0 = selfish weaving; 1 = only change lanes when the overall benefit is positive.'
  );
  tip(
    fLc
      .add(ui, 'laneChangeThreshold', ...(imp ? [0.15, 3.3, 0.05] : [0.05, 1, 0.05]))
      .name(`Incentive threshold (${accU})`)
      .onChange((v) => (params.laneChangeThreshold = v * acc)),
    'Minimum acceleration advantage required to bother changing lanes. Higher = calmer traffic with fewer lane changes; prevents ping-ponging between lanes.'
  );
  tip(
    fLc
      .add(ui, 'safeBrake', ...(imp ? [6.5, 26, 0.5] : [2, 8, 0.5]))
      .name(`Safe braking limit (${accU})`)
      .onChange((v) => (params.safeBrake = v * acc)),
    'Safety veto: a lane change is forbidden if it would force the new follower to brake harder than this. Higher = drivers accept (and force) tighter gaps.'
  );
  fLc.close();

  const fRamps = gui.addFolder('Ramps');
  const onTip = (which) =>
    `Cars per minute trying to enter at on-ramp ${which}. The map label shows how many actually merge — throughput drops when the ramp queue backs up.`;
  const offTip = (which) =>
    `Percentage of passing cars that choose exit ${which}. Each car decides about ${imp ? '700 ft' : '220 m'} upstream, then works its way to the outer lane.`;
  tip(fRamps.add(params, 'onRampA', 0, 40, 0.5).name('On-ramp A (cars/min)'), onTip('A'));
  tip(fRamps.add(params, 'onRampB', 0, 40, 0.5).name('On-ramp B (cars/min)'), onTip('B'));
  tip(fRamps.add(params, 'offRampA', 0, 50, 1).name('Exit A share (%)'), offTip('A'));
  tip(fRamps.add(params, 'offRampB', 0, 50, 1).name('Exit B share (%)'), offTip('B'));
  tip(
    fRamps
      .add(ui, 'rampSpeed', ...(imp ? [20, 60, 5] : [30, 100, 5]))
      .name(`Ramp speed (${spdU})`)
      .onChange((v) => (params.rampSpeed = v * spd)),
    'Target speed on ramp pavement. In the merge zone, entering cars accelerate past this to match mainline traffic.'
  );

  const fEvents = gui.addFolder('Events');
  tip(
    fEvents.add({ bd: () => sim.triggerBreakdown() }, 'bd').name('🔧 Random breakdown'),
    'A random car pulls over to the breakdown lane, parks with hazards for the incident duration, then merges back into traffic. Passing cars slow down to look.'
  );
  tip(
    fEvents.add({ ac: () => sim.triggerRandomAccident() }, 'ac').name('💥 Random accident'),
    'A random car crashes where it is, blocking its lane until cleared. You can also click any car on the map to crash that specific one.'
  );
  tip(
    fEvents.add(params, 'accidentLanes', 1, 2, 1).name('Accident size (lanes)'),
    'How many lanes an accident blocks: 2 also drags the nearest car in the adjacent lane into the pileup.'
  );
  tip(
    fEvents.add(params, 'incidentDuration', 15, 300, 5).name('Duration (s)'),
    'How long a breakdown stays parked on the shoulder, and how long a wreck blocks its lane before being cleared away.'
  );
  tip(
    fEvents.add(params, 'rubberneck', 0, 1, 0.05).name('Rubbernecking'),
    'How much passing drivers slow down to gawk at an incident, strongest in the lanes closest to it. Even a shoulder breakdown that blocks nothing can collapse throughput.'
  );
  tip(
    fEvents.add({ cl: () => sim.clearIncidents() }, 'cl').name('Clear all events'),
    'Immediately remove every active breakdown and accident (the involved cars vanish).'
  );

  const fView = gui.addFolder('View');
  tip(
    fView.add(params, 'showCharts').name('Live charts'),
    'Show rolling 5-minute charts of average speed, flow, and cars on road. Red bands mark stretches where an incident was active. Hover a chart to read off a past value.'
  );
  tip(
    fView.add(params, 'showDiagram').name('Space-time diagram'),
    'Position × time heatmap of speeds: each column is one second, bottom to top is one lap of the loop (ticks mark the ramps). Jams appear as red bands drifting down-right — the wave rolls upstream even though every car in it drives forward.'
  );
  tip(
    fView
      .add(params, 'colorMode', { 'By speed': 'speed', 'Per car': 'random' })
      .name('Car colors'),
    'By speed: red = stopped, green = at desired speed — jams pop out instantly. Per car: each car keeps a fixed random color, good for following individuals.'
  );
  tip(
    fView
      .add({ chase: () => renderer.startChase(sim.randomEligibleCar()) }, 'chase')
      .name('🎥 Chase a car'),
    'Ride along behind a random car, with a live speedometer. Press again to switch cars; Esc or either view button returns to the free camera.'
  );
  tip(
    fView.add({ top: () => renderer.setTopView() }, 'top').name('Overhead view'),
    'Look straight down at the whole loop.'
  );
  tip(
    fView.add({ def: () => renderer.setDefaultView() }, 'def').name('Perspective view'),
    'Return to the default three-quarter camera.'
  );
  fView.close();

  return gui;
}
