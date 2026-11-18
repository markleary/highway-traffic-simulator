import assert from 'node:assert/strict';
import { Scene, MeshStandardMaterial, Object3D, PerspectiveCamera, Texture, Vector3 } from 'three';
import { ROAD, SHAPES, pointAt, setShape } from '../src/sim/road.js';
import { params } from '../src/params.js';
import { SceneRenderer } from '../src/render/renderer.js';
import { pavementGeometry } from '../src/render/road-finish.js';

// The batched surface is single-sided. Reversing its index order makes the
// road disappear from above even though all headless traffic still moves.
const vertex = new Vector3();
for (const shape of Object.keys(SHAPES)) {
  setShape(shape, 1);
  for (const lanes of [2, 4]) {
    const road = pavementGeometry(lanes);
    const { position, normal } = road.attributes;
    const outer = pointAt(0, ROAD.laneWidth / 2 + ROAD.shoulderWidth);
    const inner = pointAt(0, ROAD.laneWidth / 2 - lanes * ROAD.laneWidth - 1);
    let outerEnds = 0, innerEnds = 0, peak = 0;
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i);
      assert.ok(normal.getY(i) > 0.99, shape + ' has upward-facing pavement');
      if (vertex.distanceTo(outer) < 0.001) outerEnds++;
      if (vertex.distanceTo(inner) < 0.001) innerEnds++;
      peak = Math.max(peak, vertex.y);
    }
    assert.equal(outerEnds, 2, 'both seam stations reach the breakdown shoulder');
    assert.equal(innerEnds, 2, 'both seam stations reach the inner apron');
    assert.ok(Math.abs(peak - (shape === 'eight' ? 6.5 : 0)) < 0.02, 'pavement follows the bridge profile');
    road.dispose();
  }
}
// The live Lanes slider rebuilds the road alone. Measure the physical verge
// posts after that exact entry point, including a return to the narrower road.
setShape('circle');
const renderer = Object.assign(Object.create(SceneRenderer.prototype), {
  scene: new Scene(), camera: new PerspectiveCamera(), controls: {}, skyDome: new Object3D(),
  signAtlas: new Texture(), asphaltMat: new MeshStandardMaterial(),
  viewFit: () => ({ h: 800 }), applyWeather: () => {},
});
for (const lanes of [2, 4, 2]) {
  params.lanes = lanes;
  renderer.buildRoad();
  let minRadius = Infinity;
  renderer.scene.traverse(obj => {
    const pos = obj.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0.45) minRadius = Math.min(minRadius, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
  });
  const innerEdge = pointAt(0, ROAD.laneWidth / 2 - lanes * ROAD.laneWidth).length();
  assert.ok(minRadius < innerEdge && minRadius >= innerEdge - 1,
    'median fixtures follow the live lane count and sit within the one-metre apron');
}
console.log('Pavement geometry and live median fixture placement passed.');
