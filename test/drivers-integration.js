import assert from 'node:assert/strict';
import { params } from '../src/params.js';
import { Simulation } from '../src/sim/simulation.js';
import { Car } from '../src/sim/car.js';

const originalParams = { ...params };
Object.assign(params, {
  initialCars: 0, lanes: 2, onRampA: 0, onRampB: 0, onRampC: 0, onRampD: 0,
  desiredSpeed: 30, driverVariation: 0, responseTime: 0.6, timeHeadway: 1.4,
  minGap: 2, maxAccel: 1.4, comfortBrake: 2, roadDynamics: false, rain: 0,
  workZone: false,
});

function fixture() {
  const sim = new Simulation();
  const car = new Car({ s: 100, lane: 0, v: 10 });
  const sourceLeader = new Car({ s: 127.6, lane: 0, v: 5 });
  const targetLeader = new Car({ s: 115.6, lane: 1, v: 10 });
  sim.cars = [car, sourceLeader, targetLeader];
  return { sim, car };
}

try {
  const sourceOnly = fixture();
  sourceOnly.sim.accelMainline(sourceOnly.sim.buildLaneIndex());
  const sourceBrake = sourceOnly.car.a;
  assert.ok(sourceBrake < -1, 'closing source leader requires urgent braking');

  const targetOnly = fixture();
  targetOnly.car.lane = targetOnly.car.renderLane = 1;
  targetOnly.sim.accelMainline(targetOnly.sim.buildLaneIndex());
  const targetBrake = targetOnly.car.a;
  assert.ok(targetBrake > -0.1, 'same-speed target leader uses normal response adaptation');

  const crossing = fixture();
  crossing.sim.beginLaneChange(crossing.car, 1, crossing.sim.buildLaneIndex());
  crossing.sim.accelMainline(crossing.sim.buildLaneIndex());
  assert.ok(Math.abs(crossing.car.a - Math.min(sourceBrake, targetBrake)) < 1e-10,
    'occupying two lanes must retain the urgent response from either leader');

  const reversed = fixture();
  reversed.sim.beginLaneChange(reversed.car, 1, reversed.sim.buildLaneIndex());
  reversed.sim.accelMainline(reversed.sim.buildLaneIndex().reverse());
  assert.ok(Math.abs(reversed.car.a - crossing.car.a) < 1e-10,
    'the acceleration response is independent of lane iteration order');

  const cutIn = fixture();
  cutIn.car.v = 25;
  cutIn.car.a = 1.4;
  cutIn.sim.cars[1].s = 500;
  cutIn.sim.cars[1].v = 25;
  cutIn.sim.cars[2].s = 110;
  cutIn.sim.cars[2].v = 12;
  params.responseTime = 1.2;
  cutIn.sim.beginLaneChange(cutIn.car, 1, cutIn.sim.buildLaneIndex());
  cutIn.sim.accelMainline(cutIn.sim.buildLaneIndex());
  const adaptedEmergencyBrake = cutIn.car.a;
  assert.ok(adaptedEmergencyBrake <= -8.9,
    'an urgent cut-in cannot leave positive throttle or delayed emergency braking');
  cutIn.car.a = 1.4;
  params.responseTime = 0;
  cutIn.sim.accelMainline(cutIn.sim.buildLaneIndex());
  assert.equal(adaptedEmergencyBrake, cutIn.car.a,
    'human adaptation preserves the immediate controller response to a dangerous cut-in');

  console.log('Driver integration: urgent dual-lane braking, lane-order invariance and cut-in response passed.');
} finally {
  Object.assign(params, originalParams);
}
