const TURN = 2 * Math.PI;
const wrapAngle = angle => ((angle % TURN) + TURN) % TURN;

// Cosmetic rolling state lives with the renderer, not the traffic model. The
// fixed-step loop advances it after physics has resolved each vehicle's speed;
// display frames sample the same interpolation fraction as the vehicle pose.
export class WheelMotion {
  constructor() {
    this.states = new WeakMap();
  }

  advance(car, dt, radius) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    let state = this.states.get(car);
    if (!state) {
      state = { angle: 0, start: 0, step: 0 };
      this.states.set(car, state);
    }
    state.start = state.angle;
    // +X angular velocity makes the bottom of a wheel move toward -Z,
    // cancelling forward +Z translation at the contact patch: omega = v/r.
    state.step = (Number.isFinite(car.v) ? car.v : 0) * dt / radius;
    state.angle = wrapAngle(state.start + state.step);
  }

  angle(car, alpha = 1) {
    const state = this.states.get(car);
    if (!state) return 0;
    // Interpolate the signed step, not two wrapped angles: a revolution must
    // cross 2pi smoothly rather than turning backward to reach the endpoint.
    return wrapAngle(state.start + state.step * Math.max(0, Math.min(1, alpha)));
  }
}
