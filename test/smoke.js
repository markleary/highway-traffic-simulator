// Headless sanity check of the traffic model: runs the simulation under a few
// parameter regimes and asserts basic physical plausibility. No browser needed.
import { params, KMH } from '../src/params.js';
import { Simulation, BIN_M } from '../src/sim/simulation.js';
import { LOOP, RAMPS, SHAPES, forwardDist, pointAt, forwardAt } from '../src/sim/road.js';

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

// truckShare 0: pure-cars baseline — a truck heading a ramp queue can
// legitimately stall that ramp's measured flow for a minute (see the trucks
// scenario for mixed-traffic checks)
run('baseline regime (no trucks), 120 sim-seconds', { truckShare: 0 }, 120, (sim) => {
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
  // space-time diagram samples: one speed bin per BIN_M of loop, -1 = empty
  const bins = sim.history[sim.history.length - 1].bins;
  check(
    'speed bins cover the loop',
    sim.history.every((p) => p.bins.length === Math.ceil(LOOP / BIN_M)),
    `(len=${bins.length})`
  );
  let measured = 0;
  let sane = true;
  for (const v of bins) {
    if (v >= 0) measured++;
    if (v < -1 || v > 70) sane = false;
  }
  check('speed bins measure traffic', measured > 10 && sane, `(${measured} of ${bins.length} bins)`);
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
  // Pick a victim that has an adjacent-lane neighbor inside the 25 m drag-in
  // radius, so the pileup is reliably 2 cars (a random victim occasionally has
  // an empty stretch beside it and wrecks alone).
  const victim = sim.cars.find(
    (a) =>
      a.state === 'main' &&
      !a.incident &&
      sim.cars.some(
        (b) =>
          b.state === 'main' &&
          !b.incident &&
          Math.abs(b.lane - a.lane) === 1 &&
          Math.min(forwardDist(a.s, b.s), forwardDist(b.s, a.s)) < 20
      )
  );
  sim.triggerAccident(victim);
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
  // the space-time diagram should see the jam. Bins average across ALL lanes,
  // so the wreck's own bin can read fast if a car in the free lane is passing
  // through it at the sample instant — but the queue always leaves some bin
  // (mostly stopped cars, no passer) reading near zero.
  const jamBins = sim.history[sim.history.length - 1].bins;
  const wreckBin = Math.min(jamBins.length - 1, Math.floor(wrecks[0].s / BIN_M));
  check('speed bins measure the wreck site', jamBins[wreckBin] >= 0, `(v=${jamBins[wreckBin]?.toFixed(1)})`);
  let minBin = Infinity;
  for (const v of jamBins) if (v >= 0) minBin = Math.min(minBin, v);
  check('speed bins register the jam', minBin < 2, `(min=${minBin.toFixed(1)})`);
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

{
  console.log('\ndense seeding never overlaps (Codex review regression)');
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { initialCars: 300, truckShare: 40 });
  const sim = new Simulation();
  // positions are vehicle centers: a bumper gap sheds half of BOTH lengths
  let worstGap = Infinity;
  for (const arr of sim.buildLaneIndex()) {
    for (let i = 0; i < arr.length; i++) {
      const leader = arr[(i + 1) % arr.length];
      if (leader === arr[i]) continue;
      worstGap = Math.min(
        worstGap,
        forwardDist(arr[i].s, leader.s) - (arr[i].len + leader.len) / 2
      );
    }
  }
  check(
    'no overlapped seeds at max density + 40% trucks',
    worstGap >= params.minGap - 1e-6,
    `(worst gap=${worstGap.toFixed(2)} m over ${sim.cars.length} cars, LOOP=${LOOP.toFixed(0)})`
  );
  for (let i = 0; i < Math.round(10 / H); i++) sim.step(H);
  assertSane(sim, 'dense seeding');
}

{
  console.log('\nfeasible reset counts are seeded in full (Codex review regression)');
  // 2 lanes × 150 cars needs 150 × (4.6 + 2.0) = 990 m per lane — it fits the
  // ~1056 m loop at minGap spacing, so no car may be silently dropped
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { lanes: 2, initialCars: 300, truckShare: 0 });
  const sim = new Simulation();
  check('all 300 requested cars seeded', sim.cars.length === 300, `(seeded=${sim.cars.length})`);
  let worstGap = Infinity;
  for (const arr of sim.buildLaneIndex()) {
    for (let i = 0; i < arr.length; i++) {
      const leader = arr[(i + 1) % arr.length];
      if (leader === arr[i]) continue;
      worstGap = Math.min(
        worstGap,
        forwardDist(arr[i].s, leader.s) - (arr[i].len + leader.len) / 2
      );
    }
  }
  check('full-count seeds still respect minGap', worstGap >= params.minGap - 1e-6, `(worst=${worstGap.toFixed(2)} m)`);
}

{
  console.log('\nreset honors the trucks knob road-wide (Codex review regression)');
  // trucks are excluded from the innermost lane, so the eligible lanes must be
  // sampled at a boosted rate; average over resets to keep statistics tight
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { truckShare: 30, initialCars: 150 });
  let shareSum = 0;
  const RESETS = 10;
  for (let r = 0; r < RESETS; r++) {
    const sim = new Simulation();
    shareSum += sim.cars.filter((c) => c.kind === 'truck').length / sim.cars.length;
  }
  const avgShare = (shareSum / RESETS) * 100;
  // unboosted sampling would average ~20% here (2/3 of the knob)
  check('average seeded truck share ≈ 30%', avgShare > 26 && avgShare < 34, `(avg=${avgShare.toFixed(1)}%)`);
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
  // center-based gap math: no vehicle body may interpenetrate another
  let worstBody = Infinity;
  for (const arr of sim.buildLaneIndex()) {
    for (let i = 0; i < arr.length; i++) {
      const leader = arr[(i + 1) % arr.length];
      if (leader === arr[i]) continue;
      worstBody = Math.min(
        worstBody,
        forwardDist(arr[i].s, leader.s) - (arr[i].len + leader.len) / 2
      );
    }
  }
  check('no body interpenetration after 120 s', worstBody > -0.05, `(worst=${worstBody.toFixed(2)} m)`);
});

// --- road shapes: exact geometry on every shape, then a full traffic run.
// LOOP/RAMPS are live bindings that follow the active shape. Trucks are
// pinned off so ramp-flow behavior stays deterministic (a semi heading a
// ramp queue can legitimately stall it for a minute).

for (const [id, shape] of Object.entries(SHAPES)) {
  console.log(`\nroad shape: ${shape.label}`);
  Object.assign(params, JSON.parse(JSON.stringify(DEFAULTS)), { roadShape: id, truckShare: 0 });
  const sim = new Simulation(); // reset() applies the shape
  check(`${id}: loop length sane`, LOOP > 800 && LOOP < 1600, `(LOOP=${LOOP.toFixed(0)} m)`);
  check(`${id}: path closes at the wrap seam`, pointAt(0).distanceTo(pointAt(LOOP - 1e-9)) < 1e-3);

  // s is exact arc length: 0.5 m of s moves ~0.5 m of world, along forwardAt
  let worstLen = 0;
  let worstTan = 1;
  for (let i = 0; i < 500; i++) {
    const s = (i / 500) * LOOP;
    const a = pointAt(s);
    const b = pointAt(s + 0.5);
    worstLen = Math.max(worstLen, Math.abs(a.distanceTo(b) - 0.5));
    worstTan = Math.min(worstTan, b.sub(a).normalize().dot(forwardAt(s + 0.25)));
  }
  check(`${id}: s is exact arc length`, worstLen < 2e-3, `(err=${worstLen.toExponential(1)})`);
  check(`${id}: tangents match the path`, worstTan > 0.9999, `(dot=${worstTan.toFixed(5)})`);

  // stretches of road far apart in s must be far apart in space, or the
  // pavement (up to ~15 m each side of the centerline) would overlap itself
  const N = Math.ceil(LOOP / 3);
  const pts = [];
  for (let i = 0; i < N; i++) pts.push(pointAt((i / N) * LOOP));
  let minD = Infinity;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const ds = Math.min(j - i, N - (j - i)) * (LOOP / N);
      if (ds > 60) minD = Math.min(minD, pts[i].distanceTo(pts[j]));
    }
  }
  check(`${id}: road never overlaps itself`, minD >= 40, `(min far-pair dist=${minD.toFixed(1)} m)`);
  check(`${id}: four ramps placed`, RAMPS.length === 4 && RAMPS.every((r) => r.length > 80));
  check(`${id}: speed bins sized to this loop`, sim.binCount === Math.ceil(LOOP / BIN_M), `(${sim.binCount})`);

  for (let i = 0; i < Math.round(120 / H); i++) sim.step(H);
  assertSane(sim, id);
  const st = sim.stats();
  check(`${id}: traffic flows`, st.avgSpeed > 6, `(avg=${st.avgSpeed.toFixed(1)} m/s)`);
  check(`${id}: ramp cars merged`, st.merged > 3, `(merged=${st.merged})`);
  // mechanism proof only — the 6% exit share is a per-car roll, and a slow
  // 120 s can legitimately see very few takers (baseline asserts the stats)
  check(`${id}: cars exited`, st.exited > 0, `(exited=${st.exited})`);
}

run('2 lanes', { lanes: 2 }, 60, () => {});
run('4 lanes', { lanes: 4, initialCars: 160 }, 60, () => {});

run('aggressive tailgating params stay stable', { timeHeadway: 0.6, minGap: 0.5, desiredSpeed: 140 * KMH }, 90, (sim) => {
  const s = sim.stats();
  check('cars remain on the road', s.count > 20, `(count=${s.count})`);
});

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
