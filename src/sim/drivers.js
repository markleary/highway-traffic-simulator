// Independent human preferences and a bounded acceleration-response model.
// These illustrative ranges are tuning choices, not fitted driver populations.
// Vehicle hardware (accelK/headwayK/brakeK) and body dimensions stay in car.js.
// Adaptation lag is distinct from a pure perception/reaction delay; see Kesting
// & Treiber (2008): https://www.mtreiber.de/publications/timedelay_CACAIE_07.pdf
// We use first-order acceleration adaptation, not their full delayed HDM.

const NEUTRAL = Object.freeze({ headway: 1, accel: 1, politeness: 1, response: 1 });
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

function humanDriver(carOrKind) {
  const kind = typeof carOrKind === 'string' ? carOrKind : carOrKind.kind;
  return kind === 'car' || kind === 'truck';
}

// Stable independent hash streams; profile generation never consumes traffic's
// Math.random sequence or depends on the rendering/body model.
function signedHash(id, salt) {
  let n = (id ^ salt) >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  return ((n ^ (n >>> 15)) >>> 0) / 0xffffffff * 2 - 1;
}

export function driverProfile(id, kind = 'car') {
  if (!humanDriver(kind)) return NEUTRAL;
  return Object.freeze({
    headway: 1 + 0.4 * signedHash(id, 0x25a58e31),
    accel: 1 + 0.35 * signedHash(id, 0x5831d9ab),
    politeness: 1 + 0.7 * signedHash(id, 0x91c723d5),
    response: 1 + 0.35 * signedHash(id, 0xcf21a975),
  });
}

// variation is live, 0..1. Turning it off restores baseline vehicle factors;
// turning it back on restores each driver's original preferences.
export function driverFactor(car, key, variation = 0) {
  if (!humanDriver(car)) return 1;
  const strength = Number.isFinite(variation) ? clamp(variation, 0, 1) : 0;
  return 1 + ((car.driver?.[key] ?? 1) - 1) * strength;
}

// Returns the next actual acceleration, in m/s²; does not mutate car. Call ONCE
// after all occupied-lane/ramp restrictions have selected the target, with
// car.a still holding the previous step's realized acceleration. Keep collision
// guards and prescribed incident stops outside this response model.
//
// da/dt = (target - a)/tau, integrated exactly for a constant target during h.
// The finite response is human-only, independent of car.model. The knob is an
// adaptation time, not a claim that drivers wait tau seconds before reacting.
// Anticipation here is limited to a conservative closing/stopping-distance gate:
// urgent braking uses the requested target immediately. No leader trajectory
// history or multi-vehicle look-ahead is represented.
export function driverResponse(car, target, h, {
  responseTime = 0,
  variation = 0,
  gap = Infinity,
  leaderSpeed = car.v,
  minGap = 2,
  comfortBrake = 2,
} = {}) {
  if (!humanDriver(car) || !(responseTime > 0)) return target;
  const previous = Number.isFinite(car.a) ? car.a : 0;
  if (!(h > 0)) return previous;
  // A bounded knob and trait cannot produce an arbitrarily long feedback lag.
  const tau = clamp(responseTime, 0, 1.5) * driverFactor(car, 'response', variation);
  const amount = -Math.expm1(-h / tau);
  let next = previous + (target - previous) * amount;

  if (target < previous && target < 0) {
    const v = Math.max(0, car.v);
    const vLead = Math.max(0, leaderSpeed);
    const closing = Math.max(0, v - vLead);
    const comfortable = Math.max(0.1, comfortBrake);
    // Extra closing during adaptation plus the difference in stopping
    // distances if both brake comfortably. This conservative preview is only
    // a safety bypass, not an extra IDM braking term.
    const stoppingGap = Math.max(0, minGap) + closing * tau +
      Math.max(0, v * v - vLead * vLead) / (2 * comfortable);
    const urgent = target <= -Math.max(2, 1.5 * comfortable) ||
      (Number.isFinite(gap) && (
        gap <= Math.max(0, minGap) + 0.25 ||
        (closing > 0 && (gap <= stoppingGap || gap / closing < 2))
      ));
    if (urgent) next = target;
    // A request to slow down must not retain positive throttle while the
    // negative part of the acceleration response catches up.
    else next = Math.min(next, 0);
  }
  return next;
}
