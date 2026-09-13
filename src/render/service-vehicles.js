import * as THREE from 'three';
import { box, merge, panel, sectionAt, shell, wheels } from './vehicle-geometry.js';

// Both providers use the same presentation contract as the other vehicles:
// metres, road-level origin, +z forward, independent named instanced buffers.
// The 5.4 m ambulance and 10.5 m pumper include their bumpers and lamp lenses.
export const AMBULANCE_LIGHTS = Object.freeze({
  rear: -2.66, front: 2.65, halfW: 0.85, y: 1.0,
  brakeZ: -2.668, brakeY: 0.74, brakeHalfW: 0.85,
  brakeW: 0.32, brakeH: 0.15, brakeDepth: 0.015,
});
export const AMBULANCE_STROBE = Object.freeze({ x: 0.55, y: 2.60, z: 0.1, sx: 0.50, sy: 0.22, sz: 0.50 });
export const FIRETRUCK_LIGHTS = Object.freeze({
  rear: -5.215, front: 5.215, halfW: 0.9, y: 1.05,
  brakeZ: -5.222, brakeY: 0.88, brakeHalfW: 0.9,
  brakeW: 0.42, brakeH: 0.18, brakeDepth: 0.016,
  blinkZR: -5.222, blinkYR: 1.16, blinkHalfWR: 0.9,
  blinkWR: 0.42, blinkHR: 0.14, blinkDepthR: 0.016,
  blinkZF: 5.222, blinkYF: 1.20, blinkHalfWF: 0.84,
  blinkWF: 0.30, blinkHF: 0.12, blinkDepthF: 0.016,
});
export const FIRETRUCK_STROBE = Object.freeze({ x: 0.62, y: 3.18, z: 3.65, sx: 0.52, sy: 0.17, sz: 0.30 });

// A box-body side with connected polygonal wheel openings. The continuous
// opening over a tandem group follows its outer quarters and bridges the two
// crowns, avoiding the intersecting contours from cutting overlapping circles.
function moduleShell(front, rear, halfW, base, top, groups, radius) {
  const r = radius + 0.09;
  const lower = [[rear, base]];
  for (const group of [...groups].sort((a, b) => a[0] - b[0])) {
    const first = Math.min(...group), last = Math.max(...group);
    lower.push([first - r, base], [first - r, radius]);
    for (let i = 1; i <= 4; i++) {
      const a = Math.PI - i * Math.PI / 8;
      lower.push([first + r * Math.cos(a), radius + r * Math.sin(a)]);
    }
    if (first !== last) lower.push([last, radius + r]);
    for (let i = 1; i <= 4; i++) {
      const a = Math.PI / 2 - i * Math.PI / 8;
      lower.push([last + r * Math.cos(a), radius + r * Math.sin(a)]);
    }
    lower.push([last + r, base]);
  }
  lower.push([front, base]);
  const contour = [[front, top], [rear, top], ...lower];
  const triangles = THREE.ShapeUtils.triangulateShape(contour.map(([z, y]) => new THREE.Vector2(z, y)), []);
  const parts = [
    panel([[-halfW, top, front], [halfW, top, front], [halfW, top, rear], [-halfW, top, rear]], [0, 1, 0]),
    panel([[-halfW, base, front], [halfW, base, front], [halfW, top, front], [-halfW, top, front]], [0, 0, 1]),
    panel([[-halfW, base, rear], [halfW, base, rear], [halfW, top, rear], [-halfW, top, rear]], [0, 0, -1]),
  ];
  for (const side of [-1, 1]) {
    for (const triangle of triangles) parts.push(panel(triangle.map(i => [side * halfW, contour[i][1], contour[i][0]]), [side, 0, 0]));
  }
  return merge(parts);
}
const faceCylinder = (radius, depth, side, x, y, z, sides = 10) => new THREE.CylinderGeometry(radius, radius, depth, sides)
  .rotateZ(Math.PI / 2).translate(side * x, y, z);
const sideRect = (side, x, y, z, height, depth) => panel([
  [side * x, y - height / 2, z - depth / 2], [side * x, y - height / 2, z + depth / 2],
  [side * x, y + height / 2, z + depth / 2], [side * x, y + height / 2, z - depth / 2],
], [side, 0, 0]);
function faceDisc(radius, side, x, y, z, sides = 10) {
  return panel(Array.from({ length: sides }, (_, i) => {
    const a = i * 2 * Math.PI / sides;
    return [side * x, y + radius * Math.sin(a), z + radius * Math.cos(a)];
  }), [side, 0, 0]);
}
function faceRing(outer, inner, side, x, y, z, sides = 12) {
  const parts = [];
  const point = (r, a) => [side * x, y + r * Math.sin(a), z + r * Math.cos(a)];
  for (let i = 0; i < sides; i++) {
    const a = i * 2 * Math.PI / sides, b = (i + 1) * 2 * Math.PI / sides;
    parts.push(panel([point(outer, a), point(outer, b), point(inner, b), point(inner, a)], [side, 0, 0]));
  }
  return merge(parts);
}
function serviceHubs(spots, radius, width) {
  const parts = [];
  for (const [x, z] of spots) {
    const side = Math.sign(x), face = Math.abs(x) + width / 2 + 0.008, r = radius * 0.60;
    parts.push(faceRing(r, r * 0.88, side, face, radius, z));
    const point = (r, a) => [side * (face + 0.006), radius + r * Math.sin(a), z + r * Math.cos(a)];
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, b = a + Math.PI / 6;
      parts.push(panel([point(r * 0.88, a), point(r * 0.88, b), point(r * 0.30, b), point(r * 0.30, a)], [side, 0, 0]));
    }
    parts.push(faceCylinder(r * 0.34, 0.045, side, face + 0.013, radius, z, 8));
  }
  return merge(parts);
}


const AMB_CAB = [
  { z: 2.62, hw: 0.91, y0: 0.40, y1: 1.02 },
  { z: 2.41, hw: 0.99, y0: 0.34, y1: 1.12 },
  { z: 1.59, hw: 1.02, y0: 0.32, y1: 1.24 },
  { z: 1.39, hw: 1.035, y0: 0.32, y1: 1.90 },
  { z: 0.31, hw: 1.035, y0: 0.35, y1: 1.93 },
];
const AMB_AXLES = Object.freeze([1.92, -1.58]);
const AMB_WHEEL_Y = 0.40;
const AMB_SPOTS = AMB_AXLES.flatMap(z => [[1.035, z], [-1.035, z]]);
// Shared tire construction uses a larger vertex circumradius; nominal rolling
// radii remain the axle heights above the flat road-contact face.
export const AMBULANCE_WHEELS = Object.freeze({ axles: AMB_AXLES, y: AMB_WHEEL_Y, radius: AMB_WHEEL_Y });

function ambulanceGlass() {
  const za = 1.563, zb = 1.414;
  const a = sectionAt(AMB_CAB, za), b = sectionAt(AMB_CAB, zb);
  const parts = [panel([[-0.88, a.y1 + 0.01, za], [0.88, a.y1 + 0.01, za], [0.88, b.y1 + 0.01, zb], [-0.88, b.y1 + 0.01, zb]], [0, 1, 1])];
  for (const side of [-1, 1]) {
    parts.push(box(0.013, 0.49, 0.78, side * 1.045, 1.59, 0.895));
    parts.push(box(0.50, 0.43, 0.016, side * 0.425, 1.86, -2.616));
    parts.push(box(0.115, 0.17, 0.01, side * 1.183, 1.60, 1.170));
  }
  return merge(parts);
}
function ambulanceTrim() {
  const parts = [
    box(0.79, 0.36, 0.026, 0, 0.85, 2.638),
    box(1.25, 0.14, 4.75, 0, 0.29, 0),
    box(1.57, 0.035, 0.49, 0, 2.493, 0.09),
    // Rear patient doors have framed glass, a centre seal and separate handles.
    box(0.022, 1.83, 0.014, 0, 1.485, -2.624),
    box(1.83, 0.025, 0.014, 0, 2.392, -2.624),
    box(1.83, 0.025, 0.014, 0, 0.58, -2.624),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(0.02, 1.83, 0.014, side * 0.915, 1.485, -2.624));
    // Four thin window surrounds avoid a glass slab with no frame.
    for (const x of [side * 0.147, side * 0.703]) parts.push(box(0.023, 0.493, 0.016, x, 1.86, -2.624));
    for (const y of [1.615, 2.105]) parts.push(box(0.57, 0.023, 0.016, side * 0.425, y, -2.624));
    parts.push(box(0.019, 1.02, 0.017, side * 1.048, 0.985, 0.40));
    parts.push(box(0.016, 0.037, 0.19, side * 1.049, 1.264, 0.57));
    parts.push(box(0.15, 0.043, 0.055, side * 1.088, 1.55, 1.19));
    parts.push(box(0.17, 0.235, 0.14, side * 1.18, 1.60, 1.24));
    // Patient-module side door and lower storage compartment seams.
    parts.push(box(0.013, 1.76, 0.02, side * 1.163, 1.46, -0.04));
    parts.push(box(0.013, 0.022, 0.57, side * 1.163, 2.329, -0.315));
    parts.push(box(0.013, 1.76, 0.02, side * 1.163, 1.46, -0.60));
    parts.push(box(0.013, 0.03, 0.42, side * 1.166, 1.015, -0.30));
    // Small dark pockets give the lower rear lenses a shared, visible housing.
    parts.push(box(0.38, 0.20, 0.025, side * 0.85, 0.74, -2.637));
    parts.push(box(0.43, 0.20, 0.026, side * 0.69, 0.94, 2.632));
    // Mudflaps sit behind the rear tires and stop above the road.
    parts.push(box(0.34, 0.34, 0.035, side * 1.025, 0.31, -2.015));
  }
  return merge(parts);
}
function ambulanceEquipment() {
  const parts = [
    box(2.06, 0.155, 0.095, 0, 0.44, 2.65),
    box(2.21, 0.135, 0.17, 0, 0.43, -2.61),
    box(1.75, 0.08, 0.17, 0, 0.53, -2.61),
  ];
  for (const side of [-1, 1]) {
    // Separate cab steps do not run through either axle opening.
    parts.push(box(0.22, 0.08, 0.69, side * 1.07, 0.34, 0.89));
    parts.push(box(0.13, 0.055, 0.63, side * 1.095, 0.50, 0.89));
    parts.push(box(0.11, 0.055, 0.52, side * 1.172, 0.39, -0.32));
    parts.push(box(0.026, 0.45, 0.032, side * 1.192, 1.48, -0.46));
    parts.push(box(0.033, 0.30, 0.025, side * 0.095, 1.325, -2.646));
    // Grille ribs remain restrained; six rectangles suffice at this scale.
    for (const y of [0.735, 0.845, 0.955]) parts.push(box(0.35, 0.025, 0.012, side * 0.197, y, 2.658));
  }
  return merge(parts);
}
function ambulanceMarkings() {
  const parts = [];
  // A blue six-arm medical star is drawn entirely from geometry. White staffs
  // are included in the body buffer, above these pieces in the surface normal.
  for (const side of [-1, 1]) {
    for (const angle of [0, Math.PI / 3, -Math.PI / 3]) {
      parts.push(box(0.014, 0.66, 0.15, 0, 0, 0).rotateX(angle).translate(side * 1.170, 1.87, -1.53));
    }
  }
  return merge(parts);
}
export function buildAmbulanceGeometry() {
  const body = [shell(AMB_CAB, [AMB_AXLES[0]], AMB_WHEEL_Y), moduleShell(0.32, -2.60, 1.15, 0.37, 2.48, [[AMB_AXLES[1]]], AMB_WHEEL_Y)];
  for (const side of [-1, 1]) body.push(box(0.014, 0.36, 0.030, side * 1.184, 1.87, -1.53));
  return {
    body: merge(body),
    stripe: merge([
      box(0.014, 0.25, 2.88, 1.162, 1.16, -1.16),
      box(0.014, 0.25, 2.88, -1.162, 1.16, -1.16),
      box(2.27, 0.25, 0.014, 0, 1.16, -2.627),
    ]),
    glass: ambulanceGlass(), trim: ambulanceTrim(), equipment: ambulanceEquipment(), markings: ambulanceMarkings(),
    frontLens: merge([-1, 1].map(side => box(0.37, 0.155, 0.018, side * 0.69, 0.94, 2.653))),
    rearLens: merge([-1, 1].map(side => box(0.32, 0.15, 0.016, side * 0.85, 0.74, -2.655))),
    wheels: wheels(AMB_SPOTS, AMB_WHEEL_Y, 0.32), hubs: serviceHubs(AMB_SPOTS, AMB_WHEEL_Y, 0.32),
  };
}

const FIRE_CAB = [
  { z: 5.15, hw: 1.08, y0: 0.50, y1: 1.57 },
  { z: 5.10, hw: 1.21, y0: 0.35, y1: 2.94 },
  { z: 4.92, hw: 1.21, y0: 0.32, y1: 3.0 },
  { z: 0.68, hw: 1.21, y0: 0.32, y1: 3.0 },
  { z: 0.60, hw: 1.16, y0: 0.38, y1: 2.88 },
];
const FIRE_AXLES = Object.freeze([3.72, -3.18, -4.25]);
const FIRE_WHEEL_Y = 0.52;
const FIRE_SPOTS = FIRE_AXLES.flatMap(z => [[1.095, z], [-1.095, z]]);
export const FIRETRUCK_WHEELS = Object.freeze({ axles: FIRE_AXLES, y: FIRE_WHEEL_Y, radius: FIRE_WHEEL_Y });
const FIRE_COMPARTMENTS = [
  { z: -1.85, w: 1.20, bottom: 0.78, top: 2.61 },
  { z: -3.28, w: 1.28, bottom: 1.22, top: 2.61 },
  { z: -4.51, w: 0.96, bottom: 1.22, top: 2.61 },
];
function fireGlass() {
  const parts = [];
  // The broad windscreen lies on the cab's slightly raked front face.
  for (const side of [-1, 1]) {
    parts.push(panel([
      [side * 0.06, 1.93, 5.145], [side * 1.055, 1.93, 5.145],
      [side * 1.055, 2.76, 5.115], [side * 0.06, 2.76, 5.115],
    ], [0, 0, 1]));
    parts.push(box(0.015, 0.88, 1.62, side * 1.222, 2.30, 4.02));
    parts.push(box(0.015, 0.88, 1.24, side * 1.222, 2.30, 2.45));
    parts.push(box(0.155, 0.28, 0.012, side * 1.355, 2.30, 4.505));
  }
  return merge(parts);
}
function fireTrim() {
  const parts = [
    box(1.27, 0.22, 9.42, 0, 0.37, -0.13),
    box(1.32, 0.73, 0.020, 0, 1.29, 5.164),
    box(1.24, 0.075, 0.29, 0, 3.083, 3.65),
    box(1.75, 0.050, 4.97, 0, 2.946, -2.27),
    box(0.035, 1.93, 0.016, 0, 1.85, -5.149),
  ];
  for (const side of [-1, 1]) {
    // Cab door seams and window posts stop above/beside the front opening.
    parts.push(box(0.015, 2.10, 0.023, side * 1.226, 1.755, 3.03));
    parts.push(box(0.015, 2.06, 0.023, side * 1.226, 1.745, 1.70));
    parts.push(box(0.015, 0.038, 0.25, side * 1.23, 1.72, 3.17));
    parts.push(box(0.015, 0.038, 0.25, side * 1.23, 1.72, 1.84));
    parts.push(box(0.21, 0.05, 0.05, side * 1.28, 2.15, 4.57));
    parts.push(box(0.20, 0.36, 0.18, side * 1.355, 2.30, 4.60));
    parts.push(box(0.52, 0.56, 0.020, side * 0.84, 1.35, 5.178));
    parts.push(box(0.48, 0.59, 0.020, side * 0.90, 1.02, -5.169));
    // Compartments get independent frames rather than full-length strips
    // across all the doors. Above the tandem, the cabinets clear the tires.
    for (const c of FIRE_COMPARTMENTS) {
      const h = c.top - c.bottom;
      for (const z of [c.z - c.w / 2, c.z + c.w / 2]) parts.push(sideRect(side, 1.290, (c.top + c.bottom) / 2, z, h + 0.05, 0.028));
      for (const y of [c.bottom, c.top]) parts.push(sideRect(side, 1.290, y, c.z, 0.028, c.w));
    }
    // Pump controls, a coiled hose and three recessed gauge faces.
    parts.push(box(0.018, 1.61, 1.48, side * 1.278, 1.72, -0.37));
    for (const z of [0.10, -0.35, -0.80]) parts.push(faceDisc(0.059, side, 1.323, 2.24, z, 10));
    parts.push(new THREE.TorusGeometry(0.25, 0.041, 5, 12).rotateY(Math.PI / 2).translate(side * 1.322, 1.58, -0.34));
    for (const z of [0.05, -0.75]) parts.push(faceCylinder(0.062, 0.018, side, 1.36, 1.075, z, 8));
    // Rear mudflaps occupy just the rubber band behind the tandem.
    parts.push(box(0.35, 0.37, 0.035, side * 1.08, 0.35, -4.82));
    // One short wiper per windscreen keeps the front face legible.
    parts.push(box(0.40, 0.025, 0.015, 0, 0, 0).rotateZ(side * 0.14).translate(side * 0.55, 2.0, 5.15));
  }
  return merge(parts);
}
function fireEquipment() {
  const parts = [
    box(2.34, 0.21, 0.10, 0, 0.47, 5.20),
    box(2.46, 0.19, 0.10, 0, 0.47, -5.20),
    box(2.06, 0.07, 0.15, 0, 0.60, 5.15),
    box(2.20, 0.07, 0.15, 0, 0.60, -5.15),
    box(0.085, 0.105, 5.53, 0.54, 3.075, -2.13),
    box(0.085, 0.105, 5.53, -0.54, 3.075, -2.13),
  ];
  for (let z = -4.74; z < 0.55; z += 0.47) parts.push(box(1.02, 0.063, 0.065, 0, 3.075, z));
  for (const y of [1.015, 1.17, 1.325, 1.48, 1.635]) parts.push(box(1.24, 0.032, 0.015, 0, y, 5.180));
  for (const side of [-1, 1]) {
    for (const c of FIRE_COMPARTMENTS) {
      const h = c.top - c.bottom;
      parts.push(sideRect(side, 1.273, (c.top + c.bottom) / 2, c.z, h - 0.036, c.w - 0.04));
      // A handful of fine slats carry the roll-up-door texture at chase scale.
      for (let y = c.bottom + 0.21; y < c.top; y += 0.27) parts.push(sideRect(side, 1.289, y, c.z, 0.018, c.w - 0.07));
      parts.push(box(0.055, 0.038, 0.31, side * 1.293, c.bottom + 0.14, c.z));
    }
    // Pump panel borders, gauge rims/needles, hose couplings and valve grips.
    for (const z of [0.395, -1.13]) parts.push(box(0.020, 1.65, 0.033, side * 1.298, 1.72, z));
    for (const y of [0.90, 2.54]) parts.push(box(0.020, 0.033, 1.54, side * 1.298, y, -0.37));
    for (const z of [0.10, -0.35, -0.80]) {
      parts.push(faceRing(0.084, 0.061, side, 1.333, 2.24, z, 10));
      parts.push(box(0.012, 0.061, 0.008, 0, 0, 0).rotateX(0.45).translate(side * 1.336, 2.25, z));
    }
    for (const z of [0.05, -0.75]) {
      parts.push(faceCylinder(0.093, 0.085, side, 1.32, 1.075, z, 8));
      parts.push(box(0.022, 0.033, 0.21, side * 1.318, 1.235, z));
    }
    // Front and rear cab steps avoid the wheel arch, with small grab rails.
    for (const [z, depth] of [[4.67, 0.60], [2.41, 1.10]]) {
      parts.push(box(0.19, 0.08, depth, side * 1.22, 0.35, z));
      parts.push(box(0.13, 0.06, depth, side * 1.24, 0.55, z));
    }
    parts.push(box(0.032, 0.49, 0.035, side * 1.258, 1.45, 3.03));
    parts.push(box(0.032, 0.49, 0.035, side * 1.258, 1.45, 1.70));
    parts.push(box(0.032, 1.15, 0.027, side * 0.99, 1.94, -5.17));
  }
  return merge(parts);
}
export function buildFiretruckGeometry() {
  return {
    body: merge([shell(FIRE_CAB, [FIRE_AXLES[0]], FIRE_WHEEL_Y), moduleShell(0.66, -5.13, 1.25, 0.36, 2.91, [[FIRE_AXLES[2], FIRE_AXLES[1]]], FIRE_WHEEL_Y)]),
    stripe: merge([
      box(0.014, 0.22, 4.18, 1.223, 1.36, 2.86), box(0.014, 0.22, 4.18, -1.223, 1.36, 2.86),
      // The rear belts sit above the doors, keeping the equipment readable.
      box(0.014, 0.12, 5.66, 1.264, 2.78, -2.23), box(0.014, 0.12, 5.66, -1.264, 2.78, -2.23),
      box(2.47, 0.20, 0.014, 0, 1.36, -5.158),
    ]),
    glass: fireGlass(), trim: fireTrim(), equipment: fireEquipment(),
    frontLens: merge([-1, 1].map(side => box(0.36, 0.18, 0.020, side * 0.84, 1.50, 5.208))),
    rearLens: merge([-1, 1].map(side => box(0.42, 0.18, 0.020, side * 0.90, 0.88, -5.208))),
    indicators: merge([-1, 1].flatMap(side => [
      box(0.30, 0.12, 0.020, side * 0.84, 1.20, 5.208),
      box(0.42, 0.14, 0.020, side * 0.90, 1.16, -5.208),
    ])),
    wheels: wheels(FIRE_SPOTS, FIRE_WHEEL_Y, 0.36), hubs: serviceHubs(FIRE_SPOTS, FIRE_WHEEL_Y, 0.36),
  };
}
