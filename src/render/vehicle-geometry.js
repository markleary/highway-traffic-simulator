import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural parts share metres, a road-level origin, and +z forward. These
// buffers contain presentation only; vehicle footprints remain simulation data.
export const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

export function merge(parts) {
  const normalized = parts.map(g => {
    const out = g.index ? g.toNonIndexed() : g;
    out.deleteAttribute('uv');
    return out;
  });
  const out = mergeGeometries(normalized);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  for (const g of new Set([...normalized, ...parts])) g.dispose();
  return out;
}

export function panel(points, outward) {
  const vertices = [];
  const normal = new THREE.Vector3(...outward);
  for (let i = 1; i < points.length - 1; i++) {
    const a = new THREE.Vector3(...points[i]).sub(new THREE.Vector3(...points[0]));
    const b = new THREE.Vector3(...points[i + 1]).sub(new THREE.Vector3(...points[0]));
    vertices.push(...(a.cross(b).dot(normal) < 0
      ? [points[0], points[i + 1], points[i]] : [points[0], points[i], points[i + 1]]).flat());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.computeVertexNormals();
  return g;
}

export function sectionAt(sections, z) {
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    if (z >= b.z) {
      const t = THREE.MathUtils.clamp((z - a.z) / (b.z - a.z), 0, 1);
      return { hw: THREE.MathUtils.lerp(a.hw, b.hw, t),
        y0: THREE.MathUtils.lerp(a.y0, b.y0, t), y1: THREE.MathUtils.lerp(a.y1, b.y1, t) };
    }
  }
  return sections.at(-1);
}

// Split the side at profile and arch stations so each facet follows the local
// body width. A single triangulated polygon would bridge width changes and
// cut through the cabin windows. Overlapping tandem arches share one opening.
export function shell(sections, axles = [], wheelRadius = 0.34) {
  const parts = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    parts.push(panel([[-a.hw,a.y1,a.z],[a.hw,a.y1,a.z],[b.hw,b.y1,b.z],[-b.hw,b.y1,b.z]], [0,1,0]));
  }
  for (const [s, normal] of [[sections[0], [0,0,1]], [sections.at(-1), [0,0,-1]]]) {
    parts.push(panel([[-s.hw,s.y0,s.z],[s.hw,s.y0,s.z],[s.hw,s.y1,s.z],[-s.hw,s.y1,s.z]], normal));
  }
  const radius = wheelRadius + 0.08;
  const samples = sections.map(s => s.z);
  for (const z of axles) {
    samples.push(z-radius-.00001,z+radius+.00001);
    for (let i=0;i<=8;i++) samples.push(z + radius*Math.cos(i*Math.PI/8));
  }
  const sortedAxles = [...axles].sort((a,b)=>a-b);
  for (let i=1;i<sortedAxles.length;i++) samples.push((sortedAxles[i-1]+sortedAxles[i])/2);
  const stations = [...new Set(samples)].filter(z=>z<=sections[0].z&&z>=sections.at(-1).z).sort((a,b)=>b-a);
  const bottom = (z, s) => Math.max(s.y0,...axles.map(axle => {
    const d=Math.abs(z-axle);
    return d<=radius ? wheelRadius + Math.sqrt(Math.max(0,radius*radius-d*d)) : s.y0;
  }));
  for (let i=0;i<stations.length-1;i++) {
    const za=stations[i],zb=stations[i+1],a=sectionAt(sections,za),b=sectionAt(sections,zb);
    for (const side of [-1,1]) parts.push(panel([
      [side*a.hw,a.y1,za],[side*b.hw,b.y1,zb],
      [side*b.hw,bottom(zb,b),zb],[side*a.hw,bottom(za,a),za],
    ],[side,0,0]));
  }
  return merge(parts);
}

// A chamfered tire profile keeps broad facets but gives the sidewall and tread
// distinct edges. Twelve radial faces have a flat contact patch at y=0.
export function wheels(spots, radius, width) {
  const parts=[];
  for (const [x,z] of spots) {
    const treadRadius = radius / Math.cos(Math.PI / 12);
    const profile=[[-width/2,radius*.88],[-width*.34,treadRadius],[width*.34,treadRadius],[width/2,radius*.88]];
    const points=profile.map(([along,r])=>new THREE.Vector2(r,along));
    parts.push(new THREE.LatheGeometry(points,12).rotateY(Math.PI/12).rotateZ(Math.PI/2).translate(x,radius,z));
    // Close the sidewalls behind the rim spokes; an uncapped lathe otherwise
    // leaves an open ring between the hub and the tire shoulder.
    for (const side of [-1,1]) parts.push(new THREE.CircleGeometry(radius*.91,12)
      .rotateY(side*Math.PI/2).translate(x+side*width/2,radius,z));
  }
  return merge(parts);
}

export function hubs(spots, radius, width, spokes = 6) {
  const parts=[];
  for (const [x,z] of spots) {
    const side=Math.sign(x), face=x+side*(width/2+.006), r=radius*.57;
    parts.push(new THREE.TorusGeometry(r,.022,4,12).rotateY(Math.PI/2).translate(face,radius,z));
    parts.push(new THREE.CylinderGeometry(r*.37,r*.37,.045,8).rotateZ(Math.PI/2).translate(face+side*.012,radius,z));
    for (let i=0;i<spokes;i++) {
      const a=i*Math.PI*2/spokes;
      parts.push(box(.025,r*.65,.045,0,0,0).rotateX(a).translate(face,radius+Math.cos(a)*r*.52,z+Math.sin(a)*r*.52));
    }
  }
  return merge(parts);
}
