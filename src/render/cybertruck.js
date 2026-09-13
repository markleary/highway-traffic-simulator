import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Presentation contract: metres, origin at the footprint's centre on the road,
// +z forward, +x driver's left, +y up. Each named buffer is one instanced part.
// A future authored model can supply these same parts and light mounts without
// changing the simulation, instance transforms, or driver-state lighting.
// Production dimensions / medium suspension setting, rounded to millimetres:
// https://www.tesla.com/ownersmanual/cybertruck/en_ae/GUID-12A976DD-EB60-431B-AFF1-5A37E95006DB.html
// 5.683 m long, 2.032 m body width, 1.790 m high, 3.635 m wheelbase.
const AXLES = Object.freeze([1.963, -1.672]);
const WHEEL_Y = 0.443;
export const CYBERTRUCK_WHEELS = Object.freeze({ axles: AXLES, y: WHEEL_Y, radius: WHEEL_Y });
const SIDE_X = 0.971;
const FRONT_Z = 2.795;
const REAR_Z = -2.795;
const PEAK_Z = 0.48;
const PEAK_Y = 1.79;
const TAIL_Y = 1.23;
const CAB_REAR_Z = -0.9;
const HOOD_REAR_Z = 1.7;
const HOOD_REAR_Y = 1.27;
const BELT = (z) => 1.16 - 0.022 * z;
const BACK = (z) => TAIL_Y + (PEAK_Y - TAIL_Y) * (z - REAR_Z) / (PEAK_Z - REAR_Z);
const FRONT = (z) => HOOD_REAR_Y + (PEAK_Y - HOOD_REAR_Y) * (HOOD_REAR_Z - z) / (HOOD_REAR_Z - PEAK_Z);
// The entire upper side is a single flat plane, retaining the characteristic
// stainless sheet rather than accidentally shading a triangulated "dent".
const SIDE = (side, y, z, lift = 0) => [side * (SIDE_X - 0.24 * (y - BELT(z)) + lift), y, z];

export const CYBERTRUCK_LIGHTS = Object.freeze({
  rear: -2.812, front: 2.812, halfW: 0.76, y: 0.58,
  brakeZ: -2.823, brakeY: 1.185, brakeW: 1.87, brakeH: 0.052,
  blinkZR: -2.818, blinkYR: 0.585, blinkHalfWR: 0.76,
  blinkWR: 0.3, blinkHR: 0.065, blinkDepthR: 0.018,
  blinkZF: 2.818, blinkYF: 0.625, blinkHalfWF: 0.76,
  blinkWF: 0.3, blinkHF: 0.065, blinkDepthF: 0.018,
});

// All authored surfaces are non-indexed with flat normals. Primitive UVs are
// discarded because the renderer uses solid materials and instance colours.
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

function triangles(faces) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(faces.flat(2), 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Convex panel, explicitly oriented outward; no DoubleSide material needed.
function panel(points, outward) {
  const faces = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 1; i < points.length - 1; i++) {
    a.fromArray(points[i]).sub(new THREE.Vector3().fromArray(points[0]));
    b.fromArray(points[i + 1]).sub(new THREE.Vector3().fromArray(points[0]));
    const reverse = a.cross(b).dot(new THREE.Vector3(...outward)) < 0;
    faces.push(reverse ? [points[0], points[i + 1], points[i]] : [points[0], points[i], points[i + 1]]);
  }
  return triangles(faces);
}

function box(w, h, d, x, y, z) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// Open-bottom six-sided wheel opening. The side wall genuinely follows this
// contour: the dark wheel well is recessed, not a plate hiding a solid body.
const ARCH_INNER = [
  [-0.555, 0.37], [-0.455, 0.785], [-0.245, 0.965],
  [0.245, 0.965], [0.455, 0.785], [0.555, 0.37],
];
const ARCH_OUTER = [
  [-0.645, 0.37], [-0.535, 0.835], [-0.285, 1.055],
  [0.285, 1.055], [0.535, 0.835], [0.645, 0.37],
];

function lowerSide(side) {
  const contour = [
    [FRONT_Z, BELT(FRONT_Z)], [REAR_Z, BELT(REAR_Z)],
    [-2.76, 0.37],
    ...[...AXLES].reverse().flatMap((axle) => ARCH_INNER.map(([z, y]) => [axle + z, y])),
    [2.7, 0.37], [2.77, 0.66],
  ];
  const indices = THREE.ShapeUtils.triangulateShape(contour.map(([z, y]) => new THREE.Vector2(z, y)), []);
  const points = contour.map(([z, y]) => [side * SIDE_X, y, z]);
  return merged(indices.map((face) => panel(face.map((index) => points[index]), [side, 0, 0])));
}

function bodyGeometry() {
  const points = [
    [FRONT_Z, 1.1], [HOOD_REAR_Z, HOOD_REAR_Y],
    [PEAK_Z, PEAK_Y], [CAB_REAR_Z, BACK(CAB_REAR_Z)], [REAR_Z, TAIL_Y],
  ];
  const parts = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [za, ya] = points[i];
    const [zb, yb] = points[i + 1];
    parts.push(panel([SIDE(-1, ya, za), SIDE(1, ya, za), SIDE(1, yb, zb), SIDE(-1, yb, zb)], [0, 1, 0]));
    for (const side of [-1, 1]) {
      parts.push(panel([
        [side * SIDE_X, BELT(za), za], [side * SIDE_X, BELT(zb), zb],
        SIDE(side, yb, zb), SIDE(side, ya, za),
      ], [side, 0, 0]));
    }
  }
  for (const side of [-1, 1]) parts.push(lowerSide(side));
  // Flat front fascia and a clipped lower lip; short overhang ahead of the
  // front wheel distinguishes the production truck from the old long wedge.
  parts.push(panel([
    SIDE(-1, 1.1, FRONT_Z), SIDE(1, 1.1, FRONT_Z),
    [SIDE_X, 0.66, 2.77], [-SIDE_X, 0.66, 2.77],
  ], [0, 0, 1]));
  parts.push(panel([
    [-SIDE_X, 0.66, 2.77], [SIDE_X, 0.66, 2.77],
    [SIDE_X, 0.37, 2.7], [-SIDE_X, 0.37, 2.7],
  ], [0, 0, 1]));
  parts.push(panel([
    SIDE(-1, TAIL_Y, REAR_Z), SIDE(1, TAIL_Y, REAR_Z),
    [SIDE_X, 0.37, -2.76], [-SIDE_X, 0.37, -2.76],
  ], [0, 0, -1]));
  // Close the very small shoulder facets where the tapered upper sheet
  // meets the constant-width lower sides and the front/rear end plates.
  for (const side of [-1, 1]) {
    parts.push(panel([
      SIDE(side, 1.1, FRONT_Z), [side * SIDE_X, BELT(FRONT_Z), FRONT_Z],
      [side * SIDE_X, 0.66, 2.77],
    ], [side, 0, 1]));
    parts.push(panel([
      SIDE(side, TAIL_Y, REAR_Z), [side * SIDE_X, BELT(REAR_Z), REAR_Z],
      [side * SIDE_X, 0.37, -2.76],
    ], [side, 0, -1]));
  }
  // Narrow undertray stays inside the wells instead of plugging the cutouts.
  parts.push(box(1.46, 0.1, 5.35, 0, 0.31, 0));
  return merged(parts);
}

function glassGeometry() {
  const parts = [];
  // A long windshield, a short glass roof and then a separate opaque tonneau.
  // Insets leave a thin stainless roof rail and the transverse peak visible.
  const topGlass = (za, zb, yAt) => panel([
    [-Math.abs(SIDE(1, yAt(za), za)[0]) + 0.052, yAt(za) + 0.009, za],
    [Math.abs(SIDE(1, yAt(za), za)[0]) - 0.052, yAt(za) + 0.009, za],
    [Math.abs(SIDE(1, yAt(zb), zb)[0]) - 0.052, yAt(zb) + 0.009, zb],
    [-Math.abs(SIDE(1, yAt(zb), zb)[0]) + 0.052, yAt(zb) + 0.009, zb],
  ], [0, 1, 0]);
  parts.push(topGlass(1.635, 0.55, FRONT), topGlass(0.415, -0.855, BACK));
  for (const side of [-1, 1]) {
    // The B pillar splits two recognisable door panes. The aft taper leaves
    // the solid triangular sail pillar connecting the cab to the bed rail.
    const frontWindow = [[1.535, 1.265], [0.515, 1.735], [0.3, 1.698], [0.3, BELT(0.3) + 0.066], [1.46, BELT(1.46) + 0.066]];
    const rearWindow = [[0.215, 1.684], [-0.82, 1.507], [-0.97, BELT(-0.97) + 0.066], [0.215, BELT(0.215) + 0.066]];
    for (const pane of [frontWindow, rearWindow]) {
      parts.push(panel(pane.map(([z, y]) => SIDE(side, y, z, 0.007)), [side, 0, 0]));
    }
  }
  return merged(parts);
}

function trimGeometry() {
  const parts = [
    box(1.92, 0.19, 0.17, 0, 0.49, 2.708),
    box(1.94, 0.175, 0.16, 0, 0.475, -2.71),
    // Lower lamp pockets, visibly distinct from the thin upper light bar.
    box(0.38, 0.095, 0.022, -0.75, 0.625, 2.797),
    box(0.38, 0.095, 0.022, 0.75, 0.625, 2.797),
    box(0.38, 0.095, 0.022, -0.75, 0.585, -2.797),
    box(0.38, 0.095, 0.022, 0.75, 0.585, -2.797),
    // Recessed plate mount and tailgate handle/camera recess.
    box(0.48, 0.16, 0.022, 0, 0.485, -2.798),
    box(0.16, 0.04, 0.018, 0, 1.08, -2.801),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(0.055, 0.135, 2.535, side * 0.977, 0.345, 0.145));
    for (const axle of AXLES) {
      for (let i = 0; i < ARCH_INNER.length - 1; i++) {
        const a = ARCH_INNER[i];
        const b = ARCH_INNER[i + 1];
        const c = ARCH_OUTER[i + 1];
        const d = ARCH_OUTER[i];
        const point = ([z, y], x) => [side * x, y, axle + z];
        // An outward-facing polygon band and its bevel, plus the tunnel's
        // recessed inner roof. Tires sit behind the flare's outer edge.
        parts.push(panel([point(a, 1.013), point(b, 1.013), point(c, 1.016), point(d, 1.016)], [side, 0, 0]));
        parts.push(panel([point(d, 1.016), point(c, 1.016), point(c, 0.969), point(d, 0.969)], [0, 1, 0]));
        parts.push(panel([point(a, 1.013), point(a, 0.738), point(b, 0.738), point(b, 1.013)], [0, -1, 0]));
      }
      // A backing surface deep in the well, behind the tire, prevents views
      // through the chassis while leaving a real 27 cm deep opening.
      parts.push(panel(ARCH_INNER.map(([z, y]) => [side * 0.735, y, axle + z]), [side, 0, 0]));
    }
    // Fine door gaps are dark narrow strips lying on the flat lower flank.
    for (const z of [1.385, 0.255, -1.01]) {
      parts.push(box(0.012, BELT(z) - 0.43, 0.009, side * 0.976, (BELT(z) + 0.43) / 2, z));
    }
    // Small triangular mirrors: broad enough to read, within the real 2.413 m
    // mirror span, rather than large rectangular ears on the roof.
    parts.push(box(0.18, 0.045, 0.06, side * 1.057, 1.205, 1.315));
    const mirror = new THREE.CylinderGeometry(0.138, 0.12, 0.115, 3)
      .rotateY(side * 0.22).scale(1.08, 1, 0.78)
      .translate(side * 1.095, 1.24, 1.295);
    parts.push(mirror);
  }
  const za = -0.988;
  const zb = -2.715;
  parts.push(panel([
    [-0.805, BACK(za) + 0.008, za], [0.805, BACK(za) + 0.008, za],
    [0.874, BACK(zb) + 0.008, zb], [-0.874, BACK(zb) + 0.008, zb],
  ], [0, 1, 0]));
  // Shallow ribs catch the light without turning the cover into a roof rack.
  const slope = Math.atan((PEAK_Y - TAIL_Y) / (PEAK_Z - REAR_Z));
  for (let i = 1; i < 15; i++) {
    const f = i / 15;
    const z = za + (zb - za) * f;
    parts.push(new THREE.BoxGeometry(1.61 + 0.138 * f, 0.014, 0.018)
      .rotateX(-slope).translate(0, BACK(z) + 0.019, z));
  }
  return merged(parts);
}

function wheelGeometry() {
  const parts = [];
  // Twelve tread facets and bevelled shoulders retain the toy-scale style.
  // Track is 1.772 m; the outer sidewalls remain inside the arch flares.
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      const rings = [[-0.1225, 0.396], [-0.087, WHEEL_Y], [0.087, WHEEL_Y], [0.1225, 0.396]];
      for (let r = 0; r < rings.length - 1; r++) {
        for (let i = 0; i < 12; i++) {
          const point = (ring, angle) => [side * (0.886 + ring[0]), WHEEL_Y + ring[1] * Math.sin(angle), z + ring[1] * Math.cos(angle)];
          const a = i * Math.PI / 6;
          const b = (i + 1) * Math.PI / 6;
          parts.push(panel([point(rings[r], a), point(rings[r], b), point(rings[r + 1], b), point(rings[r + 1], a)],
            [side * (r === 0 ? -1 : r === 2 ? 1 : 0), Math.sin((a + b) / 2), Math.cos((a + b) / 2)]));
        }
      }
      for (const face of [-1, 1]) {
        parts.push(new THREE.CylinderGeometry(0.396, 0.396, 0.003, 12)
          .rotateZ(Math.PI / 2).translate(side * (0.886 + face * 0.121), WHEEL_Y, z));
      }
    }
  }
  return merged(parts);
}

function hubGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      const vertices = Array.from({ length: 14 }, (_, i) => {
        const a = i * Math.PI / 7;
        const radius = i % 2 === 0 ? 0.351 : 0.287;
        return [side * 1.011, WHEEL_Y + Math.sin(a) * radius, z + Math.cos(a) * radius];
      });
      // A shallow seven-lobed aero cover, not a bright conventional hubcap.
      parts.push(...vertices.map((vertex, i) => panel([
        [side * 1.016, WHEEL_Y, z], vertex, vertices[(i + 1) % vertices.length],
      ], [side, 0, 0])));
      parts.push(new THREE.CylinderGeometry(0.071, 0.071, 0.01, 7)
        .rotateZ(Math.PI / 2).translate(side * 1.01, WHEEL_Y, z));
    }
  }
  return merged(parts);
}

export function buildCybertruckGeometry() {
  return {
    body: bodyGeometry(),
    glass: glassGeometry(),
    trim: trimGeometry(),
    wheels: wheelGeometry(),
    hubs: hubGeometry(),
    // Dormant lenses are physical surfaces, not emissive lights. The dynamic
    // brake/indicator instances are positioned just above these same mounts.
    frontLens: merged([box(1.895, 0.052, 0.017, 0, 1.08, 2.805)]),
    rearLens: merged([box(1.895, 0.064, 0.017, 0, 1.185, -2.805)]),
  };
}
