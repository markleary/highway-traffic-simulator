import assert from 'node:assert/strict';
import { params, DEFAULTS } from '../src/params.js';
import { Car } from '../src/sim/car.js';
import { Simulation } from '../src/sim/simulation.js';
import { RAMPS, SHOULDER_LANE } from '../src/sim/road.js';
import { laneChangeYaw } from '../src/render/lane-change-heading.js';
import { SceneRenderer } from '../src/render/renderer.js';

Object.assign(params, DEFAULTS, { initialCars: 0 });
const sim = new Simulation();
const car = new Car({ s: 100, lane: 0, v: 2 });
// Exercise renderer interpolation without constructing a DOM/WebGL scene.
const renderer = Object.create(SceneRenderer.prototype);
renderer._previousCarPoses = new WeakMap();
assert.equal(laneChangeYaw(car), 0, 'lane keeping faces along the road');

sim.beginLaneChange(car, 1);
const duration = car.laneChange.duration;
assert.equal(laneChangeYaw(car), 0, 'the maneuver starts without a heading jump');
sim.advanceLaneChange(car, duration / 4);
const quarter = laneChangeYaw(car);
sim.advanceLaneChange(car, duration / 4);
const slow = laneChangeYaw(car);
assert.ok(quarter > 0 && slow > quarter, 'the nose turns left as inward lateral motion builds');
car.v = 30;
assert.ok(laneChangeYaw(car) > 0 && laneChangeYaw(car) < slow,
  'freeway lane changes use less yaw than the same maneuver in slow traffic');
car.v = 0;
assert.ok(Number.isFinite(laneChangeYaw(car)) && laneChangeYaw(car) > 0 &&
  laneChangeYaw(car) <= 12 * Math.PI / 180,
  'a stopped car still leans into the maneuver without rotating sideways');

const before = JSON.stringify(car);
for (let i = 0; i < 100; i++) laneChangeYaw(car);
assert.equal(JSON.stringify(car), before, 'render samples do not advance or mutate traffic state');
car.ramp = RAMPS[0];
assert.equal(laneChangeYaw(car), 0, 'ramps retain their curve-derived heading');
car.ramp = null;
car.incident = { kind: 'accident' };
assert.equal(laneChangeYaw(car), 0, 'a frozen mid-change wreck has no steering yaw');
car.incident = { kind: 'breakdown' };
assert.ok(laneChangeYaw(car) > 0, 'a breakdown can still steer while pulling over');
car.incident = null;

sim.advanceLaneChange(car, duration / 4);
assert.ok(Math.abs(laneChangeYaw(car) - quarter) < 1e-12,
  'the nose straightens as the maneuver slows toward its destination');
renderer.captureCarPoses([car]);
sim.advanceLaneChange(car, duration / 4);
assert.equal(car.laneChange, null);
assert.equal(laneChangeYaw(car), 0, 'a completed lane change faces along the road');
renderer._renderAlpha = 0;
assert.ok(Math.abs(renderer.carHeading(car) - quarter) < 1e-12,
  'the final physics step retains its previous heading for interpolation');
renderer._renderAlpha = 0.5;
assert.ok(renderer.carHeading(car) > 0 && renderer.carHeading(car) < quarter,
  'display frames smoothly straighten after the maneuver record is cleared');
renderer._renderAlpha = 1;
assert.equal(renderer.carHeading(car), 0, 'the paused or final pose is fully straight');

sim.beginLaneChange(car, 0);
sim.advanceLaneChange(car, duration / 2);
assert.ok(laneChangeYaw(car) < 0, 'moving toward the outer lane turns the nose right');
sim.advanceLaneChange(car, duration / 2);
sim.beginLaneChange(car, -1, undefined, { endRender: SHOULDER_LANE, toShoulder: true });
sim.advanceLaneChange(car, duration / 2);
assert.ok(laneChangeYaw(car) < 0, 'pulling onto the shoulder turns outward too');
sim.advanceLaneChange(car, duration / 2);
assert.equal(car.state, 'shoulder');
assert.equal(laneChangeYaw(car), 0, 'a completed shoulder maneuver straightens');

console.log('Lane-change heading: direction, low-speed yaw, endpoints, ramps, incidents and pure rendering passed.');
