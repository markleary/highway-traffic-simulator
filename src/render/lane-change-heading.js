import { ROAD } from '../sim/road.js';

const MAX_YAW = 12 * Math.PI / 180;
const SPEED_FLOOR = 5; // m/s; a crawling car should never point across the road

// Cosmetic steering follows the lateral velocity of the simulation's quintic
// lane change. Positive lane motion is driver's left (+yaw for +z-forward art).
export function laneChangeYaw(car) {
  const change = car.laneChange;
  if (!change || car.ramp || car.incident?.kind === 'accident') return 0;
  const u = Math.max(0, Math.min(1, change.elapsed / change.duration));
  const lateralSpeed = ROAD.laneWidth * (change.endRender - change.startRender)
    * 30 * u * u * (1 - u) * (1 - u) / change.duration;
  // Smoothly limit the angle in queues, retaining the natural smaller heading
  // at freeway speed. Both ends return to road alignment with zero yaw rate.
  return MAX_YAW * Math.tanh(lateralSpeed / (Math.max(SPEED_FLOOR, car.v) * MAX_YAW));
}
