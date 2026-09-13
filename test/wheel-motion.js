import assert from 'node:assert/strict';
import { WheelMotion } from '../src/render/wheel-motion.js';

const TAU = 2 * Math.PI;
const nearAngle = (a, b, message) => {
  const difference = Math.atan2(Math.sin(a - b), Math.cos(a - b));
  assert.ok(Math.abs(difference) < 1e-9, `${message}: ${a} vs ${b}`);
};
const motion = new WheelMotion();
const radius = 0.34;
const car = { v: TAU * radius };
motion.advance(car, 0.25, radius);
nearAngle(motion.angle(car), Math.PI / 2, 'quarter circumference gives quarter turn');
nearAngle(motion.angle(car, 0.5), Math.PI / 4, 'pose interpolation also interpolates wheel travel');
motion.advance(car, 0.5, radius);
motion.advance(car, 0.5, radius);
nearAngle(motion.angle(car, 0.5), 0, 'interpolation crosses the revolution seam forward');
nearAngle(motion.angle(car), Math.PI / 2, 'full turns preserve the residual phase');
car.v = 0;
motion.advance(car, 1 / 60, radius);
for (const alpha of [0, .3, 1]) nearAngle(motion.angle(car, alpha), Math.PI / 2, 'stopped car holds its wheels');
for (let i=0;i<200;i++) nearAngle(motion.angle(car), Math.PI / 2, 'extra display frames do not advance a paused simulation');
assert.equal(motion.angle({v: 0}), 0, 'a replacement car starts fresh even if an old pool slot is reused');

// Sample the same accelerated fixed-step run at common display rates. Changes
// in frame rate, repeated renders and time scale cannot change rolling distance.
function replay(fps, timeScale, duration) {
  const wheels = new WheelMotion(), vehicle = {v: 2};
  const h = 1/60; let acc=0, travelled=0, steps=0;
  for(let frame=0;frame<Math.round(fps*duration/timeScale);frame++) {
    acc += timeScale/fps;
    while(acc+1e-12>=h) {
      vehicle.v = 2 + steps*h*1.5;
      wheels.advance(vehicle,h,.52); travelled += vehicle.v*h;
      acc-=h; steps++;
    }
    wheels.angle(vehicle,Math.max(0,acc/h));
  }
  nearAngle(wheels.angle(vehicle),travelled/.52,'phase matches integrated simulation distance');
  return {angle:wheels.angle(vehicle),steps};
}
const normal=replay(60,1,6);
for(const [fps,scale] of [[30,1],[144,1],[60,4],[120,.5]]) {
  const other=replay(fps,scale,6);assert.equal(other.steps,normal.steps);
  nearAngle(other.angle,normal.angle,'frame rate and time scale preserve final wheel phase');
}
const slow={v:3},fast={v:6};const separate=new WheelMotion();
separate.advance(slow,.1,.4);separate.advance(fast,.1,.4);
nearAngle(separate.angle(fast),2*separate.angle(slow),'twice the speed doubles angular displacement');
const oldSlow=separate.angle(slow);
separate.advance(fast,.1,.4);
nearAngle(separate.angle(slow),oldSlow,'another vehicle or pool ordering cannot change this car');
const backwards={v:-2};separate.advance(backwards,.2,.4);
nearAngle(separate.angle(backwards),-1,'signed travel produces the matching rotation direction');
console.log('Wheel motion: circumference, stopping, interpolation, frame rates, time scale and vehicle identity passed.');
