import { params, KMH, MPH } from './params.js';
import { Simulation } from './sim/simulation.js';
import { SceneRenderer } from './render/renderer.js';
import { buildPanel } from './ui/panel.js';

const sim = new Simulation();
const renderer = new SceneRenderer(document.getElementById('app'));
buildPanel({ sim, renderer });
// Click a car (or the road right next to one) to crash it.
renderer.onRoadClick = (point) => {
  const car = sim.carNear(point);
  if (car) sim.triggerAccident(car);
};

// console access for poking at the live simulation
window.sim = sim;
window.renderer = renderer;

// Fixed-timestep physics: rendering runs at display rate, simulation always
// steps in units of H seconds so behavior is identical at any frame rate.
const H = 1 / 60;
let last = performance.now();
let acc = 0;

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!params.paused) {
    acc += dt * params.timeScale;
    let steps = 0;
    while (acc >= H && steps < 30) {
      sim.step(H);
      acc -= H;
      steps++;
    }
    if (steps === 30) acc = 0; // can't keep up; drop time instead of spiraling
  }
  renderer.update(sim.cars);
  renderer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    params.paused = !params.paused;
  }
});

const el = {
  cars: document.getElementById('stat-cars'),
  speed: document.getElementById('stat-speed'),
  flow: document.getElementById('stat-flow'),
  inout: document.getElementById('stat-inout'),
  time: document.getElementById('stat-time'),
};
setInterval(() => {
  const s = sim.stats();
  renderer.updateRampLabels(sim.rampFlows());
  el.cars.textContent = s.count;
  el.speed.textContent =
    params.units === 'imperial'
      ? `${(s.avgSpeed / MPH).toFixed(0)} mph`
      : `${(s.avgSpeed / KMH).toFixed(0)} km/h`;
  el.flow.textContent = `${s.flowPerMin.toFixed(1)} cars/min`;
  el.inout.textContent = `${s.entered} / ${s.exited}`;
  const m = Math.floor(sim.time / 60);
  const sec = Math.floor(sim.time % 60);
  el.time.textContent = `${m}:${String(sec).padStart(2, '0')}`;
}, 250);
