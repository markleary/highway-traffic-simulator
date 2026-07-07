import { LOOP, RAMPS, ROAD, R_REF, SHOULDER_LANE, wrap, forwardDist, pointAt } from './road.js';
import { params } from '../params.js';
import { Car, VEHICLE_LEN } from './car.js';

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
    this.cars = [];
    this.incidents = []; // active breakdowns / accidents
    this.time = 0;
    this.history = []; // 1 Hz samples of {t, v, f, inc} for the live charts
    this.sampleTimer = 0;
    this.flowTimes = []; // sim timestamps of cars crossing s = 0
    this.counters = { entered: 0, merged: 0, exited: 0, laneChanges: 0 };
    // per-ramp event timestamps (merges / exits) for measured-flow readouts
    for (const ramp of RAMPS) this.rampState.set(ramp.id, { cars: [], credit: 0, flowTimes: [] });

    const lanes = params.lanes;
    const perLane = Math.floor(params.initialCars / lanes);
    const extra = params.initialCars - perLane * lanes;
    const need = (k) => VEHICLE_LEN[k] + params.minGap + 1; // slot: own length + safe gap
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
        kinds.push(truckOk && Math.random() * 100 < boostedShare ? 'truck' : 'car');
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
          1 +
          (slack * weights[j]) / wSum;
      }
    }
  }

  sampleKind() {
    return Math.random() * 100 < params.truckShare ? 'truck' : 'car';
  }

  sampleV0Factor(kind = 'car') {
    // trucks: slower (speed-limited / loaded) with less driver-to-driver spread
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
    if (car.incident) {
      // Pulling over for a breakdown: ease off while working over, but only
      // slow right down once in lane 0 — crawling in an inner lane makes the
      // gaps needed to get out of it unattainable.
      if (car.incident.phase === 'pullover') {
        v0 = Math.min(v0, car.lane === 0 ? Math.max(8, params.rampSpeed * 0.6) : v0 * 0.75);
      }
    } else if (this.incidents.length) {
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

    let arrs = this.buildLaneIndex();
    if (this.applyLaneChanges(arrs)) arrs = this.buildLaneIndex();
    this.accelMainline(arrs);
    this.accelRamps(arrs[0]);
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
    while (this.flowTimes.length && this.flowTimes[0] < this.time - 60) this.flowTimes.shift();
    for (const st of this.rampState.values()) {
      while (st.flowTimes.length && st.flowTimes[0] < this.time - 60) st.flowTimes.shift();
    }

    // chart history: one sample per sim-second, last 5 minutes
    this.sampleTimer += h;
    if (this.sampleTimer >= 1) {
      this.sampleTimer -= 1;
      const s = this.stats();
      this.history.push({ t: this.time, v: s.avgSpeed, f: s.flowPerMin, inc: this.incidents.length > 0 });
      if (this.history.length > 300) this.history.shift();
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
        car.a = idm(car, leader ? leader.v : car.v, gap, this.effectiveV0(car));
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

        const v0 = this.effectiveV0(car);
        const leader = arr.length > 1 ? arr[(i + 1) % arr.length] : null;
        const curGap = leader ? forwardDist(car.s, leader.s) - halfLens(car, leader) : Infinity;
        const curAcc = idm(car, leader ? leader.v : car.v, curGap, v0);

        const exitDist = car.exitRamp ? forwardDist(car.s, car.exitRamp.sDiverge) : Infinity;
        const mandatory = exitDist < 400 || pullover;
        // A stranded car gets bolder about cutting in the longer it has waited.
        let brakeLimit = p.safeBrake;
        if (pullover) {
          brakeLimit *= 1 + Math.min((this.time - car.incident.phaseStart) / 10, 1.5);
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
        // trucks rarely bother changing lanes
        let bestScore = p.laneChangeThreshold * (car.kind === 'truck' ? 2.5 : 1);
        for (const t of targets) {
          const { leader: nl, follower: nf } = neighborsAt(arrs[t], car.s);
          const gapAhead = nl ? forwardDist(car.s, nl.s) - halfLens(car, nl) : Infinity;
          const gapBehind = nf ? forwardDist(nf.s, car.s) - halfLens(nf, car) : Infinity;
          if (gapAhead < p.minGap || gapBehind < p.minGap) continue;

          const myNew = idm(car, nl ? nl.v : car.v, gapAhead, v0);
          let nfNew = 0;
          let nfOld = 0;
          if (nf) {
            nfNew = idm(nf, car.v, gapBehind, this.v0(nf));
            if (nfNew < -brakeLimit) continue;
            const nfCurGap = nl ? forwardDist(nf.s, nl.s) - halfLens(nf, nl) : Infinity;
            nfOld = idm(nf, nl ? nl.v : nf.v, nfCurGap, this.v0(nf));
          }

          let score = myNew - curAcc - p.politeness * Math.max(0, nfOld - nfNew);
          score += t < l ? 0.08 : -0.08; // mild keep-right bias
          if (pullover) score += 2.5;
          else if (mandatory) score += 1 + 3 * (1 - exitDist / 400);
          if (score > bestScore) {
            bestScore = score;
            bestLane = t;
          }
        }

        if (bestLane >= 0) {
          car.lane = bestLane;
          car.lcCooldown = mandatory ? 1.2 : 3.5;
          this.counters.laneChanges++;
          changed = true;
        } else {
          car.lcCooldown = 0.2 + Math.random() * 0.2;
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
        if (!car.exitRamp && !car.incident && forwardDist(car.sPrev, ramp.decideS) < traveled) {
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
        car.renderLane = -(Math.hypot(pt.x, pt.z) - R_REF) / ROAD.laneWidth;
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
    const eligible = this.cars.filter((c) => c.state === 'main' && !c.incident);
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

  // Nearest normal mainline car to a world-space point (used by click-to-crash).
  carNear(point, radius = 12) {
    let best = null;
    let bestD = radius * radius;
    for (const car of this.cars) {
      if (car.state !== 'main' || car.incident) continue;
      const pos = pointAt(car.s, -car.renderLane * ROAD.laneWidth);
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
      avgSpeed: n ? sum / n : 0, // m/s; display layer converts
      flowPerMin: window > 5 ? this.flowTimes.length * (60 / window) : 0,
      ...this.counters,
    };
  }
}
