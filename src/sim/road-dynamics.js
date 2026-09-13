import { curvatureAt, gradeAt, laneOffset } from './road.js';
import { params } from '../params.js';

// Optional, illustrative road constraints. The small diorama bends are much
// tighter than a freeway designed for 70 mph, so these remain opt-in. This
// is a speed-target model, not a full tire, banking, powertrain or fuel model.
export function roadSpeedLimit(car, rain = params.rain) {
  if (!params.roadDynamics || car.state !== 'main') return Infinity;
  const heavy = car.kind === 'truck' || car.kind === 'firetruck';
  const lateralComfort = (heavy ? 1.5 : 2.2) * (1 - 0.25 * (rain || 0)); // m/s²
  const braking = Math.max(0.5, params.comfortBrake * car.brakeK * 0.7);
  const lookahead = Math.min(300, Math.max(60, car.v * car.v / (2 * braking)));
  const offset = laneOffset(car.renderLane ?? car.lane);
  let limit = Infinity;
  // Look ahead to reduce the target before entering a tight bend or climb.
  // Current + 15 m samples fit even the shortest arc in the shape catalog.
  for (let d = 0; d <= lookahead; d += 15) {
    const s = car.s + d;
    const curve = Math.abs(curvatureAt(s, offset));
    // Physics integrates lane-0 s for every lane. Convert the physical lane
    // speed limit back into ds/dt: inner lanes cover less pavement per unit s.
    const metric = curve > 1e-8 ? Math.abs(curvatureAt(s)) / curve : 1;
    let local = curve > 1e-8 ? Math.sqrt(lateralComfort / curve) / metric : Infinity;
    if (heavy) {
      const grade = Math.max(0, gradeAt(s));
      if (grade > 0) {
        // Available power per mass divided by grade + rolling resistance
        // gives a conservative climbing pace. Heavy trucks have less spare
        // power per tonne. Ordinary passenger vehicles retain their targets.
        const specificPower = car.kind === 'truck' ? 10 : 14; // W/kg = m²/s³
        const climb = Math.max(5, specificPower / (9.81 * grade + 0.08));
        local = Math.min(local, climb);
      }
    }
    limit = Math.min(limit, Math.sqrt(local * local + 2 * braking * d));
  }
  return limit;
}
