import * as THREE from 'three';

// Geometry of the circular "highway". The road's OUTER pavement edge is fixed;
// adding lanes grows the road inward, so ramp geometry (attached to the
// outside) never moves when the lane count changes.
export const ROAD = {
  outerR: 170,       // outer edge of the travel lanes (m)
  laneWidth: 3.7,    // m
  shoulderWidth: 3.0, // breakdown lane outside lane 0 (m)
  minLanes: 2,
  maxLanes: 4,
};

// s runs along the center of lane 0 (the outermost lane). All lanes share this
// arc-length coordinate: the traffic model treats the loop as a straight road
// that wraps around; curvature is purely cosmetic.
export const R_REF = ROAD.outerR - ROAD.laneWidth / 2;
export const LOOP = 2 * Math.PI * R_REF;

export function wrap(s) {
  return ((s % LOOP) + LOOP) % LOOP;
}

// Distance driving forward from `from` to `to` (always in [0, LOOP)).
export function forwardDist(from, to) {
  return wrap(to - from);
}

// Lane 0 is the outermost (slow / ramp) lane; higher lanes are further inside.
export function laneOffset(lane) {
  return -lane * ROAD.laneWidth;
}

// Fractional "lane" of the shoulder's centerline (negative = outside lane 0),
// in the same units as car.renderLane. Cars park here during breakdowns.
export const SHOULDER_LANE = -(ROAD.outerR + ROAD.shoulderWidth / 2 - R_REF) / ROAD.laneWidth;

const A0 = Math.PI / 2;

// Traffic runs clockwise seen from above (+y), which puts the outside of the
// loop on the drivers' right — where the ramps are.
function angleAt(s) {
  return A0 - s / R_REF;
}

export function pointAt(s, offset = 0, target = new THREE.Vector3()) {
  const th = angleAt(s);
  const r = R_REF + offset;
  return target.set(r * Math.cos(th), 0, r * Math.sin(th));
}

export function forwardAt(s, target = new THREE.Vector3()) {
  const th = angleAt(s);
  return target.set(Math.sin(th), 0, -Math.cos(th));
}

function outwardAt(s, target = new THREE.Vector3()) {
  const th = angleAt(s);
  return target.set(Math.cos(th), 0, Math.sin(th));
}

function makeOnRamp(id, rateKey, label, sJoin) {
  const J = pointAt(sJoin);
  const F = forwardAt(sJoin);
  const O = outwardAt(sJoin);
  const P0 = J.clone().addScaledVector(F, -88).addScaledVector(O, 55);
  const P1 = P0.clone().addScaledVector(F, 38);
  const P2 = J.clone().addScaledVector(F, -38);
  const curve = new THREE.CubicBezierCurve3(P0, P1, P2, J.clone());
  return {
    id,
    rateKey,     // params key holding this ramp's inflow (cars/min)
    label,       // shown on the map, matches the panel's slider names
    type: 'on',
    sJoin,
    curve,       // runs entry → merge point
    length: curve.getLength(),
    mergeZone: 65, // acceleration lane: cars may merge within this many meters of the ramp end
  };
}

function makeOffRamp(id, rateKey, label, sDiverge) {
  const D = pointAt(sDiverge);
  const F = forwardAt(sDiverge);
  const O = outwardAt(sDiverge);
  const P3 = D.clone().addScaledVector(F, 88).addScaledVector(O, 55);
  const P1 = D.clone().addScaledVector(F, 38);
  const P2 = P3.clone().addScaledVector(F, -38);
  const curve = new THREE.CubicBezierCurve3(D.clone(), P1, P2, P3);
  const decideDist = 220; // how far upstream cars decide to take this exit
  return {
    id,
    rateKey,     // params key holding this ramp's exit share (%)
    label,       // shown on the map, matches the panel's slider names
    type: 'off',
    sDiverge,
    decideS: wrap(sDiverge - decideDist),
    curve,       // runs diverge point → exit
    length: curve.getLength(),
  };
}

// Two diamond interchanges on opposite sides of the loop, each an off-ramp
// followed by an on-ramp (exit before entrance, like a real interchange).
// Diverge/join points are spaced so the two ramps of an interchange never
// cross: the off-ramp fully clears the corridor before the on-ramp enters it.
export const RAMPS = [
  makeOffRamp('offA', 'offRampA', 'Exit A', 0.04 * LOOP),
  makeOnRamp('onA', 'onRampA', 'On-ramp A', 0.24 * LOOP),
  makeOffRamp('offB', 'offRampB', 'Exit B', 0.54 * LOOP),
  makeOnRamp('onB', 'onRampB', 'On-ramp B', 0.74 * LOOP),
];
