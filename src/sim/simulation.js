import { LOOP, RAMPS, ROAD, SHOULDER_LANE, wrap, forwardDist, pointAt, forwardAt, lateralOf, setShape } from './road.js';
import { params } from '../params.js';
import { driverFactor, driverResponse } from './drivers.js';
import { roadSpeedLimit } from './road-dynamics.js';
import { RampDemand } from './demand.js';
import {
  Car,
  EMERGENCY_KINDS,
  VEHICLE_LEN,
  isEmergencyVehicle,
  vehicleSpec,
} from './car.js';

// Spatial resolution of the space-time diagram's speed sampling (m of s).
export const BIN_M = 10;

// How far ahead of a work zone's cones the closed lane starts merging out.
const WZ_WARN = 250;

// Speed below which a ramp car counts as QUEUED rather than just driving down
// the ramp (see rampQueues). A car held at a meter or stuck waiting for a gap
// sits at or near zero; one simply traversing the ramp runs at its 12 m/s
// spawn speed or better. Measured across quiet, moderate, flooded and metered
// regimes the split is bimodal with nothing at all between ~2 and ~12 m/s, so
// the exact cut is not delicate.
const RAMP_QUEUE_SPEED = 2; // m/s

// Total concurrent emergency-vehicle cap. Each renderer model has this many
// instances available, so a shared cap guarantees physics never drives an
// invisible vehicle while preserving the old eight-ambulance ceiling.
const MAX_EMERGENCY_VEHICLES = 8;

// Emergency-vehicle lane choice is intentionally less twitchy than ordinary
// MOBIL. A target lane must offer a meaningful projected pace gain, then the
// driver commits long enough to use that opening instead of immediately
// reconsidering the lane it just left. Traffic ahead hears the siren somewhat
// earlier and accepts a firmer merge to clear its lane.
const EMERGENCY_SIREN_RANGE = 260; // m
const EMERGENCY_PASS_LOOKAHEAD = 3; // s used to turn leader gap into projected pace
const EMERGENCY_PASS_SPEED_GAIN = 3; // m/s of projected pace: a real pass, not noise
const EMERGENCY_LANE_HOLD = 4; // s after taking a passing opportunity

// A lane change occupies BOTH lanes until the body has cleared the source.
// This conservative reservation lets ordinary one-dimensional car following
// account for a vehicle crossing the lane line, without instantaneous jumps.
function occupiesLane(car, lane) {
  return car.lane === lane || car.laneChange?.from === lane;
}

function maneuverDuration(car) {
  if (isEmergencyVehicle(car.kind)) return car.kind === 'firetruck' ? 4.5 : 3;
  if (car.kind === 'truck') return 5;
  // Stable per-car variation, independent of the traffic random sequence.
  return 3.6 + ((car.id * 17) % 11) * 0.08;
}

// Project onto the LOCAL approach to this ramp's join, not some unrelated
// road segment at a crossing. Tangent corrections converge quickly near the
// merge, and preserve the exact world position when converting coordinates.
function localRoadProjection(point, initialS) {
  let s = wrap(initialS);
  const center = pointAt(s), tangent = forwardAt(s);
  for (let i = 0; i < 6; i++) {
    pointAt(s, 0, center); forwardAt(s, tangent);
    const ds = (point.x - center.x) * tangent.x + (point.z - center.z) * tangent.z;
    s = wrap(s + ds);
    if (Math.abs(ds) < 1e-8) break;
  }
  return { s, offset: lateralOf(s, point), point };
}

function rampProjection(ramp, rampPos) {
  const point = ramp.curve.getPointAt(Math.max(0, Math.min(1, rampPos / ramp.length)));
  return localRoadProjection(point, ramp.sJoin - (ramp.length - rampPos));
}

// A siren run is budgeted in DISTANCE (laps driven), which stops counting
// down at v = 0; a responder wedged behind a blockage would never retire,
// and eight of them would hold the dispatch cap shut for the rest of the
// session. Back the distance budget with a deadline: the same run at a
// pessimistically slow average, so it scales with road size and only ever
// fires on a responder that is genuinely stuck.
const EMERGENCY_RUN_LAPS = 1.6;
const EMERGENCY_MIN_PACE = 4; // m/s
const emergencyRunDist = () => EMERGENCY_RUN_LAPS * LOOP;
const emergencyRunTime = () => emergencyRunDist() / EMERGENCY_MIN_PACE;

// Rain (0–1, the max of the steady Rain knob and a live storm): slower
// desired speeds, longer following, and less grip. Each factor is mild, but
// together they cut capacity enough to tip a near-capacity regime into
// stop-and-go — which is the demo. Module-level live value (like road.js's
// LOOP binding) so the hot idm() path reads it without extra plumbing.
const RAIN_V0 = 0.3; // desired-speed reduction at full rain
const RAIN_HEADWAY = 0.5; // extra time headway at full rain
const RAIN_GRIP = 0.35; // comfortable-braking reduction at full rain (planning)
const RAIN_HARD = 0.3; // hard-brake and safety-gate reduction at full rain (physics)
let rainNow = 0; // set at the top of every step

// Positions are vehicle CENTERS (that is where the meshes are drawn), so a
// bumper-to-bumper gap must shed half of BOTH vehicles' lengths. With uniform
// lengths subtracting one full length was equivalent; with trucks it is not.
function halfLens(a, b) {
  return (a.len + b.len) / 2;
}

// Intelligent Driver Model for `car` reacting to a leader. Returns m/s².
// gap is bumper-to-bumper distance to the leader; Infinity = free road.
// The global IDM knobs are scaled per vehicle: trucks accelerate lazily,
// brake more gently, and follow at a bigger time gap.
function idm(car, vLead, gap, v0) {
  const p = params;
  const hardBrake = -9 * car.brakeK * (1 - RAIN_HARD * rainNow); // wet road: less grip
  if (gap <= 0) return hardBrake;
  const v = car.v;
  const aMax = p.maxAccel * car.accelK * driverFactor(car, 'accel', p.driverVariation);
  let acc = aMax * (1 - Math.pow(v / Math.max(v0, 0.1), 4));
  if (Number.isFinite(gap)) {
    const dv = v - vLead;
    const wetBrake = p.comfortBrake * (1 - RAIN_GRIP * rainNow);
    const sStar =
      p.minGap +
      Math.max(
        0,
        v * p.timeHeadway * car.headwayK * driverFactor(car, 'headway', p.driverVariation) *
          (1 + RAIN_HEADWAY * rainNow) +
          (v * dv) / (2 * Math.sqrt(aMax * wetBrake * car.brakeK))
      );
    acc -= aMax * (sStar / gap) ** 2;
  }
  return Math.max(acc, hardBrake);
}

// Adapt a human driver's normal response once, after leader restrictions are
// combined. Keep live hardware/grip limits and prescribed stop guards intact.
function respond(car, target, h, gap, leaderSpeed) {
  const p = params;
  return Math.max(-9 * car.brakeK * (1 - RAIN_HARD * rainNow), Math.min(
    p.maxAccel * car.accelK * driverFactor(car, 'accel', p.driverVariation),
    driverResponse(car, target, h, {
      responseTime: p.responseTime, variation: p.driverVariation, gap, leaderSpeed,
      minGap: p.minGap, comfortBrake: p.comfortBrake * car.brakeK * (1 - RAIN_GRIP * rainNow),
    })
  ));
}

// Idealized ACC research controller: IDM tempered by the Constant-Acceleration
// Heuristic (Treiber & Kesting, "Traffic Flow Dynamics", ch. 11). CAH estimates
// the braking required if the leader maintains its current acceleration; the
// blend softens some abrupt IDM responses to short gaps, such as cut-ins.
// It can damp traffic waves in the staged scenarios, but string stability is
// not guaranteed for arbitrary parameters or real commercial ACC systems.
// The Cybertruck appearance does not imply calibration to Tesla's controller.
const ACC_COOL = 0.99; // "coolness factor": how strongly CAH tempers IDM

function accACC(car, leader, gap, aIDM) {
  const p = params;
  const v = car.v;
  const vL = leader.v;
  // Leader's acceleration for the prediction, capped at our own maximum —
  // assuming the leader will out-accelerate physics would license tailgating.
  const aL = Math.min(leader.a, p.maxAccel);
  const denom = vL * vL - 2 * gap * aL;
  let aCAH;
  if (vL * (v - vL) <= -2 * gap * aL && denom > 1e-6) {
    // gap is opening: the constant-acceleration prediction never collides
    aCAH = (v * v * aL) / denom;
  } else {
    // closing on the leader: kinematically required deceleration
    const dv = Math.max(v - vL, 0);
    aCAH = aL - (dv * dv) / (2 * gap);
  }
  if (aIDM >= aCAH) return aIDM; // IDM isn't panicking; keep it
  const b = p.comfortBrake * (1 - RAIN_GRIP * rainNow);
  return Math.max(
    (1 - ACC_COOL) * aIDM + ACC_COOL * (aCAH + b * Math.tanh((aIDM - aCAH) / b)),
    -9 * (1 - RAIN_HARD * rainNow)
  );
}

// arr is sorted by s ascending. Returns the cars just ahead of / behind s,
// with wraparound; both may be the same car if the lane holds only one.
function neighborsAt(arr, s) {
  const n = arr.length;
  if (n === 0) return { leader: null, follower: null };
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].s <= s) lo = mid + 1;
    else hi = mid;
  }
  return { leader: arr[lo % n], follower: arr[(lo - 1 + n) % n] };
}

// A compact estimate of how much speed a lane can support over the next few
// seconds. The leader's pace matters, but extra runway lets an emergency vehicle
// accelerate before catching it. This provides the hysteresis MOBIL's
// instantaneous acceleration comparison lacks when two lanes are nearly tied.
function lanePace(leader, gap, v0) {
  if (!leader) return v0;
  return Math.min(v0, leader.v + Math.max(0, gap) / EMERGENCY_PASS_LOOKAHEAD);
}

function insertSorted(arr, car) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].s <= car.s) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, car);
}

export class Simulation {
  constructor() {
    this.cars = []; // every car, whatever its state
    this.rampState = new Map(); // ramp id → cars, measured flow, and upstream demand
    this.reset();
  }

  reset() {
    // Apply the road geometry knobs (no-op unless one changed). Doing this
    // here keeps the "GUI writes params, sim reads them" contract; a geometry
    // change just requires a reset, since car s-coordinates don't map across
    // shapes or sizes.
    setShape(params.roadShape, params.roadScale, params.interchanges);
    this.cars = [];
    this.incidents = []; // active breakdowns / accidents
    this.storm = null; // live rain storm (startStorm), on top of the Rain knob
    rainNow = this.rainNow = Math.min(1, params.rain);
    this.time = 0;
    this.history = []; // 1 Hz samples of {t, v, f, n, m, inc, rain, bins} for the live charts
    this.binCount = Math.ceil(LOOP / BIN_M); // space-time diagram resolution
    this.incidentStarts = []; // {t, s} per triggered incident (space-time ✕ markers)
    this.sampleTimer = 0;
    this.flowTimes = []; // sim timestamps of cars crossing s = 0
    this.counters = { entered: 0, merged: 0, exited: 0, laneChanges: 0 };
    // Clear removed interchange IDs as well as the active ramps on reset.
    this.rampState.clear();
    for (const ramp of RAMPS) this.rampState.set(ramp.id, {
      cars: [], flowTimes: [], demand: ramp.type === 'on' ? new RampDemand() : null,
    });

    const lanes = params.lanes;
    this._laneCount = lanes;
    const perLane = Math.floor(params.initialCars / lanes);
    const extra = params.initialCars - perLane * lanes;
    // slot: own length + min gap — the exact feasibility requirement; any
    // extra breathing room comes out of the randomized slack below, so a
    // layout that fits at minGap spacing is never rejected
    const need = (spec) => spec.len + params.minGap;
    // The innermost lane carries no trucks (on 3+ lanes), so sample trucks in
    // the eligible lanes at a boosted rate to keep the ROAD-WIDE mix at the
    // requested truckShare (capped at 100% when the knob asks for more than
    // the eligible lanes can express).
    const laneCounts = Array.from({ length: lanes }, (_, l) => perLane + (l < extra ? 1 : 0));
    const total = laneCounts.reduce((a, b) => a + b, 0);
    const eligibleTotal = lanes >= 3 ? total - laneCounts[lanes - 1] : total;
    const boostedShare =
      eligibleTotal > 0 ? Math.min(100, (params.truckShare * total) / eligibleTotal) : 0;
    for (let l = 0; l < lanes; l++) {
      const count = laneCounts[l];
      if (count === 0) continue;
      // no trucks in the innermost lane (they avoid it, see applyLaneChanges)
      const truckOk = !(lanes >= 3 && l === lanes - 1);
      // Choose kind AND model first, then pack: every vehicle gets its required slot
      // and the leftover road is dealt out as randomized extra gaps, so seeds
      // can never overlap at any density or mix. If the lane can't fit the
      // mix, trucks downgrade to cars; if it can't even fit the cars, the
      // lane seeds fewer vehicles than requested.
      const specs = [];
      for (let j = 0; j < count; j++) {
        specs.push(vehicleSpec(
          truckOk && Math.random() * 100 < boostedShare ? 'truck' : this.sampleCarKind()
        ));
      }
      let totalReq = specs.reduce((sum, spec) => sum + need(spec), 0);
      for (let j = 0; totalReq > LOOP && j < specs.length; j++) {
        if (specs[j].kind === 'truck') {
          const replacement = vehicleSpec('car');
          totalReq -= need(specs[j]) - need(replacement);
          specs[j] = replacement;
        }
      }
      while (totalReq > LOOP && specs.length) totalReq -= need(specs.pop());
      const slack = LOOP - totalReq;
      const weights = specs.map(() => 0.2 + Math.random());
      const wSum = weights.reduce((a, b) => a + b, 0);
      let s = Math.random() * LOOP;
      for (let j = 0; j < specs.length; j++) {
        const spec = specs[j];
        const car = new Car({
          s: wrap(s), lane: l, v0Factor: this.sampleV0Factor(spec.kind),
          kind: spec.kind, model: spec.model,
        });
        car.v = this.v0(car) * 0.85;
        this.cars.push(car);
        // centers: advance by half of this vehicle plus half of the next one
        // plus the gap, plus this slot's share of the slack (pair halves sum
        // to the same totalReq as need() around the loop)
        const nextSpec = specs[(j + 1) % specs.length];
        s +=
          (spec.len + nextSpec.len) / 2 +
          params.minGap +
          (slack * weights[j]) / wSum;
      }
    }
  }

  sampleKind() {
    return Math.random() * 100 < params.truckShare ? 'truck' : this.sampleCarKind();
  }

  // Trucks never get ACC; the knob is the share of CARS driving on it.
  sampleCarKind() {
    return Math.random() * 100 < params.accShare ? 'acc' : 'car';
  }

  sampleV0Factor(kind = 'car') {
    // trucks: slower (speed-limited / loaded) with less driver-to-driver spread.
    // ACC cars keep the full human spread — the driver still picks the set
    // speed; only the *following* behavior differs (see accACC).
    const base = kind === 'truck' ? 0.8 : 1;
    const spread = params.speedVariation * (kind === 'truck' ? 0.5 : 1);
    return base * (1 + spread * (Math.random() * 2 - 1));
  }

  v0(car) {
    // wet roads slow everyone's target speed, emergency vehicles included
    return params.desiredSpeed * car.v0Factor * (1 - RAIN_V0 * rainNow);
  }

  // Desired speed, reduced when the car is heading for an exit: it slows to
  // ramp speed approaching the diverge, and slows extra when it still needs
  // to get over to lane 0 — which is exactly what jams up real exits.
  // Incidents ahead reduce it too (rubbernecking), strongest in the lanes
  // closest to the wreck or the shoulder.
  effectiveV0(car) {
    let v0 = this.v0(car);
    if (car.exitRamp) {
      const dist = forwardDist(car.s, car.exitRamp.sDiverge);
      const rampV0 = params.rampSpeed;
      if (car.lane === 0 && dist < 130) {
        v0 = Math.min(v0, rampV0 + ((v0 - rampV0) * dist) / 130);
      } else if (car.lane > 0 && dist < 250) {
        v0 = Math.min(v0, Math.max(rampV0, (v0 * dist) / 250));
      }
    }
    if (
      !isEmergencyVehicle(car.kind) &&
      (this._emergencyVehicles?.length || this._ambs?.length)
    ) {
      const near = this.emergencyBehind(car, EMERGENCY_SIREN_RANGE, car.lane);
      // Only the siren's OWN lane slows, bleeding speed as it closes (down
      // to a floor the responder can still weave around): merging out into
      // same-speed neighbors is feasible where merging out of a fast lane is
      // not — the same trick exit-bound cars use to make lane 0. The other
      // lanes are deliberately left alone: capping them slows a 220 m zone
      // that TRAVELS WITH the responder, compressing the receiving lanes
      // into a clot that walls in both the corridor cars and the responder.
      if (near) {
        v0 = Math.min(
          v0,
          this.v0(car) * (0.65 + 0.35 * (near.dist / EMERGENCY_SIREN_RANGE))
        );
      }
    }
    const wz = this.workZone();
    if (wz) {
      const inside = forwardDist(wz.sStart, car.s) < wz.len;
      if (occupiesLane(car, wz.lane)) {
        const dist = inside ? 0 : forwardDist(car.s, wz.sStart);
        if (dist < WZ_WARN) {
          // Runway shrinking toward the cones: brake down like an exit car
          // and nose in — late-merge pressure is where the zipper (and the
          // capacity drop) comes from. Floor of 6 m/s while merging out.
          v0 = Math.min(v0, Math.max(6, (v0 * dist) / WZ_WARN));
        }
      } else if (inside || forwardDist(car.s, wz.sStart) < 60) {
        // posted work-zone speed through the cones, all lanes
        v0 = Math.min(v0, params.desiredSpeed * 0.7);
      }
    }
    if (car.incident) {
      // Pulling over for a breakdown: ease off while working over, but only
      // slow right down once in lane 0 — crawling in an inner lane makes the
      // gaps needed to get out of it unattainable.
      if (car.incident.phase === 'pullover') {
        v0 = Math.min(v0, car.lane === 0 ? Math.max(8, params.rampSpeed * 0.6) : v0 * 0.75);
      }
    } else if (this.incidents.length && !isEmergencyVehicle(car.kind)) {
      // emergency vehicles skip the rubbernecking cap: they are the ones on duty
      const LANE_WEIGHT = [0.7, 0.4, 0.2, 0.1];
      for (const inc of this.incidents) {
        for (const other of inc.cars) {
          const d = forwardDist(car.s, other.s); // upstream distance to the scene
          if (d > 200) continue;
          const laneDist = Math.abs(car.lane - (other.state === 'shoulder' ? -1 : other.lane));
          const w = LANE_WEIGHT[Math.min(laneDist, 3)];
          const proximity = Math.min(1, (200 - d) / 120); // full effect within 80 m
          v0 *= 1 - params.rubberneck * w * proximity;
        }
      }
    }
    return Math.min(v0, roadSpeedLimit(car, rainNow));
  }

  // A storm arc: rolls in over 40 s, pours for 90, clears over 50. The live
  // rain level each step is the max of this and the steady Rain knob, so the
  // knob sets a climate and the button throws weather at it. `delay` puts
  // the onset in the future — the downpour preset uses it to give the demo
  // a dry minute of baseline traffic before the tipping starts.
  startStorm(delay = 0) {
    this.storm = { t0: this.time + delay };
  }

  stormLevel() {
    if (!this.storm) return 0;
    const age = this.time - this.storm.t0;
    if (age < 0) return 0; // scheduled but not rolled in yet
    if (age < 40) return age / 40;
    if (age < 130) return 1;
    if (age < 180) return (180 - age) / 50;
    this.storm = null;
    return 0;
  }

  // The work zone cones off the INNERMOST lane over a stretch — ramps attach
  // to lane 0 and exits drift there, so the inner lane is the only one a
  // closure can take without colliding with ramp logic. Derived from params
  // on every call, so the sliders apply live with no reset; null when off.
  workZone() {
    if (!params.workZone) return null;
    return {
      lane: params.lanes - 1,
      len: Math.min(params.workZoneLen, LOOP - 100), // never cone the whole loop
      sStart: wrap((params.workZonePos / 100) * LOOP),
    };
  }

  onLaneCountChanged() {
    // Removing pavement is a geometry edit, not a merge. Clamping all cars
    // from removed lanes into one surviving lane can put several bodies at
    // the same s. Re-seed safely with the selected count instead.
    if (params.lanes < this._laneCount) {
      this.reset();
      return true;
    }
    this._laneCount = params.lanes;
    return false;
  }

  buildLaneIndex() {
    const arrs = Array.from({ length: params.lanes }, () => []);
    for (const car of this.cars) {
      if (car.state !== 'main') continue;
      arrs[car.lane]?.push(car);
      const source = car.laneChange?.from;
      if (source !== car.lane && source >= 0) arrs[source]?.push(car);
    }
    for (const arr of arrs) arr.sort((a, b) => a.s - b.s);
    return arrs;
  }

  beginLaneChange(car, targetLane, arrs, {
    fromLane = car.lane, endRender = targetLane, toShoulder = false, cooldown = 3.5,
  } = {}) {
    if (car.laneChange) return false;
    const duration = maneuverDuration(car);
    car.laneChange = {
      from: fromLane, to: targetLane, startRender: car.renderLane, endRender,
      elapsed: 0, duration, toShoulder,
    };
    if (targetLane >= 0) {
      car.lane = targetLane;
      if (arrs && !arrs[targetLane].includes(car)) insertSorted(arrs[targetLane], car);
    }
    car.lcCooldown = duration + cooldown;
    return true;
  }

  advanceLaneChange(car, h) {
    const change = car.laneChange;
    if (!change) return false;
    // A crashed vehicle comes to rest wherever it was crossing the line;
    // its source reservation survives until the wreck is removed.
    if (car.incident?.kind === 'accident') return true;
    change.elapsed = Math.min(change.elapsed + h, change.duration);
    const u = change.elapsed / change.duration;
    // Quintic smoothstep: continuous lateral speed/acceleration at each end.
    const progress = u * u * u * (10 + u * (-15 + 6 * u));
    car.renderLane = change.startRender + (change.endRender - change.startRender) * progress;
    if (u >= 1) {
      car.renderLane = change.endRender;
      if (change.toShoulder) car.state = 'shoulder';
      car.laneChange = null;
    }
    return true;
  }

  // Last safe waiting position on the ramp. Check the oriented body, not
  // just its center: a long truck's nose reaches the road well before the
  // center of a compact car. Geometry is cached per physical model length.
  rampHoldPosition(ramp, car) {
    ramp._holdPositions ??= new Map();
    if (ramp._holdPositions.has(car.len)) return ramp._holdPositions.get(car.len);
    const clear = (position) => {
      const projection = rampProjection(ramp, position);
      const tangent = ramp.curve.getTangentAt(position / ramp.length);
      // All procedural road vehicles fit inside this 2.7 m wide envelope.
      // Mainline half-width 1.35 m + .55 m clearance allows for curvature.
      for (const longitudinal of [-car.len / 2, 0, car.len / 2]) {
        for (const side of [-1.35, 1.35]) {
          const corner = projection.point.clone();
          corner.x += tangent.x * longitudinal - tangent.z * side;
          corner.z += tangent.z * longitudinal + tangent.x * side;
          if (localRoadProjection(corner, projection.s + longitudinal).offset < 1.9) return false;
        }
      }
      return true;
    };
    let lo = 0, hi = ramp.length;
    for (let i = 0; i < 24; i++) {
      const middle = (lo + hi) / 2;
      if (clear(middle)) lo = middle;
      else hi = middle;
    }
    ramp._holdPositions.set(car.len, lo);
    return lo;
  }

  syncRampMerge(car) {
    const projection = rampProjection(car.ramp, car.rampPos);
    car.s = projection.s;
    car.renderLane = -projection.offset / ROAD.laneWidth;
  }

  setRampMergeS(car, s) {
    // Invert the local, monotone projection after a mainline overlap repair,
    // so the rendered ramp position and both following constraints agree.
    const distance = forwardDist(s, car.ramp.sJoin);
    let lo = 0, hi = car.rampPos;
    for (let i = 0; i < 20; i++) {
      const middle = (lo + hi) / 2;
      const projected = rampProjection(car.ramp, middle);
      if (forwardDist(projected.s, car.ramp.sJoin) > distance) lo = middle;
      else hi = middle;
    }
    car.rampPos = lo;
    this.syncRampMerge(car);
  }

  advanceRampMerge(car, h) {
    car.sPrev = car.s;
    car.rampPos += car.v * h;
    car.laneChange.elapsed += h;
    if (car.rampPos < car.ramp.length) {
      this.syncRampMerge(car);
      return;
    }
    const ramp = car.ramp;
    car.s = wrap(ramp.sJoin + car.rampPos - ramp.length);
    car.renderLane = 0;
    const queue = this.rampState.get(ramp.id).cars;
    queue.splice(queue.indexOf(car), 1);
    car.ramp = null;
    car.rampMerge = false;
    car.laneChange = null;
    car.lcCooldown = Math.max(3, car.lcCooldown);
  }

  step(h) {
    if (params.lanes !== this._laneCount) this.onLaneCountChanged();
    this.time += h;

    // live rain: the steady knob or the storm arc, whichever is wetter —
    // every physics pass below reads the module-level value
    rainNow = this.rainNow = Math.min(1, Math.max(params.rain, this.stormLevel()));

    // Emergency vehicles: retire any that finished their siren run, and cache
    // the active list for corridor checks (emergencyBehind runs per ordinary
    // car per step, so repeatedly scanning all traffic would be wasteful).
    this._emergencyVehicles = [];
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (!isEmergencyVehicle(c.kind)) continue;
      if (!Number.isFinite(c.emergencyDist)) c.emergencyDist = emergencyRunDist();
      if (!Number.isFinite(c.emergencyUntil)) c.emergencyUntil = this.time + emergencyRunTime();
      if (c.incident) continue; // a wrecked responder is the incident's to clear
      c.emergencyDist -= c.v * h;
      // distance budget spent, or stuck long enough that it never will be
      if (c.emergencyDist <= 0 || this.time >= c.emergencyUntil) this.cars.splice(i, 1);
      else if (c.state === 'main') this._emergencyVehicles.push(c);
    }
    this._ambs = this._emergencyVehicles; // compatibility with the old cache name

    let arrs = this.buildLaneIndex();
    if (this.applyLaneChanges(arrs)) arrs = this.buildLaneIndex();
    this.accelMainline(arrs, h);
    this.accelRamps(arrs[0], h);
    this.accelWorkZone();
    this.accelIncidents();

    for (const car of this.cars) {
      car.lcCooldown -= h;
      car.v = Math.max(0, car.v + car.a * h);
      if (car.state === 'onramp' || car.state === 'offramp') {
        car.rampPos += car.v * h;
        if (car.state === 'onramp') {
          const hold = this.rampHoldPosition(car.ramp, car);
          if (car.rampPos > hold) {
            car.rampPos = hold;
            car.v = 0;
          }
        }
      } else if (car.rampMerge) {
        this.advanceRampMerge(car, h);
      } else {
        // 'main' and 'shoulder' both live in road coordinates
        car.sPrev = car.s;
        car.s = wrap(car.s + car.v * h);
        if (!this.advanceLaneChange(car, h)) {
          const target = car.state === 'shoulder' ? SHOULDER_LANE : car.lane;
          const dl = target - car.renderLane;
          const maxStep = 2.0 * h; // fallback for externally staged cars
          car.renderLane += Math.abs(dl) <= maxStep ? dl : Math.sign(dl) * maxStep;
        }
      }
    }

    arrs = this.buildLaneIndex();
    for (let pass = 0; pass < this.cars.length; pass++) {
      this.preventOverlaps(arrs);
      if (!this.preventRampOverlaps()) break;
    }
    this.updateIncidents(arrs);
    this.handleMarkers();
    this.handleMerges(arrs[0]);
    this.despawnExited();
    this.spawnFromRamps(h);
    this.updateLights();
    while (this.flowTimes.length && this.flowTimes[0] < this.time - 60) this.flowTimes.shift();
    // keep incident-start marks just past the charts' 5-minute window
    while (this.incidentStarts.length && this.incidentStarts[0].t < this.time - 310) {
      this.incidentStarts.shift();
    }
    for (const st of this.rampState.values()) {
      while (st.flowTimes.length && st.flowTimes[0] < this.time - 60) st.flowTimes.shift();
    }

    // chart history: one sample per sim-second, last 5 minutes
    this.sampleTimer += h;
    if (this.sampleTimer >= 1) {
      this.sampleTimer -= 1;
      const s = this.stats();
      this.history.push({
        t: this.time,
        v: s.avgSpeed,
        f: s.flowPerMin,
        n: s.count, // every vehicle, ramps included — matches the HUD
        m: s.mainCount, // mainline only — the fundamental diagram's density
        inc: this.incidents.length > 0,
        rain: rainNow, // the charts shade blue while it rained
        bins: this.speedBins(),
      });
      if (this.history.length > 300) this.history.shift();
    }
  }

  // Mean mainline speed for each BIN_M meters of s — one column of the
  // space-time diagram. -1 marks a bin with no vehicle in it.
  speedBins() {
    const n = this.binCount;
    const sums = new Float32Array(n);
    const counts = new Uint16Array(n);
    for (const car of this.cars) {
      if (car.state !== 'main') continue;
      const b = Math.min(n - 1, Math.floor(car.s / BIN_M));
      sums[b] += car.v;
      counts[b]++;
    }
    const bins = new Float32Array(n);
    for (let i = 0; i < n; i++) bins[i] = counts[i] ? sums[i] / counts[i] : -1;
    return bins;
  }

  // Driver-communication lights, resolved every step. Brake lights are
  // EV-regen style — on past a deceleration threshold, with hysteresis so
  // hovering at the threshold doesn't flicker — plus "holding the pedal"
  // when stopped. A jam wave reads as a red pulse running upstream. Turn
  // signals (+1 = inward/driver's left, -1 = outward/right) resolve by
  // priority: a maneuver in progress, merging in from a ramp, working over
  // toward a chosen exit, then blocked MOBIL desire (signalWant) — a car
  // that wants a gap it can't safely take blinks without moving. Incident
  // cars show hazards instead (renderer blinks the whole body amber).
  updateLights() {
    for (const car of this.cars) {
      if (car.incident) {
        car.signal = 0;
        car.brakeLit = false;
        continue;
      }
      // EV-regen thresholds at speed (ignite at -1.1, release at -0.7);
      // below a ~5 mph crawl the pedal stays covered: any slowing lights
      // the lamp and only a clear pull-away releases it. At a standstill
      // the light holds even through the slightly positive commanded a of
      // a blocked car whose gap breathes (that flicker read as stopped
      // cars with no brake lights).
      const onAt = car.v < 0.5 ? 0.3 : car.v < 2.2 ? 0 : -1.1;
      const offAt = car.v < 0.5 ? 0.3 : car.v < 2.2 ? 0.25 : -0.7;
      car.brakeLit = car.a < (car.brakeLit ? offAt : onAt);

      if (car.kind === 'ambulance') {
        // The ambulance model has no ordinary indicator clusters; its roof
        // strobes do the talking. Police cars and fire trucks keep flowing
        // through the normal desire/maneuver logic below because both models
        // have dedicated front and rear turn signals.
        car.signal = 0;
        continue;
      }
      if (car.state === 'onramp') {
        car.signal = car.ramp.length - car.rampPos < car.ramp.mergeZone + 40 ? 1 : 0;
      } else if (car.state === 'offramp') {
        car.signal = 0;
      } else if (car.laneChange) {
        car.signal = Math.sign(car.laneChange.endRender - car.laneChange.startRender);
      } else if (Math.abs(car.renderLane - car.lane) > 0.15) {
        car.signal = car.lane > car.renderLane ? 1 : -1; // mid-maneuver
      } else if (
        car.exitRamp &&
        (car.lane > 0 || forwardDist(car.s, car.exitRamp.sDiverge) < 250)
      ) {
        car.signal = -1;
      } else if (car.signalWant && this.time < car.signalUntil) {
        car.signal = car.signalWant;
      } else {
        car.signal = 0;
      }
    }
  }

  // Cars WAITING on each ramp. On-ramp queues are the COST side of ramp
  // metering, and of any inflow the merge can't absorb: the achieved rate
  // alone can't tell "demand is low" apart from "demand is high and the queue
  // is swallowing it", which is exactly the trade the meters demo asks you to
  // weigh. Off-ramps are included for symmetry; they rarely queue.
  //
  // Waiting, not merely present: total ramp occupancy counts a car that just
  // spawned and is driving down an open ramp toward a gap, so a free-flowing
  // ramp would flicker "1 queued" with no backpressure at all and the label
  // would stop meaning anything (Codex review).
  rampQueues() {
    const queues = {};
    for (const ramp of RAMPS) {
      queues[ramp.id] = this.rampState
        .get(ramp.id)
        .cars.filter((car) => car.v < RAMP_QUEUE_SPEED).length;
    }
    return queues;
  }

  // Demand waiting upstream has not entered the modeled ramp. Keep it
  // separate from stopped ramp cars, road occupancy, and measured throughput.
  rampDemand() {
    return Object.fromEntries(RAMPS
      .filter((ramp) => ramp.type === 'on')
      .map((ramp) => [ramp.id, this.rampState.get(ramp.id).demand.stats()]));
  }

  // Measured throughput of each ramp (cars/min over the last minute).
  rampFlows() {
    const window = Math.min(this.time, 60);
    const flows = {};
    for (const ramp of RAMPS) {
      const st = this.rampState.get(ramp.id);
      flows[ramp.id] = window > 5 ? st.flowTimes.length * (60 / window) : 0;
    }
    return flows;
  }

  accelMainline(arrs, h = 1 / 60) {
    for (const car of this.cars) {
      if (car.state === 'main') car._nextAcceleration = Infinity;
    }
    for (const arr of arrs) {
      // Take the more restrictive of the source and receiving lanes while
      // crossing. Publish only after ALL lanes, so an ACC driver always sees
      // the previous step's leader acceleration, including at s=0.
      for (let i = 0; i < arr.length; i++) {
        const car = arr[i];
        const leader = arr.length > 1 ? arr[(i + 1) % arr.length] : null;
        const gap = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const aIDM = idm(car, leader ? leader.v : car.v, gap, this.effectiveV0(car));
        // ACC only tempers real following situations; ramp queues and
        // blocked-gap cases (gap <= 0) keep the plain IDM/hard-brake result.
        const acceleration =
          car.kind === 'acc' && leader && Number.isFinite(gap) && gap > 0
            ? accACC(car, leader, gap, aIDM)
            : aIDM;
        // Response urgency depends on the gap AND closing speed. Evaluate
        // each occupied lane against the same previous acceleration before
        // taking the minimum; the most negative raw IDM target need not be
        // the lane that requires an immediate braking response.
        const realized = respond(car, acceleration, h, gap, leader ? leader.v : car.v);
        if (realized < car._nextAcceleration) {
          car._nextAcceleration = realized;
          car._followingGap = gap;
          car._leaderSpeed = leader ? leader.v : car.v;
        }
      }
    }
    for (const car of this.cars) {
      if (car.state === 'main') {
        car.a = car._nextAcceleration;
      }
    }
  }

  accelRamps(lane0, h = 1 / 60) {
    const p = params;
    const rampV0 = p.rampSpeed * (1 - RAIN_V0 * rainNow);
    for (const ramp of RAMPS) {
      const st = this.rampState.get(ramp.id);
      st.cars.sort((a, b) => a.rampPos - b.rampPos);
      if (p.metering && ramp.type === 'on') this.meterTick(ramp, st);
      // Speed of mainline traffic around the merge point, for speed matching.
      let localV = null;
      if (ramp.type === 'on' && st.cars.length) {
        const { leader } = neighborsAt(lane0, ramp.sJoin);
        localV = leader ? leader.v : null;
      }
      for (let i = 0; i < st.cars.length; i++) {
        const car = st.cars[i];
        // A car committed to the merge already follows lane0, but remains a
        // physical leader for the queue behind it until it clears the curve.
        if (car.rampMerge) continue;
        const leader = i + 1 < st.cars.length ? st.cars[i + 1] : null;
        let v0r = rampV0;
        if (ramp.type === 'on' && ramp.length - car.rampPos < ramp.mergeZone) {
          // Acceleration lane: match the speed of traffic being merged into.
          v0r =
            localV === null
              ? this.v0(car)
              : Math.min(this.v0(car), Math.max(localV + 2, rampV0 * 0.5));
        }
        let acc = leader
          ? idm(car, leader.v, leader.rampPos - car.rampPos - halfLens(car, leader), v0r)
          : idm(car, car.v, Infinity, v0r);
        acc = respond(car, acc, h,
          leader ? leader.rampPos - car.rampPos - halfLens(car, leader) : Infinity,
          leader ? leader.v : car.v);
        if (ramp.type === 'on') {
          // The ramp end is a wall, but only brake for it once physically
          // necessary — braking the IDM way the whole length of the ramp
          // would make every car crawl into the merge zone.
          const rem = this.rampHoldPosition(ramp, car) - car.rampPos;
          if (rem < 0.5) acc = Math.min(acc, -9);
          else {
            const needed = (car.v * car.v) / (2 * rem);
            if (needed > p.safeBrake * 0.8) acc = Math.min(acc, -needed);
          }
          // Ramp meter: a second, releasable wall at the stop line (the
          // start of the acceleration lane). Held cars brake for it early —
          // comfortBrake, not the end-wall's last-moment slam — so the queue
          // settles AT the line. Cars already past it (metering toggled on
          // mid-flight, or a released straddler that crept through) are left
          // alone: the wall only exists while rem says the line is ahead.
          if (p.metering && !car.meterGo) {
            const remM = ramp.length - ramp.mergeZone - car.rampPos - car.len / 2;
            if (remM > -1.5) {
              if (remM < 0.5) acc = Math.min(acc, -9);
              else {
                const needed = (car.v * car.v) / (2 * remM);
                if (needed > p.comfortBrake * 0.7) acc = Math.min(acc, -needed);
              }
            }
          }
        }
        car.a = acc;
      }
    }
  }

  // One car per green: when the cycle clock allows and the head of the held
  // queue has arrived at (or is rolling up to) the stop line, wave it
  // through and restart the clock. An idle meter doesn't bank greens — the
  // clock only counts down against a waiting car — so at low demand cars
  // roll up, get their green, and barely have to stop; the meter only binds
  // when demand outruns the rate, which is the whole point.
  meterTick(ramp, st) {
    st.nextGreenAt ??= 0;
    st.greenUntil ??= 0;
    if (this.time < st.nextGreenAt) return;
    const meterS = ramp.length - ramp.mergeZone;
    for (let i = st.cars.length - 1; i >= 0; i--) {
      const car = st.cars[i];
      if (car.meterGo || car.rampPos - car.len / 2 >= meterS) continue; // already through
      if (meterS - car.rampPos - car.len / 2 < 14) {
        car.meterGo = true;
        st.nextGreenAt = this.time + 60 / Math.max(1, params.meterRate);
        st.greenUntil = this.time + 1.0; // renderer flashes the green lamp
      }
      break; // only ever consider the head of the held queue
    }
  }

  // MOBIL-style: change lanes when the acceleration gain (discounted by the
  // politeness-weighted cost to the new follower) beats the threshold, and the
  // new follower is never forced to brake harder than safeBrake. Cars heading
  // for an exit only consider moving outward once the exit is near.
  applyLaneChanges(arrs) {
    const p = params;
    const wz = this.workZone();
    let changed = false;
    // Visit each driver once, but reserve accepted gaps immediately. Otherwise
    // two drivers on opposite sides of a lane can both claim the same space.
    const candidates = arrs.map((arr) => arr.slice());
    for (let l = 0; l < arrs.length; l++) {
      const arr = arrs[l];
      for (const car of candidates[l]) {
        if (car.lcCooldown > 0 || car.laneChange || car.lane !== l) continue;
        // Wrecked cars sit still; breakdown cars only change lanes while
        // working their way over to the shoulder.
        const pullover = car.incident?.phase === 'pullover';
        if (car.incident && !pullover) continue;
        const i = arr.indexOf(car);

        // Emergency driving: the responder hunts a meaningfully faster lane
        // with no politeness, then commits to the opening instead of reacting
        // to every momentary acceleration advantage.
        // Everyone else checks for a siren bearing down (see emergencyBehind):
        // being in its lane makes leaving near-mandatory, and nobody moves
        // INTO its lane inside the corridor.
        const emergency = isEmergencyVehicle(car.kind);
        const siren = emergency
          ? null
          : this.emergencyBehind(car, EMERGENCY_SIREN_RANGE, l);
        const yielding = !!siren;
        const sirenNear = yielding ? 1 - siren.dist / EMERGENCY_SIREN_RANGE : 0;
        const yieldUrgency = yielding ? 3.2 + 3 * sirenNear : 0;

        const v0 = this.effectiveV0(car);
        const leader = arr.length > 1 ? arr[(i + 1) % arr.length] : null;
        const curGap = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const curAcc = idm(car, leader ? leader.v : car.v, curGap, v0);
        const curPace = emergency ? lanePace(leader, curGap, v0) : 0;

        // Work zone: a car in the closed lane must be out before the cones.
        // Inside counts as distance 0 — cars caught by a live toggle escape
        // outward at full urgency.
        let wzDist = Infinity;
        if (wz && l === wz.lane) {
          wzDist = forwardDist(wz.sStart, car.s) < wz.len ? 0 : forwardDist(car.s, wz.sStart);
        }
        const wzUrgent = wzDist < WZ_WARN;

        const exitDist = car.exitRamp ? forwardDist(car.s, car.exitRamp.sDiverge) : Infinity;
        const mandatory = exitDist < 400 || pullover || wzUrgent;
        // A stranded car gets bolder about cutting in the longer it has waited.
        let brakeLimit = p.safeBrake * (1 - RAIN_HARD * rainNow); // wet: gentler gates
        if (pullover) {
          brakeLimit *= 1 + Math.min((this.time - car.incident.phaseStart) / 10, 1.5);
        } else if (emergency) {
          // A useful passing opening can warrant a firm merge.
          brakeLimit *= 1.5;
        } else if (yielding) {
          // A vehicle directly ahead of the siren accepts progressively firmer
          // braking from the receiving lane rather than waiting indefinitely
          // for an ordinary commuter-sized gap.
          brakeLimit *= 1.75 + 0.75 * sirenNear;
        }

        let targets;
        if (mandatory) targets = l > 0 ? [l - 1] : [];
        else {
          targets = [];
          if (l > 0) targets.push(l - 1);
          if (l < arrs.length - 1) targets.push(l + 1);
          // trucks stay out of the innermost lane on 3+ lane roads
          if (car.kind === 'truck' && arrs.length >= 3) {
            targets = targets.filter((t) => t < arrs.length - 1);
          }
        }

        let bestLane = -1;
        // Trucks rarely bother changing lanes. Emergency vehicles use the normal
        // MOBIL threshold after the stronger projected-pace gate below.
        let bestScore = p.laneChangeThreshold * (car.kind === 'truck' ? 2.5 : 1);
        let wantLane = -1;
        // Blinker-worthy desire needs a clearly better lane, not a marginal
        // preference — without this margin nearly half of dense traffic blinks.
        let wantScore = bestScore + 0.3;
        for (const t of targets) {
          // Check each candidate independently: a closer responder in some
          // other lane must not hide a siren bearing down in this target lane.
          if (
            !emergency &&
            this.emergencyBehind(car, EMERGENCY_SIREN_RANGE, t)
          ) {
            continue;
          }
          // never merge into the coned lane on its approach or inside it
          if (
            wz &&
            t === wz.lane &&
            (forwardDist(wz.sStart, car.s) < wz.len || forwardDist(car.s, wz.sStart) < WZ_WARN)
          ) {
            continue;
          }
          const { leader: nl, follower: nf } = neighborsAt(arrs[t], car.s);
          const gapAhead = nl ? forwardDist(car.s, nl.s) - halfLens(car, nl) : Infinity;
          const gapBehind = nf ? forwardDist(nf.s, car.s) - halfLens(nf, car) : Infinity;

          const myNew = idm(car, nl ? nl.v : car.v, gapAhead, v0);
          // Do not weave for a marginal instantaneous acceleration advantage:
          // the target lane has to support a noticeably faster pace over the
          // next few seconds. This is the main flip-flop guard.
          //
          // A MANDATORY move is exempt: it isn't a pass, it's getting out of a
          // lane that ends. Work-zone v0 is capped at the taper's crawl floor
          // for BOTH lanes, so a pace GAIN is unsatisfiable there and the gate
          // vetoed every escape. A responder that spawned in the coned lane
          // then sat at the taper forever, never spending its distance budget
          // and so never despawning.
          if (
            emergency &&
            !mandatory &&
            lanePace(nl, gapAhead, v0) < curPace + EMERGENCY_PASS_SPEED_GAIN
          ) {
            continue;
          }
          // Desire, gauged before the gap/safety gates below: the gain the
          // driver sees in the target lane, whether or not the move is safe.
          // A passing desire lights the blinker (see updateLights) — a car
          // that wants a gap it can't take blinks without moving.
          let want = myNew - curAcc + (emergency ? 0 : t < l ? 0.08 : -0.08);
          if (pullover) want += 2.5;
          else if (wzUrgent) want += 1 + 3 * (1 - wzDist / WZ_WARN);
          else if (mandatory) want += 1 + 3 * (1 - exitDist / 400);
          else if (yielding) want += yieldUrgency + (t < l ? 0.35 : 0);
          if (want > wantScore) {
            wantScore = want;
            wantLane = t;
          }

          // Emergency moves may use a smaller physical gap; the braking gate
          // below still decides whether the receiving follower can cope.
          const gapFloor = p.minGap * (emergency ? 0.5 : yielding ? 0.25 : 1);
          if (gapAhead < gapFloor || gapBehind < gapFloor) continue;
          let nfNew = 0;
          let nfOld = 0;
          if (nf) {
            nfNew = idm(nf, car.v, gapBehind, this.v0(nf));
            if (nfNew < -brakeLimit) continue;
            const nfCurGap = nl && nf !== nl ? forwardDist(nf.s, nl.s) - halfLens(nf, nl) : Infinity;
            nfOld = idm(nf, nl ? nl.v : nf.v, nfCurGap, this.v0(nf));
          }

          let score =
            myNew - curAcc - (emergency ? 0 : p.politeness *
              driverFactor(car, 'politeness', p.driverVariation)) * Math.max(0, nfOld - nfNew);
          // Emergency vehicles choose on projected pace above, with no directional
          // bias that could pull them straight back into the lane they left.
          // Everyone else keeps the mild keep-right bias.
          if (!emergency) score += t < l ? 0.08 : -0.08;
          if (pullover) score += 2.5;
          else if (wzUrgent) score += 1 + 3 * (1 - wzDist / WZ_WARN);
          else if (mandatory) score += 1 + 3 * (1 - exitDist / 400);
          // strong from the moment the siren is audible — real drivers clear
          // early, not when the bumper arrives (a distance-proportional bonus
          // left cars sitting until the last 80 m)
          else if (yielding) score += yieldUrgency + (t < l ? 0.35 : 0);
          if (score > bestScore) {
            bestScore = score;
            bestLane = t;
          }
        }

        if (bestLane >= 0) {
          this.beginLaneChange(car, bestLane, arrs, {
            cooldown: emergency ? EMERGENCY_LANE_HOLD : mandatory ? 1.2 : 3.5,
          });
          this.counters.laneChanges++;
          changed = true;
        } else {
          car.lcCooldown = 0.2 + Math.random() * 0.2;
          if (wantLane >= 0) {
            // wanted a lane but couldn't take it: blink until re-evaluated
            car.signalWant = wantLane > l ? 1 : -1;
            car.signalUntil = this.time + 1.0;
          }
        }
      }
    }
    return changed;
  }

  // IDM should keep cars apart on its own; this is a belt-and-braces clamp so
  // extreme parameter combinations can't make cars drive through each other.
  preventOverlaps(arrs) {
    // A crossing vehicle participates in two ordering constraints. Moving it
    // back in one lane can tighten the other lane, so propagate corrections
    // until neither lane has an overlap. In normal operation the first pass
    // makes no correction; the bound also handles a compressed queue spanning
    // many cars without recursive stack growth.
    let moved = false;
    for (let pass = 0; pass < this.cars.length; pass++) {
      let corrected = false;
      for (const arr of arrs) {
        if (arr.length < 2) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          const car = arr[i];
          const leader = arr[(i + 1) % arr.length];
          const gap = forwardDist(car.s, leader.s) - halfLens(car, leader);
          if (gap < 0.2) {
            car.s = wrap(leader.s - halfLens(car, leader) - 0.25);
            if (car.rampMerge) this.setRampMergeS(car, car.s);
            car.v = Math.min(car.v, leader.v);
            corrected = true;
            moved = true;
          }
        }
      }
      if (!corrected) break;
    }
    // A repair across s=0 rotates an otherwise valid circular ordering. The
    // subsequent ramp/reentry searches use binary search, which also needs
    // the ordinary ascending ordering restored at that seam.
    if (moved) for (const arr of arrs) arr.sort((a, b) => a.s - b.s);
  }

  // Point-crossing events: the flow counter at s = 0, exit decisions at each
  // off-ramp's decision marker, and the diverge itself.
  handleMarkers() {
    for (const car of this.cars) {
      if (car.state !== 'main' || car.rampMerge) continue;
      const traveled = forwardDist(car.sPrev, car.s);
      // 0 = didn't move; > 30 = was pushed backward by the overlap clamp and
      // the wrapped "distance" is bogus. Real per-step travel is < 1 m.
      if (traveled <= 0 || traveled > 30) continue;

      if (forwardDist(car.sPrev, 0) < traveled) this.flowTimes.push(this.time);

      for (const ramp of RAMPS) {
        if (ramp.type !== 'off') continue;
        if (
          !car.exitRamp &&
          !car.incident &&
          !isEmergencyVehicle(car.kind) && // emergency run ends by distance, never an exit
          forwardDist(car.sPrev, ramp.decideS) < traveled
        ) {
          if (Math.random() * 100 < params[ramp.rateKey]) car.exitRamp = ramp;
        }
        if (car.exitRamp === ramp && forwardDist(car.sPrev, ramp.sDiverge) < traveled) {
          if (car.lane === 0 && !car.laneChange) {
            car.state = 'offramp';
            car.ramp = ramp;
            car.rampPos = forwardDist(ramp.sDiverge, car.s);
            car.exitRamp = null;
            const st = this.rampState.get(ramp.id);
            st.cars.push(car);
            st.flowTimes.push(this.time);
          } else {
            car.exitRamp = null; // missed the exit; carry on around the loop
          }
        }
      }
    }
  }

  handleMerges(lane0) {
    const p = params;
    for (const ramp of RAMPS) {
      if (ramp.type !== 'on') continue;
      const st = this.rampState.get(ramp.id);
      // Front-most ramp car first; it has priority for the next gap.
      for (let i = st.cars.length - 1; i >= 0; i--) {
        const car = st.cars[i];
        if (car.state !== 'onramp') continue;
        const remaining = ramp.length - car.rampPos;
        if (remaining > ramp.mergeZone) break;
        // Reserve lane0 just before this body's nose reaches it. The curve
        // itself completes the merge, so neither position nor direction
        // jumps when changing the simulation's following constraints.
        if (car.rampPos < this.rampHoldPosition(ramp, car) - 10) break;
        const projection = rampProjection(ramp, car.rampPos);
        const sIns = projection.s;
        const { leader, follower } = neighborsAt(lane0, sIns);
        const gapAhead = leader ? forwardDist(sIns, leader.s) - halfLens(car, leader) : Infinity;
        const gapBehind = follower ? forwardDist(follower.s, sIns) - halfLens(follower, car) : Infinity;
        // Braking-distance-based acceptance: each party needs a half-second
        // of headway plus room to shed any speed difference at a hard-but-
        // survivable rate. Slow jammed traffic needs only small gaps (zipper
        // merge); fast traffic demands long ones. A car running out of ramp
        // gets desperate and noses in, forcing the follower to yield — which
        // is where merge-induced jam waves come from.
        const usableRemaining = Math.max(0, this.rampHoldPosition(ramp, car) - car.rampPos);
        const desperation = 1 + 2 * Math.max(0, 1 - usableRemaining / 20);
        const shed = 2 * p.safeBrake * (1 - RAIN_HARD * rainNow) * 1.5 * desperation;
        const needAhead =
          p.minGap +
          (0.5 * car.v) / desperation +
          (leader ? Math.max(0, car.v ** 2 - leader.v ** 2) / shed : 0);
        const needBehind = follower
          ? p.minGap +
            (0.5 * follower.v) / desperation +
            Math.max(0, follower.v ** 2 - car.v ** 2) / shed
          : 0;
        // The single ramp lane cannot pass its own queue head. Reserving a
        // gap for a follower while the head waits would make them block each
        // other: the follower cannot drive through the head, and its lane0
        // reservation would then deny the head's reentry gap forever.
        if (gapAhead < needAhead || gapBehind < needBehind) break;

        car.state = 'main';
        car.lane = 0;
        car.renderLane = -projection.offset / ROAD.laneWidth;
        car.s = sIns;
        car.sPrev = sIns;
        car.rampMerge = true;
        this.beginLaneChange(car, 0, [lane0], { fromLane: -1, cooldown: 3 });
        st.flowTimes.push(this.time);
        this.counters.merged++;
      }
    }
  }

  // The cones are a wall: a car still in the closed lane stops at the taper
  // rather than driving through it. A car stopped at the cones nosing into
  // the open lane is the zipper's slow half — and the queue it grows is the
  // work zone's capacity drop.
  accelWorkZone() {
    const wz = this.workZone();
    if (!wz) return;
    for (const car of this.cars) {
      if (car.state !== 'main' || !occupiesLane(car, wz.lane) || car.incident) continue;
      const dist = forwardDist(car.s, wz.sStart);
      // far away, or already inside (a live toggle caught it: it escapes
      // outward under full merge urgency instead of stopping dead)
      if (dist > 200 || forwardDist(wz.sStart, car.s) < wz.len) continue;
      const gap = dist - car.len / 2 - 1.5;
      car.a = Math.min(car.a, idm(car, 0, gap, this.effectiveV0(car)));
    }
  }

  // Acceleration overrides for cars involved in an incident. Runs after the
  // regular car-following pass so it wins.
  accelIncidents() {
    for (const inc of this.incidents) {
      for (const car of inc.cars) {
        if (inc.kind === 'accident') {
          car.a = -9; // emergency stop, then stays put
        } else if (inc.phase === 'stopping') {
          car.a = Math.min(car.a, -Math.max(params.comfortBrake * 1.5, 2));
        } else if (inc.phase === 'parked') {
          car.a = 0;
          car.v = 0;
        } else if (inc.phase === 'reenter') {
          // roll along the shoulder building speed for the merge
          car.a = idm(car, car.v, Infinity, Math.min(params.rampSpeed, this.v0(car)));
        }
        // 'pullover' keeps its normal mainline acceleration
      }
    }
  }

  // Incident phase machine: breakdowns pull over → park → re-merge; accident
  // wrecks vanish when their timer expires.
  updateIncidents(arrs) {
    const p = params;
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const inc = this.incidents[i];

      if (inc.kind === 'accident') {
        if (this.time >= inc.clearAt) {
          for (const car of inc.cars) this.removeCar(car);
          this.incidents.splice(i, 1);
        }
        continue;
      }

      // breakdown
      const car = inc.cars[0];
      const phaseTime = this.time - inc.phaseStart;
      if (inc.phase === 'pullover') {
        if (car.lane === 0 && !car.laneChange && Math.abs(car.renderLane) < 0.25) {
          this.beginLaneChange(car, -1, arrs, {
            endRender: SHOULDER_LANE, toShoulder: true, cooldown: 0,
          });
          this.setPhase(inc, 'stopping');
        } else if (phaseTime > 20 && car.lane > 0 && car.lcCooldown <= 0 && !car.laneChange) {
          // Out of patience: accept a smaller comfort margin, never an
          // occupied space. Keep the index current for other breakdowns.
          const targetLane = car.lane - 1;
          const { leader, follower } = neighborsAt(arrs[targetLane], car.s);
          const gapAhead = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
          const gapBehind = follower ? forwardDist(follower.s, car.s) - halfLens(follower, car) : Infinity;
          if (gapAhead >= p.minGap && gapBehind >= p.minGap) {
            this.beginLaneChange(car, targetLane, arrs, { cooldown: 1.5 });
          }
        }
      } else if (inc.phase === 'stopping') {
        if (car.v < 0.05 && car.state === 'shoulder') {
          car.v = 0;
          this.setPhase(inc, 'parked');
          inc.parkedUntil = this.time + p.incidentDuration;
        }
      } else if (inc.phase === 'parked') {
        if (this.time >= inc.parkedUntil) this.setPhase(inc, 'reenter');
      } else if (inc.phase === 'reenter') {
        const { leader, follower } = neighborsAt(arrs[0], car.s);
        const gapAhead = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const gapBehind = follower ? forwardDist(follower.s, car.s) - halfLens(follower, car) : Infinity;
        const desperation = 1 + 2 * Math.min(phaseTime / 12, 1);
        const shed = 2 * p.safeBrake * (1 - RAIN_HARD * rainNow) * 1.5 * desperation;
        const needAhead =
          p.minGap +
          (0.5 * car.v) / desperation +
          (leader ? Math.max(0, car.v ** 2 - leader.v ** 2) / shed : 0);
        const needBehind = follower
          ? p.minGap +
            (0.5 * follower.v) / desperation +
            Math.max(0, follower.v ** 2 - car.v ** 2) / shed
          : 0;
        // Patience changes the accepted headway above, but a timeout cannot
        // create a gap. Stay on the shoulder until traffic provides one.
        if (gapAhead > needAhead && gapBehind > needBehind) {
          car.state = 'main';
          car.lane = 0;
          car.incident = null;
          this.beginLaneChange(car, 0, arrs, { fromLane: -1, cooldown: 3 });
          this.incidents.splice(i, 1);
        }
      }
    }
  }

  setPhase(inc, phase) {
    inc.phase = phase;
    inc.phaseStart = this.time;
  }

  triggerBreakdown() {
    const car = this.randomEligibleCar();
    if (!car) return;
    car.exitRamp = null;
    const inc = { kind: 'breakdown', cars: [car], phase: 'pullover', phaseStart: this.time };
    car.incident = inc;
    this.incidents.push(inc);
    this.incidentStarts.push({ t: this.time, s: car.s });
  }

  triggerAccident(car) {
    if (!car || car.state !== 'main' || car.incident) return;
    const inc = { kind: 'accident', cars: [car], clearAt: this.time + params.incidentDuration };
    this.wreck(car, inc);
    if (params.accidentLanes >= 2 && params.lanes > 1) {
      // drag the nearest neighbor in the adjacent lane into the pileup
      const otherLane = car.lane + 1 < params.lanes ? car.lane + 1 : car.lane - 1;
      let best = null;
      let bestD = 25;
      for (const c of this.cars) {
        if (c.state !== 'main' || c.incident || !occupiesLane(c, otherLane)) continue;
        const d = Math.min(forwardDist(car.s, c.s), forwardDist(c.s, car.s));
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best) this.wreck(best, inc);
    }
    this.incidents.push(inc);
    this.incidentStarts.push({ t: this.time, s: car.s });
  }

  wreck(car, inc) {
    car.incident = inc;
    car.exitRamp = null;
    car.wreckYaw = (Math.random() - 0.5) * 0.6;
    inc.cars.includes(car) || inc.cars.push(car);
  }

  triggerRandomAccident() {
    this.triggerAccident(this.randomEligibleCar());
  }

  randomEligibleCar() {
    const eligible = this.cars.filter(
      (c) => c.state === 'main' && !c.rampMerge && !c.incident && !isEmergencyVehicle(c.kind)
    );
    return eligible.length ? eligible[Math.floor(Math.random() * eligible.length)] : null;
  }

  clearIncidents() {
    for (const inc of this.incidents) {
      for (const car of inc.cars) this.removeCar(car);
    }
    this.incidents = [];
  }

  removeCar(car) {
    const i = this.cars.indexOf(car);
    if (i >= 0) this.cars.splice(i, 1);
    if (car.ramp) {
      const queue = this.rampState.get(car.ramp.id)?.cars;
      const index = queue?.indexOf(car) ?? -1;
      if (index >= 0) queue.splice(index, 1);
    }
  }

  // Find the safest placement in the innermost lane for a vehicle of `kind`.
  // Positions are centers, so a feasible slot must fit both neighboring half
  // lengths, the new vehicle's full length, and minGap at both bumpers. This is
  // more important for a fire truck than the old center-gap midpoint scan: a
  // large center gap can still be physically too short between long vehicles.
  emergencySpawnSlot(arr, kind) {
    const len = VEHICLE_LEN[kind];
    if (!arr.length) return { s: 0, v: params.desiredSpeed, slack: Infinity };

    let best = null;
    for (let i = 0; i < arr.length; i++) {
      const behind = arr[i];
      const ahead = arr[(i + 1) % arr.length];
      // A lone car's gap to itself is the whole loop, not forwardDist(s, s)=0.
      const centerGap = arr.length === 1 ? LOOP : forwardDist(behind.s, ahead.s);
      const needBehind = (behind.len + len) / 2 + params.minGap;
      const needAhead = (len + ahead.len) / 2 + params.minGap;
      const slack = centerGap - needBehind - needAhead;
      if (slack < 0 || (best && slack <= best.slack)) continue;
      best = {
        s: wrap(behind.s + needBehind + slack / 2),
        v: Math.max(behind.v, 8), // never materialize at rest mid-traffic
        slack,
      };
    }
    return best;
  }

  // Send a random feasible emergency vehicle around the loop. Passing a kind
  // makes selection deterministic (and backs the compatibility wrapper below).
  // Omitted-kind selection is uniform across the models that physically fit.
  spawnEmergencyVehicle(kind) {
    const emergencyCount = this.cars.filter((c) => isEmergencyVehicle(c.kind)).length;
    if (emergencyCount >= MAX_EMERGENCY_VEHICLES) return null;

    // Innermost lane, except never the coned one: a work zone closes exactly
    // that lane, and since ordinary traffic has already vacated it the widest
    // gap in it is almost always INSIDE the cones, so dispatch would drop the
    // responder into a closed lane and drive it through the taper.
    const closed = this.workZone()?.lane ?? -1;
    let lane = params.lanes - 1;
    if (lane === closed) lane = Math.max(0, lane - 1);
    const arr = this.buildLaneIndex()[lane];
    const kinds =
      kind === undefined ? EMERGENCY_KINDS : isEmergencyVehicle(kind) ? [kind] : [];
    const candidates = kinds
      .map((candidateKind) => ({
        kind: candidateKind,
        slot: this.emergencySpawnSlot(arr, candidateKind),
      }))
      .filter((candidate) => candidate.slot);
    if (!candidates.length) return null;

    const index =
      kind === undefined
        ? Math.min(candidates.length - 1, Math.floor(Math.random() * candidates.length))
        : 0;
    const chosen = candidates[index];
    const emergency = new Car({
      s: chosen.slot.s,
      lane,
      v: chosen.slot.v,
      kind: chosen.kind,
    });
    emergency.emergencyDist = emergencyRunDist(); // siren-run budget in meters driven
    emergency.emergencyUntil = this.time + emergencyRunTime(); // ...and its deadline
    this.cars.push(emergency);
    return emergency;
  }

  spawnAmbulance() {
    return this.spawnEmergencyVehicle('ambulance');
  }

  // Nearest active emergency vehicle approaching this car from behind, within
  // the move-over corridor range. Passing a lane restricts the search so each
  // responder corridor remains independent when several sirens are active.
  // Null when no relevant siren bears down on the car.
  emergencyBehind(car, range = EMERGENCY_SIREN_RANGE, lane = null) {
    let best = null;
    let bestD = range;
    const active = this._emergencyVehicles?.length ? this._emergencyVehicles : this._ambs || [];
    for (const emergency of active) {
      if (emergency === car || (lane !== null && !occupiesLane(emergency, lane))) continue;
      const d = forwardDist(emergency.s, car.s);
      if (d < bestD) {
        bestD = d;
        best = emergency;
      }
    }
    return best && { emergency: best, dist: bestD };
  }

  // Compatibility with pre-generic callers and the old `{amb, dist}` result.
  // New code should use emergencyBehind and its `{emergency, dist}` result.
  ambBehind(car, range = EMERGENCY_SIREN_RANGE) {
    const result = this.emergencyBehind(car, range);
    return result && { amb: result.emergency, dist: result.dist };
  }

  // Nearest car to a pointer ray ({origin, dir}, dir normalized), measured
  // point-to-ray in 3D so elevation counts: a ground-plane hit point lands
  // metres past a car on the figure eight's bridge, and at its crossing both
  // levels share x/z. The small penalty along the ray means that when it
  // threads both levels, the nearer (upper) car wins — it's the visible one.
  // Click-to-crash uses the default filter (normal mainline cars only); the
  // hover readout passes any = true to also read ramp, shoulder, and
  // incident cars.
  carNearRay(ray, radius = 9, any = false) {
    let best = null;
    let bestScore = Infinity;
    const { origin, dir } = ray;
    for (const car of this.cars) {
      if (!any && (car.state !== 'main' || car.incident)) continue;
      const pos = car.ramp
        ? car.ramp.curve.getPointAt(Math.min(Math.max(car.rampPos / car.ramp.length, 0), 1))
        : pointAt(car.s, -car.renderLane * ROAD.laneWidth);
      const vx = pos.x - origin.x;
      const vy = pos.y + 0.8 - origin.y; // aim at mid-body, not the tire line
      const vz = pos.z - origin.z;
      const t = Math.max(0, vx * dir.x + vy * dir.y + vz * dir.z);
      const d = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - t * t));
      const score = d + t * 0.004; // ~2.6 cm per m of depth at the crossing
      if (d < radius && score < bestScore) {
        bestScore = score;
        best = car;
      }
    }
    return best;
  }

  despawnExited() {
    for (const ramp of RAMPS) {
      if (ramp.type !== 'off') continue;
      const st = this.rampState.get(ramp.id);
      for (let i = st.cars.length - 1; i >= 0; i--) {
        const car = st.cars[i];
        if (car.rampPos >= ramp.length - 1) {
          st.cars.splice(i, 1);
          const j = this.cars.indexOf(car);
          if (j >= 0) this.cars.splice(j, 1);
          this.counters.exited++;
        }
      }
    }
  }

  spawnFromRamps(h) {
    for (const ramp of RAMPS) {
      if (ramp.type !== 'on') continue;
      const st = this.rampState.get(ramp.id);
      st.demand.advance(h, params[ramp.rateKey] / 60, params.arrivalMode,
        () => vehicleSpec(this.sampleKind()));
      const spec = st.demand.peek();
      if (!spec) continue;
      // st.cars is sorted by rampPos; index 0 is nearest the ramp entrance.
      // The new vehicle spawns centered at 0, so clearance needs both halves.
      // The FIFO head was sampled at request time. Never reroll a blocked
      // Cybertruck, or let a shorter EV jump the queue when only it would fit.
      if (
        st.cars.length &&
        st.cars[0].rampPos < (st.cars[0].len + spec.len) / 2 + 4
      )
        continue;
      st.demand.admit();
      // A driver joining the back of an upstream queue is already matching
      // its pace. Spawning at 12 m/s into four metres behind a stopped car
      // would require more stopping distance than this entrance provides.
      const entranceLeader = st.cars[0];
      const car = new Car({
        v: Math.min(12, entranceLeader?.v ?? 12),
        v0Factor: this.sampleV0Factor(spec.kind), kind: spec.kind, model: spec.model,
      });
      car.state = 'onramp';
      car.ramp = ramp;
      car.rampPos = 0;
      st.cars.unshift(car); // preserve nearest-entrance-first ordering immediately
      this.cars.push(car);
      this.counters.entered++;
    }
  }

  preventRampOverlaps() {
    // Keep the same emergency backstop as the mainline during severe
    // backpressure, including the short stopping queues at ramp meters.
    // The front-to-back pass propagates a correction through the whole queue.
    let mainlineMoved = false;
    for (const ramp of RAMPS) {
      const cars = this.rampState.get(ramp.id).cars;
      let leader = null;
      for (let i = cars.length - 1; i >= 0; i--) {
        const car = cars[i];
        if (car.state !== 'onramp' && car.state !== 'offramp' && !car.rampMerge) continue;
        if (leader) {
          const limit = leader.rampPos - halfLens(car, leader) - 0.25;
          if (car.rampPos > limit) {
            car.rampPos = limit;
            car.v = Math.min(car.v, leader.v);
            if (car.rampMerge) {
              this.syncRampMerge(car);
              mainlineMoved = true;
            }
          }
        }
        leader = car;
      }
    }
    return mainlineMoved;
  }

  stats() {
    let sum = 0;
    let n = 0;
    for (const car of this.cars) {
      if (car.state === 'main') {
        sum += car.v;
        n++;
      }
    }
    const window = Math.min(this.time, 60);
    const upstreamWaiting = [...this.rampState.values()]
      .reduce((sum, st) => sum + (st.demand?.waiting ?? 0), 0);
    return {
      count: this.cars.length,
      mainCount: n, // mainline only — the loop's density excludes ramp queues
      avgSpeed: n ? sum / n : 0, // m/s; display layer converts
      flowPerMin: window > 5 ? this.flowTimes.length * (60 / window) : 0,
      requested: this.counters.entered + upstreamWaiting,
      upstreamWaiting,
      ...this.counters,
    };
  }
}
