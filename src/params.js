// Unit conversions — factor × display-unit = SI. All values in `params` are
// SI (m, s, m/s, m/s²); units only exist at the display layer (panel + HUD).
export const KMH = 1 / 3.6; // km/h → m/s
export const MPH = 0.44704; // mph → m/s
export const FT = 0.3048;   // ft → m (and ft/s² → m/s²)

// Every live-tunable knob lives here. The GUI mutates this object directly and
// the simulation reads it on every step, so changes take effect immediately.
export const params = {
  // time
  paused: false,
  timeScale: 1.0,

  // display
  units: 'imperial', // 'imperial' | 'metric' — display only, internals are SI
  colorMode: 'speed', // 'speed' | 'random'
  showCharts: true,
  showDiagram: true, // space-time heatmap section of the charts panel
  // flow × density scatter section of the charts panel. Its default is
  // viewport-aware: the full panel stands ~630 px above the window bottom and
  // the HUD owns the top ~170, so on shorter windows the section starts
  // hidden (still toggleable) instead of painting over the HUD. The window
  // guard keeps the headless smoke test (Node) importable.
  showFundamental: typeof window !== 'undefined' && window.innerHeight >= 800,
  showFps: false, // FPS row at the bottom of the HUD (the F key toggles it too)

  // road
  roadShape: 'circle', // key into SHAPES (road.js); applied by Simulation.reset()
  roadScale: 1,        // multiplies the shape's radii and straights; applied on reset
  interchanges: 2,     // requested interchange count (2-4); shapes build what fits
  lanes: 3,

  // traffic mix
  truckShare: 10, // % of vehicles that are semi trucks (new spawns / reset)
  accShare: 0,    // % of cars (trucks excluded) driving on adaptive cruise control

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

  // events
  incidentDuration: 90, // s — how long a breakdown stays parked / a wreck blocks
  rubberneck: 0.5,      // 0–1: how much passing traffic slows to gawk
  accidentLanes: 1,     // cars involved in a triggered accident (1 or 2 lanes)
};
