import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ROAD, SHAPES, pointAt, setShape } from '../src/sim/road.js';
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
console.log('Pavement geometry passed for all five loops at minimum and maximum lane counts.');
