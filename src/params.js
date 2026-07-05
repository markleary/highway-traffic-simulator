export const KMH = 1 / 3.6; // km/h → m/s

// Every live-tunable knob lives here. The GUI mutates this object directly and
// the simulation reads it on every step, so changes take effect immediately.
export const params = {
  // time
  paused: false,
  timeScale: 1.0,

  // road
  lanes: 3,

  // driver model (IDM)
  desiredSpeedKmh: 110,
  speedVariation: 0.15, // per-car spread around desired speed (fraction, at spawn)
  timeHeadway: 1.4,     // s — "following distance" in time
  minGap: 2.0,          // m — bumper-to-bumper gap when stopped
  maxAccel: 1.4,        // m/s²
  comfortBrake: 2.0,    // m/s²

  // lane changing (MOBIL-style)
  politeness: 0.3,          // how much a car weighs the follower it cuts off
  laneChangeThreshold: 0.2, // m/s² advantage required to bother changing
  safeBrake: 4.0,           // hardest braking a lane change may force on others

  // traffic
  initialCars: 80, // seeded on reset

  // ramps — on-ramps in cars/min, off-ramps in % of passing traffic that exits
  onRampA: 8,
  onRampB: 8,
  offRampA: 6,
  offRampB: 6,
  rampSpeedKmh: 65,

  // rendering
  colorMode: 'speed', // 'speed' | 'random'
};
