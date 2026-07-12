import { params, KMH, MPH } from './params.js';
import { Simulation } from './sim/simulation.js';
import { SceneRenderer } from './render/renderer.js';
import { buildPanel } from './ui/panel.js';
import { ChartPanel } from './ui/charts.js';
import { Speedometer } from './ui/speedo.js';

const sim = new Simulation();
const renderer = new SceneRenderer(document.getElementById('app'));
buildPanel({ sim, renderer });
const charts = new ChartPanel();
const speedo = new Speedometer();
// hovering the space-time diagram highlights the matching spot on the road;
// clicking it flies the camera there for a live overhead look
charts.onHoverS = (s) => renderer.setRoadCursor(s);
charts.onPickS = (s) => renderer.focusOnS(s);
// re-fit the camera now that both side panels exist and can be measured
renderer.setDefaultView();
// Click a car (or the road right next to one) to crash it. Picking is ray-
// based so cars on the figure eight's bridge deck pick correctly.
renderer.onRoadClick = (ray) => {
  const car = sim.carNearRay(ray);
  if (car) sim.triggerAccident(car);
};

// console access for poking at the live simulation
window.sim = sim;
window.renderer = renderer;
window.speedo = speedo;
window.charts = charts;
window.params = params;

// Fixed-timestep physics: rendering runs at display rate, simulation always
// steps in units of H seconds so behavior is identical at any frame rate.
const H = 1 / 60;
let last = performance.now();
let acc = 0;
let fpsFrames = 0; // render frames since the last HUD tick (FPS readout)

function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  fpsFrames++;
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
  // if the chased car left the world (exited, or wreck cleared), follow another
  if (renderer.chaseCar && !sim.cars.includes(renderer.chaseCar)) {
    const next = sim.randomEligibleCar();
    if (next) renderer.startChase(next);
    else renderer.stopChase();
  }
  speedo.update(renderer.chaseCar);
  // hover readout: same pick path as click-to-crash, re-run every frame so
  // the nameplate follows whichever car is under the pointer right now
  const hoverRay = renderer.pointerRay();
  renderer.setHoverCar(hoverRay && sim.carNearRay(hoverRay, 9, true));
  renderer.setRain(sim.rainNow || 0);
  renderer.update(sim.cars);
  renderer.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 'v' cycles the cameras; 'c' jumps straight to (or re-rolls) the chase.
// Panel view buttons don't move this index — the cycle just resumes from
// wherever it last was, which is harmless.
const views = [
  () => renderer.setDefaultView(),
  () => renderer.setTopView(),
  () => renderer.startChase(sim.randomEligibleCar()),
];
let viewIndex = 0; // startup camera is the perspective view

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    params.paused = !params.paused;
  }
  if (e.code === 'Escape') renderer.stopChase();
  // letter shortcuts: never while typing in the panel or chorded with a
  // browser shortcut (cmd/ctrl+F is find, not our FPS toggle)
  if (e.target !== document.body || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'KeyF') params.showFps = !params.showFps;
  if (e.code === 'KeyC') {
    viewIndex = 2; // a following 'v' continues the cycle from chase
    renderer.startChase(sim.randomEligibleCar()); // fresh car if already chasing
  }
  if (e.code === 'KeyV') {
    viewIndex = (viewIndex + 1) % views.length;
    views[viewIndex]();
  }
});

const el = {
  cars: document.getElementById('stat-cars'),
  speed: document.getElementById('stat-speed'),
  flow: document.getElementById('stat-flow'),
  inout: document.getElementById('stat-inout'),
  time: document.getElementById('stat-time'),
  fps: document.getElementById('stat-fps'),
  fpsRow: document.getElementById('row-fps'),
};
// In chase view the centered speedometer lands on top of the full hint line,
// and most of its tips (orbit, zoom) don't apply anyway — swap in a short
// chase-specific set that fits beside the gauge.
const hintEl = document.getElementById('hint');
const hintFree = hintEl.innerHTML;
// keep this short: it shares the bottom bar with the centered speedometer
const hintChase = 'drag orbit &nbsp;·&nbsp; esc exit &nbsp;·&nbsp; c switch';
let hintShowsChase = false;

// Touch chase toggle (visible only at the phone breakpoint): one tap in,
// one tap out — there's no C key on a phone. Label follows the state on
// the HUD tick below.
const chaseBtn = document.getElementById('chase-btn');
chaseBtn.addEventListener('click', () => {
  if (renderer.chaseCar) renderer.stopChase();
  else renderer.startChase(sim.randomEligibleCar());
});

// The bottom-left legend follows the color mode: the speed gradient only
// explains By speed; By type gets kind swatches (hues match the renderer's
// TYPE_COLORS); Per car has nothing to explain, so it hides.
const legendEl = document.getElementById('legend');
const legendSpeed = legendEl.innerHTML;
const sw = (hex, label) =>
  `<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;` +
  `background:${hex};margin-right:5px"></i>${label}</span>`;
// "ACC" over "adaptive cruise": the long label ran the legend panel under
// the hint bar, and the hover readout already calls these "ACC car"
const legendType =
  `<div class="labels" style="margin-top:0;gap:12px;justify-content:flex-start">` +
  sw('#3987e5', 'human') + sw('#199e70', 'ACC') + sw('#d98e32', 'truck') +
  sw('#f4f7f9', 'ambulance') + `</div>`;
let legendMode = 'speed';
// phone-sized screen, matching the CSS breakpoint and params.js SMALL
const SMALL = Math.min(window.innerWidth, window.innerHeight) < 500;

let fpsLast = performance.now();
setInterval(() => {
  const s = sim.stats();
  if (hintShowsChase !== !!renderer.chaseCar) {
    hintShowsChase = !!renderer.chaseCar;
    hintEl.innerHTML = hintShowsChase ? hintChase : hintFree;
    chaseBtn.textContent = hintShowsChase ? '✕ Exit chase' : '🎥 Chase';
  }
  if (legendMode !== params.colorMode) {
    legendMode = params.colorMode;
    if (legendMode === 'speed') legendEl.innerHTML = legendSpeed;
    else if (legendMode === 'type') legendEl.innerHTML = legendType;
  }
  // Per car has nothing to explain; on phones the centered speedometer
  // lands where the legend sits, so it also yields during a chase there
  legendEl.style.display =
    legendMode === 'random' || (SMALL && renderer.chaseCar) ? 'none' : '';
  // FPS over the real time since the last tick (the interval isn't exact)
  const nowMs = performance.now();
  el.fpsRow.style.display = params.showFps ? '' : 'none';
  if (params.showFps) el.fps.textContent = (fpsFrames / ((nowMs - fpsLast) / 1000)).toFixed(0);
  fpsFrames = 0;
  fpsLast = nowMs;
  renderer.updateRampLabels(sim.rampFlows());
  charts.update(sim.history, sim.incidentStarts);
  el.cars.textContent = s.count;
  el.speed.textContent =
    params.units === 'imperial'
      ? `${(s.avgSpeed / MPH).toFixed(0)} mph`
      : `${(s.avgSpeed / KMH).toFixed(0)} km/h`;
  // integer: a decimal ticking 4×/s jitters (and can resize) the HUD
  el.flow.textContent = `${Math.round(s.flowPerMin)} cars/min`;
  el.inout.textContent = `${s.entered} / ${s.exited}`;
  const m = Math.floor(sim.time / 60);
  const sec = Math.floor(sim.time % 60);
  el.time.textContent = `${m}:${String(sec).padStart(2, '0')}`;
}, 250);
