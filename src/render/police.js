import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural patrol-sedan presentation provider. Metres, road at y=0, +z
// forward, origin at the footprint centre. Even the push bumper and lamps
// stay inside the simulation's 5.0 m length. Fixed white livery and dark trim
// are separate from the tintable shell; an authored model can supply these
// same named buffers later without changing vehicle state or traffic logic.
const FRONT = 2.43;
const REAR = -2.43;
const AXLES = Object.freeze([1.53, -1.53]);
const WHEEL_Y = 0.365;
export const POLICE_WHEELS = Object.freeze({ axles: AXLES, y: WHEEL_Y, radius: WHEEL_Y });
const SHOULDER_SLOPE = 0.55;
// z, half-width, shoulder/belt height, hood/roof/deck height.
const PROFILE = [
  [FRONT, 0.80, 0.755, 0.815],
  [2.20, 0.955, 0.86, 0.90],
  [1.06, 0.995, 0.99, 1.015],
  [0.34, 0.995, 1.00, 1.50],
  [-0.92, 0.995, 1.00, 1.505],
  [-1.58, 0.995, 1.01, 1.06],
  [-2.22, 0.93, 0.94, 0.965],
  [REAR, 0.79, 0.79, 0.85],
];
const ARCH = [
  [-0.445, 0.29], [-0.420, 0.52], [-0.308, 0.708],
  [-0.16, 0.786], [0.16, 0.786], [0.308, 0.708],
  [0.420, 0.52], [0.445, 0.29],
];

export const POLICE_LIGHTS = Object.freeze({
  rear: -2.475, front: 2.457, halfW: 0.71, y: 0.77,
  brakeZ: -2.482, brakeY: 0.775, brakeHalfW: 0.515, brakeW: 0.27, brakeH: 0.13,
  blinkZR: -2.484, blinkYR: 0.775, blinkHalfWR: 0.755,
  blinkWR: 0.16, blinkHR: 0.13, blinkDepthR: 0.012,
  blinkZF: 2.458, blinkYF: 0.758, blinkHalfWF: 0.773,
  blinkWF: 0.125, blinkHF: 0.12, blinkDepthF: 0.012,
});
export const POLICE_STROBE = Object.freeze({
  x: 0.43, y: 1.65, z: -0.10, sx: 0.40, sy: 0.13, sz: 0.22,
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
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

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
function roofPoint(side, z, inset = 0, lift = 0) {
  const p = profileAt(z);
  return [side * (p.w - SHOULDER_SLOPE * (p.top - p.belt) - inset), p.top + lift, z];
}
function sidePoint(side, y, z, lift = 0) {
  const p = profileAt(z);
  return [side * (p.w - SHOULDER_SLOPE * (y - p.belt) + lift), y, z];
}
function lowerSide(side) {
  const contour = [
    ...PROFILE.map(([z, , belt]) => [z, belt]),
    [REAR, 0.40], [-2.21, 0.29],
    ...[...AXLES].reverse().flatMap((axle) => ARCH.map(([z, y]) => [axle + z, y])),
    [2.21, 0.29], [FRONT, 0.40],
  ];
  const triangles = THREE.ShapeUtils.triangulateShape(contour.map(([z, y]) => new THREE.Vector2(z, y)), []);
  const points = contour.map(([z, y]) => [side * profileAt(z).w, y, z]);
  return merged(triangles.map((face) => panel(face.map((index) => points[index]), [side, 0, 0])));
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
  for (const z of [FRONT, REAR]) {
    const p = profileAt(z);
    parts.push(panel([[-p.w, 0.40, z], [p.w, 0.40, z], roofPoint(1, z), roofPoint(-1, z)], [0, 0, Math.sign(z)]));
  }
  parts.push(box(1.42, 0.10, 4.35, 0, 0.265, 0));
  return merged(parts);
}
function roofGeometry() {
  // White roof with a dark window header around its perimeter.
  return panel([
    roofPoint(-1, 0.275, 0.008, 0.009), roofPoint(1, 0.275, 0.008, 0.009),
    roofPoint(1, -0.855, 0.008, 0.009), roofPoint(-1, -0.855, 0.008, 0.009),
  ], [0, 1, 0]);
}
function glassGeometry() {
  const parts = [];
  for (const [za, zb] of [[1.002, 0.385], [-0.968, -1.51]]) {
    parts.push(panel([
      roofPoint(-1, za, 0.055, 0.009), roofPoint(1, za, 0.055, 0.009),
      roofPoint(1, zb, 0.055, 0.009), roofPoint(-1, zb, 0.055, 0.009),
    ], [0, 1, 0]));
  }
  for (const side of [-1, 1]) {
    // Body-colour A/B/C pillars break the glass into an unmistakable four-door
    // cabin. The quarter window is separated from the rear passenger window.
    for (const [za, zb] of [[0.93, 0.34], [0.34, 0.006], [-0.078, -0.82], [-0.885, -0.92], [-0.92, -1.41]]) {
      const a = profileAt(za);
      const b = profileAt(zb);
      parts.push(panel([
        sidePoint(side, a.belt + 0.045, za, 0.009), sidePoint(side, b.belt + 0.045, zb, 0.009),
        sidePoint(side, b.top - 0.055, zb, 0.009), sidePoint(side, a.top - 0.055, za, 0.009),
      ], [side, 0, 0]));
    }
  }
  // Rear-facing mirror inserts and the driver's A-pillar spotlight lens.
  for (const side of [-1, 1]) parts.push(box(0.112, 0.052, 0.007, side * 1.058, 1.072, 0.824));
  parts.push(new THREE.CylinderGeometry(0.048, 0.048, 0.009, 8).rotateX(Math.PI / 2).translate(0.964, 1.133, 0.923));
  return merged(parts);
}
function liveryGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    // Doors end between the openings, so the livery never fills in a wheel
    // arch. Separate panels preserve the centre shut line through the white.
    for (const [za, zb] of [[1.06, 0.004], [-0.018, -1.045]]) {
      parts.push(panel([
        [side * 1.002, 0.395, za], [side * 1.002, 0.395, zb],
        [side * 1.002, 0.969, zb], [side * 1.002, 0.969, za],
      ], [side, 0, 0]));
    }
  }
  // Light rear licence plate provides a small central anchor below the lamps.
  parts.push(box(0.36, 0.115, 0.01, 0, 0.555, -2.445));
  return merged(parts);
}

// Tiny geometric block glyphs: no font fetch, canvas texture, image or atlas.
// Each contiguous row becomes one quad. Lettering remains a few bold shapes
// at normal chase distance instead of a texture blurred by minification.
const GLYPHS = {
  P: ['111', '101', '111', '100', '100'],
  O: ['111', '101', '101', '101', '111'],
  L: ['100', '100', '100', '100', '111'],
  I: ['111', '010', '010', '010', '111'],
  C: ['111', '100', '100', '100', '111'],
  E: ['111', '100', '110', '100', '111'],
};
function policeLettering(side) {
  const parts = [];
  const pixel = 0.058;
  const width = (6 * 4 - 1) * pixel;
  for (const [letter, glyph] of Array.from('POLICE').map((letter, i) => [i, GLYPHS[letter]])) {
    glyph.forEach((row, r) => {
      let column = 0;
      while (column < row.length) {
        if (row[column] !== '1') { column++; continue; }
        const start = column;
        while (column < row.length && row[column] === '1') column++;
        const left = width / 2 - (letter * 4 + start) * pixel;
        const right = width / 2 - (letter * 4 + column) * pixel;
        const top = 0.883 - r * pixel;
        const bottom = top - pixel;
        parts.push(panel([
          [side * 1.009, top, side * left], [side * 1.009, top, side * right],
          [side * 1.009, bottom, side * right], [side * 1.009, bottom, side * left],
        ], [side, 0, 0]));
      }
    });
  }
  return merged(parts);
}
function trimGeometry() {
  const parts = [
    box(1.68, 0.135, 0.045, 0, 0.43, 2.455),
    box(1.72, 0.135, 0.045, 0, 0.43, -2.455),
    box(0.70, 0.235, 0.028, 0, 0.69, 2.454),
    box(1.27, 0.055, 0.29, 0, 1.563, -0.10),
    // Push bar projects from the grille with separate vertical uprights, but
    // is narrow enough to leave all front lamps unobstructed.
    box(0.74, 0.065, 0.035, 0, 0.55, 2.480),
    box(0.72, 0.045, 0.035, 0, 0.845, 2.480),
    box(0.065, 0.43, 0.035, 0.37, 0.68, 2.480),
    box(0.065, 0.43, 0.035, -0.37, 0.68, 2.480),
    box(0.045, 0.045, 0.095, 0.37, 0.47, 2.430),
    box(0.045, 0.045, 0.095, -0.37, 0.47, 2.430),
    // Small grille slots catch enough light to distinguish grille and bar.
    box(0.67, 0.018, 0.016, 0, 0.635, 2.473),
    box(0.67, 0.018, 0.016, 0, 0.692, 2.473),
    box(0.67, 0.018, 0.016, 0, 0.749, 2.473),
    box(0.405, 0.155, 0.015, 0, 0.555, -2.435),
    // Roof aerial, kept short enough to preserve the low-poly silhouette.
    new THREE.CylinderGeometry(0.006, 0.013, 0.24, 5).translate(0, 1.64, -0.67),
  ];
  for (const side of [-1, 1]) {
    parts.push(policeLettering(side));
    parts.push(box(0.045, 0.075, 2.08, side * 0.992, 0.34, 0.008));
    // Door protection strip and handles sit below and above the lettering.
    parts.push(box(0.012, 0.028, 2.05, side * 1.012, 0.515, 0));
    for (const z of [0.12, -0.91]) parts.push(box(0.015, 0.029, 0.15, side * 1.012, 0.935, z));
    parts.push(box(0.16, 0.036, 0.055, side * 0.966, 1.047, 0.91));
    parts.push(box(0.17, 0.095, 0.18, side * 1.058, 1.070, 0.92));
    parts.push(box(0.50, 0.19, 0.035, side * 0.60, 0.758, 2.436));
    parts.push(box(0.51, 0.18, 0.035, side * 0.60, 0.775, -2.453));
    for (const axle of AXLES) {
      // Recessed black liner closes the inner well, not the outer opening.
      for (let i = 0; i < ARCH.length - 1; i++) {
        const a = ARCH[i];
        const b = ARCH[i + 1];
        const point = ([z, y], x) => [side * x, y, axle + z];
        parts.push(panel([point(a, 0.998), point(a, 0.688), point(b, 0.688), point(b, 0.998)], [0, -1, 0]));
      }
      parts.push(panel(ARCH.map(([z, y]) => [side * 0.685, y, axle + z]), [side, 0, 0]));
    }
  }
  // A-pillar spotlight is a strong patrol-car cue even with warning lights off.
  parts.push(box(0.035, 0.10, 0.035, 0.954, 1.098, 0.85));
  parts.push(new THREE.CylinderGeometry(0.06, 0.067, 0.083, 8).rotateX(Math.PI / 2).translate(0.964, 1.133, 0.875));
  return merged(parts);
}
function wheelGeometry() {
  const parts = [];
  const rings = [[-0.113, 0.316], [-0.082, WHEEL_Y], [0.082, WHEEL_Y], [0.113, 0.316]];
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      const point = (ring, angle) => [side * (0.842 + ring[0]), WHEEL_Y + ring[1] * Math.sin(angle), z + ring[1] * Math.cos(angle)];
      for (let r = 0; r < rings.length - 1; r++) {
        for (let i = 0; i < 12; i++) {
          const a = i * Math.PI / 6;
          const b = (i + 1) * Math.PI / 6;
          parts.push(panel([point(rings[r], a), point(rings[r], b), point(rings[r + 1], b), point(rings[r + 1], a)],
            [side * (r === 0 ? -1 : r === 2 ? 1 : 0), Math.sin((a + b) / 2), Math.cos((a + b) / 2)]));
        }
      }
      for (const face of [-1, 1]) parts.push(panel(Array.from({ length: 12 }, (_, i) => point([face * 0.113, 0.316], i * Math.PI / 6)), [side * face, 0, 0]));
    }
  }
  return merged(parts);
}
function hubGeometry() {
  const parts = [];
  for (const side of [-1, 1]) {
    for (const z of AXLES) {
      const point = (radius, angle, x) => [side * x, WHEEL_Y + radius * Math.sin(angle), z + radius * Math.cos(angle)];
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        const b = (i + 1) * Math.PI / 6;
        // Steel-wheel lip and six broad spokes expose the dark tire behind
        // them; no bright solid disc that reads as a toy hubcap.
        parts.push(panel([point(0.263, a, 0.958), point(0.263, b, 0.958), point(0.239, b, 0.964), point(0.239, a, 0.964)], [side, 0, 0]));
        if (i % 2 === 0) parts.push(panel([point(0.239, a, 0.964), point(0.239, b, 0.964), point(0.095, b, 0.973), point(0.095, a, 0.973)], [side, 0, 0]));
      }
      parts.push(new THREE.CylinderGeometry(0.099, 0.099, 0.025, 12).rotateZ(Math.PI / 2).translate(side * 0.973, WHEEL_Y, z));
    }
  }
  return merged(parts);
}

export function buildPoliceGeometry() {
  return {
    body: bodyGeometry(), roof: roofGeometry(), glass: glassGeometry(),
    panels: liveryGeometry(), trim: trimGeometry(),
    frontLens: merged([-1, 1].map((side) => box(0.30, 0.12, 0.013, side * 0.54, 0.758, 2.456))),
    rearLens: merged([-1, 1].map((side) => box(0.27, 0.13, 0.013, side * 0.515, 0.775, -2.474))),
    indicators: merged([-1, 1].flatMap((side) => [
      box(0.125, 0.12, 0.012, side * 0.773, 0.758, 2.455),
      box(0.16, 0.13, 0.012, side * 0.755, 0.775, -2.475),
    ])),
    wheels: wheelGeometry(), hubs: hubGeometry(),
  };
}
