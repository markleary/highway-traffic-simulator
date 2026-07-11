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

// Each shape builds its segment ops plus an `interchanges(len, count)`
// function returning up to `count` {off, on} anchor pairs (s along the loop),
// CLAMPED to what physically fits — each interchange needs room for its ramp
// tips (~105 m out from the anchors), and two tips on a shared straight point
// at each other, so mid-straight diamonds only fit on long straights. Anchors
// sit on straights (or the circle) so ramps attach to road that isn't bending
// through them; corner/cap interchanges split across the bend — exit before,
// entrance after — like real beltways do.
// Builders take the road-scale multiplier: radii and straights scale, while
// ramp anchors stay a fixed physical distance from their segment ends (the
// ramp footprint never scales), so bigger roads mean longer open stretches
// between interchanges — and unlock more of them.
export const SHAPES = {
  circle: {
    label: 'Circle',
    build(k) {
      const r = 168.15 * k; // k=1 preserves the original loop (LOOP ≈ 1056.5)
      return {
        ops: [L(r, 360)],
        // evenly spaced diamonds; each takes ~300 m of arc. The N=2 layout
        // reproduces the original (off at 0.04·LOOP, on at 0.24·LOOP).
        interchanges(len, count) {
          const n = Math.min(count, Math.max(2, Math.floor(len / 300)));
          return Array.from({ length: n }, (_, i) => ({
            off: (i / n) * len + 42,
            on: (i / n) * len + 254,
          }));
        },
      };
    },
  },
  speedway: {
    label: 'Speedway',
    build(k) {
      const straight = 300 * k;
      const r = 85 * k;
      const half = straight + Math.PI * r;
      return {
        ops: [S(straight), L(r, 180), S(straight), L(r, 180)],
        interchanges: (len, count) =>
          strideInterchanges(count, half, straight, [0, half]),
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
        // one interchange per corner: exit runs straight on where the road
        // bends, entrance joins just after the corner. N=2 uses opposite
        // corners (the original layout); 3-4 fill in the rest.
        interchanges(len, count) {
          const corners = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] }[Math.min(count, 4)];
          return corners.map((c) => ({
            off: c * quarter + straight - 40,
            on: ((c + 1) % 4) * quarter + 45,
          }));
        },
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
      return {
        ops: [...halfOps, ...halfOps.map((op) => ({ ...op }))],
        interchanges: (len, count) =>
          strideInterchanges(count, half, straight, [0, half]),
      };
    },
  },
  eight: {
    label: 'Figure eight',
    build(k) {
      // Two lobes joined by their internal tangent lines: wrap the right
      // lobe clockwise, cross, wrap the left lobe counterclockwise, cross
      // back. Net turn is 0 — the lobes cancel — which is why the closure
      // check accepts any whole number of turns. The second straight rises
      // over the first on a raised-cosine hump: the model still drives a
      // flat wrapped line (s stays plan-view arc length; elevation is
      // cosmetic exactly like curvature), the renderer adds the bridge.
      const r = 100 * k; // lobe radius
      const c = 175 * k; // lobe center distance from the crossing
      const beta = Math.asin(r / c); // tangent angle off the lobe axis
      const A = 180 + (2 * beta) / DEG; // degrees swept around each lobe
      const h = Math.sqrt(c * c - r * r); // crossing → tangent point
      const arc = r * A * DEG;
      const mid = 2 * arc + 3 * h; // middle of the second straight = the crossing
      const R = Math.min(120, 0.8 * h); // bridge approach length each side
      return {
        ops: [Rt(r, A), S(2 * h), L(r, A), S(2 * h)],
        elev(s) {
          const d = Math.abs(s - mid);
          return d < R ? 3.25 * (1 + Math.cos((Math.PI * d) / R)) : 0; // peak 6.5 m
        },
        // one diamond per lobe, straddling it like the corner interchanges
        // on the other shapes; anchors sit outside the bridge approaches
        interchanges: (len) => [
          { off: arc + 2 * h - 15, on: 2 * arc + 2 * h + 15 }, // around the left lobe
          { off: len - 15, on: arc + 15 }, // around the right lobe
        ],
      };
    },
  },
};

// Two-straight shapes (Speedway, Grand Prix): the base pair of interchanges
// straddles the bends — exit at the end of one straight, entrance at the
// start of the next. Extra interchanges are full diamonds mid-straight, which
// need the straight long enough (≥ 570 m, i.e. road scale ≥ 1.9) that the
// facing ramp tips — and their constant-screen-size labels, which crowd
// together as the camera pulls back on big roads — stay clear of each other
// and of the straddling ramps at the ends.
function strideInterchanges(count, half, straight, starts) {
  const pairs = [
    { off: starts[0] + straight - 15, on: half + 15 },
    { off: starts[1] + straight - 15, on: 15 },
  ];
  if (straight >= 570) {
    const c = straight / 2;
    for (let i = 0; i < Math.min(count, 4) - 2; i++) {
      pairs.push({ off: starts[i] + c - 220, on: starts[i] + c + 220 });
    }
  }
  return pairs.sort((a, b) => a.off - b.off);
}

// Current shape state. LOOP and RAMPS are live bindings: setShape() updates
// them and every importer sees the new values. RAMPS keeps its array identity
// (repopulated in place) so long-lived references stay valid.
export let LOOP = 0;
export const RAMPS = [];
let currentShape = null;
let currentScale = 0;
let currentCount = 0;
let segs = [];
let extent = { halfX: 0, halfZ: 0 };
let elevFn = null; // the shape's elevation profile (bridges); null = flat

// Cosmetic elevation at arc length s. The traffic model never sees this —
// s is plan-view arc length and the sim drives a flat wrapped line; only
// rendering (and the smoke test's grade-separation exemption) look up y.
export function elevAt(s) {
  return elevFn ? elevFn(wrap(s)) : 0;
}

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

export function setShape(id, scale = 1, interchanges = 2) {
  const shape = SHAPES[id] ?? SHAPES.circle;
  const k = Math.min(Math.max(scale, 0.5), 4); // sanity clamp, knob offers 1-3
  const n = Math.round(Math.min(Math.max(interchanges, 2), 4));
  if (currentShape === shape && currentScale === k && currentCount === n) return;
  currentShape = shape;
  currentScale = k;
  currentCount = n;

  const { ops, interchanges: placeInterchanges, elev } = shape.build(k);
  elevFn = elev ?? null;

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
  // wrap seam — fail loudly, this is a design error in the shape table. The
  // net turn must be a whole number of turns: −1 for the simple loops, 0 for
  // the figure eight (its lobes turn opposite ways and cancel).
  const turns = phi / (2 * Math.PI);
  const headingErr = Math.abs(turns - Math.round(turns));
  if (Math.hypot(x, z) > 0.01 || headingErr > 1e-7) {
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

  // Letters follow the loop: pairs come back sorted by position, so A..D
  // read in driving order. The shape may return fewer pairs than requested
  // when its geometry can't fit them (see each shape's `interchanges`).
  const pairs = placeInterchanges(LOOP, n);
  RAMPS.length = 0;
  pairs.forEach((p, i) => {
    const letter = 'ABCD'[i];
    RAMPS.push(
      makeOffRamp(`off${letter}`, `offRamp${letter}`, `Exit ${letter}`, wrap(p.off)),
      makeOnRamp(`on${letter}`, `onRamp${letter}`, `On-ramp ${letter}`, wrap(p.on))
    );
  });
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
// (positive = outward / driver's right, matching laneOffset()). y carries
// the shape's cosmetic elevation (flat 0 on every shape but the eight).
export function pointAt(s, offset = 0, target = new THREE.Vector3()) {
  const p = poseAt(s);
  let { x, z } = p;
  if (offset) {
    x += -Math.sin(p.phi) * offset;
    z += Math.cos(p.phi) * offset;
  }
  return target.set(x, elevFn ? elevFn(wrap(s)) : 0, z);
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
