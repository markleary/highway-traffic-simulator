import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Presentation contract matches cybertruck.js: metres, origin at the footprint
// centre on the road, +z forward, +x driver's left, +y up; one instanced part
// per named buffer. This generic electric fastback fits the ordinary 4.6 m car
// footprint. These parts can later be supplied by an authored low-poly model.
const FRONT_Z = 2.278;
const REAR_Z = -2.278;
const AXLES = Object.freeze([1.43, -1.36]);
const WHEEL_Y = 0.342;
export const EV_WHEELS = Object.freeze({ axles: AXLES, y: WHEEL_Y, radius: WHEEL_Y });
const SIDE_SLOPE = 0.47;
// z, half body width, belt height, roof/hood height. Broad planar facets keep
// the shell legible at traffic scale without rounding away its low-poly feel.
const PROFILE = [
  [FRONT_Z, 0.785, 0.70, 0.70],
  [2.03, 0.902, 0.81, 0.85],
  [1.10, 0.93, 0.872, 0.965],
  [0.40, 0.93, 0.906, 1.425],
  [-0.35, 0.93, 0.930, 1.445],
  [-0.90, 0.93, 0.948, 1.330],
  [-1.50, 0.93, 0.969, 1.030],
  [-2.03, 0.895, 0.906, 0.950],
  [REAR_Z, 0.805, 0.810, 0.810],
];

export const EV_LIGHTS = Object.freeze({
  rear: -2.284, front: 2.284, halfW: 0.60, y: 0.665,
  brakeZ: -2.287, brakeY: 0.764, brakeW: 1.50, brakeH: 0.045,
  blinkZR: -2.294, blinkYR: 0.764, blinkHalfWR: 0.60,
  blinkWR: 0.28, blinkHR: 0.045, blinkDepthR: 0.012,
  blinkZF: 2.294, blinkYF: 0.667, blinkHalfWF: 0.60,
  blinkWF: 0.28, blinkHF: 0.045, blinkDepthF: 0.012,
});

function merged(parts) {
  const normalized = parts.map((part) => {
    const geometry = part.index ? part.toNonIndexed() : part;
    geometry.deleteAttribute('uv');
    geometry.computeVertexNormals();
    return geometry;
  });
  const geometry = mergeGeometries(normalized);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  for (const part of normalized) part.dispose();
  for (const part of parts) if (!normalized.includes(part)) part.dispose();
  return geometry;
}

function panel(points, outward) {
  const vertices = [];
  const normal = new THREE.Vector3(...outward);
  for (let i = 1; i < points.length - 1; i++) {
    const a = new THREE.Vector3().fromArray(points[i]).sub(new THREE.Vector3().fromArray(points[0]));
    const b = new THREE.Vector3().fromArray(points[i + 1]).sub(new THREE.Vector3().fromArray(points[0]));
    const cross = a.cross(b);
    if (cross.lengthSq() < 1e-16) continue;
    const face = cross.dot(normal) < 0
      ? [points[0], points[i + 1], points[i]]
      : [points[0], points[i], points[i + 1]];
    vertices.push(...face.flat());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function profileAt(z) {
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const a = PROFILE[i];
    const b = PROFILE[i + 1];
    if (z >= b[0]) {
      const t = (z - a[0]) / (b[0] - a[0]);
      return { w: a[1] + (b[1] - a[1]) * t, belt: a[2] + (b[2] - a[2]) * t, top: a[3] + (b[3] - a[3]) * t };
    }
  }
  const [, w, belt, top] = PROFILE[PROFILE.length - 1];
  return { w, belt, top };
}

function sidePoint(side, y, z, lift = 0) {
  const p = profileAt(z);
  return [side * (p.w - SIDE_SLOPE * (y - p.belt) + lift), y, z];
}

function roofPoint(side, z, inset = 0, lift = 0) {
  const p = profileAt(z);
  return [side * (p.w - SIDE_SLOPE * (p.top - p.belt) - inset), p.top + lift, z];
}

// The side wall goes around each wheel: no solid slab behind the tire. The
// polygonal opening follows the compact EV's small-overhang, long-wheelbase form.
const ARCH = [
  [-0.414, 0.275], [-0.391, 0.495], [-0.285, 0.675],
  [-0.145, 0.751], [0.145, 0.751], [0.285, 0.675],
  [0.391, 0.495], [0.414, 0.275],
];

function lowerSide(side) {
  const contour = [
    ...PROFILE.map(([z, , belt]) => [z, belt]),
    [REAR_Z, 0.365], [-2.08, 0.275],
    ...[...AXLES].reverse().flatMap((axle) => ARCH.map(([z, y]) => [axle + z, y])),
    [2.08, 0.275], [FRONT_Z, 0.365],
  ];
  const indices = THREE.ShapeUtils.triangulateShape(contour.map(([z, y]) => new THREE.Vector2(z, y)), []);
  const points = contour.map(([z, y]) => [side * profileAt(z).w, y, z]);
  return merged(indices.map((face) => panel(face.map((index) => points[index]), [side, 0, 0])));
}

function bodyGeometry() {
  const parts = [];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const za = PROFILE[i][0];
    const zb = PROFILE[i + 1][0];
    parts.push(panel([roofPoint(-1, za), roofPoint(1, za), roofPoint(1, zb), roofPoint(-1, zb)], [0, 1, 0]));
    for (const side of [-1, 1]) {
      parts.push(panel([
        sidePoint(side, profileAt(za).belt, za), sidePoint(side, profileAt(zb).belt, zb),
        roofPoint(side, zb), roofPoint(side, za),
      ], [side, 0, 0]));
    }
  }
  for (const side of [-1, 1]) parts.push(lowerSide(side));
  for (const z of [FRONT_Z, REAR_Z]) {
    const p = profileAt(z);
    parts.push(panel([
      [-p.w, 0.365, z], [p.w, 0.365, z],
      roofPoint(1, z), roofPoint(-1, z),
    ], [0, 0, Math.sign(z)]));
  }
  // A narrow undertray leaves the wheel wells open, and the body itself stays
  // inside ±2.3 m even at the bumper lips and licence-plate recess.
  parts.push(box(1.39, 0.095, 4.29, 0, 0.245, 0));
  return merged(parts);
}

function glassGeometry() {
  const parts = [];
  // Windshield / panoramic roof / hatch glass follow the shell's exact facets.
  // Tiny breaks distinguish the windshield header and rear hatch seal.
  for (const [za, zb] of [[1.025, 0.425], [0.37, -0.35], [-0.35, -0.90], [-0.90, -1.405]]) {
    parts.push(panel([
      roofPoint(-1, za, 0.055, 0.008), roofPoint(1, za, 0.055, 0.008),
      roofPoint(1, zb, 0.055, 0.008), roofPoint(-1, zb, 0.055, 0.008),
    ], [0, 1, 0]));
  }
  // Split at profile vertices so the windows lie on the flat body facets.
  // The short body-colour gap at z≈0 is the B pillar between the two doors.
  for (const side of [-1, 1]) {
    for (const [za, zb] of [[0.998, 0.40], [0.40, 0.035], [-0.035, -0.35], [-0.35, -0.90], [-0.90, -1.32]]) {
      const a = profileAt(za);
      const b = profileAt(zb);
      parts.push(panel([
        sidePoint(side, a.belt + 0.052, za, 0.007), sidePoint(side, b.belt + 0.052, zb, 0.007),
        sidePoint(side, b.top - 0.051, zb, 0.007), sidePoint(side, a.top - 0.051, za, 0.007),
      ], [side, 0, 0]));
    }
  }
  return merged(parts);
}

function trimGeometry() {
  const parts = [
    // Clean closed upper nose; only a slim lower cooling slot and dark sill.
    box(1.43, 0.058, 0.018, 0, 0.449, 2.289),
    box(1.48, 0.085, 0.036, 0, 0.368, 2.282),
    box(1.46, 0.078, 0.022, 0, 0.379, -2.289),
    box(0.44, 0.134, 0.012, 0, 0.576, -2.285),
    // Lamp pockets remain inset within the physical length.
    box(1.51, 0.061, 0.014, 0, 0.764, -2.285),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(0.055, 0.10, 1.95, side * 0.915, 0.294, 0.035));
    // Small flush handles and restrained shut lines read as doors, not armor.
    for (const z of [0.955, 0, -0.912]) {
      const belt = profileAt(z).belt;
      parts.push(box(0.008, belt - 0.35, 0.008, side * 0.934, (belt + 0.35) / 2, z));
    }
    for (const z of [0.75, -0.70]) {
      parts.push(box(0.013, 0.025, 0.153, side * 0.937, profileAt(z).belt - 0.059, z));
    }
    // Compact swept mirrors rather than prominent rectangular stalks.
    parts.push(box(0.17, 0.025, 0.048, side * 0.94, 1.012, 0.905));
    const mirror = new THREE.CylinderGeometry(0.075, 0.070, 0.073, 5)
      .rotateY(side * 0.22).scale(1.04, 1, 0.94)
      .translate(side * 1.007, 1.045, 0.865);
    parts.push(mirror);
    for (const axle of AXLES) {
      for (let i = 0; i < ARCH.length - 1; i++) {
        const a = ARCH[i];
        const b = ARCH[i + 1];
        const point = ([z, y], x) => [side * x, y, axle + z];
        // A recessed wheel-well tunnel and a fine dark edge, never a large SUV
        // flare. The sidewall and wheel remain visibly separate at close range.
        parts.push(panel([point(a, 0.933), point(a, 0.682), point(b, 0.682), point(b, 0.933)], [0, -1, 0]));
        const outside = ([z, y]) => [z * 1.035, WHEEL_Y + (y - WHEEL_Y) * 1.035];
        parts.push(panel([point(a, 0.934), point(b, 0.934), point(outside(b), 0.934), point(outside(a), 0.934)], [side, 0, 0]));
      }
      parts.push(panel(ARCH.map(([z, y]) => [side * 0.680, y, axle + z]), [side, 0, 0]));
    }
  }
  return merged(parts);
}

function wheelGeometry() {
  const parts = [];
  const rings = [[-0.101, 0.301], [-0.074, WHEEL_Y], [0.074, WHEEL_Y], [0.101, 0.301]];
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      const point = (ring, angle) => [side * (0.815 + ring[0]), WHEEL_Y + ring[1] * Math.sin(angle), z + ring[1] * Math.cos(angle)];
      for (let r = 0; r < rings.length - 1; r++) {
        for (let i = 0; i < 12; i++) {
          const a = i * Math.PI / 6;
          const b = (i + 1) * Math.PI / 6;
          parts.push(panel([point(rings[r], a), point(rings[r], b), point(rings[r + 1], b), point(rings[r + 1], a)],
            [side * (r === 0 ? -1 : r === 2 ? 1 : 0), Math.sin((a + b) / 2), Math.cos((a + b) / 2)]));
        }
      }
      for (const face of [-1, 1]) {
        parts.push(panel(Array.from({ length: 12 }, (_, i) => point([face * 0.101, 0.301], i * Math.PI / 6)), [side * face, 0, 0]));
      }
    }
  }
  return merged(parts);
}

function hubGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        const b = (i + 1) * Math.PI / 6;
        const rim = (angle) => [side * 0.919, WHEEL_Y + 0.262 * Math.sin(angle), z + 0.262 * Math.cos(angle)];
        const inner = (angle) => [side * 0.925, WHEEL_Y + 0.235 * Math.sin(angle), z + 0.235 * Math.cos(angle)];
        parts.push(panel([rim(a), rim(b), inner(b), inner(a)], [side, 0, 0]));
        parts.push(panel([[side * 0.932, WHEEL_Y, z], inner(a), inner(b)], [side, 0, 0]));
      }
      // The closed shallow cover is aerodynamic, with a small recessed-looking
      // central cap rather than spokes or a conspicuous chrome disc.
      parts.push(new THREE.CylinderGeometry(0.059, 0.059, 0.009, 6)
        .rotateZ(Math.PI / 2).translate(side * 0.933, WHEEL_Y, z));
    }
  }
  return merged(parts);
}

export function buildEVGeometry() {
  return {
    body: bodyGeometry(),
    glass: glassGeometry(),
    trim: trimGeometry(),
    wheels: wheelGeometry(),
    hubs: hubGeometry(),
    // Lamps fit inside the standard-car footprint along with their animated
    // brake/indicator overlays; their dormant lenses remain physical surfaces.
    frontLens: merged([-1, 1].map((side) => box(0.36, 0.045, 0.012, side * 0.585, 0.667, 2.29))),
    rearLens: merged([box(1.50, 0.045, 0.012, 0, 0.764, -2.289)]),
  };
}
