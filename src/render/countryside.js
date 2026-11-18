// Static scenery in metres. Each farm's fields and buildings share one
// vertex-colored mesh with all the other farms, including in the largest layout.
import * as THREE from 'three';
import { merge, panel, box, painted } from './vehicle-geometry.js';

export function sceneryRandom(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// One convex gable at each end, two contrasting roof planes, and trim at
// architectural scale so the doors and eaves hold their shape at chase height.
function barn() {
  const red = 0xa94f3b,
    roof = 0x465858,
    trim = 0xe3cfa6;
  const parts = [painted(box(13, 5.5, 21, 0, 2.75, 0), red)];
  for (const side of [-1, 1]) {
    const z = side * 10.5;
    parts.push(
      painted(
        panel(
          [
            [-6.5, 5.5, z],
            [6.5, 5.5, z],
            [0, 10, z],
          ],
          [0, 0, side]
        ),
        red
      )
    );
    const x = side * 7.1;
    parts.push(
      painted(
        panel(
          [
            [0, 10.2, -11.1],
            [x, 5.2, -11.1],
            [x, 5.2, 11.1],
            [0, 10.2, 11.1],
          ],
          [side, 1, 0]
        ),
        roof
      )
    );
    parts.push(painted(box(5.8, 4.5, 0.16, 0, 2.25, z), trim));
    parts.push(painted(box(5.2, 4.2, 0.18, 0, 2.1, z + side * 0.1), 0x783f32));
    for (const angle of [-0.88, 0.88]) {
      parts.push(
        painted(
          new THREE.BoxGeometry(0.24, 6.3, 0.2).rotateZ(angle).translate(0, 2.1, z + side * 0.2),
          trim
        )
      );
    }
    parts.push(painted(box(1.8, 1.4, 0.14, 0, 6.9, z), trim));
    parts.push(painted(box(1.4, 1.05, 0.16, 0, 6.9, z + side * 0.06), roof));
  }
  const siloX = 12,
    siloZ = -4;
  parts.push(
    painted(new THREE.CylinderGeometry(3.5, 3.5, 13, 12).translate(siloX, 6.5, siloZ), 0xb4bbb1)
  );
  parts.push(painted(new THREE.ConeGeometry(3.85, 2.8, 12).translate(siloX, 14.4, siloZ), 0x6f8483));
  for (const y of [4, 8, 12.5]) {
    parts.push(
      painted(
        new THREE.CylinderGeometry(3.55, 3.55, 0.25, 12, 1, true).translate(siloX, y, siloZ),
        0x82928d
      )
    );
  }
  return merge(parts);
}

const CROPS = [
  [0xbda05e, 0xb29a59],
  [0x849253, 0x7e8b50],
  [0xa67d57, 0x9d7755],
];
// Adjacent strips share edges. A slight crown lifts the soil above the
// meadow. The angled ends give adjacent plots slightly different outlines.
function field(x, z, width, length, tones) {
  const positions = [],
    colors = [];
  const bands = Math.max(5, Math.round(width / 4));
  const cross = (i, end, edge = false) => {
    const t = i / bands;
    return [
      x + (t - 0.5) * width + end * 1.8,
      edge ? -0.2 : -0.2 + 0.58 * Math.sin(t * Math.PI),
      z + end * (length / 2 - 1.8 * t - (edge ? 0 : 2)),
    ];
  };
  for (let i = 0; i < bands; i++) {
    const a = cross(i, -1),
      b = cross(i, 1),
      c = cross(i + 1, 1),
      d = cross(i + 1, -1);
    const headA = cross(i, -1, true), headB = cross(i + 1, -1, true);
    const tailA = cross(i, 1, true), tailB = cross(i + 1, 1, true);
    const ink = new THREE.Color(tones[i % 2]);
    for (const point of [a, b, c, a, c, d, headA, a, d, headA, d, headB, b, tailA, tailB, b, tailB, c]) {
      positions.push(...point);
      colors.push(ink.r, ink.g, ink.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// Walk a jittered grid out from the infield. A circular reserve contains
// every rotated building and row, and keeps the existing trees and mounds
// from growing through them. A fixed budget bounds the work at 3× road scale.
export function buildFarms(bounds, clear, random) {
  const sites = [],
    hedges = [];
  const candidates = [];
  const nx = Math.ceil((bounds.halfX + 180) / 195);
  const nz = Math.ceil((bounds.halfZ + 180) / 175);
  for (let i = -nx; i <= nx; i++) {
    for (let j = -nz; j <= nz; j++) {
      const x = i * 195 + (random() - 0.5) * 82 - 21;
      const z = j * 175 + (random() - 0.5) * 72 - 12;
      candidates.push({ x, z, rank: x * x + z * z });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);
  const parts = [];
  let barnTemplate;
  for (const { x, z } of candidates) {
    const radius = 77;
    if (
      !clear(x, z, radius + 18, radius + 7) ||
      sites.some((site) => Math.hypot(site.x - x, site.z - z) < 2 * radius + 15)
    )
      continue;
    const n = sites.length;
    const group = [
      field(-19, -5, 45 + random() * 12, 65 + random() * 16, CROPS[n % 3]),
      field(27, -20, 28 + random() * 10, 39 + random() * 10, CROPS[(n + 1) % 3]),
    ];
    if (n % 3 === 0) {
      // A gravel yard ties the buildings to the field entrance. Its cool
      // stone reads differently from both tilled earth and standing grain.
      group.push(
        painted(
          panel(
            [
              [7, 0.09, 7],
              [8, 0.09, 43],
              [50, 0.09, 37],
              [45, 0.09, 9],
            ],
            [0, 1, 0]
          ),
          0x9e9781
        )
      );
      barnTemplate ??= barn();
      group.push(barnTemplate.clone().rotateY(0.35).translate(28, 0, 19));
      for (let k = 0; k < 3; k++) {
        group.push(
          painted(
            new THREE.CylinderGeometry(1.35, 1.35, 2.8, 8)
              .rotateZ(Math.PI / 2)
              .translate(11 + k * 3.4, 1.4, 36 - (k % 2) * 3),
            0xbc9854
          )
        );
      }
    } else {
      group.push(field(26, 21, 32, 25, CROPS[(n + 2) % 3]));
    }
    const yaw = (random() - 0.5) * 0.7 + (n % 2 ? 0.95 : -0.18);
    parts.push(merge(group).rotateY(yaw).translate(x, 0, z));
    sites.push({ x, z, radius });
    for (let j = 0; j < 6; j++) {
      const hx = -50 + random() * 2,
        hz = -36 + j * 12 + random() * 2;
      hedges.push([
        x + hx * Math.cos(yaw) + hz * Math.sin(yaw),
        z - hx * Math.sin(yaw) + hz * Math.cos(yaw),
      ]);
    }
    if (sites.length === 16) break;
  }
  barnTemplate?.dispose();
  const mesh = parts.length
    ? new THREE.Mesh(
        merge(parts),
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
      )
    : null;
  return { sites, mesh, hedges };
}

// Two closed, irregular ridgelines replace isolated cones on the horizon.
// Bake soft variations into the facets and progressively cooler colors
// into the distant range. The bases fade to the same haze as the ground.
export function ridgeGeometry(haze) {
  const positions = [],
    colors = [];
  const random = sceneryRandom(7462);
  const count = 84;
  for (let layer = 0; layer < 2; layer++) {
    const toe = [],
      crest = [],
      foot = [];
    const base = layer ? 3210 : 2400;
    const color = new THREE.Color(layer ? 0xb4c1bc : 0x829e94);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2,
        phase = layer * 2.3;
      const radial = (r, y, angle) => [r * Math.cos(angle), y, r * Math.sin(angle)];
      const h =
        (layer ? 310 : 145) +
        90 * Math.sin(3 * a + phase) +
        53 * Math.sin(7 * a - phase) +
        30 * Math.cos(11 * a + phase) +
        34 * random();
      toe.push(radial(base - 210 + 75 * Math.sin(5 * a), -35, a));
      crest.push(radial(base + 100 * Math.cos(4 * a + phase), h, a + 0.025 * random()));
      foot.push(radial(base - 110 + 45 * Math.cos(8 * a), h * (0.18 + 0.3 * random()), a + 0.018));
    }
    const facet = (a, b, c, value) => {
      for (const v of [a, b, c]) {
        positions.push(...v);
        const ink = color.clone().multiplyScalar(value);
        ink.lerp(haze, THREE.MathUtils.clamp((45 - v[1]) / 45, 0, 1));
        colors.push(ink.r, ink.g, ink.b);
      }
    };
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const light = 0.98 + 0.045 * Math.cos(i * 0.73 + layer);
      facet(toe[i], toe[j], foot[i], light * 0.95);
      facet(toe[j], foot[j], foot[i], light * 0.96);
      facet(foot[i], foot[j], crest[i], light);
      facet(foot[j], crest[j], crest[i], light * 1.045);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}
