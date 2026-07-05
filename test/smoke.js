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

run('2 lanes', { lanes: 2 }, 60, () => {});
run('4 lanes', { lanes: 4, initialCars: 160 }, 60, () => {});

run('aggressive tailgating params stay stable', { timeHeadway: 0.6, minGap: 0.5, desiredSpeed: 140 * KMH }, 90, (sim) => {
  const s = sim.stats();
  check('cars remain on the road', s.count > 20, `(count=${s.count})`);
});

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
