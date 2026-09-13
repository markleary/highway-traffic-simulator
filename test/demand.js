import assert from 'node:assert/strict';
import { RampDemand } from '../src/sim/demand.js';
import { Car, vehicleSpec } from '../src/sim/car.js';
import { Simulation } from '../src/sim/simulation.js';
import { RAMPS } from '../src/sim/road.js';
import { params } from '../src/params.js';

const plain = () => vehicleSpec('car');
const originalParams = { ...params };
const originalRandom = Math.random;
let seed = 12345;
Math.random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

function test(label, run) {
  run();
  console.log(`  ok   ${label}`);
}

try {
  console.log('\nUpstream ramp demand');
  test('regular requests conserve specified volume across frame partitions', () => {
    const fine = new RampDemand(1);
    const coarse = new RampDemand(1);
    for (let i = 0; i < 3600; i++) fine.advance(1 / 60, 0.5, 'regular', plain);
    coarse.advance(60, 0.5, 'regular', plain);
    assert.equal(fine.requested, 30);
    assert.deepEqual(fine.stats(), coarse.stats());
    assert.equal(fine.waiting, fine.requested - fine.admitted);
  });

  test('Poisson counts have variable volume with the requested mean and variance', () => {
    const counts = [];
    for (let i = 0; i < 1500; i++) {
      const demand = new RampDemand(i);
      demand.advance(60, 1, 'random', plain);
      counts.push(demand.requested);
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length;
    assert.ok(Math.abs(mean - 60) < 1, `mean ${mean}`);
    assert.ok(variance > 50 && variance < 70, `variance ${variance}`);
  });

  test('arrival timing is independent of admission and downstream random draws', () => {
    const blocked = new RampDemand(984);
    const free = new RampDemand(984);
    for (let i = 0; i < 1200; i++) {
      blocked.advance(0.1, 0.7, 'random', plain);
      for (let j = 0; j < 11; j++) Math.random();
      free.advance(0.1, 0.7, 'random', plain);
      while (free.waiting) free.admit();
      assert.equal(blocked.requested, free.requested);
    }
    assert.equal(free.waiting, 0);
    assert.equal(blocked.waiting, free.admitted);
  });

  test('live rate changes preserve partial headways; zero rate creates no requests', () => {
    const demand = new RampDemand(1);
    demand.advance(1, 0.5, 'regular', plain);
    demand.advance(60, 0, 'regular', plain);
    assert.equal(demand.requested, 0);
    demand.advance(0.5, 1, 'regular', plain);
    assert.equal(demand.requested, 1);
    demand.advance(1, 2, 'regular', plain);
    assert.equal(demand.requested, 3);
    demand.advance(500, 0, 'random', plain);
    assert.equal(demand.requested, 3);
    demand.admit();
    assert.deepEqual(demand.stats(), { requested: 3, admitted: 1, waiting: 2 });
  });

  test('large blocked queues retain every body in FIFO order using compact storage', () => {
    const demand = new RampDemand(1);
    const specs = [vehicleSpec('acc', 'cybertruck'), vehicleSpec('truck'), vehicleSpec('acc', 'ev')];
    for (let i = 0; i < 100000; i++) demand.enqueue(specs[i % specs.length]);
    assert.equal(demand.waiting, 100000);
    assert.ok(demand._chunks.length * 1024 < 101000);
    for (let i = 0; i < 100000; i++) {
      const head = demand.peek();
      assert.equal(head, demand.peek(), 'the blocked head has stable identity');
      assert.deepEqual(demand.admit(), specs[i % specs.length]);
    }
    assert.equal(demand.waiting, 0);
    assert.equal(demand._chunks.length, 0, 'drained chunks are released');
    assert.equal(demand.peek(), null);
    demand.enqueue(specs[0]);
    assert.deepEqual(demand.admit(), specs[0], 'a drained queue can be reused');
  });

  test('both ACC body choices remain unbiased in a blocked upstream backlog', () => {
    const demand = new RampDemand(1);
    demand.advance(20000, 1, 'regular', () => vehicleSpec('acc'));
    let cybertrucks = 0;
    while (demand.waiting) cybertrucks += demand.admit().model === 'cybertruck';
    assert.ok(cybertrucks > 9700 && cybertrucks < 10300, `${cybertrucks} Cybertrucks`);
  });

  const empty = () => {
    Object.assign(params, originalParams, {
      initialCars: 0, lanes: 3, roadShape: 'circle', roadScale: 1, interchanges: 2,
      onRampA: 0, onRampB: 0, onRampC: 0, onRampD: 0,
      offRampA: 0, offRampB: 0, offRampC: 0, offRampD: 0,
      truckShare: 0, accShare: 100, arrivalMode: 'regular',
    });
    return new Simulation();
  };

  test('blocked entrances conserve requests and show upstream wait separately', () => {
    const sim = empty();
    const ramp = RAMPS.find((r) => r.type === 'on');
    const state = sim.rampState.get(ramp.id);
    const blocker = new Car();
    Object.assign(blocker, { state: 'onramp', ramp, rampPos: 0, v: 0 });
    state.cars.push(blocker);
    sim.cars.push(blocker);
    params[ramp.rateKey] = 60;
    sim.spawnFromRamps(120);
    assert.equal(sim.cars.length, 1, 'upstream requests do not allocate full Cars');
    assert.deepEqual(sim.rampDemand()[ramp.id], { requested: 120, admitted: 0, waiting: 120 });
    assert.equal(sim.rampQueues()[ramp.id], 1);
    assert.equal(sim.stats().requested, 120);
    assert.equal(sim.stats().upstreamWaiting, 120);
    const requestedModel = state.demand.peek().model;
    params[ramp.rateKey] = 0;
    params.accShare = 0;
    params.truckShare = 100;
    state.cars.length = 0;
    sim.cars.length = 0;
    sim.spawnFromRamps(1);
    assert.equal(sim.counters.entered, 1, 'zero rate still admits the existing backlog');
    assert.equal(sim.cars[0].kind, 'acc', 'request-time mix survives later slider edits');
    assert.equal(sim.cars[0].model, requestedModel);
    assert.equal(sim.stats().upstreamWaiting, 119);
    assert.equal(sim.stats().requested, 120);
  });

  test('short EVs cannot overtake a blocked Cybertruck; slider edits keep queued models', () => {
    const sim = empty();
    const ramp = RAMPS.find((r) => r.type === 'on');
    const state = sim.rampState.get(ramp.id);
    const blocker = new Car();
    Object.assign(blocker, { state: 'onramp', ramp, rampPos: 9, v: 0 });
    state.cars.push(blocker);
    sim.cars.push(blocker);
    state.demand.enqueue(vehicleSpec('acc', 'cybertruck'));
    state.demand.enqueue(vehicleSpec('acc', 'ev'));
    const head = state.demand.peek();
    params.accShare = 0;
    params.truckShare = 100;
    sim.spawnFromRamps(1);
    assert.equal(state.demand.peek(), head);
    assert.equal(state.demand.waiting, 2);
    assert.equal(sim.counters.entered, 0);
    blocker.rampPos = 9.2;
    sim.spawnFromRamps(0);
    assert.equal(state.cars[0].model, 'cybertruck');
    assert.equal(state.cars[0].kind, 'acc');
    assert.equal(state.demand.peek().model, 'ev');
    sim.spawnFromRamps(0);
    assert.equal(sim.counters.entered, 1, 'the newly admitted body blocks the next request');
    state.cars[0].rampPos = 20;
    state.cars.sort((a, b) => a.rampPos - b.rampPos);
    sim.spawnFromRamps(0);
    assert.equal(state.cars[0].model, 'ev');
    assert.equal(state.cars[0].kind, 'acc');
    assert.equal(state.demand.waiting, 0);
  });

  test('entrance admissions match a stopped or crawling queue', () => {
    for (const leaderSpeed of [0, 1.5, 20]) {
      const sim = empty();
      const ramp = RAMPS.find((r) => r.type === 'on');
      const state = sim.rampState.get(ramp.id);
      const leader = new Car({ v: leaderSpeed });
      Object.assign(leader, { state: 'onramp', ramp, rampPos: 9.2 });
      state.cars.push(leader);
      sim.cars.push(leader);
      state.demand.enqueue(vehicleSpec('acc', 'cybertruck'));
      sim.spawnFromRamps(0);
      assert.equal(state.cars[0].v, Math.min(12, leaderSpeed));
    }
  });

  test('ramp safety backstop respects both vehicle lengths and propagates backward', () => {
    const sim = empty();
    const ramp = RAMPS.find((r) => r.type === 'on');
    const state = sim.rampState.get(ramp.id);
    const rear = new Car({ v: 8 });
    const middle = new Car({ kind: 'truck', v: 5 });
    const front = new Car({ v: 0 });
    for (const [car, rampPos] of [[rear, 10], [middle, 20], [front, 30]]) {
      Object.assign(car, { state: 'onramp', ramp, rampPos });
      state.cars.push(car);
      sim.cars.push(car);
    }
    sim.preventRampOverlaps();
    for (let i = 1; i < state.cars.length; i++) {
      const follower = state.cars[i - 1], leader = state.cars[i];
      assert.ok(leader.rampPos - follower.rampPos - (leader.len + follower.len) / 2 >= 0.249999);
      assert.equal(follower.v, 0);
    }
  });

  test('meter backpressure never overlaps ramp bodies at GUI and stress arrival rates', () => {
    for (const rate of [40, 80]) {
      const sim = empty();
      Object.assign(params, {
        accShare: 35, truckShare: 20, metering: true, meterRate: 1,
        driverVariation: 0, responseTime: 0.6, arrivalMode: 'regular',
      });
      const ramp = RAMPS.find((r) => r.type === 'on');
      params[ramp.rateKey] = rate;
      for (let step = 0; step < 60 * 180; step++) {
        sim.step(1 / 60);
        for (const r of RAMPS) {
          const cars = sim.rampState.get(r.id).cars;
          for (let i = 0; i < cars.length; i++) {
            assert.ok(cars[i].rampPos >= -1e-8, 'ramp repair does not push a car upstream of admission');
            if (!i) continue;
            const follower = cars[i - 1], leader = cars[i];
            const gap = leader.rampPos - follower.rampPos - (leader.len + follower.len) / 2;
            assert.ok(gap >= 0.199999, `rate ${rate}, time ${sim.time}, gap ${gap}`);
          }
        }
      }
      const demand = sim.rampDemand()[ramp.id];
      assert.equal(demand.requested, rate * 3);
      assert.ok(demand.waiting > 0, 'test actually exercises an upstream queue');
      assert.equal(demand.requested, demand.admitted + demand.waiting);
    }
  });

  test('reset drops removed interchange state and resets demand counters', () => {
    const sim = empty();
    params.roadScale = 2;
    params.interchanges = 4;
    sim.reset();
    const previousIds = [...sim.rampState.keys()];
    const ramp = RAMPS.find((r) => r.type === 'on');
    sim.rampState.get(ramp.id).demand.enqueue(plain());
    params.roadScale = 1;
    params.interchanges = 2;
    sim.reset();
    assert.ok(previousIds.length > sim.rampState.size);
    assert.deepEqual([...sim.rampState.keys()], RAMPS.map((r) => r.id));
    assert.equal(sim.stats().requested, 0);
    assert.equal(sim.stats().upstreamWaiting, 0);
  });

  console.log('All demand checks passed.');
} finally {
  Object.assign(params, originalParams);
  Math.random = originalRandom;
}
