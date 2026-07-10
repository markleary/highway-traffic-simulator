import { LOOP, RAMPS, ROAD, SHOULDER_LANE, wrap, forwardDist, pointAt, lateralOf, setShape } from './road.js';
import { params } from '../params.js';
import { Car, VEHICLE_LEN } from './car.js';

// Spatial resolution of the space-time diagram's speed sampling (m of s).
export const BIN_M = 10;

// How far ahead of a work zone's cones the closed lane starts merging out.
const WZ_WARN = 250;

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
  const hardBrake = -9 * car.brakeK;
  if (gap <= 0) return hardBrake;
  const v = car.v;
  const aMax = p.maxAccel * car.accelK;
  let acc = aMax * (1 - Math.pow(v / Math.max(v0, 0.1), 4));
  if (Number.isFinite(gap)) {
    const dv = v - vLead;
    const sStar =
      p.minGap +
      Math.max(
        0,
        v * p.timeHeadway * car.headwayK +
          (v * dv) / (2 * Math.sqrt(aMax * p.comfortBrake * car.brakeK))
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
  const b = p.comfortBrake;
  return Math.max(
    (1 - ACC_COOL) * aIDM + ACC_COOL * (aCAH + b * Math.tanh((aIDM - aCAH) / b)),
    -9
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
    this.time = 0;
    this.history = []; // 1 Hz samples of {t, v, f, n, m, inc, bins} for the live charts
    this.binCount = Math.ceil(LOOP / BIN_M); // space-time diagram resolution
    this.incidentStarts = []; // sim timestamps, one per triggered incident (chart markers)
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
    return params.desiredSpeed * car.v0Factor;
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
    if (car.kind !== 'ambulance' && this._ambs?.length) {
      const near = this.ambBehind(car);
      // Only the siren's OWN lane slows, bleeding speed as it closes (down
      // to a floor the ambulance can still weave around): merging out into
      // same-speed neighbors is feasible where merging out of a fast lane is
      // not — the same trick exit-bound cars use to make lane 0. The other
      // lanes are deliberately left alone: capping them slows a 220 m zone
      // that TRAVELS WITH the ambulance, compressing the receiving lanes
      // into a clot that walls in both the corridor cars and the ambulance.
      if (near && car.lane === near.amb.lane) {
        v0 = Math.min(v0, this.v0(car) * (0.65 + 0.35 * (near.dist / 220)));
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
    } else if (this.incidents.length && car.kind !== 'ambulance') {
      // ambulances skip the rubbernecking cap: they are the ones on duty
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

    // ambulances: retire any that finished their siren run, and cache the
    // active list for the move-over corridor checks (ambBehind runs per car
    // per step — scanning all cars for the handful of ambulances would not do)
    this._ambs = [];
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.kind !== 'ambulance') continue;
      if (!c.incident && (c.ambDist -= c.v * h) <= 0) this.cars.splice(i, 1);
      else if (c.state === 'main' && !c.incident) this._ambs.push(c);
    }

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
    while (this.incidentStarts.length && this.incidentStarts[0] < this.time - 310) {
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
        car.signal = 0; // the strobes do the talking (renderer)
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
    const rampV0 = p.rampSpeed;
    for (const ramp of RAMPS) {
      const st = this.rampState.get(ramp.id);
      st.cars.sort((a, b) => a.rampPos - b.rampPos);
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
        }
        car.a = acc;
      }
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

        // Emergency driving: the ambulance hunts the fastest lane with no
        // politeness, no keep-right bias, and a hair-trigger threshold.
        // Everyone else checks for a siren bearing down (see ambBehind):
        // being in its lane makes leaving near-mandatory, and nobody moves
        // INTO its lane inside the corridor.
        const amb = car.kind === 'ambulance';
        const siren = amb ? null : this.ambBehind(car);

        const v0 = this.effectiveV0(car);
        const leader = arr.length > 1 ? arr[(i + 1) % arr.length] : null;
        const curGap = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const curAcc = idm(car, leader ? leader.v : car.v, curGap, v0);

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
        let brakeLimit = p.safeBrake;
        if (pullover) {
          brakeLimit *= 1 + Math.min((this.time - car.incident.phaseStart) / 10, 1.5);
        } else if (amb || (siren && l === siren.amb.lane)) {
          // clearing a siren's path — or being the siren weaving around a
          // baulked car — warrants a firm merge; traffic yields to it
          brakeLimit *= 1.5;
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
        // trucks rarely bother changing lanes; the ambulance barely hesitates
        let bestScore = p.laneChangeThreshold * (car.kind === 'truck' ? 2.5 : amb ? 0.5 : 1);
        let wantLane = -1;
        // Blinker-worthy desire needs a clearly better lane, not a marginal
        // preference — without this margin nearly half of dense traffic blinks.
        let wantScore = bestScore + 0.3;
        for (const t of targets) {
          // never merge into the corridor lane while the siren is in it
          if (siren && t === siren.amb.lane && l !== siren.amb.lane) continue;
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
          // Desire, gauged before the gap/safety gates below: the gain the
          // driver sees in the target lane, whether or not the move is safe.
          // A passing desire lights the blinker (see updateLights) — a car
          // that wants a gap it can't take blinks without moving.
          let want = myNew - curAcc + (amb ? 0 : t < l ? 0.08 : -0.08);
          if (pullover) want += 2.5;
          else if (wzUrgent) want += 1 + 3 * (1 - wzDist / WZ_WARN);
          else if (mandatory) want += 1 + 3 * (1 - exitDist / 400);
          else if (siren && l === siren.amb.lane) want += 2.2 + 1.8 * (1 - siren.dist / 220);
          if (want > wantScore) {
            wantScore = want;
            wantLane = t;
          }

          // clearing a siren's path (or being it) warrants half a normal gap
          const gapFloor = amb || (siren && l === siren.amb.lane) ? p.minGap * 0.5 : p.minGap;
          if (gapAhead < gapFloor || gapBehind < gapFloor) continue;
          let nfNew = 0;
          let nfOld = 0;
          if (nf) {
            nfNew = idm(nf, car.v, gapBehind, this.v0(nf));
            if (nfNew < -brakeLimit) continue;
            const nfCurGap = nl ? forwardDist(nf.s, nl.s) - halfLens(nf, nl) : Infinity;
            nfOld = idm(nf, nl ? nl.v : nf.v, nfCurGap, this.v0(nf));
          }

          let score = myNew - curAcc - (amb ? 0 : p.politeness) * Math.max(0, nfOld - nfNew);
          // The ambulance holds the innermost lane — the corridor only knits
          // if the siren's lane is predictable — and drops out of it only to
          // pass something truly stuck, returning as soon as it clears.
          // Everyone else keeps the mild keep-right bias.
          if (amb) score += t > l ? 0.3 : -0.3;
          else score += t < l ? 0.08 : -0.08;
          if (pullover) score += 2.5;
          else if (wzUrgent) score += 1 + 3 * (1 - wzDist / WZ_WARN);
          else if (mandatory) score += 1 + 3 * (1 - exitDist / 400);
          // strong from the moment the siren is audible — real drivers clear
          // early, not when the bumper arrives (a distance-proportional bonus
          // left cars sitting until the last 80 m)
          else if (siren && l === siren.amb.lane) score += 2.2 + 1.8 * (1 - siren.dist / 220);
          if (score > bestScore) {
            bestScore = score;
            bestLane = t;
          }
        }

        if (bestLane >= 0) {
          car.lane = bestLane;
          car.lcCooldown = mandatory || amb || (siren && l === siren.amb.lane) ? 1.2 : 3.5;
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
          car.kind !== 'ambulance' && // laps until its run ends, never exits
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
        const shed = 2 * p.safeBrake * 1.5 * desperation;
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
        const shed = 2 * p.safeBrake * 1.5 * desperation;
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
    this.incidentStarts.push(this.time);
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
    this.incidentStarts.push(this.time);
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
      (c) => c.state === 'main' && !c.incident && c.kind !== 'ambulance'
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

  // Send an ambulance around the loop: it spawns into the widest gap in the
  // innermost lane, runs well above the global desired speed, and despawns
  // after ~1.6 laps. Traffic ahead reacts through ambBehind (slowing and
  // vacating its lane) — the move-over corridor is emergent, not scripted.
  spawnAmbulance() {
    const lane = params.lanes - 1;
    const arr = this.buildLaneIndex()[lane];
    let s = 0;
    let v = params.desiredSpeed;
    if (arr.length) {
      let lead = arr[0];
      let bestGap = -1;
      for (let i = 0; i < arr.length; i++) {
        const gap = forwardDist(arr[i].s, arr[(i + 1) % arr.length].s);
        if (gap > bestGap) {
          bestGap = gap;
          lead = arr[i];
        }
      }
      s = wrap(lead.s + bestGap / 2);
      v = Math.max(lead.v, 8); // never materialize at rest mid-traffic
    }
    const amb = new Car({ s, lane, v, v0Factor: 1.55, kind: 'ambulance' });
    amb.ambDist = 1.6 * LOOP; // siren-run budget in meters driven
    this.cars.push(amb);
    return amb;
  }

  // Nearest active ambulance approaching this car from behind, within the
  // move-over corridor range. Null when no siren bears down on the car.
  ambBehind(car, range = 220) {
    let best = null;
    let bestD = range;
    for (const amb of this._ambs || []) {
      if (amb === car) continue;
      const d = forwardDist(amb.s, car.s);
      if (d < bestD) {
        bestD = d;
        best = amb;
      }
    }
    return best && { amb: best, dist: bestD };
  }

  // Nearest car to a world-space point. Click-to-crash uses the default
  // filter (normal mainline cars only); the hover readout passes any = true
  // to also read ramp, shoulder, and incident cars.
  carNear(point, radius = 12, any = false) {
    let best = null;
    let bestD = radius * radius;
    for (const car of this.cars) {
      if (!any && (car.state !== 'main' || car.incident)) continue;
      const pos = car.ramp
        ? car.ramp.curve.getPointAt(Math.min(Math.max(car.rampPos / car.ramp.length, 0), 1))
        : pointAt(car.s, -car.renderLane * ROAD.laneWidth);
      const dx = pos.x - point.x;
      const dz = pos.z - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
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
