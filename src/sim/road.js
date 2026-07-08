import * as THREE from 'three';

// Road geometry. The centerline of lane 0 (the outermost lane) is a closed
// path built from straight and circular-arc segments, so arc length, tangents
// and lateral offsets are all exact — no spline approximation. The traffic
// model itself never sees the shape: it treats the loop as a straight road of
// length LOOP that wraps around; curvature is purely cosmetic.
export const ROAD = {
  laneWidth: 3.7,    // m
  shoulderWidth: 3.0, // breakdown lane outside lane 0 (m)
  minLanes: 2,
  maxLanes: 4,
};

// Fractional "lane" of the shoulder's centerline (negative = outside lane 0),
// in the same units as car.renderLane. Cars park here during breakdowns.
export const SHOULDER_LANE = -(ROAD.laneWidth / 2 + ROAD.shoulderWidth / 2) / ROAD.laneWidth;

// Lane 0 is the outermost (slow / ramp) lane; higher lanes are further inside.
export function laneOffset(lane) {
  return -lane * ROAD.laneWidth;
}

// ---------------------------------------------------------------------------
// Path framework. Pose convention on the ground (x-z) plane, y up:
//   forward(φ) = (cos φ, 0, sin φ)
//   right(φ)   = forward × up = (−sin φ, 0, cos φ)
// The right side of travel is the OUTSIDE of the loop (shoulder, ramps), so
// positive lateral offsets point outward and laneOffset() is negative — the
// same convention the circle always had. Increasing φ turns right; the loop
// circulates with a net turn of −2π (left-handed), which is what "clockwise
// seen from above" has meant here since day one.

const DEG = Math.PI / 180;
const S = (len) => ({ kind: 'straight', len });
const L = (r, deg) => ({ kind: 'arc', r, dir: -1, len: r * deg * DEG }); // left turn
const Rt = (r, deg) => ({ kind: 'arc', r, dir: +1, len: r * deg * DEG }); // right turn

// Each shape builds its segment ops plus the four ramp anchor positions
// (s along the loop). Anchors sit on straights (or the circle) so ramps
// attach to road that isn't bending through them; Beltway splits each
// interchange across a corner — exit before the bend, entrance after —
// which is how real beltways do it.
// Builders take the road-scale multiplier: radii and straights scale, while
// ramp anchors stay a fixed physical distance from their segment ends (the
// ramp footprint itself — bezier tips ~105 m out — never scales), so bigger
// roads mean longer open stretches between the same interchanges.
export const SHAPES = {
  circle: {
    label: 'Circle',
    build(k) {
      const r = 168.15 * k; // k=1 preserves the original loop (LOOP ≈ 1056.5)
      return {
        ops: [L(r, 360)],
        ramps: (len) => ({ offA: 0.04 * len, onA: 0.24 * len, offB: 0.54 * len, onB: 0.74 * len }),
      };
    },
  },
  speedway: {
    label: 'Speedway',
    build(k) {
      const straight = 300 * k;
      const r = 85 * k;
      const half = straight + Math.PI * r;
      // Each interchange straddles a cap: exit at the end of one straight,
      // entrance at the start of the next. Two ramp tips on a shared straight
      // would point at each other and collide (the circle's curvature used to
      // splay them apart for free).
      return {
        ops: [S(straight), L(r, 180), S(straight), L(r, 180)],
        ramps: () => ({ offA: straight - 15, onA: half + 15, offB: half + straight - 15, onB: 15 }),
      };
    },
  },
  beltway: {
    label: 'Beltway',
    build(k) {
      const straight = 160 * k;
      const r = 70 * k;
      const quarter = straight + (Math.PI / 2) * r; // one side + one corner
      return {
        ops: [
          S(straight), L(r, 90), S(straight), L(r, 90),
          S(straight), L(r, 90), S(straight), L(r, 90),
        ],
        ramps: () => ({
          offA: straight - 40,               // late on side 1: the exit runs straight on where the road bends
          onA: quarter + 45,                 // early on side 2: entering just after the corner
          offB: straight - 40 + 2 * quarter, // same interchange mirrored to sides 3 / 4
          onB: 3 * quarter + 45,
        }),
      };
    },
  },
  gp: {
    label: 'Grand Prix',
    build(k) {
      // A stadium pinched by an S-kink on each side. Each half turns exactly
      // −180°, so repeating it twice closes the loop by symmetry. The Rt()
      // section is the one stretch of road anywhere that curves right.
      const straight = 300 * k;
      const halfOps = [S(straight), L(75 * k, 100), Rt(55 * k, 40), L(75 * k, 120)];
      const half = halfOps.reduce((a, op) => a + op.len, 0);
      // Interchanges straddle the S-sections, same reasoning as the Speedway.
      return {
        ops: [...halfOps, ...halfOps.map((op) => ({ ...op }))],
        ramps: () => ({ offA: straight - 15, onA: half + 15, offB: half + straight - 15, onB: 15 }),
      };
    },
  },
};

// Current shape state. LOOP and RAMPS are live bindings: setShape() updates
// them and every importer sees the new values. RAMPS keeps its array identity
// (repopulated in place) so long-lived references stay valid.
export let LOOP = 0;
export const RAMPS = [];
let currentShape = null;
let currentScale = 0;
let segs = [];
let extent = { halfX: 0, halfZ: 0 };

export function wrap(s) {
  return ((s % LOOP) + LOOP) % LOOP;
}

// Distance driving forward from `from` to `to` (always in [0, LOOP)).
export function forwardDist(from, to) {
  return wrap(to - from);
}

// Half-extents of the centerline's bounding box (the path is re-centered on
// the origin), for camera framing.
export function bounds() {
  return { halfX: extent.halfX, halfZ: extent.halfZ };
}

export function setShape(id, scale = 1) {
  const shape = SHAPES[id] ?? SHAPES.circle;
  const k = Math.min(Math.max(scale, 0.5), 4); // sanity clamp, knob offers 1-3
  if (currentShape === shape && currentScale === k) return;
  currentShape = shape;
  currentScale = k;

  const { ops, ramps } = shape.build(k);

  // Walk the turtle: precompute each segment's entry pose, and for arcs the
  // rotation center and entry radial vector.
  let x = 0;
  let z = 0;
  let phi = 0;
  let s0 = 0;
  segs = [];
  for (const op of ops) {
    const seg = { kind: op.kind, s0, len: op.len };
    if (op.kind === 'straight') {
      seg.x = x;
      seg.z = z;
      seg.phi = phi;
      x += Math.cos(phi) * op.len;
      z += Math.sin(phi) * op.len;
    } else {
      const { r, dir } = op;
      seg.r = r;
      seg.d = dir;
      seg.phi = phi;
      seg.cx = x + -Math.sin(phi) * r * dir; // center sits `right * r` away for a right turn
      seg.cz = z + Math.cos(phi) * r * dir;
      seg.vx = x - seg.cx; // radial vector at entry, rotated as the arc progresses
      seg.vz = z - seg.cz;
      const beta = (dir * op.len) / r;
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      x = seg.cx + seg.vx * cb - seg.vz * sb;
      z = seg.cz + seg.vx * sb + seg.vz * cb;
      phi += beta;
    }
    s0 += op.len;
    segs.push(seg);
  }
  LOOP = s0;

  // A shape that doesn't return to its start pose would tear the road at the
  // wrap seam — fail loudly, this is a design error in the shape table.
  const headingErr = Math.abs(phi + 2 * Math.PI);
  if (Math.hypot(x, z) > 0.01 || headingErr > 1e-6) {
    throw new Error(`road shape '${id}' does not close (gap ${Math.hypot(x, z).toFixed(3)} m)`);
  }

  // Re-center the path on the origin so camera framing is symmetric.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const probe = new THREE.Vector3();
  const STEPS = Math.ceil(LOOP / 2);
  for (let i = 0; i < STEPS; i++) {
    pointAt((i / STEPS) * LOOP, 0, probe);
    minX = Math.min(minX, probe.x);
    maxX = Math.max(maxX, probe.x);
    minZ = Math.min(minZ, probe.z);
    maxZ = Math.max(maxZ, probe.z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (const seg of segs) {
    if (seg.kind === 'straight') {
      seg.x -= cx;
      seg.z -= cz;
    } else {
      seg.cx -= cx;
      seg.cz -= cz;
    }
  }
  extent = { halfX: (maxX - minX) / 2, halfZ: (maxZ - minZ) / 2 };

  const anchor = ramps(LOOP);
  RAMPS.length = 0;
  RAMPS.push(
    makeOffRamp('offA', 'offRampA', 'Exit A', anchor.offA),
    makeOnRamp('onA', 'onRampA', 'On-ramp A', anchor.onA),
    makeOffRamp('offB', 'offRampB', 'Exit B', anchor.offB),
    makeOnRamp('onB', 'onRampB', 'On-ramp B', anchor.onB)
  );
}

// Pose along the centerline; shared scratch keeps the hot path allocation-free.
const _pose = { x: 0, z: 0, phi: 0 };

function poseAt(s) {
  s = wrap(s);
  let seg = segs[0];
  for (let i = segs.length - 1; i > 0; i--) {
    if (segs[i].s0 <= s) {
      seg = segs[i];
      break;
    }
  }
  const u = s - seg.s0;
  if (seg.kind === 'straight') {
    _pose.phi = seg.phi;
    _pose.x = seg.x + Math.cos(seg.phi) * u;
    _pose.z = seg.z + Math.sin(seg.phi) * u;
  } else {
    const beta = (seg.d * u) / seg.r;
    const cb = Math.cos(beta);
    const sb = Math.sin(beta);
    _pose.phi = seg.phi + beta;
    _pose.x = seg.cx + seg.vx * cb - seg.vz * sb;
    _pose.z = seg.cz + seg.vx * sb + seg.vz * cb;
  }
  return _pose;
}

// World position at arc length s, displaced sideways by `offset` meters
// (positive = outward / driver's right, matching laneOffset()).
export function pointAt(s, offset = 0, target = new THREE.Vector3()) {
  const p = poseAt(s);
  let { x, z } = p;
  if (offset) {
    x += -Math.sin(p.phi) * offset;
    z += Math.cos(p.phi) * offset;
  }
  return target.set(x, 0, z);
}

export function forwardAt(s, target = new THREE.Vector3()) {
  const p = poseAt(s);
  return target.set(Math.cos(p.phi), 0, Math.sin(p.phi));
}

// Signed lateral offset of a world point from the centerline at s
// (positive = outside lane 0), e.g. to seed renderLane when a ramp car
// merges so it slides in from wherever it actually is.
export function lateralOf(s, point) {
  const p = poseAt(s);
  return (point.x - p.x) * -Math.sin(p.phi) + (point.z - p.z) * Math.cos(p.phi);
}

function outwardAt(s, target = new THREE.Vector3()) {
  const p = poseAt(s);
  return target.set(-Math.sin(p.phi), 0, Math.cos(p.phi));
}

function makeOnRamp(id, rateKey, label, sJoin) {
  const J = pointAt(sJoin);
  const F = forwardAt(sJoin);
  const O = outwardAt(sJoin);
  const P0 = J.clone().addScaledVector(F, -88).addScaledVector(O, 55);
  const P1 = P0.clone().addScaledVector(F, 38);
  const P2 = J.clone().addScaledVector(F, -38);
  const curve = new THREE.CubicBezierCurve3(P0, P1, P2, J.clone());
  return {
    id,
    rateKey,     // params key holding this ramp's inflow (cars/min)
    label,       // shown on the map, matches the panel's slider names
    type: 'on',
    sJoin,
    curve,       // runs entry → merge point
    length: curve.getLength(),
    mergeZone: 65, // acceleration lane: cars may merge within this many meters of the ramp end
  };
}

function makeOffRamp(id, rateKey, label, sDiverge) {
  const D = pointAt(sDiverge);
  const F = forwardAt(sDiverge);
  const O = outwardAt(sDiverge);
  const P3 = D.clone().addScaledVector(F, 88).addScaledVector(O, 55);
  const P1 = D.clone().addScaledVector(F, 38);
  const P2 = P3.clone().addScaledVector(F, -38);
  const curve = new THREE.CubicBezierCurve3(D.clone(), P1, P2, P3);
  const decideDist = 220; // how far upstream cars decide to take this exit
  return {
    id,
    rateKey,     // params key holding this ramp's exit share (%)
    label,       // shown on the map, matches the panel's slider names
    type: 'off',
    sDiverge,
    decideS: wrap(sDiverge - decideDist),
    curve,       // runs diverge point → exit
    length: curve.getLength(),
  };
}

// Valid geometry from the first import; Simulation.reset() re-syncs the shape
// from params.roadShape, so this only matters before the first reset.
setShape('circle');
