// Station colors describe the actual pavement, shoulder, and the smoother
// wheel paths. A single opaque surface follows the bridge grade and the seam.
import * as THREE from 'three';
import { ROAD, LOOP, pointAt, forwardAt, forwardDist, elevAt } from '../sim/road.js';
import { merge, panel, painted } from './vehicle-geometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function pavementGeometry(lanes) {
  const half = ROAD.laneWidth / 2;
  const bands = [
    [half + ROAD.shoulderWidth, 0x534f48],
    [half + ROAD.shoulderWidth - 0.4, 0x434649],
    [half + 0.08, 0x414447],
    [half, 0x484b4d],
  ];
  for (let lane = 0; lane < lanes; lane++) {
    const center = -lane * ROAD.laneWidth;
    bands.push(
      [center + 0.78, 0x404447],
      [center, 0x484b4d],
      [center - 0.78, 0x404447],
      [center - half, 0x484b4d]
    );
  }
  const inner = half - lanes * ROAD.laneWidth;
  bands.push([inner - 0.1, 0x414447], [inner - 1, 0x4b4945]);
  const shades = bands.map(([, hex]) => new THREE.Color(hex));
  const steps = Math.ceil(LOOP / 4);
  const positions = [],
    colors = [],
    indices = [];
  const p = new THREE.Vector3();
  const stride = bands.length;
  for (let i = 0; i <= steps; i++) {
    const s = ((i % steps) * LOOP) / steps;
    const shade = 1 + 0.034 * Math.cos(((i % steps) / steps) * Math.PI * 38);
    for (let j = 0; j < stride; j++) {
      pointAt(s, bands[j][0], p);
      positions.push(p.x, p.y, p.z);
      const c = shades[j];
      colors.push(c.r * shade, c.g * shade, c.b * shade);
      if (i < steps && j + 1 < stride) {
        const k = i * stride + j;
        indices.push(k, k + stride, k + 1, k + 1, k + stride, k + stride + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// One small mipmapped atlas serves all four possible junction letters. The
// backs and posts are dimensional so the signs read from both approaches.
export function exitAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < 4; i++) {
    const y = i * 128;
    ctx.fillStyle = '#21554c';
    ctx.fillRect(0, y, 256, 128);
    ctx.strokeStyle = ctx.fillStyle = '#fff4ce';
    ctx.lineWidth = 4;
    ctx.strokeRect(7, y + 7, 242, 114);
    ctx.font = 'bold 35px system-ui, sans-serif';
    ctx.fillText('EXIT', 21, y + 52);
    ctx.font = 'bold 61px system-ui, sans-serif';
    ctx.fillText('ABCD'[i], 21, y + 108);
    ctx.beginPath();
    ctx.moveTo(152, y + 87);
    ctx.lineTo(203, y + 36);
    ctx.moveTo(165, y + 36);
    ctx.lineTo(203, y + 36);
    ctx.lineTo(203, y + 74);
    ctx.lineWidth = 12;
    ctx.stroke();
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

// Rail runs guard the elevated span and the inside verge opposite exits. A
// folded profile catches the sun along its length without a separate material.
function medianFixtures(ramps, lanes) {
  const parts = [];
  const inner = ROAD.laneWidth / 2 - lanes * ROAD.laneWidth - 0.72;
  const count = Math.ceil(LOOP / 5);
  const exits = ramps.filter((ramp) => ramp.type === 'off');
  for (let i = 0; i < count; i++) {
    const s = (i * LOOP) / count;
    const dir = forwardAt(s);
    const yaw = Math.atan2(dir.x, dir.z);
    const p = pointAt(s, inner);
    const rail = elevAt(s) > 1.8 || exits.some((ramp) => forwardDist(ramp.sDiverge - 40, s) < 65);
    if (rail) {
      const next = pointAt(((i + 1) * LOOP) / count, inner);
      const nx = -dir.z,
        nz = dir.x;
      const point = (v, y, width) => [v.x + nx * width, v.y + y, v.z + nz * width];
      for (const [low, high, lip, color] of [
        [0.49, 0.67, 0.09, 0x788986],
        [0.67, 0.85, -0.09, 0xb1b9ad],
      ]) {
        parts.push(
          painted(
            panel(
              [point(p, low, lip), point(next, low, lip), point(next, high, -lip), point(p, high, -lip)],
              [nx, 0, nz]
            ),
            color
          )
        );
      }
      parts.push(
        painted(
          new THREE.BoxGeometry(0.14, 0.88, 0.2)
            .rotateY(yaw)
            .translate(p.x - nx * 0.13, p.y + 0.31, p.z - nz * 0.13),
          0x7a8077
        )
      );
    } else if (i % 8 === 0) {
      parts.push(
        painted(
          new THREE.BoxGeometry(0.16, 0.98, 0.14).rotateY(yaw).translate(p.x, p.y + 0.38, p.z),
          0xc5c7ad
        )
      );
      parts.push(
        painted(
          new THREE.BoxGeometry(0.17, 0.19, 0.15).rotateY(yaw).translate(p.x, p.y + 0.79, p.z),
          0xe2af50
        )
      );
    }
  }
  return parts;
}

export function roadsideFixtures(ramps, lanes, atlas) {
  const fixtures = medianFixtures(ramps, lanes),
    faces = [];
  for (const ramp of ramps) {
    if (ramp.type !== 'off') continue;
    const s = ramp.sDiverge - 12;
    const pos = pointAt(s, ROAD.laneWidth / 2 + ROAD.shoulderWidth + 3.8);
    const dir = forwardAt(s);
    const yaw = Math.atan2(-dir.x, -dir.z);
    const place = (g) => g.rotateY(yaw).translate(pos.x, pos.y, pos.z);
    for (const x of [-1.35, 1.35]) {
      fixtures.push(
        painted(place(new THREE.BoxGeometry(0.17, 4.85, 0.17).translate(x, 2.32, -0.15)), 0x818e8c)
      );
    }
    fixtures.push(painted(place(new THREE.BoxGeometry(4.8, 2.4, 0.13).translate(0, 4.25, 0)), 0x879693));
    const face = new THREE.PlaneGeometry(4.77, 2.37);
    const uv = face.attributes.uv;
    const letter = 'ABCD'.indexOf(ramp.id.at(-1));
    for (let i = 0; i < uv.count; i++) uv.setY(i, (3 - letter + 0.01 + uv.getY(i) * 0.98) / 4);
    faces.push(place(face.translate(0, 4.25, 0.072)));
  }
  const group = new THREE.Group();
  group.add(
    new THREE.Mesh(
      merge(fixtures),
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
    ),
    new THREE.Mesh(
      mergeGeometries(faces),
      new THREE.MeshBasicMaterial({
        map: atlas,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      })
    )
  );
  return group;
}
