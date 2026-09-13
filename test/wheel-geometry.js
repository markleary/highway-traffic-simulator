import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildPassengerWheels, PASSENGER_WHEELS } from '../src/render/passenger.js';
import { buildCybertruckGeometry, CYBERTRUCK_WHEELS } from '../src/render/cybertruck.js';
import { buildEVGeometry, EV_WHEELS } from '../src/render/ev.js';
import { buildPoliceGeometry, POLICE_WHEELS } from '../src/render/police.js';
import { buildSemiGeometry, SEMI_WHEELS } from '../src/render/semi.js';
import { buildAmbulanceGeometry, AMBULANCE_WHEELS, buildFiretruckGeometry, FIRETRUCK_WHEELS } from '../src/render/service-vehicles.js';
import { annotateRollingGeometry, makeWheelMaterial } from '../src/render/wheel-material.js';

const MODELS = [
  ['passenger', buildPassengerWheels, PASSENGER_WHEELS],
  ['cybertruck', buildCybertruckGeometry, CYBERTRUCK_WHEELS],
  ['ev', buildEVGeometry, EV_WHEELS],
  ['police', buildPoliceGeometry, POLICE_WHEELS],
  ['semi', buildSemiGeometry, SEMI_WHEELS],
  ['ambulance', buildAmbulanceGeometry, AMBULANCE_WHEELS],
  ['firetruck', buildFiretruckGeometry, FIRETRUCK_WHEELS],
];
const EPS = 2e-6;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const near = (a, b, label, epsilon = EPS) => assert.ok(Math.abs(a - b) <= epsilon, `${label}: expected ${b}, got ${a}`);
const records = [];
let checkedVertices = 0;

for (const [name, build, layout] of MODELS) {
  assert.ok(Object.isFrozen(layout) && Object.isFrozen(layout.axles), `${name}: immutable layout`);
  assert.ok(layout.radius > 0 && Number.isFinite(layout.radius), `${name}: physical rolling radius`);
  const parts = build();
  const modelExtents = layout.axles.map(() => new THREE.Box3());
  for (const part of ['wheels', 'hubs']) {
    const geometry = parts[part];
    const position = geometry.getAttribute('position');
    const originalPositions = position.array.slice();
    const originalNormals = geometry.getAttribute('normal').array.slice();
    assert.equal(annotateRollingGeometry(geometry, layout), geometry);
    assert.deepEqual(position.array, originalPositions, `${name}/${part}: annotation preserves authored vertices`);
    assert.deepEqual(geometry.getAttribute('normal').array, originalNormals, `${name}/${part}: annotation preserves authored normals`);
    const pivot = geometry.getAttribute('wheelPivot');
    assert.equal(pivot.itemSize, 2);
    assert.equal(pivot.count, position.count);
    const box = geometry.boundingBox, sphere = geometry.boundingSphere;
    const assignments = [];
    const bottom = new Map();
    for (let vertex = 0; vertex < position.count; vertex++) {
      const p = new THREE.Vector3().fromBufferAttribute(position, vertex);
      assert.ok([p.x, p.y, p.z].every(Number.isFinite), `${name}/${part}: finite source point`);
      near(pivot.getX(vertex), layout.y, `${name}/${part}: declared axle height`);
      const axle = layout.axles.findIndex(z => Math.abs(z - pivot.getY(vertex)) <= EPS);
      assert.notEqual(axle, -1, `${name}/${part}: every pivot belongs to a declared axle`);
      const center = new THREE.Vector3(p.x, pivot.getX(vertex), pivot.getY(vertex));
      const radius = p.distanceTo(center);
      assert.ok(radius <= layout.radius * 1.15, `${name}/${part}: vertex belongs to this wheel, not adjacent bodywork`);
      assignments.push(axle);
      modelExtents[axle].expandByPoint(p);

      // Independent full-revolution envelope: every point traces a circle in
      // its own axle plane. Its exact extrema must stay within the CPU bounds,
      // including the sphere used by Three for culling. No angle sampling can
      // accidentally miss a facet's furthest position between display frames.
      assert.ok(p.x >= box.min.x - EPS && p.x <= box.max.x + EPS, `${name}/${part}: unchanged lateral bounds`);
      assert.ok(center.y - radius >= box.min.y - EPS && center.y + radius <= box.max.y + EPS, `${name}/${part}: full-turn vertical bounds`);
      assert.ok(center.z - radius >= box.min.z - EPS && center.z + radius <= box.max.z + EPS, `${name}/${part}: full-turn longitudinal bounds`);
      const farthestFromSphereCenter = Math.hypot(
        p.x - sphere.center.x,
        Math.hypot(center.y - sphere.center.y, center.z - sphere.center.z) + radius,
      );
      assert.ok(farthestFromSphereCenter <= sphere.radius + EPS, `${name}/${part}: full-turn sphere encloses every vertex`);

      // Three's rotation is the reference here, separate from the GLSL helper.
      const originalRelative = p.clone().sub(center);
      const rotated = originalRelative.clone().applyAxisAngle(X_AXIS, Math.PI / 7).add(center);
      near(rotated.x, p.x, `${name}/${part}: spin cannot change track width`);
      near(rotated.distanceTo(center), radius, `${name}/${part}: rigid wheel radius`);
      const completeTurn = originalRelative.clone().applyAxisAngle(X_AXIS, Math.PI * 2).add(center);
      assert.ok(completeTurn.distanceTo(p) < EPS, `${name}/${part}: complete turn restores the original vertex`);
      if (part === 'wheels') {
        const key = `${axle}:${Math.sign(p.x)}`;
        if (!bottom.has(key) || p.y < bottom.get(key).point.y) bottom.set(key, { point: p, center });
      }
      checkedVertices++;
    }
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    assert.equal(count % 3, 0, `${name}/${part}: complete triangle buffer`);
    for (let i = 0; i < count; i += 3) {
      const a = assignments[index ? index.getX(i) : i];
      assert.equal(assignments[index ? index.getX(i + 1) : i + 1], a, `${name}/${part}: triangle remains on a single axle`);
      assert.equal(assignments[index ? index.getX(i + 2) : i + 2], a, `${name}/${part}: triangle remains on a single axle`);
    }
    if (part === 'wheels') {
      assert.equal(bottom.size, layout.axles.length * 2, `${name}: both sides exist at every axle, including tandems`);
      for (const { point, center } of bottom.values()) {
        assert.ok(point.y < center.y, `${name}: fixture selects bottom tread`);
        const turned = point.clone().sub(center).applyAxisAngle(X_AXIS, 0.001).add(center);
        assert.ok(turned.z < point.z, `${name}: positive X rotation moves bottom tread backward for forward +z travel on both sides`);
        near(turned.x, point.x, `${name}: left and right tread retain their lateral coordinates`);
      }
    }
    records.push({ name, part, geometry, layout });
  }
  // Declared pivots must match the actual geometry, not merely point to a
  // plausible axle. This catches a centre copied from another tire profile.
  modelExtents.forEach((extent, axle) => {
    near((extent.min.y + extent.max.y) / 2, layout.y, `${name}: geometric vertical centre`);
    near((extent.min.z + extent.max.z) / 2, layout.axles[axle], `${name}: geometric axle centre`);
  });
  for (const [part, geometry] of Object.entries(parts)) {
    if (part !== 'wheels' && part !== 'hubs') geometry.dispose();
  }
}

// Regressions caused by wrong geometry grouping must fail loudly, including
// indexed triangles. Build this invalid face from actual front/rear tire
// vertices rather than an oversized synthetic slab.
const fixture = records.find(record => record.name === 'firetruck' && record.part === 'wheels');
const fixturePos = fixture.geometry.getAttribute('position');
const fixturePivot = fixture.geometry.getAttribute('wheelPivot');
const front = [], rear = [];
for (let i = 0; i < fixturePos.count && (front.length < 2 || rear.length < 1); i++) {
  const candidates = Math.abs(fixturePivot.getY(i) - fixture.layout.axles[0]) < EPS ? front : rear;
  if (candidates.length < (candidates === front ? 2 : 1)) candidates.push(new THREE.Vector3().fromBufferAttribute(fixturePos, i));
}
const crossed = new THREE.BufferGeometry().setFromPoints([...front, ...rear]);
crossed.setIndex([0, 1, 2]);
assert.throws(() => annotateRollingGeometry(crossed, fixture.layout), /triangle spans multiple axles/);
crossed.dispose();
const wrongPivot = fixture.geometry.clone();
assert.throws(() => annotateRollingGeometry(wrongPivot, { ...fixture.layout, y: fixture.layout.y + 3 }), /outside its axle/);
wrongPivot.dispose();

// Exercise the patch against the installed Three shader, so renamed or moved
// chunks cannot silently leave rotating positions with unrotated lighting.
const base = new THREE.MeshStandardMaterial({
  color: 0x516273, roughness: 0.81, metalness: 0.27,
  flatShading: true, vertexColors: true, side: THREE.DoubleSide,
  transparent: true, opacity: 0.87, fog: false,
});
base.defines = { ...base.defines, EXISTING_DEFINE: 1 };
let previousHookThis, previousHookRenderer;
base.onBeforeCompile = function (shader, renderer) {
  previousHookThis = this;
  previousHookRenderer = renderer;
  shader.uniforms.existingUniform = { value: 42 };
  shader.vertexShader = `// previous material hook\n${shader.vertexShader}`;
};
base.customProgramCacheKey = () => 'existing-wheel-livery-v2';
const originalHook = base.onBeforeCompile, originalCache = base.customProgramCacheKey;
const originalColor = base.color.clone();
const wheel = makeWheelMaterial(base);
assert.notEqual(wheel, base);
assert.notEqual(wheel.color, base.color);
for (const key of ['roughness', 'metalness', 'flatShading', 'vertexColors', 'side', 'transparent', 'opacity', 'fog']) {
  assert.equal(wheel[key], base[key], `rolling material retains ${key}`);
}
assert.deepEqual(wheel.defines, base.defines);
assert.ok(wheel.color.equals(base.color));
assert.notEqual(wheel.customProgramCacheKey(), base.customProgramCacheKey(), 'patched and ordinary materials cannot share a shader program');
assert.ok(wheel.customProgramCacheKey().startsWith(base.customProgramCacheKey()), 'existing material cache identity survives');
const vertexSource = THREE.ShaderLib.standard.vertexShader;
const fragmentSource = THREE.ShaderLib.standard.fragmentShader;
const shader = { vertexShader: vertexSource, fragmentShader: fragmentSource, uniforms: {} };
const rendererToken = {};
wheel.onBeforeCompile(shader, rendererToken);
assert.equal(previousHookThis, wheel, 'existing compile hook receives the new material');
assert.equal(previousHookRenderer, rendererToken);
assert.equal(shader.uniforms.existingUniform.value, 42);
assert.ok(shader.vertexShader.startsWith('// previous material hook'));
assert.equal(shader.fragmentShader, fragmentSource, 'lighting/material fragment shader is untouched');
const source = shader.vertexShader;
for (const declaration of ['attribute vec2 wheelPivot;', 'attribute float wheelAngle;']) {
  assert.equal(source.split(declaration).length - 1, 1, 'each GPU attribute is declared exactly once');
}
assert.match(source, /objectNormal\.yz\s*=\s*rotateWheelYZ\(/, 'normals rotate with the tire');
assert.match(source, /objectTangent\.yz\s*=\s*rotateWheelYZ\(/, 'tangents rotate when supplied');
assert.match(source, /transformed\.yz\s*=\s*wheelPivot\s*\+\s*rotateWheelYZ\(\s*transformed\.yz\s*-\s*wheelPivot/, 'positions rotate around their own axle');
assert.match(source, /rotation\.x\s*\*\s*point\.x\s*-\s*rotation\.y\s*\*\s*point\.y[\s\S]*rotation\.y\s*\*\s*point\.x\s*\+\s*rotation\.x\s*\*\s*point\.y/, 'GLSL uses the same positive X convention proven on the actual tread');
const normalSpin = source.indexOf('objectNormal.yz ='), positionSpin = source.indexOf('transformed.yz =');
assert.ok(normalSpin > source.indexOf('#include <beginnormal_vertex>') && normalSpin < source.indexOf('#include <defaultnormal_vertex>'), 'normal spin occurs before instancing/world transforms');
assert.ok(positionSpin > source.indexOf('#include <begin_vertex>') && positionSpin < source.indexOf('#include <project_vertex>'), 'position spin occurs before projection and instance transform');
assert.equal(base.onBeforeCompile, originalHook);
assert.equal(base.customProgramCacheKey, originalCache);
assert.ok(base.color.equals(originalColor));
assert.equal(base.customProgramCacheKey(), 'existing-wheel-livery-v2');
wheel.color.set(0xffffff);
assert.ok(base.color.equals(originalColor), 'changing the rolling clone cannot recolor static trim using the base material');
assert.throws(() => wheel.onBeforeCompile({ vertexShader: 'void main() {}', uniforms: {} }, rendererToken), /requires the Three.js/);
for (const { geometry } of records) geometry.dispose();
wheel.dispose();
base.dispose();
console.log(`Wheel geometry: ${MODELS.length} layouts, ${checkedVertices} tire/hub vertices, complete-turn bounds, axle grouping, forward rotation and shader/material checks passed.`);
