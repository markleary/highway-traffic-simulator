// Unit conversions — factor × display-unit = SI. All values in `params` are
// SI (m, s, m/s, m/s²); units only exist at the display layer (panel + HUD).
export const KMH = 1 / 3.6; // km/h → m/s
export const MPH = 0.44704; // mph → m/s
export const FT = 0.3048;   // ft → m (and ft/s² → m/s²)

// Viewport signals as live matchMedia queries: watchViewport() below keeps
// the derived defaults tracking resize/rotation the way the CSS media rules
// in index.html always have (the old boot-time innerWidth reads froze the
// signal at load). `small` is the same expression as the CSS phone
// breakpoint; the min-* queries are inverted so their boundaries match the
// old innerWidth/innerHeight checks. Null under Node (headless smoke test).
const MQ =
  typeof window === 'undefined'
    ? null
    : {
        small: matchMedia('(max-width: 500px), (max-height: 500px)'), // phones, either orientation
        wide: matchMedia('(min-width: 900px)'), // room for chart stack + panel + visible road
        tall: matchMedia('(min-height: 800px)'), // room for the full stack incl. fundamental
      };
export const smallScreen = () => !!MQ && MQ.small.matches;
export function onSmallScreenChange(fn) {
  if (MQ) MQ.small.addEventListener('change', () => fn(MQ.small.matches));
}

// --- device signals -------------------------------------------------------
// Tesla's in-car browser (2026 firmware) presents as plain desktop Linux
// Chrome — the Tesla/ UA token older firmware carried is gone — so the car
// is detected by capability instead: a touch-driven X11-Linux browser is a
// car, or a Linux touchscreen desktop, which the same treatment suits.
// Confirmed firing in-car (2026 Model Y): the car fakes the UA but not its
// touch signals. This is deliberately separate from MQ.small: the car's
// screen is BIG — it keeps the desktop layout (charts, open panel) and only
// the keyboard and native-picker assumptions change.
//
// Query flags: `?tesla` FORCES the Tesla treatment anywhere — the car no
// longer needs it, desktop testing of the fallback still does. `?debug`
// paints main.js's diagnostic panel WITHOUT changing behavior (a diagnostic
// that alters what it measures is no diagnostic); ?tesla implies the panel,
// so the in-car bookmark from the detection hunt keeps working.
const QUERY = typeof location === 'undefined' ? null : new URLSearchParams(location.search);
export const FORCED_TESLA = !!QUERY && QUERY.has('tesla');
export const DEBUG_PANEL = FORCED_TESLA || (!!QUERY && QUERY.has('debug'));
const NAV = typeof navigator === 'undefined' ? null : navigator;
const TOUCH_INPUT =
  !!NAV &&
  (NAV.maxTouchPoints > 0 ||
    (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches));
// the pure heuristic verdict, force excluded — the debug panel reports this
export const DETECTED_TESLA =
  !!NAV &&
  (/tesla|qtcarbrowser/i.test(NAV.userAgent) ||
    (/X11; Linux x86_64/.test(NAV.userAgent) && !/android/i.test(NAV.userAgent) && TOUCH_INPUT));
export const TESLA_BROWSER = FORCED_TESLA || DETECTED_TESLA;
// Touch-first UI (chase button instead of keyboard tips) for any screen
// whose PRIMARY pointer is a finger — iPads masquerade as desktop Macs but
// report a coarse pointer. Windows touch laptops stay desktop: their primary
// pointer is the mouse, and maxTouchPoints alone never flips this (it only
// feeds the Tesla arm above, gated on the X11-Linux UA). Phones pass too,
// redundantly with the CSS phone breakpoint.
export const TOUCH_UI =
  TESLA_BROWSER || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);

// Chart-visibility defaults for the current viewport: phones and narrow
// windows would bury the map under the 320 px stack, and the fundamental
// diagram additionally needs a tall window (the full panel stands ~630 px
// above the window bottom and the HUD owns the top ~170). Node pretends to
// be a big desktop — it never renders.
const chartDefaults = () => ({
  showCharts: !smallScreen() && (!MQ || MQ.wide.matches),
  showDiagram: !smallScreen(), // space-time heatmap section of the charts panel
  showFundamental: !smallScreen() && (!MQ || MQ.tall.matches),
});

// Every live-tunable knob lives here. The GUI mutates this object directly and
// the simulation reads it on every step, so changes take effect immediately.
export const params = {
  // time
  paused: false,
  timeScale: 1.0,

  // display
  units: 'imperial', // 'imperial' | 'metric' — display only, internals are SI
  colorMode: 'speed', // 'speed' | 'random' | 'type' (human / ACC / truck)
  // chart visibility starts viewport-derived and KEEPS tracking viewport
  // changes via watchViewport() below — until a toggle is claimed
  // (ownDisplay: the panel's View toggles, or a preset that stages a chart)
  ...chartDefaults(),
  showFps: false, // FPS row at the bottom of the HUD (the F key toggles it too)
  scenery: true, // landscape dressing (trees, hills, clouds) — off for weak GPUs

  // road
  roadShape: 'circle', // key into SHAPES (road.js); applied by Simulation.reset()
  roadScale: 1,        // multiplies the shape's radii and straights; applied on reset
  interchanges: 2,     // requested interchange count (2-4); shapes build what fits
  lanes: 3,

  // traffic mix
  truckShare: 5,  // % of vehicles that are semi trucks (new spawns / reset)
  accShare: 5,    // % of cars (trucks excluded) driving on adaptive cruise control

  // driver model (IDM)
  desiredSpeed: 70 * MPH, // m/s
  speedVariation: 0.15,   // per-car spread around desired speed (fraction, at spawn)
  timeHeadway: 1.4,       // s — "following distance" in time
  minGap: 2.0,            // m — bumper-to-bumper gap when stopped
  maxAccel: 1.4,          // m/s²
  comfortBrake: 2.0,      // m/s²

  // lane changing (MOBIL-style)
  politeness: 0.3,          // how much a car weighs the follower it cuts off
  laneChangeThreshold: 0.2, // m/s² advantage required to bother changing
  safeBrake: 4.0,           // hardest braking a lane change may force on others

  // traffic
  initialCars: 80, // seeded on reset

  // ramps — on-ramps in cars/min, off-ramps in % of passing traffic that
  // exits. C/D exist for the 3rd/4th interchange and are ignored below that.
  onRampA: 8,
  onRampB: 8,
  onRampC: 8,
  onRampD: 8,
  offRampA: 6,
  offRampB: 6,
  offRampC: 6,
  offRampD: 6,
  rampSpeed: 40 * MPH, // m/s
  metering: false, // signals at every on-ramp release one car per green (live, no reset)
  meterRate: 8,    // greens per minute at each meter — the calibrated rush-flood
                   // rate (see the meters preset / smoke test). Higher rates
                   // (the old default 10–12) barely bind against a 30/min flood
                   // and stop shaping demand — the meter never gets ahead of it.

  // events
  incidentDuration: 90, // s — how long a breakdown stays parked / a wreck blocks
  rubberneck: 0.5,      // 0–1: how much passing traffic slows to gawk
  accidentLanes: 1,     // cars involved in a triggered accident (1 or 2 lanes)
  rain: 0, // 0–1 steady rain level; the storm event (sim.startStorm) peaks over it

  // work zone: cones close the innermost lane over a stretch (sim.workZone).
  // Applies live — no reset; cars caught inside work their way out.
  workZone: false,
  workZonePos: 50, // where the cones start, % of the way around the loop
  workZoneLen: 300, // coned length, m
};

// Factory snapshot, taken before anything mutates params. Scenario presets
// (src/presets.js) spread this back in so every preset starts from the same
// known stage rather than compounding on whatever the sliders last said.
export const DEFAULTS = Object.freeze(JSON.parse(JSON.stringify(params)));

// --- live viewport tracking ---------------------------------------------
// The spread chart defaults above are AUTO values. Until a toggle is
// claimed via ownDisplay(), a breakpoint flip re-derives it live — rotate
// an iPad to landscape and the charts arrive, shrink a desktop window and
// they tuck away. A claimed knob never auto-changes again this session.
const owned = new Set();
export function ownDisplay(key) {
  owned.add(key);
}
export function watchViewport() {
  if (!MQ) return;
  const apply = () => {
    for (const [key, val] of Object.entries(chartDefaults())) {
      if (!owned.has(key)) params[key] = val;
    }
  };
  for (const mq of Object.values(MQ)) mq.addEventListener('change', apply);
}
