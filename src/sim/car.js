import { driverProfile } from './drivers.js';

let nextId = 1;

// 'acc' selects the illustrative adaptive-cruise controller; the separately
// sampled model selects the body and footprint. Neither EV model implies
// calibration to a manufacturer's proprietary controller.
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

export function vehicleLabel(carOrKind) {
  const kind = typeof carOrKind === 'object' ? carOrKind?.kind : carOrKind;
  if (carOrKind && typeof carOrKind === 'object' && kind === 'acc') {
    if (carOrKind.model === 'cybertruck') return 'ACC Cybertruck';
    if (carOrKind.model === 'ev') return 'ACC electric car';
  }
  return VEHICLE_LABELS[kind] ?? 'Vehicle';
}

export const MODEL_LEN = Object.freeze({
  car: 4.6,
  ev: 4.6, // compact electric sedan: exactly the ordinary car's footprint
  cybertruck: 5.683,
  truck: 16.5,
  ...Object.fromEntries(
    EMERGENCY_KINDS.map((kind) => [kind, EMERGENCY_PROFILES[kind].length])
  ),
}); // m

// Compatibility for callers that use a kind's old default length. ACC now
// has two footprints: runtime packing/clearance must use vehicleSpec().len.
export const VEHICLE_LEN = Object.freeze({
  car: MODEL_LEN.car,
  truck: MODEL_LEN.truck,
  acc: MODEL_LEN.cybertruck,
  ...Object.fromEntries(EMERGENCY_KINDS.map((kind) => [kind, MODEL_LEN[kind]])),
});

// Sample once, before testing whether this specific body fits. Passing a
// model explicitly supports controlled IDM/ACC comparisons with the same
// body, dimensions and driver factors; neither controller owns a geometry.
export function vehicleSpec(kind = 'car', model) {
  model ??= kind === 'acc' ? (Math.random() < 0.5 ? 'cybertruck' : 'ev') : kind;
  const passenger = kind === 'car' || kind === 'acc';
  if (!Object.hasOwn(VEHICLE_LEN, kind) ||
      !(passenger ? ['car', 'ev', 'cybertruck'].includes(model) : model === kind)) {
    throw new Error(`Invalid vehicle kind/model: ${kind}/${model}`);
  }
  return { kind, model, len: MODEL_LEN[model] };
}

export class Car {
  constructor({ s = 0, lane = 0, v = 0, v0Factor, kind = 'car', model } = {}) {
    const spec = vehicleSpec(kind, model);
    this.id = nextId++;
    this.kind = kind; // 'car' | 'truck' | 'acc' | an EMERGENCY_KINDS entry
    this.model = spec.model; // stable geometry, independent of the controller/category
    this.len = spec.len;
    this.driver = driverProfile(this.id, kind); // stable preferences; no extra random draws
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
