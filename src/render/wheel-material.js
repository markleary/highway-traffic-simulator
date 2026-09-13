import * as THREE from 'three';

// One geometry can contain every wheel on a vehicle: vertices carry their
// axle's local (y,z) pivot while wheelAngle is supplied once per car instance.
// Both sides share the same +x rotation, so forward +z travel moves the bottom
// tread backwards. Rotation happens before the car's instance yaw and pitch.
export function annotateRollingGeometry(geometry, layout) {
  const position = geometry?.getAttribute?.('position');
  const axles = layout?.axles;
  const y = layout?.y;
  const radius = layout?.radius;
  if (!position || position.itemSize !== 3 || position.count === 0) {
    throw new TypeError('Rolling geometry requires nonempty three-component positions.');
  }
  if (!Array.isArray(axles) || axles.length === 0 || !axles.every(Number.isFinite)
    || !Number.isFinite(y) || !Number.isFinite(radius) || radius <= 0) {
    throw new TypeError('Wheel layout requires finite axles, centre height and positive radius.');
  }
  const tolerance = Math.max(1, radius) * 1e-5;
  for (let i = 0; i < axles.length; i++) {
    for (let j = i + 1; j < axles.length; j++) {
      if (Math.abs(axles[i] - axles[j]) <= tolerance) {
        throw new RangeError('Wheel layout contains duplicate axle positions.');
      }
    }
  }

  const pivots = new Float32Array(position.count * 2);
  const axleForVertex = new Uint32Array(position.count);
  // Twelve-sided contact patches and beveled rims extend slightly beyond the
  // nominal rolling radius. A generous geometric allowance accepts those
  // facets while catching a body/chassis buffer or a mistyped axle layout.
  const radialLimit = radius * 1.15 + tolerance;
  let maximumRadius = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const px = position.getX(vertex), py = position.getY(vertex), pz = position.getZ(vertex);
    if (![px, py, pz].every(Number.isFinite)) {
      throw new RangeError(`Wheel vertex ${vertex} is not finite.`);
    }
    let nearest = 0, distance = Infinity, secondDistance = Infinity;
    for (let axle = 0; axle < axles.length; axle++) {
      const candidate = Math.abs(pz - axles[axle]);
      if (candidate < distance) {
        secondDistance = distance;
        distance = candidate;
        nearest = axle;
      } else {
        secondDistance = Math.min(secondDistance, candidate);
      }
    }
    if (secondDistance - distance <= tolerance) {
      throw new RangeError(`Wheel vertex ${vertex} is ambiguous between axles.`);
    }
    const radialDistance = Math.hypot(py - y, pz - axles[nearest]);
    if (radialDistance > radialLimit) {
      throw new RangeError(`Wheel vertex ${vertex} lies outside its axle's rolling radius.`);
    }
    maximumRadius = Math.max(maximumRadius, radialDistance);
    pivots[vertex * 2] = y;
    pivots[vertex * 2 + 1] = axles[nearest];
    axleForVertex[vertex] = nearest;
  }

  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  if (count % 3 !== 0) throw new RangeError('Rolling geometry must contain complete triangles.');
  for (let triangle = 0; triangle < count; triangle += 3) {
    const a = index ? index.getX(triangle) : triangle;
    const b = index ? index.getX(triangle + 1) : triangle + 1;
    const c = index ? index.getX(triangle + 2) : triangle + 2;
    if (axleForVertex[a] !== axleForVertex[b] || axleForVertex[a] !== axleForVertex[c]) {
      throw new RangeError('A rolling triangle spans multiple axles.');
    }
  }

  geometry.setAttribute('wheelPivot', new THREE.BufferAttribute(pivots, 2));
  // Vertex shaders do not update CPU bounds. Enclose a complete revolution so
  // ordinary mesh culling remains valid as well as the current uncullable
  // vehicle pools. Bounds include the original x extent unchanged.
  geometry.computeBoundingBox();
  geometry.boundingBox.min.y = y - maximumRadius;
  geometry.boundingBox.max.y = y + maximumRadius;
  geometry.boundingBox.min.z = Math.min(...axles) - maximumRadius;
  geometry.boundingBox.max.z = Math.max(...axles) + maximumRadius;
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geometry;
}

const DECLARATIONS = /* glsl */`
attribute vec2 wheelPivot;
attribute float wheelAngle;
vec2 rotateWheelYZ( const vec2 point, const vec2 rotation ) {
  return vec2(
    rotation.x * point.x - rotation.y * point.y,
    rotation.y * point.x + rotation.x * point.y
  );
}
`;

const ROTATE_NORMAL = /* glsl */`
vec2 wheelRotation = vec2( cos( wheelAngle ), sin( wheelAngle ) );
objectNormal.yz = rotateWheelYZ( objectNormal.yz, wheelRotation );
#ifdef USE_TANGENT
  objectTangent.yz = rotateWheelYZ( objectTangent.yz, wheelRotation );
#endif
`;

const ROTATE_POSITION = /* glsl */`
transformed.yz = wheelPivot + rotateWheelYZ( transformed.yz - wheelPivot, wheelRotation );
`;

// Preserve Standard/Physical material settings and any existing compile hook.
// These providers are static geometry: they do not contain skinning or morphs.
// The r170 normal and position chunks remain intact, including instancing,
// lights, fog and color attributes. No additional wheel draw calls are needed.
export function makeWheelMaterial(baseMaterial) {
  if (!baseMaterial?.isMeshStandardMaterial) {
    throw new TypeError('Rolling wheels require a MeshStandardMaterial or MeshPhysicalMaterial.');
  }
  const material = baseMaterial.clone();
  // StandardMaterial.copy() restores only its built-in define in r170.
  material.defines = { ...baseMaterial.defines };
  const originalCompile = baseMaterial.onBeforeCompile;
  const originalCacheKey = baseMaterial.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    originalCompile.call(this, shader, renderer);
    for (const chunk of ['common', 'beginnormal_vertex', 'begin_vertex']) {
      if (!shader.vertexShader.includes(`#include <${chunk}>`)) {
        throw new Error(`Rolling material requires the Three.js ${chunk} shader chunk.`);
      }
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DECLARATIONS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${ROTATE_NORMAL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROTATE_POSITION}`);
  };
  material.customProgramCacheKey = () => `${originalCacheKey}|traffic-wheel-rotation-v1`;
  return material;
}
