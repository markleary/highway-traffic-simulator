let nextId = 1;

// 'acc' is an adaptive-cruise-control car: same size and speed habits as a
// human-driven car, but it follows with the constant-acceleration heuristic
// (see simulation.js) so it absorbs jam waves instead of amplifying them.
// Emergency vehicles share the siren-run behavior in simulation.js, but their
// size, target speed, and IDM response reflect the very different hardware.
export const EMERGENCY_PROFILES = Object.freeze({
  ambulance: Object.freeze({
    length: 5.4,
    v0Factor: 1.55,
    accelK: 1.5,
    headwayK: 0.55,
    brakeK: 1.1,
  }),
  police: Object.freeze({
    length: 5.0,
    v0Factor: 1.7,
    accelK: 2.0,
    headwayK: 0.5,
    brakeK: 1.25,
  }),
  firetruck: Object.freeze({
    length: 10.5,
    v0Factor: 1.25,
    accelK: 0.6,
    headwayK: 0.8,
    brakeK: 0.85,
  }),
});

export const EMERGENCY_KINDS = Object.freeze(Object.keys(EMERGENCY_PROFILES));

const VEHICLE_LABELS = Object.freeze({
  car: 'Car',
  acc: 'ACC car',
  truck: 'Semi-truck',
  ambulance: 'Ambulance',
  police: 'Police car',
  firetruck: 'Fire truck',
});

export function isEmergencyVehicle(kind) {
  return Object.prototype.hasOwnProperty.call(EMERGENCY_PROFILES, kind);
}

export function vehicleLabel(kind) {
  return VEHICLE_LABELS[kind] ?? 'Vehicle';
}

export const VEHICLE_LEN = Object.freeze({
  car: 4.6,
  truck: 16.5,
  acc: 4.6,
  ...Object.fromEntries(
    EMERGENCY_KINDS.map((kind) => [kind, EMERGENCY_PROFILES[kind].length])
  ),
}); // m

export class Car {
  constructor({ s = 0, lane = 0, v = 0, v0Factor, kind = 'car' } = {}) {
    this.id = nextId++;
    this.kind = kind; // 'car' | 'truck' | 'acc' | an EMERGENCY_KINDS entry
    this.len = VEHICLE_LEN[kind];
    const emergency = EMERGENCY_PROFILES[kind];
    if (kind === 'truck') {
      // Loaded semi: accelerates lazily, brakes gently, follows at a bigger
      // time gap. These scale the global IDM knobs per vehicle.
      this.accelK = 0.35;
      this.headwayK = 1.6;
      this.brakeK = 0.8;
    } else if (emergency) {
      this.accelK = emergency.accelK;
      this.headwayK = emergency.headwayK;
      this.brakeK = emergency.brakeK;
    } else {
      this.accelK = 1;
      this.headwayK = 1;
      this.brakeK = 1;
    }

    // mainline state (valid when state === 'main')
    this.s = s;
    this.sPrev = s;
    this.lane = lane;
    this.renderLane = lane; // smoothed lateral position, rendering only

    // ramp state (valid when state is 'onramp' / 'offramp')
    this.ramp = null;
    this.rampPos = 0; // m along the ramp curve

    this.state = 'main'; // 'main' | 'onramp' | 'offramp'
    this.v = v;  // m/s
    this.a = 0;  // m/s²

    this.v0Factor = v0Factor ?? emergency?.v0Factor ?? 1; // personal multiplier on desired speed
    this.exitRamp = null;     // off-ramp this car has decided to take
    this.lcCooldown = Math.random(); // staggers lane-change decisions
    this.hue = Math.random(); // for the 'random' color mode

    // driver-communication lights, resolved each step (see sim.updateLights)
    this.brakeLit = false;
    this.signal = 0;      // +1 = blinking inward (driver's left), -1 = outward
    this.signalWant = 0;  // MOBIL desire that was blocked (applyLaneChanges)
    this.signalUntil = 0; // sim time the blocked desire expires

    // Compatibility for callers/tests that predate generic emergency vehicles.
    // The canonical field is emergencyDist; ambDist remains a live alias.
    if (emergency) {
      Object.defineProperty(this, 'ambDist', {
        configurable: true,
        enumerable: true,
        get() {
          return this.emergencyDist;
        },
        set(value) {
          this.emergencyDist = value;
        },
      });
    }
  }
}
