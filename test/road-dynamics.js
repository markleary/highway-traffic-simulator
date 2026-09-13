import assert from 'node:assert/strict';
import { params, DEFAULTS } from '../src/params.js';
import { Car } from '../src/sim/car.js';
import { setShape, LOOP, curvatureAt, gradeAt } from '../src/sim/road.js';
import { roadSpeedLimit } from '../src/sim/road-dynamics.js';

Object.assign(params, DEFAULTS, { roadDynamics: true });
setShape('circle', 1, 2);
assert.ok(Math.abs(curvatureAt(0) + 1 / 168.15) < 1e-9);
assert.equal(curvatureAt(0), curvatureAt(LOOP));
assert.ok(Math.abs(curvatureAt(0, -7.4)) > Math.abs(curvatureAt(0)));
assert.equal(gradeAt(0), 0);
const car = new Car({ s: 100, lane: 0, v: 25 });
const tightLimit = roadSpeedLimit(car);
car.lane = car.renderLane = 2;
const metric = Math.abs(curvatureAt(car.s) / curvatureAt(car.s, -7.4));
assert.ok(Math.abs(roadSpeedLimit(car) ** 2 * metric ** 2 * Math.abs(curvatureAt(car.s, -7.4)) - 2.2) < 1e-8,
  'curve comfort converts shared s-speed into actual lane speed');
car.lane = car.renderLane = 0;
setShape('circle', 3, 2);
assert.ok(roadSpeedLimit(car) > tightLimit * 1.6, 'larger-radius curves allow faster comfortable travel');
params.roadDynamics = false;
assert.equal(roadSpeedLimit(car), Infinity, 'off preserves the original target');
params.roadDynamics = true;
setShape('eight', 1, 2);
let climbS = 0;
for (let s = 0; s < LOOP; s += 1) if (gradeAt(s) > gradeAt(climbS)) climbS = s;
assert.ok(gradeAt(climbS) > 0.07, 'test uses the bridge climb');
const truck = new Car({ kind: 'truck', s: climbS, lane: 0, v: 10 });
car.s = climbS; car.v = 10;
assert.ok(roadSpeedLimit(truck) < roadSpeedLimit(car), 'the uphill heavy vehicle has less climbing pace');
assert.ok(roadSpeedLimit(truck) > 5, 'heavy vehicles can keep climbing instead of stalling');
for (let s = 0; s < LOOP; s += 3) {
  truck.s = s;
  assert.ok(roadSpeedLimit(truck) > 0 && !Number.isNaN(roadSpeedLimit(truck)));
}
assert.equal(gradeAt(0), gradeAt(LOOP));
console.log('Road dynamics: curvature, bridge grade, optional limits and heavy-vehicle climbing checks passed.');
