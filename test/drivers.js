import assert from 'node:assert/strict';
import { Car, EMERGENCY_PROFILES } from '../src/sim/car.js';
import { driverProfile, driverFactor, driverResponse } from '../src/sim/drivers.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12,
  `expected ${expected}, got ${actual}`);
const keys = ['headway', 'accel', 'politeness', 'response'];
const bounds = { headway: [0.6, 1.4], accel: [0.65, 1.35], politeness: [0.3, 1.7], response: [0.65, 1.35] };

// Deterministic profiles do not consume the stream used for demand, model
// selection, or lane-decision staggering, and survive live diversity changes.
const savedRandom = Math.random;
Math.random = () => { throw new Error('driver profiles must not consume random draws'); };
try {
  const totals = Object.fromEntries(keys.map(key => [key, 0]));
  for (let id = 1; id <= 10000; id++) {
    const driver = driverProfile(id);
    assert.ok(Object.isFrozen(driver));
    assert.deepEqual(driver, driverProfile(id));
    assert.deepEqual(driver, driverProfile(id, 'truck'));
    const car = { kind: 'car', driver };
    for (const key of keys) {
      const [lo, hi] = bounds[key];
      assert.ok(driver[key] >= lo && driver[key] <= hi);
      near(driverFactor(car, key, 0), 1);
      near(driverFactor(car, key, 0.2), 1 + (driver[key] - 1) * 0.2);
      near(driverFactor(car, key, 1), driver[key]);
      near(driverFactor(car, key, 10), driver[key]);
      near(driverFactor(car, key, -1), 1);
      totals[key] += driver[key];
    }
  }
  for (const key of keys) assert.ok(Math.abs(totals[key] / 10000 - 1) < 0.015);
  assert.notDeepEqual(driverProfile(12), driverProfile(13));
} finally {
  Math.random = savedRandom;
}

const driver = driverProfile(23);
const human = { kind: 'car', model: 'ev', driver, v: 25, a: 0 };
const opts = { responseTime: 0.6, variation: 0.2 };
const tau = 0.6 * driverFactor(human, 'response', 0.2);
near(driverResponse(human, 2, 0.1, opts), 2 * (1 - Math.exp(-0.1 / tau)));
assert.ok(driverResponse(human, 2, 0.1, opts) > 0);
assert.ok(driverResponse(human, 2, 0.1, opts) < 2);
near(driverResponse(human, 2, 0, opts), 0);
near(driverResponse(human, 2, 0.1, { responseTime: 0 }), 2);
near(driverResponse({ ...human, model: 'cybertruck' }, 2, 0.1, opts),
  driverResponse(human, 2, 0.1, opts));

// Exact integration is subdivision invariant while target and scene stay fixed.
let split = { ...human };
for (let i = 0; i < 60; i++) split.a = driverResponse(split, 2, 1 / 60, opts);
near(split.a, driverResponse(human, 2, 1, opts));
near(human.a, 0); // response is pure; caller controls the simultaneous update

// Mild braking adapts; urgent cut-ins / a stopped queue / a hard target do not
// wait for the previous throttle command to decay. Recovery remains gradual.
assert.ok(driverResponse(human, -1, 0.1, opts) > -1);
near(driverResponse({ ...human, a: 1 }, -1, 0.1, opts), 0);
near(driverResponse({ ...human, a: 1 }, -1.5, 0.1,
  { ...opts, gap: 8, leaderSpeed: 15 }), -1.5);
near(driverResponse(human, -1.5, 0.1,
  { ...opts, gap: 100, leaderSpeed: 0 }), -1.5);
near(driverResponse(human, -0.2, 0.1,
  { ...opts, gap: 2, leaderSpeed: 25 }), -0.2);
near(driverResponse(human, -4, 0.1, opts), -4);
assert.ok(driverResponse({ ...human, a: -4 }, 1, 0.1, opts) < 0);

for (const kind of ['acc', ...Object.keys(EMERGENCY_PROFILES)]) {
  const neutral = { ...human, kind, driver: driverProfile(23, kind) };
  for (const key of keys) near(driverFactor(neutral, key, 1), 1);
  near(driverResponse(neutral, 2, 0.1, opts), 2);
  near(driverResponse(neutral, -2, 0.1, opts), -2);
}

// Car integration keeps current vehicle/controller baselines, using only the
// two existing random draws (lane-change staggering and cosmetic hue).
let draws = 0;
Math.random = () => { draws++; return 0.5; };
try {
  const car = new Car({ kind: 'car', model: 'ev' });
  assert.deepEqual(car.driver, driverProfile(car.id, 'car'));
  near(car.len, 4.6);
  near(draws, 2);
  for (const [kind, profile] of Object.entries(EMERGENCY_PROFILES)) {
    const emergency = new Car({ kind });
    near(emergency.accelK, profile.accelK);
    near(emergency.headwayK, profile.headwayK);
    near(emergency.brakeK, profile.brakeK);
    near(emergency.v0Factor, profile.v0Factor);
  }
} finally {
  Math.random = savedRandom;
}

console.log('Driver profile and acceleration-response checks passed.');
