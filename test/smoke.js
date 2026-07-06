// Headless sanity check of the traffic model: runs the simulation under a few
// parameter regimes and asserts basic physical plausibility. No browser needed.
import { params, KMH } from '../src/params.js';
import { Simulation } from '../src/sim/simulation.js';

const DEFAULTS = JSON.parse(JSON.stringify(params));
const H = 1 / 60;
let failures = 0;

function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label} ${detail}`);
    failures++;
  }
}

function assertSane(sim, label) {
  let bad = 0;
  for (const car of sim.cars) {
    if (!Number.isFinite(car.s) || !Number.isFinite(car.v) || !Number.isFinite(car.a)) bad++;
    if (car.v < 0 || car.v > 70) bad++; // 70 m/s = 252 km/h: nothing should go faster
  }
  check(`${label}: all car states finite and plausible`, bad === 0, `(${bad} bad)`);
}

function run(label, overrides, seconds, checks) {
  console.log(`\n${label}`);
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), overrides);
  const sim = new Simulation();
  const steps = Math.round(seconds / H);
  for (let i = 0; i < steps; i++) sim.step(H);
  assertSane(sim, label);
  checks(sim);
  return sim;
}

run('default regime, 120 sim-seconds', {}, 120, (sim) => {
  const s = sim.stats();
  check('cars remain on the road', s.count > 20, `(count=${s.count})`);
  check('traffic is moving', s.avgSpeed > 6, `(avg=${s.avgSpeed.toFixed(1)} m/s)`);
  check('on-ramp cars entered', s.entered > 5, `(entered=${s.entered})`);
  check('ramp cars merged onto mainline', s.merged > 3, `(merged=${s.merged})`);
  check('cars exited via off-ramps', s.exited > 2, `(exited=${s.exited})`);
  check('lane changes happened', s.laneChanges > 10, `(lc=${s.laneChanges})`);
  check('flow measured at start line', s.flowPerMin > 10, `(flow=${s.flowPerMin.toFixed(1)}/min)`);
  const rf = sim.rampFlows();
  check('on-ramp flows measured', rf.onA > 0 && rf.onA < 40 && rf.onB > 0, `(onA=${rf.onA.toFixed(1)}, onB=${rf.onB.toFixed(1)})`);
  check('exit flows measured', rf.offA + rf.offB > 0, `(offA=${rf.offA.toFixed(1)}, offB=${rf.offB.toFixed(1)})`);
  check(
    'chart history sampled at 1 Hz',
    sim.history.length === 120 && sim.history.every((p) => Number.isFinite(p.v) && Number.isFinite(p.f)),
    `(len=${sim.history.length})`
  );
});

run('flood: heavy inflow, no exits → jam builds', { onRampA: 35, onRampB: 35, offRampA: 0, offRampB: 0, initialCars: 120 }, 180, (sim) => {
  const s = sim.stats();
  check('car count grew well past seed', s.count > 160, `(count=${s.count})`);
  check('nobody exited', s.exited === 0, `(exited=${s.exited})`);
  check('congestion slowed traffic', s.avgSpeed < 26.5, `(avg=${s.avgSpeed.toFixed(1)} m/s)`);
});

run('drain: no inflow, heavy exits → road empties', { onRampA: 0, onRampB: 0, offRampA: 45, offRampB: 45, initialCars: 120 }, 240, (sim) => {
  const s = sim.stats();
  check('car count dropped well below seed', s.count < 60, `(count=${s.count})`);
  check('nobody entered', s.entered === 0, `(entered=${s.entered})`);
  check('many cars exited', s.exited > 60, `(exited=${s.exited})`);
});

// --- incident scenarios (need mid-run triggers, so they drive stepping manually)

{
  console.log('\naccident: 2-lane pileup blocks traffic, then clears');
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { incidentDuration: 30, accidentLanes: 2 });
  const sim = new Simulation();
  for (let i = 0; i < Math.round(15 / H); i++) sim.step(H);
  sim.triggerRandomAccident();
  check('incident registered', sim.incidents.length === 1);
  const wrecks = sim.incidents[0]?.cars ?? [];
  check('pileup involves two cars', wrecks.length === 2, `(${wrecks.length})`);
  let minV = Infinity;
  for (let i = 0; i < Math.round(25 / H); i++) {
    sim.step(H);
    for (const c of sim.cars) if (c.state === 'main' && !c.incident) minV = Math.min(minV, c.v);
  }
  check('wrecked cars came to a stop', wrecks.every((c) => c.v === 0));
  check('a queue formed behind the wreck', minV < 2, `(minV=${minV.toFixed(1)})`);
  for (let i = 0; i < Math.round(20 / H); i++) sim.step(H); // past clearAt
  check('accident cleared after duration', sim.incidents.length === 0);
  check('wrecks vanished on clear', wrecks.every((c) => !sim.cars.includes(c)));
  assertSane(sim, 'accident scenario');
}

{
  console.log('\nbreakdown: pull over, park on shoulder, re-merge');
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { incidentDuration: 25 });
  const sim = new Simulation();
  for (let i = 0; i < Math.round(5 / H); i++) sim.step(H);
  sim.triggerBreakdown();
  const bdCar = sim.incidents[0]?.cars[0];
  check('breakdown registered', sim.incidents.length === 1 && !!bdCar);
  let sawShoulder = false;
  let sawParked = false;
  let remerged = false;
  for (let i = 0; i < Math.round(115 / H); i++) {
    sim.step(H);
    if (bdCar.state === 'shoulder') sawShoulder = true;
    if (sim.incidents[0]?.phase === 'parked') sawParked = true;
    // check at the moment of resolution — afterwards the car may legitimately
    // drive on and leave via an off-ramp
    if (!remerged && sim.incidents.length === 0) remerged = bdCar.state === 'main';
  }
  check('car reached the shoulder', sawShoulder);
  check('car parked for a while', sawParked);
  check('breakdown resolved', sim.incidents.length === 0);
  check('car re-merged into traffic', remerged, `(final state=${bdCar.state})`);
  assertSane(sim, 'breakdown scenario');
}

run('trucks in the mix', { truckShare: 20 }, 120, (sim) => {
  const trucks = sim.cars.filter((c) => c.kind === 'truck');
  check('trucks present', trucks.length > 3, `(${trucks.length})`);
  check(
    'trucks are long and speed-limited',
    trucks.every((t) => t.len > 10 && t.v0Factor < 0.95),
    `(worst v0Factor=${trucks.length ? Math.max(...trucks.map((t) => t.v0Factor)).toFixed(2) : '-'})`
  );
  check(
    'no truck in the leftmost lane',
    trucks.filter((t) => t.state === 'main').every((t) => t.lane < params.lanes - 1)
  );
  check('traffic still flows with trucks', sim.stats().avgSpeed > 4, `(${sim.stats().avgSpeed.toFixed(1)} m/s)`);
});

run('2 lanes', { lanes: 2 }, 60, () => {});
run('4 lanes', { lanes: 4, initialCars: 160 }, 60, () => {});

run('aggressive tailgating params stay stable', { timeHeadway: 0.6, minGap: 0.5, desiredSpeed: 140 * KMH }, 90, (sim) => {
  const s = sim.stats();
  check('cars remain on the road', s.count > 20, `(count=${s.count})`);
});

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
