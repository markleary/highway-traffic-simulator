import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural conventional tractor / dry-van trailer. Metres, road-level origin,
// +z forward, +x driver's left. The complete assembly stays in the simulation's
// 16.5 m footprint; named material buffers also make an authored replacement
// possible without changing the vehicle controller or instance update path.
const WHEEL_Y = 0.52 * Math.cos(Math.PI / 12);
const STEER_Z = 7.12;
const TANDEMS = Object.freeze([3.69, 2.57, -5.94, -7.08]);
// The .52 m vertex radius is larger than the flat-contact rolling radius.
// Spin around the existing axle centre using its nominal distance to the road.
export const SEMI_WHEELS = Object.freeze({
  axles: Object.freeze([STEER_Z, ...TANDEMS]), y: WHEEL_Y, radius: WHEEL_Y,
});
const TRAILER_FRONT = 4.32;
const TRAILER_REAR = -8.21;
const FLOOR_Y = 1.30;
const ROOF_Y = 3.95;
const SIDES = [-1, 1];

export const SEMI_LIGHTS = Object.freeze({
  rear: -8.22, front: 8.225, halfW: 0.94, y: 0.96,
  brakeZ: -8.237, brakeY: 1.01, brakeHalfW: 0.88, brakeW: 0.32, brakeH: 0.12,
  blinkZR: -8.237, blinkYR: 1.19, blinkHalfWR: 0.88,
  blinkWR: 0.32, blinkHR: 0.09, blinkDepthR: 0.014,
  blinkZF: 8.237, blinkYF: 1.00, blinkHalfWF: 0.88,
  blinkWF: 0.25, blinkHF: 0.075, blinkDepthF: 0.014,
});

function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function merged(parts) {
  const normalized = parts.map((part) => {
    const geometry = part.index ? part.toNonIndexed() : part;
    geometry.deleteAttribute('uv');
    geometry.computeVertexNormals();
    return geometry;
  });
  const result = mergeGeometries(normalized);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  for (const part of normalized) part.dispose();
  for (const part of parts) if (!normalized.includes(part)) part.dispose();
  return result;
}

function panel(points, normal) {
  const verts = [];
  const direction = new THREE.Vector3(...normal);
  const origin = new THREE.Vector3(...points[0]);
  for (let i = 1; i < points.length - 1; i++) {
    const cross = new THREE.Vector3(...points[i]).sub(origin)
      .cross(new THREE.Vector3(...points[i + 1]).sub(origin));
    if (cross.lengthSq() < 1e-16) continue;
    const triangle = cross.dot(direction) >= 0
      ? [points[0], points[i], points[i + 1]]
      : [points[0], points[i + 1], points[i]];
    verts.push(...triangle.flat());
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function loft(sections) {
  const rows = sections.map(([z, w, bottom, top]) => [
    [-w, top, z], [w, top, z], [w, bottom, z], [-w, bottom, z],
  ]);
  const parts = [];
  for (let i = 0; i < rows.length - 1; i++) {
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      parts.push(panel([rows[i][edge], rows[i][next], rows[i + 1][next], rows[i + 1][edge]],
        [[0, 1, 0], [1, 0, 0], [0, -1, 0], [-1, 0, 0]][edge]));
    }
  }
  parts.push(panel(rows[0], [0, 0, 1]), panel(rows.at(-1), [0, 0, -1]));
  return merged(parts);
}

function cylinder(radius, depth, x, y, z, axis = 'x', segments = 8) {
  const geometry = new THREE.CylinderGeometry(radius, radius, depth, segments);
  if (axis === 'x') geometry.rotateZ(Math.PI / 2);
  if (axis === 'z') geometry.rotateX(Math.PI / 2);
  return geometry.translate(x, y, z);
}

function cabGeometry() {
  const parts = [
    // The narrow engine hood leaves the steer wheels exposed. The cab's high
    // sill and separate steps replace the old painted slab down to the road.
    loft([[8.15, 0.79, 1.035, 1.48], [7.91, 0.87, 1.055, 1.62], [6.72, 0.91, 1.06, 1.79]]),
    loft([[6.79, 0.97, 1.08, 1.80], [6.45, 1.085, 1.03, 2.92],
      [5.37, 1.085, 1.03, 3.10], [4.89, 1.035, 1.08, 3.08]]),
    // A restrained sleeper fairing closes part of the height gap to the van.
    loft([[5.63, 1.02, 3.05, 3.065], [5.21, 0.99, 3.06, 3.46], [4.90, 0.98, 3.06, 3.49]]),
  ];
  for (const side of SIDES) {
    // Eight broad fender facets follow a real opening, rather than painting a
    // black wheel onto an unbroken body side. A visible gap clears the tire.
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 8;
      const b = (i + 1) * Math.PI / 8;
      const p = (r, angle, x) => [side * x, WHEEL_Y + r * Math.sin(angle), STEER_Z + r * Math.cos(angle)];
      parts.push(panel([p(0.585, a, 1.185), p(0.585, b, 1.185), p(0.715, b, 1.185), p(0.715, a, 1.185)], [side, 0, 0]));
      parts.push(panel([p(0.715, a, 0.82), p(0.715, a, 1.185), p(0.715, b, 1.185), p(0.715, b, 0.82)], [0, 1, 0]));
    }
  }
  return merged(parts);
}

function glassGeometry() {
  const parts = [];
  for (const side of SIDES) {
    // Split windshield and door glass; the painted centre bar remains visible.
    parts.push(panel([
      [side * 0.055, 1.915, 6.765], [side * 0.85, 1.915, 6.765],
      [side * 0.94, 2.805, 6.495], [side * 0.055, 2.805, 6.495],
    ], [0, 0.3, 1]));
    parts.push(panel([
      [side * 1.094, 1.96, 6.51], [side * 1.094, 1.96, 5.60],
      [side * 1.094, 2.91, 5.60], [side * 1.094, 2.765, 6.44],
    ], [side, 0, 0]));
    parts.push(box(0.015, 0.34, 0.32, side * 1.078, 2.37, 5.18));
    parts.push(box(0.035, 0.26, 0.19, side * 1.251, 2.45, 6.53));
  }
  return merged(parts);
}

function trimGeometry() {
  const parts = [
    box(1.39, 0.82, 0.035, 0, 1.27, 8.175), // deep radiator opening
    box(2.16, 0.16, 0.17, 0, 0.565, 8.165),
    box(0.46, 0.18, 0.02, 0, 0.69, 8.23),
    // Trailer doors sit inside their metallic frame; the narrow dark seam is
    // offset from the wall so no coplanar flashing appears at chase distance.
    box(0.032, 2.42, 0.014, 0, 2.63, -8.222),
    box(2.37, 0.27, 0.06, 0, 1.09, -8.17),
  ];
  for (const side of SIDES) {
    parts.push(
      box(0.019, 1.82, 0.018, side * 1.097, 1.98, 5.51),
      box(0.025, 0.035, 0.86, side * 1.099, 1.46, 6.02),
      box(0.03, 0.055, 0.19, side * 1.105, 1.84, 5.71),
      box(0.18, 0.045, 0.045, side * 1.15, 2.34, 6.55),
      box(0.15, 0.32, 0.25, side * 1.195, 2.45, 6.53),
      // Mud flaps sit behind the tandems, clear of the contact patches.
      box(0.59, 0.52, 0.055, side * 0.99, 0.48, 1.96),
      box(0.59, 0.52, 0.055, side * 0.99, 0.48, -7.69),
    );
  }
  return merged(parts);
}

function chassisGeometry() {
  const parts = [];
  for (const side of SIDES) {
    parts.push(
      box(0.16, 0.22, 6.02, side * 0.45, 0.81, 5.02), // tractor frame rails
      box(0.10, 0.21, 12.31, side * 0.47, 1.13, -1.955), // trailer I-beams
      box(0.14, 0.41, 0.14, side * 0.88, 0.935, 0.59), // raised landing gear
      box(0.30, 0.08, 0.28, side * 0.88, 0.715, 0.59),
    );
    for (const z of TANDEMS) {
      parts.push(box(0.24, 0.19, 0.82, side * 0.63, 0.74, z));
      parts.push(box(0.25, 0.22, 0.25, side * 0.51, 0.92, z));
    }
  }
  parts.push(cylinder(0.1, 2.05, 0, WHEEL_Y, STEER_Z));
  for (const z of TANDEMS) parts.push(cylinder(0.115, 2.04, 0, WHEEL_Y, z));
  for (const z of [-7.80, -4.45, -0.90, 3.28]) parts.push(box(2.20, 0.10, 0.14, 0, 1.115, z));
  parts.push(box(1.36, 0.10, 1.10, 0, 1.015, 3.61)); // fifth-wheel platform
  return merged(parts);
}

function metalGeometry() {
  const parts = [
    box(2.21, 0.18, 0.15, 0, 0.725, 8.165), // bright bumper face
    box(0.047, 0.88, 0.06, -0.71, 1.29, 8.199),
    box(0.047, 0.88, 0.06, 0.71, 1.29, 8.199),
    box(1.47, 0.047, 0.06, 0, 1.73, 8.199),
    box(1.47, 0.047, 0.06, 0, 0.85, 8.199),
    box(2.22, 0.14, 0.12, 0, 0.56, -8.16), // rear underride bar
    box(2.45, 0.10, 0.065, 0, 3.91, -8.205),
    box(2.45, 0.10, 0.065, 0, 1.36, -8.205),
  ];
  for (const x of [-0.43, -0.215, 0, 0.215, 0.43]) parts.push(box(0.032, 0.73, 0.05, x, 1.29, 8.205));
  for (const side of SIDES) {
    parts.push(
      cylinder(0.31, 1.24, side * 0.87, 0.78, 5.42, 'z'), // fuel tanks tucked behind steps
      box(0.30, 0.075, 1.16, side * 1.08, 0.51, 5.76),
      box(0.24, 0.075, 1.01, side * 1.105, 0.84, 5.72),
      box(0.037, 0.082, 12.53, side * 1.237, 1.345, -1.945),
      box(0.034, 0.075, 12.53, side * 1.235, 3.92, -1.945),
      box(0.064, 2.57, 0.054, side * 1.205, 2.63, -8.216),
      box(0.045, 2.53, 0.05, side * 1.238, 2.63, 4.288),
      box(0.045, 2.15, 0.048, side * 0.56, 2.63, -8.224), // rear locking rods
      box(0.15, 0.075, 0.055, side * 0.56, 1.91, -8.222),
      box(0.10, 0.47, 0.10, side * 0.83, 0.815, -8.11),
    );
    for (const y of [1.65, 2.56, 3.51]) parts.push(box(0.19, 0.055, 0.04, side * 1.08, y, -8.226));
    // Sparse vertical ribs leave large quiet side panels instead of striping
    // every centimetre of the box. The van reads as fabricated sheet metal.
    for (const z of [-5.10, -1.90, 1.30]) parts.push(box(0.026, 2.47, 0.025, side * 1.233, 2.64, z));
  }
  return merged(parts);
}

function wheelGeometry() {
  const spots = [];
  for (const side of SIDES) {
    spots.push([side * 1.016, STEER_Z, 0.32]);
    for (const z of TANDEMS) {
      spots.push([side * 0.775, z, 0.265], [side * 1.083, z, 0.265]);
    }
  }
  const parts = [];
  for (const [x, z, width] of spots) {
    const rings = [[-width / 2, 0.457], [-width * 0.34, 0.52], [width * 0.34, 0.52], [width / 2, 0.457]];
    const point = ([dx, radius], angle) => [x + dx, Math.max(0, WHEEL_Y + radius * Math.sin(angle)), z + radius * Math.cos(angle)];
    for (let ring = 0; ring < rings.length - 1; ring++) {
      for (let i = 0; i < 12; i++) {
        const a = Math.PI / 12 + i * Math.PI / 6;
        const b = a + Math.PI / 6;
        parts.push(panel([point(rings[ring], a), point(rings[ring], b), point(rings[ring + 1], b), point(rings[ring + 1], a)],
          [ring === 0 ? -1 : ring === 2 ? 1 : 0, Math.sin((a + b) / 2), Math.cos((a + b) / 2)]));
      }
    }
    for (const end of [0, 3]) {
      parts.push(panel(Array.from({ length: 12 }, (_, i) => point(rings[end], Math.PI / 12 + i * Math.PI / 6)), [end === 0 ? -1 : 1, 0, 0]));
    }
  }
  return merged(parts);
}

function hubGeometry() {
  const parts = [];
  for (const side of SIDES) {
    for (const z of [STEER_Z, ...TANDEMS]) {
      const faceX = z === STEER_Z ? 1.18 : 1.219;
      const p = (r, angle, depth = 0) => [side * (faceX + depth), WHEEL_Y + r * Math.sin(angle), z + r * Math.cos(angle)];
      for (let i = 0; i < 12; i++) {
        const a = Math.PI / 12 + i * Math.PI / 6;
        const b = a + Math.PI / 6;
        // Silver rolled rim, shallow dished steel centre, and six dark gaps.
        // The openings expose the underlying tire instead of texture decals.
        parts.push(panel([p(0.346, a), p(0.346, b), p(0.291, b, 0.011), p(0.291, a, 0.011)], [side, 0, 0]));
        if (i % 2 === 0) {
          parts.push(panel([p(0.291, a, 0.011), p(0.291, b, 0.011), p(0.123, b, 0.004), p(0.123, a, 0.004)], [side, 0, 0]));
        }
      }
      parts.push(panel(Array.from({ length: 8 }, (_, i) => p(0.133, i * Math.PI / 4, 0.021)), [side, 0, 0]));
      const capRadius = z === STEER_Z ? 0.065 : 0.085;
      const cap = Array.from({ length: 6 }, (_, i) => p(capRadius, i * Math.PI / 3, 0.044));
      parts.push(panel(cap, [side, 0, 0]));
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        const b = (i + 1) * Math.PI / 3;
        parts.push(panel([p(capRadius, a, 0.021), p(capRadius, b, 0.021), cap[(i + 1) % 6], cap[i]],
          [0, Math.sin((a + b) / 2), Math.cos((a + b) / 2)]));
      }
    }
  }
  return merged(parts);
}

function reflectorsGeometry(red) {
  const parts = [];
  for (const side of SIDES) {
    for (let i = 0; i < 16; i++) {
      if ((i % 2 === 0) !== red) continue;
      const z = -7.88 + i * 0.78;
      parts.push(panel([[side * 1.262, 1.45, z - 0.195], [side * 1.262, 1.45, z + 0.195],
        [side * 1.262, 1.53, z + 0.195], [side * 1.262, 1.53, z - 0.195]], [side, 0, 0]));
    }
  }
  for (let i = 0; i < 6; i++) {
    if ((i % 2 === 0) !== red) continue;
    const x = -0.99 + i * 0.396;
    parts.push(panel([[x - 0.165, 0.5335, -8.238], [x + 0.165, 0.5335, -8.238],
      [x + 0.165, 0.6065, -8.238], [x - 0.165, 0.6065, -8.238]], [0, 0, -1]));
  }
  return merged(parts);
}

export function buildSemiGeometry() {
  const indicators = [];
  for (const side of SIDES) {
    indicators.push(
      box(0.29, 0.105, 0.025, side * 0.88, 1.00, 8.223),
      box(0.35, 0.115, 0.025, side * 0.88, 1.19, -8.223),
      box(0.023, 0.11, 0.12, side * 1.249, 1.57, 4.15),
      box(0.023, 0.11, 0.12, side * 1.249, 1.57, -1.94),
      box(0.055, 0.10, 0.12, side * 1.204, 3.87, 4.23),
    );
  }
  for (const x of [-0.78, -0.39, 0, 0.39, 0.78]) indicators.push(box(0.11, 0.080, 0.10, x, 2.986, 6.37));
  const rearLens = SIDES.map((side) => box(0.36, 0.15, 0.025, side * 0.88, 1.01, -8.223));
  for (const x of [-0.25, 0, 0.25]) rearLens.push(box(0.10, 0.08, 0.018, x, 3.865, -8.224));
  for (const side of SIDES) rearLens.push(box(0.022, 0.11, 0.12, side * 1.249, 1.57, -8.04));
  return {
    cab: cabGeometry(),
    trailer: box(2.45, ROOF_Y - FLOOR_Y, TRAILER_FRONT - TRAILER_REAR, 0, (FLOOR_Y + ROOF_Y) / 2, (TRAILER_FRONT + TRAILER_REAR) / 2),
    glass: glassGeometry(),
    trim: trimGeometry(),
    chassis: chassisGeometry(),
    metal: metalGeometry(),
    frontLens: merged(SIDES.map((side) => box(0.40, 0.19, 0.025, side * 0.88, 1.25, 8.223))),
    rearLens: merged(rearLens),
    indicators: merged(indicators),
    wheels: wheelGeometry(),
    hubs: hubGeometry(),
    reflectorRed: reflectorsGeometry(true),
    reflectorWhite: reflectorsGeometry(false),
  };
}
