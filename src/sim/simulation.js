import { LOOP, RAMPS, ROAD, SHOULDER_LANE, wrap, forwardDist, pointAt, lateralOf, setShape } from './road.js';
import { params } from '../params.js';
import {
  Car,
  EMERGENCY_KINDS,
  VEHICLE_LEN,
  isEmergencyVehicle,
} from './car.js';

// Spatial resolution of the space-time diagram's speed sampling (m of s).
export const BIN_M = 10;

// How far ahead of a work zone's cones the closed lane starts merging out.
const WZ_WARN = 250;

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
  const aMax = p.maxAccel * car.accelK;
  let acc = aMax * (1 - Math.pow(v / Math.max(v0, 0.1), 4));
  if (Number.isFinite(gap)) {
    const dv = v - vLead;
    const wetBrake = p.comfortBrake * (1 - RAIN_GRIP * rainNow);
    const sStar =
      p.minGap +
      Math.max(
        0,
        v * p.timeHeadway * car.headwayK * (1 + RAIN_HEADWAY * rainNow) +
          (v * dv) / (2 * Math.sqrt(aMax * wetBrake * car.brakeK))
      );
    acc -= aMax * (sStar / gap) ** 2;
  }
  return Math.max(acc, hardBrake);
}

// Adaptive cruise control: IDM tempered by the Constant-Acceleration
// Heuristic (Treiber & Kesting, "Traffic Flow Dynamics", ch. 11). Plain IDM
// panics when the gap falls below its desired s* — it brakes far harder than
// physics requires, and that overreaction is exactly what amplifies a small
// slowdown into a stop-and-go wave. The CAH computes the deceleration a
// constant-acceleration prediction of the leader actually demands, and when
// IDM wants to brake much harder than that, the blend below overrides the
// panic. ACC cars therefore absorb perturbations instead of magnifying them.
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
    this.rampState = new Map(); // ramp id → { cars: [], credit: 0 }
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
    // per-ramp event timestamps (merges / exits) for measured-flow readouts
    for (const ramp of RAMPS) this.rampState.set(ramp.id, { cars: [], credit: 0, flowTimes: [] });

    const lanes = params.lanes;
    const perLane = Math.floor(params.initialCars / lanes);
    const extra = params.initialCars - perLane * lanes;
    // slot: own length + min gap — the exact feasibility requirement; any
    // extra breathing room comes out of the randomized slack below, so a
    // layout that fits at minGap spacing is never rejected
    const need = (k) => VEHICLE_LEN[k] + params.minGap;
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
      // Choose kinds first, then pack: every vehicle gets its required slot
      // and the leftover road is dealt out as randomized extra gaps, so seeds
      // can never overlap at any density or mix. If the lane can't fit the
      // mix, trucks downgrade to cars; if it can't even fit the cars, the
      // lane seeds fewer vehicles than requested.
      const kinds = [];
      for (let j = 0; j < count; j++) {
        kinds.push(
          truckOk && Math.random() * 100 < boostedShare ? 'truck' : this.sampleCarKind()
        );
      }
      let totalReq = kinds.reduce((sum, k) => sum + need(k), 0);
      for (let j = 0; totalReq > LOOP && j < kinds.length; j++) {
        if (kinds[j] === 'truck') {
          totalReq -= need('truck') - need('car');
          kinds[j] = 'car';
        }
      }
      while (totalReq > LOOP && kinds.length) totalReq -= need(kinds.pop());
      const slack = LOOP - totalReq;
      const weights = kinds.map(() => 0.2 + Math.random());
      const wSum = weights.reduce((a, b) => a + b, 0);
      let s = Math.random() * LOOP;
      for (let j = 0; j < kinds.length; j++) {
        const kind = kinds[j];
        const car = new Car({ s: wrap(s), lane: l, v0Factor: this.sampleV0Factor(kind), kind });
        car.v = this.v0(car) * 0.85;
        this.cars.push(car);
        // centers: advance by half of this vehicle plus half of the next one
        // plus the gap, plus this slot's share of the slack (pair halves sum
        // to the same totalReq as need() around the loop)
        const nextKind = kinds[(j + 1) % kinds.length];
        s +=
          (VEHICLE_LEN[kind] + VEHICLE_LEN[nextKind]) / 2 +
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
      if (car.lane === wz.lane) {
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
    return v0;
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
    for (const car of this.cars) {
      // trucks stay out of the innermost lane on 3+ lane roads
      const maxLane =
        car.kind === 'truck' && params.lanes >= 3 ? params.lanes - 2 : params.lanes - 1;
      if (car.lane > maxLane) car.lane = maxLane;
    }
  }

  buildLaneIndex() {
    const arrs = Array.from({ length: params.lanes }, () => []);
    for (const car of this.cars) {
      if (car.state === 'main') arrs[Math.min(car.lane, params.lanes - 1)].push(car);
    }
    for (const arr of arrs) arr.sort((a, b) => a.s - b.s);
    return arrs;
  }

  step(h) {
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
      if (!Number.isFinite(c.emergencyDist)) c.emergencyDist = 1.6 * LOOP;
      if (!c.incident && (c.emergencyDist -= c.v * h) <= 0) this.cars.splice(i, 1);
      else if (c.state === 'main' && !c.incident) this._emergencyVehicles.push(c);
    }
    this._ambs = this._emergencyVehicles; // compatibility with the old cache name

    let arrs = this.buildLaneIndex();
    if (this.applyLaneChanges(arrs)) arrs = this.buildLaneIndex();
    this.accelMainline(arrs);
    this.accelRamps(arrs[0]);
    this.accelWorkZone();
    this.accelIncidents();

    for (const car of this.cars) {
      car.lcCooldown -= h;
      car.v = Math.max(0, car.v + car.a * h);
      if (car.state === 'onramp' || car.state === 'offramp') {
        car.rampPos += car.v * h;
      } else {
        // 'main' and 'shoulder' both live in road coordinates
        car.sPrev = car.s;
        car.s = wrap(car.s + car.v * h);
        const target = car.state === 'shoulder' ? SHOULDER_LANE : car.lane;
        const dl = target - car.renderLane;
        const maxStep = 2.0 * h; // lanes per second, rendering only
        car.renderLane += Math.abs(dl) <= maxStep ? dl : Math.sign(dl) * maxStep;
      }
    }

    arrs = this.buildLaneIndex();
    this.preventOverlaps(arrs);
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

  accelMainline(arrs) {
    for (const arr of arrs) {
      for (let i = 0; i < arr.length; i++) {
        const car = arr[i];
        const leader = arr.length > 1 ? arr[(i + 1) % arr.length] : null;
        const gap = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const aIDM = idm(car, leader ? leader.v : car.v, gap, this.effectiveV0(car));
        // ACC only tempers real following situations; ramp queues and
        // blocked-gap cases (gap <= 0) keep the plain IDM/hard-brake result.
        car.a =
          car.kind === 'acc' && leader && Number.isFinite(gap) && gap > 0
            ? accACC(car, leader, gap, aIDM)
            : aIDM;
      }
    }
  }

  accelRamps(lane0) {
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
        if (ramp.type === 'on') {
          // The ramp end is a wall, but only brake for it once physically
          // necessary — braking the IDM way the whole length of the ramp
          // would make every car crawl into the merge zone.
          const rem = ramp.length - 3 - car.len / 2 - car.rampPos;
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
    for (let l = 0; l < arrs.length; l++) {
      const arr = arrs[l];
      for (let i = 0; i < arr.length; i++) {
        const car = arr[i];
        if (car.lcCooldown > 0) continue;
        // Wrecked cars sit still; breakdown cars only change lanes while
        // working their way over to the shoulder.
        const pullover = car.incident?.phase === 'pullover';
        if (car.incident && !pullover) continue;

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
          if (
            emergency &&
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
            const nfCurGap = nl ? forwardDist(nf.s, nl.s) - halfLens(nf, nl) : Infinity;
            nfOld = idm(nf, nl ? nl.v : nf.v, nfCurGap, this.v0(nf));
          }

          let score =
            myNew - curAcc - (emergency ? 0 : p.politeness) * Math.max(0, nfOld - nfNew);
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
          car.lane = bestLane;
          if (emergency) car.lcCooldown = EMERGENCY_LANE_HOLD;
          else if (yielding) car.lcCooldown = 3.5;
          else car.lcCooldown = mandatory ? 1.2 : 3.5;
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
    for (const arr of arrs) {
      if (arr.length < 2) continue;
      for (let i = 0; i < arr.length; i++) {
        const car = arr[i];
        const leader = arr[(i + 1) % arr.length];
        const gap = forwardDist(car.s, leader.s) - halfLens(car, leader);
        if (gap < 0.2) {
          car.s = wrap(leader.s - halfLens(car, leader) - 0.25);
          car.v = Math.min(car.v, leader.v);
        }
      }
    }
  }

  // Point-crossing events: the flow counter at s = 0, exit decisions at each
  // off-ramp's decision marker, and the diverge itself.
  handleMarkers() {
    for (const car of this.cars) {
      if (car.state !== 'main') continue;
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
          if (car.lane === 0) {
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
        const remaining = ramp.length - car.rampPos;
        if (remaining > ramp.mergeZone) break;

        const sIns = wrap(ramp.sJoin - remaining);
        const { leader, follower } = neighborsAt(lane0, sIns);
        const gapAhead = leader ? forwardDist(sIns, leader.s) - halfLens(car, leader) : Infinity;
        const gapBehind = follower ? forwardDist(follower.s, sIns) - halfLens(follower, car) : Infinity;
        // Braking-distance-based acceptance: each party needs a half-second
        // of headway plus room to shed any speed difference at a hard-but-
        // survivable rate. Slow jammed traffic needs only small gaps (zipper
        // merge); fast traffic demands long ones. A car running out of ramp
        // gets desperate and noses in, forcing the follower to yield — which
        // is where merge-induced jam waves come from.
        const desperation = 1 + 2 * Math.max(0, 1 - remaining / 20);
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
        if (gapAhead < needAhead || gapBehind < needBehind) continue;

        st.cars.splice(i, 1);
        car.state = 'main';
        car.lane = 0;
        // Start rendering from the car's actual lateral spot on the ramp so
        // it slides into the lane instead of teleporting.
        const pt = ramp.curve.getPointAt(Math.min(car.rampPos / ramp.length, 1));
        car.renderLane = -lateralOf(sIns, pt) / ROAD.laneWidth;
        car.s = sIns;
        car.sPrev = wrap(sIns - 0.01);
        car.ramp = null;
        car.lcCooldown = 3;
        insertSorted(lane0, car);
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
      if (car.state !== 'main' || car.lane !== wz.lane || car.incident) continue;
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
          car.a = -Math.max(params.comfortBrake * 1.5, 2);
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
        if (car.lane === 0 && Math.abs(car.renderLane) < 0.25) {
          car.state = 'shoulder';
          this.setPhase(inc, 'stopping');
        } else if (phaseTime > 20 && car.lane > 0 && car.lcCooldown <= 0) {
          // out of patience: force the way over, following traffic must yield
          car.lane -= 1;
          car.lcCooldown = 1.5;
        }
      } else if (inc.phase === 'stopping') {
        if (car.v < 0.05) {
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
        // after 25 s of waiting, force the merge — nobody idles on a shoulder forever
        if ((gapAhead > needAhead && gapBehind > needBehind) || phaseTime > 25) {
          car.state = 'main';
          car.lane = 0;
          car.incident = null;
          car.lcCooldown = 3;
          insertSorted(arrs[0], car);
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
        if (c.state !== 'main' || c.incident || c.lane !== otherLane) continue;
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
      (c) => c.state === 'main' && !c.incident && !isEmergencyVehicle(c.kind)
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

    const lane = params.lanes - 1;
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
    emergency.emergencyDist = 1.6 * LOOP; // siren-run budget in meters driven
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
      if (emergency === car || (lane !== null && emergency.lane !== lane)) continue;
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
      st.credit = Math.min(st.credit + (params[ramp.rateKey] / 60) * h, 2);
      if (st.credit < 1) continue;
      // st.cars is sorted by rampPos; index 0 is nearest the ramp entrance.
      // The new vehicle spawns centered at 0, so clearance needs both halves.
      const kind = this.sampleKind();
      if (
        st.cars.length &&
        st.cars[0].rampPos < (st.cars[0].len + VEHICLE_LEN[kind]) / 2 + 4
      )
        continue;
      st.credit -= 1;
      const car = new Car({ v: 12, v0Factor: this.sampleV0Factor(kind), kind });
      car.state = 'onramp';
      car.ramp = ramp;
      car.rampPos = 0;
      st.cars.push(car);
      this.cars.push(car);
      this.counters.entered++;
    }
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
    return {
      count: this.cars.length,
      mainCount: n, // mainline only — the loop's density excludes ramp queues
      avgSpeed: n ? sum / n : 0, // m/s; display layer converts
      flowPerMin: window > 5 ? this.flowTimes.length * (60 / window) : 0,
      ...this.counters,
    };
  }
}
