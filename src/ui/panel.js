import GUI from 'lil-gui';
import { params, KMH, MPH, FT, smallScreen, onSmallScreenChange, ownDisplay } from '../params.js';
import { SHAPES, RAMPS } from '../sim/road.js';
import { PRESETS, applyPreset } from '../presets.js';

// survives panel rebuilds so the dropdown keeps showing the applied scenario
const presetState = { scenario: '' };

// params holds SI values only. Sliders with units bind to a proxy object in
// display units and write converted SI back on change; toggling units tears
// the panel down and rebuilds it with new labels, ranges and proxy values
// (changing the interchange count rebuilds it too, so the Ramps folder shows
// exactly the ramps that exist).
export function buildPanel({ sim, renderer }) {
  let gui = null;
  // phones start collapsed to the title bar: a 245 px panel on a ~430 px
  // screen buries the map and collides with the HUD. Open state survives
  // rebuilds (units/interchange/preset changes) — collapsing under the
  // finger that just moved a slider would be hostile.
  let open = !smallScreen();
  let touched = false; // the user toggled the panel: it's theirs now
  const rebuild = () => {
    if (gui) {
      open = !gui._closed;
      gui.destroy();
      hideTip(); // the row it points at just went away
    }
    // defer: destroying the GUI from inside its own onChange handler
    gui = makeGui({ sim, renderer, onRebuild: () => setTimeout(rebuild, 0) });
    // user toggles claim the panel. Watch the title CLICK, not onOpenClose:
    // lil-gui routes taps and keyboard Enter/Space through $title.click(),
    // while programmatic open()/close() (rebuild restore, breakpoint flip)
    // dispatch no click — so intent is read at its source and programmatic
    // toggles can never claim the panel by accident
    gui.$title.addEventListener('click', () => { touched = true; });
    if (!open) gui.close();
    // CSS centers the chase speedometer in the strip left of the panel
    // column only while the column actually hangs open (index.html)
    document.body.classList.toggle('panel-open', open);
  };
  rebuild();
  // collapsed-on-phones keeps tracking the breakpoint (rotation, a resize
  // across it) until the user has claimed the panel by toggling it
  onSmallScreenChange((small) => {
    if (touched) return;
    hideTip(); // no tap accompanies a breakpoint flip, so dismiss it here
    if (small) gui.close();
    else gui.open();
  });
}

// --- Tesla dropdown fallback -------------------------------------------
// Tesla's in-car browser is Chromium inside Tesla's own UI shell, and the
// shell never renders the native <select> picker — so tapping lil-gui's
// dropdowns (a transparent <select> stacked over a styled display div)
// does nothing there. Stand in a small in-page menu instead: its rows
// drive the real <select> (selectedIndex + a change event), so lil-gui's
// whole pipeline — onChange, onFinishChange, updateDisplay — runs
// untouched. `?tesla` forces it on for testing in a normal browser.
const SELECT_FALLBACK =
  /Tesla/.test(navigator.userAgent) || new URLSearchParams(location.search).has('tesla');

function wireSelectFallback(gui) {
  if (!SELECT_FALLBACK) return;
  let menu = null;
  let owner = null; // the option controller whose menu is open
  const close = () => {
    if (!menu) return;
    menu.remove();
    owner.$display.classList.remove('focus');
    menu = owner = null;
    document.removeEventListener('pointerdown', onOutside, true);
  };
  // dismiss-anywhere; the owner's own select toggles itself closed instead
  // (this capture listener runs first, so skipping it here avoids a
  // close-then-reopen on the same tap)
  const onOutside = (e) => {
    if (!menu.contains(e.target) && e.target !== owner.$select) close();
  };
  const open = (ctrl) => {
    close();
    const r = ctrl.$widget.getBoundingClientRect();
    menu = document.createElement('div');
    menu.className = 'gui-menu';
    menu.style.minWidth = `${r.width}px`;
    ctrl._names.forEach((name, i) => {
      const row = document.createElement('div');
      row.textContent = name;
      if (i === ctrl.$select.selectedIndex) row.classList.add('selected');
      // click, not pointerdown: a scroll drag on a long menu must not commit
      row.addEventListener('click', () => {
        ctrl.$select.selectedIndex = i;
        ctrl.$select.dispatchEvent(new Event('change'));
        close();
      });
      menu.appendChild(row);
    });
    // parented inside the gui root: inherits lil-gui's theme variables, and
    // a panel rebuild destroys it with everything else. position:fixed still
    // measures against the viewport (lil-gui never transforms its root).
    gui.domElement.appendChild(menu);
    const m = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - m.width - 8))}px`;
    menu.style.top =
      r.bottom + 2 + m.height > window.innerHeight - 8
        ? `${Math.max(8, r.top - m.height - 2)}px` // no room below: open upward
        : `${r.bottom + 2}px`;
    ctrl.$display.classList.add('focus'); // the halo the select would get
    owner = ctrl;
    document.addEventListener('pointerdown', onOutside, true);
  };
  for (const ctrl of gui.controllersRecursive()) {
    if (!ctrl.$select) continue;
    ctrl.$select.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // no native picker attempt, no focus grab
      if (owner === ctrl) close();
      else open(ctrl);
    });
  }
  gui.domElement.addEventListener('scroll', close, true); // panel scrolled under it
}

// --- panel tooltips ---------------------------------------------------
// Native `title` tooltips never show on touch devices, and the tip copy is
// half the panel's teaching value. One shared .gui-tip div instead: a mouse
// gets a faster, wrapping hover tooltip on the whole row; touch long-presses
// a control's LABEL (never the widget half, so it can't fight a slider
// drag). Any tap anywhere dismisses it.
let tipEl = null;
let tipTimer = 0;

function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.style.display = 'none';
}

function showTip(row) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'gui-tip';
    document.body.appendChild(tipEl);
    // dismiss-anywhere, for the touch path (a mouse gets pointerout).
    // Capture phase: it runs before wireTips' pointerdown arms a new press.
    document.addEventListener('pointerdown', hideTip, true);
  }
  tipEl.textContent = row.dataset.tip;
  tipEl.style.display = 'block';
  const r = row.getBoundingClientRect();
  const t = tipEl.getBoundingClientRect();
  // left of the panel row, clamped on-screen. On a phone it may overlay the
  // panel itself — it sits above it (z-index) and any tap dismisses it.
  tipEl.style.left = `${Math.max(8, r.left - t.width - 10)}px`;
  tipEl.style.top = `${Math.min(Math.max(8, r.top), window.innerHeight - t.height - 8)}px`;
}

// Tag a controller's row with tip text (rendered by the listeners below).
function tip(ctrl, text) {
  ctrl.domElement.dataset.tip = text;
  return ctrl;
}

function wireTips(gui) {
  const root = gui.domElement;
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return; // no popups mid-drag
    const row = e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    if (row) tipTimer = setTimeout(() => showTip(row), 350);
  });
  root.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse') return;
    const row = e.target.closest('[data-tip]');
    if (row && row.contains(e.relatedTarget)) return; // still inside the row
    hideTip();
  });
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const label = e.target.closest('.name');
    const row = label && label.closest('[data-tip]');
    if (!row) return;
    tipTimer = setTimeout(() => showTip(row), 450); // long-press
    const cancel = () => clearTimeout(tipTimer);
    window.addEventListener('pointerup', cancel, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
  });
  root.addEventListener('scroll', hideTip, true); // panel scrolled under the tip
}

function makeGui({ sim, renderer, onRebuild }) {
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
    workZoneLen: Math.round(params.workZoneLen / acc),
  };

  const gui = new GUI({ title: 'Traffic Controls' });
  tip(
    gui
      .add(presetState, 'scenario', {
        '— pick a scenario —': '',
        ...Object.fromEntries(Object.entries(PRESETS).map(([key, p]) => [p.label, key])),
      })
      .name('Scenario')
      .onChange((key) => {
        if (!key) return;
        applyPreset(key, sim);
        renderer.onRoadChanged(); // preset may toggle the work zone etc.
        onRebuild(); // sliders must show the preset's values
      }),
    'One-click demo setups: applies a curated parameter regime and resets the road.\n' +
      Object.values(PRESETS)
        .map((p) => `• ${p.label}: ${p.tip}`)
        .join('\n')
  );
  tip(
    gui
      .add(params, 'units', { 'Imperial (mph)': 'imperial', 'Metric (km/h)': 'metric' })
      .name('Units')
      .onChange(onRebuild),
    'Display units for speeds, gaps and accelerations. The simulation itself always runs in SI internally.'
  );

  const fSim = gui.addFolder('Simulation');
  tip(fSim.add(params, 'paused').name('Paused').listen(), 'Freeze the simulation. The spacebar toggles this too.');
  tip(
    fSim.add(params, 'timeScale', 0.1, 8, 0.1).name('Time scale'),
    'Simulation speed multiplier: 2 runs at twice real time, 0.5 at half.'
  );
  tip(
    fSim.add(params, 'initialCars', 0, 600, 5).name('Cars on reset'),
    'How many cars are seeded around the loop when you press Reset. If they can\'t all fit (small road, many cars), as many as physically fit are seeded.'
  );
  tip(
    fSim.add({ reset: () => sim.reset() }, 'reset').name('↻ Reset simulation'),
    'Remove all cars and reseed the loop with "Cars on reset" cars.'
  );

  const fRoad = gui.addFolder('Road');
  const shapeOptions = Object.fromEntries(
    Object.entries(SHAPES).map(([id, shape]) => [shape.label, id])
  );
  // Any geometry knob can change how many interchanges FIT (shape and scale
  // included, not just the count knob), so they all reset the sim and rebuild
  // the panel — the Ramps folder is generated from the ramps that exist.
  // onFinishChange: one reset per adjustment, not one per slider drag step.
  const geometryChanged = () => {
    sim.reset(); // reads roadShape/roadScale/interchanges; s doesn't map across geometries
    renderer.onRoadChanged();
    onRebuild();
  };
  tip(
    fRoad.add(params, 'roadShape', shapeOptions).name('Shape').onFinishChange(geometryChanged),
    'Shape of the highway loop. Changing it rebuilds the road and reseeds traffic — the physics is identical on every shape; only the scenery bends.'
  );
  tip(
    fRoad
      .add(params, 'roadScale', 1, 3, 0.5)
      .name('Road scale (×)')
      .onFinishChange(geometryChanged),
    'Multiplies the loop\'s size: 3× the circle is ~2 miles around. Longer stretches between interchanges give jam waves room to develop, travel, and dissolve on their own — watch the space-time diagram grow parallel stripes. Changing it rebuilds the road and reseeds traffic.'
  );
  tip(
    fRoad
      .add(params, 'interchanges', 2, 4, 1)
      .name('Interchanges')
      .onFinishChange(geometryChanged),
    'How many exit + on-ramp interchanges the loop gets (each has its own sliders below). Shapes fit what their geometry allows: the beltway takes 4 at any size, the 1× circle fits 3 (scale it to 1.5× for the 4th), and the speedway and grand prix need Road scale 2× before mid-straight interchanges fit.'
  );
  tip(
    fRoad
      .add(params, 'lanes', 2, 4, 1)
      .name('Lanes')
      .onChange(() => {
        sim.onLaneCountChanged();
        renderer.buildRoad();
        // the work zone closes whichever lane is innermost NOW — the cones
        // must move to it with the physics (Codex review)
        renderer.onWorkZoneChanged();
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

  // One slider per ramp that actually exists (RAMPS follows the interchange
  // knob); changing the count rebuilds the panel so this list stays true.
  const fRamps = gui.addFolder('Ramps');
  tip(
    fRamps.add(params, 'metering').name('🚦 Ramp meters'),
    'Signals at every on-ramp release one car per green instead of letting platoons shove in. Queues grow on the ramps, but the mainline keeps flowing — the classic counterintuitive fix. Applies live.'
  );
  tip(
    fRamps.add(params, 'meterRate', 2, 20, 1).name('Meter rate (cars/min)'),
    'Greens per minute at each meter. Sweep it: too high and the meter never binds, too low and the ramps starve the road while queues explode.'
  );
  const onTip = (which) =>
    `Cars per minute trying to enter at on-ramp ${which}. The map label shows how many actually merge — throughput drops when the ramp queue backs up.`;
  const offTip = (which) =>
    `Percentage of passing cars that choose exit ${which}. Each car decides about ${imp ? '700 ft' : '220 m'} upstream, then works its way to the outer lane.`;
  for (const ramp of RAMPS.filter((r) => r.type === 'on')) {
    tip(fRamps.add(params, ramp.rateKey, 0, 40, 0.5).name(`${ramp.label} (cars/min)`), onTip(ramp.label.slice(-1)));
  }
  for (const ramp of RAMPS.filter((r) => r.type === 'off')) {
    tip(fRamps.add(params, ramp.rateKey, 0, 50, 1).name(`${ramp.label} share (%)`), offTip(ramp.label.slice(-1)));
  }
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
    fEvents.add({ amb: () => sim.spawnAmbulance() }, 'amb').name('🚑 Emergency vehicle'),
    'Send an ambulance around the loop well above the speed limit. Traffic ahead of the siren slows and pulls out of its lane — the "move over" corridor is emergent, not scripted. It weaves through whatever does not clear, and leaves the map after about a lap and a half.'
  );
  tip(
    fEvents.add({ storm: () => sim.startStorm() }, 'storm').name('🌧 Rain storm'),
    'A three-minute storm: rolls in over 40 s, pours, then clears. Wet roads mean ~30% slower targets, half again the following distance, and less grip — watch a busy regime tip into stop-and-go as it peaks. The line charts shade blue while it rains.'
  );
  tip(
    fEvents.add(params, 'rain', 0, 1, 0.05).name('Rain (steady)'),
    'Steady rain level, applied live: 0 = dry, 1 = downpour. The storm button peaks over whatever is set here.'
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
  tip(
    fEvents
      .add(params, 'workZone')
      .name('🚧 Work zone')
      .onChange(() => renderer.onWorkZoneChanged()),
    'Cone off the innermost lane over a stretch of road. Approaching traffic merges out at the taper — zipper merging, early-vs-late mergers, and the capacity drop all emerge. Applies live: cars caught inside work their way out.'
  );
  tip(
    fEvents
      .add(params, 'workZonePos', 0, 100, 1)
      .name('Zone position (%)')
      .onChange(() => renderer.onWorkZoneChanged()),
    'Where the cones start, as a fraction of the way around the loop from the start line.'
  );
  tip(
    fEvents
      .add(ui, 'workZoneLen', ...(imp ? [330, 2600, 30] : [100, 800, 10]))
      .name(`Zone length (${lenU})`)
      .onChange((v) => {
        params.workZoneLen = v * acc;
        renderer.onWorkZoneChanged();
      }),
    'How much road the cones close off. Longer zones move the bottleneck, not its capacity — the queue lives at the taper.'
  );

  const fView = gui.addFolder('View');
  // chart toggles: .listen() so a viewport-driven auto flip (watchViewport)
  // shows in the checkbox; .onChange claims the knob for the user for good
  tip(
    fView.add(params, 'showCharts').name('Live charts').listen()
      .onChange(() => ownDisplay('showCharts')),
    'Show rolling 5-minute charts of average speed, flow, and cars on road. Red bands mark stretches where an incident was active. Hover a chart to read off a past value.'
  );
  tip(
    fView.add(params, 'showDiagram').name('Space-time diagram').listen()
      .onChange(() => ownDisplay('showDiagram')),
    'Position × time heatmap of speeds: each column is one second, bottom to top is one lap of the loop (ticks mark the ramps). Jams appear as red bands drifting down-right — the wave rolls upstream even though every car in it drives forward. Click anywhere on it to fly the camera to that stretch of road.'
  );
  tip(
    fView.add(params, 'showFundamental').name('Fundamental diagram').listen()
      .onChange(() => ownDisplay('showFundamental')),
    'Flow vs density, the canonical traffic plot: one dot per second, colored by average speed and fading with age. Free-flowing dots ride the dashed diagonal (slope = desired speed); when the road saturates they break off it — flow collapsing while density keeps rising.'
  );
  tip(
    fView.add(params, 'showFps').name('FPS counter').listen(),
    "Show the renderer's frames per second at the bottom of the stats panel. The F key toggles this too."
  );
  tip(
    fView.add(params, 'scenery').name('Scenery'),
    'Landscape dressing: trees, hills, clouds. Purely cosmetic — turn it off for maximum frame rate on modest hardware.'
  );
  tip(
    fView
      .add(params, 'colorMode', { 'By speed': 'speed', 'By type': 'type', 'Per car': 'random' })
      .name('Car colors'),
    'By speed: red = stopped, green = at desired speed — jams pop out instantly. By type: human / adaptive-cruise / truck each get a fixed color (see the legend) — watch who absorbs the waves. Per car: each car keeps a fixed random color, good for following individuals.'
  );
  tip(
    fView
      .add({ chase: () => renderer.startChase(sim.randomEligibleCar()) }, 'chase')
      .name('🎥 Chase a car'),
    'Ride along behind a random car, with a live speedometer. Hold the left mouse button to swing the camera around the car — it eases back behind on release. Press again (or the C key) to switch cars; Esc or either view button returns to the free camera.'
  );
  tip(
    fView.add({ top: () => renderer.setTopView() }, 'top').name('Overhead view'),
    'Look straight down at the whole loop. The V key cycles perspective → overhead → chase.'
  );
  tip(
    fView.add({ def: () => renderer.setDefaultView() }, 'def').name('Perspective view'),
    'Return to the default three-quarter camera.'
  );
  fView.close();

  // Opening/collapsing the panel (folders too) resizes the column that
  // renderer.viewFit reserves; re-fit a parked auto view once lil-gui's
  // ~300 ms height transition lands so the measurement sees the final rect.
  // Registered last: the fLc/fView.close() calls above shouldn't fire it.
  gui.onOpenClose((changed) => {
    if (changed === gui) document.body.classList.toggle('panel-open', !gui._closed);
    setTimeout(() => renderer.refitView(), 350);
  });

  // The keyboard shortcuts gate on focus being off the panel (main.js), but
  // lil-gui parks focus on the last-touched widget — space then re-toggles
  // that checkbox (or re-fires that button) instead of pausing, and c/v/f
  // go dead until a click lands elsewhere. Hand focus back once an
  // interaction commits — but only a POINTER-driven one: a keyboard user
  // who tabbed in and toggled with Space keeps focus, so Tab continues
  // from where they were (Codex review). Text entry keeps focus while
  // typing (lil-gui number fields blur themselves on Enter).
  let pointerDriven = false;
  gui.domElement.addEventListener('pointerdown', () => (pointerDriven = true), true);
  gui.domElement.addEventListener('keydown', () => (pointerDriven = false), true);
  gui.onFinishChange(() => {
    if (!pointerDriven) return;
    const el = document.activeElement;
    if (el && gui.domElement.contains(el) && !(el.tagName === 'INPUT' && el.type === 'text')) {
      el.blur();
    }
  });
  gui.domElement.addEventListener('click', (e) => {
    if (e.detail === 0) return; // keyboard activation: leave tab focus alone
    // function buttons are <button>; folder/root titles are div.title[tabindex]
    const b = e.target.closest('button, .title');
    if (b) setTimeout(() => b.blur(), 0);
  });
  wireTips(gui);
  wireSelectFallback(gui);

  return gui;
}
