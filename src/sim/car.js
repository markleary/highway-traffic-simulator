let nextId = 1;

// 'acc' is an adaptive-cruise-control car: same size and speed habits as a
// human-driven car, but it follows with the constant-acceleration heuristic
// (see simulation.js) so it absorbs jam waves instead of amplifying them.
export const VEHICLE_LEN = { car: 4.6, truck: 16.5, acc: 4.6 }; // m

export class Car {
  constructor({ s = 0, lane = 0, v = 0, v0Factor = 1, kind = 'car' } = {}) {
    this.id = nextId++;
    this.kind = kind; // 'car' | 'truck' | 'acc'
    this.len = VEHICLE_LEN[kind];
    if (kind === 'truck') {
      // Loaded semi: accelerates lazily, brakes gently, follows at a bigger
      // time gap. These scale the global IDM knobs per vehicle.
      this.accelK = 0.35;
      this.headwayK = 1.6;
      this.brakeK = 0.8;
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

    this.v0Factor = v0Factor; // personal multiplier on the desired-speed knob
    this.exitRamp = null;     // off-ramp this car has decided to take
    this.lcCooldown = Math.random(); // staggers lane-change decisions
    this.hue = Math.random(); // for the 'random' color mode
  }
}
