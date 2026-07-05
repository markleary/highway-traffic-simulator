let nextId = 1;

export class Car {
  constructor({ s = 0, lane = 0, v = 0, v0Factor = 1 } = {}) {
    this.id = nextId++;
    this.len = 4.6; // m

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
