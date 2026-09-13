import assert from 'node:assert/strict';
import { params, DEFAULTS } from '../src/params.js';
import { Car } from '../src/sim/car.js';
import { Simulation } from '../src/sim/simulation.js';
import { LOOP, RAMPS, ROAD, SHAPES, SHOULDER_LANE, wrap, forwardDist, pointAt, forwardAt, lateralOf } from '../src/sim/road.js';

let seed = 0x6a09e667;
Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

const H = 1 / 60;
let checks = 0;
function check(label, condition) {
  assert.ok(condition, label);
  checks++;
}
function blank(lanes = 3) {
  Object.assign(params, DEFAULTS, {
    lanes, initialCars: 0, rain: 0, workZone: false,
    onRampA: 0, onRampB: 0, onRampC: 0, onRampD: 0,
    offRampA: 0, offRampB: 0, offRampC: 0, offRampD: 0,
  });
  return new Simulation();
}
function add(sim, s, lane, v = 15, kind = 'car') {
  const car = new Car({ s: wrap(s), lane, v, kind, model: kind === 'acc' ? 'ev' : undefined });
  car.lcCooldown = 999;
  sim.cars.push(car);
  return car;
}
function noOverlap(sim, label) {
  for (const lane of sim.buildLaneIndex()) {
    if (lane.length < 2) continue;
    for (let i = 0; i < lane.length; i++) {
      const car = lane[i], leader = lane[(i + 1) % lane.length];
      check(label, forwardDist(car.s, leader.s) - (car.len + leader.len) / 2 >= 0.19);
    }
  }
}
function worldPoint(car) {
  return car.ramp
    ? car.ramp.curve.getPointAt(Math.max(0, Math.min(1, car.rampPos / car.ramp.length)))
    : pointAt(car.s, -car.renderLane * ROAD.laneWidth);
}
function projectPoint(point, initialS) {
  let s = initialS;
  for (let i = 0; i < 8; i++) {
    const center = pointAt(s), tangent = forwardAt(s);
    s = wrap(s + (point.x - center.x) * tangent.x + (point.z - center.z) * tangent.z);
  }
  return { s, offset: lateralOf(s, point) };
}

for (const offset of [0, -110]) {
  const sim = blank();
  const first = add(sim, 100 + offset, 0, 20);
  add(sim, 120 + offset, 0, 5);
  const opposing = add(sim, 100 + offset, 2, 20);
  add(sim, 120 + offset, 2, 5);
  first.lcCooldown = opposing.lcCooldown = 0;
  const lanes = sim.buildLaneIndex();
  sim.applyLaneChanges(lanes);
  const crossing = [first, opposing].find((car) => car.lane === 1);
  check('one crossing driver reserves an opposing same-position opening', !!crossing &&
    [first, opposing].filter((car) => car.lane === 1).length === 1);
  check('source and destination both include crossing body',
    lanes[crossing.laneChange.from].includes(crossing) && lanes[1].includes(crossing));
  check('lane change begins at the previous physical lateral position',
    crossing.renderLane === crossing.laneChange.from);
  check('the maneuver takes three to five seconds',
    crossing.laneChange.duration >= 3 && crossing.laneChange.duration <= 5);
  const previousLane = crossing.lane;
  crossing.lcCooldown = 0;
  sim.applyLaneChanges(sim.buildLaneIndex());
  check('a driver cannot change lanes again mid-maneuver', crossing.lane === previousLane &&
    sim.counters.laneChanges === 1);
  sim.updateLights();
  check('signal starts with the maneuver before the body moves', crossing.signal ===
    Math.sign(crossing.laneChange.to - crossing.laneChange.from));
  noOverlap(sim, 'accepted maneuver is overlap-free around the seam');
}

for (const sourceLeader of [false, true]) {
  const sim = blank();
  const crossing = add(sim, LOOP - 10, 0, 20);
  add(sim, 8, sourceLeader ? 0 : 1, 0);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  const lanes = sim.buildLaneIndex();
  sim.accelMainline(lanes);
  check('crossing car brakes for the restrictive leader in either lane', crossing.a < -5);
  const s0 = crossing.s;
  sim.step(H);
  check('crossing car integrates longitudinal motion only once',
    Math.abs(forwardDist(s0, crossing.s) - crossing.v * H) < 1e-8);
  noOverlap(sim, 'both occupied lanes remain collision free after integration');
}

{
  const sim = blank();
  const crossing = add(sim, 100, 0);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  const duration = crossing.laneChange.duration;
  let lastLateral = crossing.renderLane;
  let maxLateralSpeed = 0;
  for (let i = 0; i < Math.floor(duration / H) - 1; i++) {
    sim.step(H);
    maxLateralSpeed = Math.max(maxLateralSpeed, Math.abs(crossing.renderLane - lastLateral) / H);
    lastLateral = crossing.renderLane;
    check('body remains in the reserved lateral corridor', crossing.renderLane >= 0 && crossing.renderLane < 1);
    check('source stays occupied until the full maneuver completes', sim.buildLaneIndex()[0].includes(crossing));
  }
  sim.step(H); sim.step(H);
  check('completion releases source and centers the car in the target', !crossing.laneChange &&
    crossing.renderLane === 1 && !sim.buildLaneIndex()[0].includes(crossing));
  check('smooth transition has bounded lateral speed', maxLateralSpeed < 0.6);
}

{
  const sim = blank();
  const crossing = add(sim, 100, 0);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  sim.advanceLaneChange(crossing, crossing.laneChange.duration / 2);
  params.accidentLanes = 1;
  sim.triggerAccident(crossing);
  for (let i = 0; i < 400; i++) sim.step(H);
  check('crash interrupts lateral motion at the actual crash position', crossing.renderLane === 0.5);
  check('straddling wreck blocks both lanes until cleared',
    sim.buildLaneIndex()[0].includes(crossing) && sim.buildLaneIndex()[1].includes(crossing));
  sim.clearIncidents();
  check('clearing wreck also removes both lane reservations', !sim.buildLaneIndex().flat().includes(crossing));
}

{
  const sim = blank();
  const ramp = RAMPS.find((r) => r.type === 'on');
  const sIns = wrap(ramp.sJoin - 5);
  const crossing = add(sim, sIns, 0, 0);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  const entering = add(sim, 0, 0, 0);
  entering.state = 'onramp'; entering.ramp = ramp; entering.rampPos = ramp.length - 5;
  sim.rampState.get(ramp.id).cars.push(entering);
  sim.handleMerges(sim.buildLaneIndex()[0]);
  check('ramp cannot merge through a vehicle still leaving lane zero', entering.state === 'onramp');
  sim.advanceLaneChange(crossing, crossing.laneChange.duration);
  sim.handleMerges(sim.buildLaneIndex()[0]);
  check('ramp can merge after source clears with its own lateral transition',
    entering.state === 'main' && !!entering.laneChange && sim.buildLaneIndex()[0].includes(entering));
}

{
  const sim = blank();
  const crossing = add(sim, LOOP - 1, 0, 0);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  const shoulder = add(sim, LOOP - 1, 0, 0);
  shoulder.state = 'shoulder'; shoulder.renderLane = SHOULDER_LANE;
  const incident = { kind: 'breakdown', phase: 'reenter', phaseStart: -100, cars: [shoulder] };
  shoulder.incident = incident; sim.incidents.push(incident);
  sim.updateIncidents(sim.buildLaneIndex());
  check('shoulder reentry respects a source-lane reservation across the seam', shoulder.state === 'shoulder');
  sim.advanceLaneChange(crossing, crossing.laneChange.duration);
  sim.updateIncidents(sim.buildLaneIndex());
  check('shoulder reentry transitions smoothly once the source lane clears',
    shoulder.state === 'main' && !!shoulder.laneChange && shoulder.renderLane === SHOULDER_LANE);
}

{
  const sim = blank();
  const car = add(sim, 100, 0, 0);
  const incident = { kind: 'breakdown', phase: 'pullover', phaseStart: 0, cars: [car] };
  car.incident = incident; sim.incidents.push(incident);
  sim.updateIncidents(sim.buildLaneIndex());
  check('pulling onto the shoulder retains the mainline reservation',
    car.state === 'main' && !!car.laneChange && sim.buildLaneIndex()[0].includes(car));
  for (let i = 0; i < 350; i++) sim.step(H);
  check('parking releases the lane only after physically reaching the shoulder',
    car.state === 'shoulder' && car.renderLane === SHOULDER_LANE && !sim.buildLaneIndex()[0].includes(car));
}

{
  const sim = blank();
  const crossing = add(sim, 95.6, 0, 10);
  add(sim, 100, 0, 0);
  add(sim, 90.9, 1, 10);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  sim.preventOverlaps(sim.buildLaneIndex());
  noOverlap(sim, 'overlap correction propagates through both lane constraints');
}

{
  const sim = blank();
  const crossing = add(sim, 0.1, 0, 10);
  add(sim, 3, 0, 0);
  add(sim, LOOP - 5, 1, 10);
  sim.beginLaneChange(crossing, 1, sim.buildLaneIndex());
  const lanes = sim.buildLaneIndex();
  sim.preventOverlaps(lanes);
  noOverlap(sim, 'cross-lane corrections remain safe when pushed through s=0');
  check('post-repair lane index is sorted for binary-search merge gates', lanes.every((lane) =>
    lane.every((car, i) => i === 0 || lane[i - 1].s <= car.s)));
}

{
  const sim = blank(3);
  const responder = add(sim, 100, 2, 25, 'police');
  const other = add(sim, 150, 2, 15);
  sim._emergencyVehicles = [responder];
  sim.beginLaneChange(responder, 1, sim.buildLaneIndex());
  check('siren corridor includes both lanes while the responder crosses',
    sim.emergencyBehind(other, 260, 1)?.emergency === responder &&
    sim.emergencyBehind(other, 260, 2)?.emergency === responder);
  const slot = sim.emergencySpawnSlot(sim.buildLaneIndex()[2], 'firetruck');
  check('emergency insertion reserves the still-occupied source body',
    slot && Math.min(forwardDist(responder.s, slot.s), forwardDist(slot.s, responder.s)) > 8);
}

{
  const sim = blank(2);
  params.workZone = true; params.workZonePos = 50;
  const taper = sim.workZone().sStart;
  const crossing = add(sim, taper - 7, 1, 20);
  sim.beginLaneChange(crossing, 0, sim.buildLaneIndex());
  crossing.a = 2;
  sim.accelWorkZone();
  check('work-zone wall constrains the source lane until the body clears it', crossing.a < -5);
}

{
  const sim = blank(2);
  Object.assign(params, { politeness: 1, safeBrake: 10, laneChangeThreshold: 2, driverVariation: 0 });
  const passing = add(sim, 100, 0, 20);
  add(sim, 120, 0, 5);
  add(sim, 90, 1, 20);
  passing.lcCooldown = 0;
  sim.applyLaneChanges(sim.buildLaneIndex());
  check('a lone receiving follower is free-flowing before the proposed cut-in, not following itself',
    passing.lane === 0 && !passing.laneChange);
}

// Dense source lanes try opposing moves into a nearly full middle lane. All
// checks include source reservations, rather than merely each car.lane.
for (const offset of [0, -5]) {
  const sim = blank(3);
  const spacing = 8;
  const count = Math.floor(LOOP / spacing);
  for (let j = 0; j < count; j++) {
    for (const lane of [0, 2]) {
      const car = add(sim, offset + j * LOOP / count, lane, j % 7 === 0 ? 0 : 8);
      car.lcCooldown = 0;
    }
    if (j % 2 === 0) add(sim, offset + j * LOOP / count + 0.5, 1, 3);
  }
  for (let i = 0; i < 180; i++) {
    sim.step(H);
    noOverlap(sim, 'dense opposing maneuvers remain safe in both occupied lanes');
  }
  check('dense opposing maneuvers leave all positions and speeds finite',
    sim.cars.every((car) => Number.isFinite(car.s) && Number.isFinite(car.v) && Number.isFinite(car.a)));
}

{
  const sim = blank(4);
  for (let lane = 0; lane < 4; lane++) add(sim, 100, lane, 0);
  params.initialCars = 80;
  params.lanes = 2;
  check('lane removal reports a safely reseeded simulation', sim.onLaneCountChanged() === true);
  check('lane removal does not clamp overlapping cars into the surviving lanes',
    sim.cars.length === 80 && sim.cars.every((car) => car.lane < 2 && !car.laneChange));
  noOverlap(sim, 'reseeded reduced road is collision free');
  const original = sim.cars.slice();
  params.lanes = 3;
  check('adding a lane preserves the current traffic', sim.onLaneCountChanged() === false &&
    original.every((car, i) => sim.cars[i] === car));
}

for (const shape of Object.keys(SHAPES)) {
  for (const scale of [1, 3]) {
    const sim = blank();
    params.roadShape = shape; params.roadScale = scale;
    sim.reset();
    for (const ramp of RAMPS.filter((r) => r.type === 'on')) {
      for (const kind of ['car', 'truck']) {
        const car = add(sim, 0, 0, 8, kind);
        car.state = 'onramp'; car.ramp = ramp;
        const hold = sim.rampHoldPosition(ramp, car);
        car.rampPos = hold - 9;
        const queue = sim.rampState.get(ramp.id).cars;
        queue.push(car);
        const before = worldPoint(car);
        sim.handleMerges(sim.buildLaneIndex()[0]);
        check(`${shape} ${scale}x ${ramp.id} ${kind}: gap reservation preserves exact world position`,
          car.rampMerge && before.distanceTo(worldPoint(car)) < 1e-9);
        check('merging vehicle remains the ramp follower leader and mainline reservation',
          queue.includes(car) && sim.buildLaneIndex()[0].includes(car));
        let previous = before;
        for (let i = 0; car.rampMerge && i < 1500; i++) {
          const vBefore = car.v;
          sim.step(H);
          const current = worldPoint(car);
          check('entire curve and endpoint handoff are position-continuous',
            current.distanceTo(previous) < Math.max(vBefore, car.v) * H + 0.025);
          previous = current;
        }
        check('merge finishes with no stale ramp membership or lateral transition',
          !car.rampMerge && !car.ramp && !car.laneChange && !queue.includes(car));
        sim.removeCar(car);

        // A denied gap must hold the actual oriented front/body outside the
        // mainline envelope, even for the long trailer on curved approaches.
        const held = add(sim, 0, 0, 0, kind);
        held.state = 'onramp'; held.ramp = ramp; held.rampPos = hold;
        queue.push(held);
        const center = worldPoint(held);
        const projected = projectPoint(center, ramp.sJoin - (ramp.length - hold));
        const tangent = ramp.curve.getTangentAt(hold / ramp.length);
        for (const along of [-held.len / 2, 0, held.len / 2]) {
          for (const side of [-1.35, 1.35]) {
            const corner = center.clone();
            corner.x += tangent.x * along - tangent.z * side;
            corner.z += tangent.z * along + tangent.x * side;
            check('waiting body keeps clearance from the mainline vehicle envelope',
              projectPoint(corner, projected.s + along).offset >= 1.89);
          }
        }
        const blocker = add(sim, projected.s, 0, 0);
        const inc = { kind: 'accident', cars: [blocker], clearAt: sim.time + 100 };
        blocker.incident = inc; sim.incidents.push(inc);
        for (let i = 0; i < 60; i++) sim.step(H);
        check('denied gap cannot push the waiting car past its physical hold boundary',
          held.state === 'onramp' && held.rampPos <= hold + 1e-8);
        sim.clearIncidents(); sim.removeCar(held);
      }
    }
  }
}

{
  const sim = blank();
  const ramp = RAMPS.find((r) => r.type === 'on');
  const car = add(sim, 0, 0, 0);
  car.state = 'onramp'; car.ramp = ramp;
  car.rampPos = sim.rampHoldPosition(ramp, car) - 1;
  const queue = sim.rampState.get(ramp.id).cars;
  queue.push(car);
  sim.handleMerges(sim.buildLaneIndex()[0]);
  const position = worldPoint(car);
  check('random breakdown cannot conflict with an in-progress ramp transfer', sim.randomEligibleCar() === null);
  params.accidentLanes = 1;
  sim.triggerAccident(car);
  for (let i = 0; i < 300; i++) sim.step(H);
  check('stopped merge wreck keeps both ramp and mainline blocked at its actual position',
    queue.includes(car) && sim.buildLaneIndex()[0].includes(car) &&
    worldPoint(car).distanceTo(position) < 1e-8);
  sim.clearIncidents();
  check('clearing a merge wreck removes both physical memberships',
    !queue.includes(car) && !sim.buildLaneIndex()[0].includes(car));
}

{
  const sim = blank();
  const ramp = RAMPS.find((r) => r.type === 'on');
  const head = add(sim, 0, 0, 0), follower = add(sim, 0, 0, 0);
  for (const car of [head, follower]) { car.state = 'onramp'; car.ramp = ramp; }
  head.rampPos = sim.rampHoldPosition(ramp, head);
  follower.rampPos = head.rampPos - 9;
  sim.syncRampMerge(head); sim.syncRampMerge(follower);
  const queue = sim.rampState.get(ramp.id).cars;
  queue.push(follower, head);
  const blocker = add(sim, head.s, 0, 0);
  check('fixture gives the follower an apparent mainline gap behind the blocked head',
    forwardDist(follower.s, blocker.s) - (follower.len + blocker.len) / 2 >= params.minGap);
  sim.handleMerges(sim.buildLaneIndex()[0]);
  check('a denied queue head prevents followers from reserving around it',
    head.state === 'onramp' && follower.state === 'onramp');
  sim.removeCar(blocker);
  for (let i = 0; i < 1800; i++) sim.step(H);
  check('removing the blockage lets both queued cars complete the merge',
    head.state === 'main' && follower.state === 'main' &&
    !head.rampMerge && !follower.rampMerge && queue.length === 0);
}

{
  const sim = blank();
  const ramp = RAMPS.find((r) => r.type === 'on');
  const car = add(sim, 0, 0, 0);
  car.state = 'onramp'; car.ramp = ramp;
  car.rampPos = sim.rampHoldPosition(ramp, car) - 9;
  sim.rampState.get(ramp.id).cars.push(car);
  sim.handleMerges(sim.buildLaneIndex()[0]);
  const oldPosition = car.rampPos;
  add(sim, car.s + car.len - 0.15, 0, 0);
  sim.preventOverlaps(sim.buildLaneIndex());
  check('mainline emergency correction also rolls back the actual ramp body', car.rampPos < oldPosition);
  check('corrected s and rendered ramp coordinates represent the same point',
    pointAt(car.s, -car.renderLane * ROAD.laneWidth).distanceTo(worldPoint(car)) < 1e-5);
  noOverlap(sim, 'mainline repair leaves the merging body collision free');
}

console.log(`Finite lane-change regressions passed (${checks} assertions).`);
