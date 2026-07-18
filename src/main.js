import { params, KMH, MPH, watchViewport, TOUCH_UI, DEBUG_PANEL, TESLA_BROWSER } from './params.js';
import { Simulation } from './sim/simulation.js';
import { SceneRenderer } from './render/renderer.js';
import { buildPanel } from './ui/panel.js';
import { ChartPanel } from './ui/charts.js';
import { Speedometer } from './ui/speedo.js';

// touch-first screens of ANY size (the Tesla browser presents as a desktop,
// iPads as Macs): keyboard tips are dead weight and a finger needs the chase
// toggle — CSS keys off this class the same way it keys off the phone
// breakpoint, without dragging in the rest of the small-screen layout
document.body.classList.toggle('touch-ui', TOUCH_UI);

const sim = new Simulation();
const renderer = new SceneRenderer(document.getElementById('app'));
buildPanel({ sim, renderer });
watchViewport(); // un-owned chart defaults keep tracking breakpoint flips
const charts = new ChartPanel();
const speedo = new Speedometer();
// hovering the space-time diagram highlights the matching spot on the road;
// clicking it flies the camera there for a live overhead look
charts.onHoverS = (s) => renderer.setRoadCursor(s);
charts.onPickS = (s) => renderer.focusOnS(s);
// re-fit the camera now that both side panels exist and can be measured
renderer.setDefaultView();
// Left-click a car (or the road right next to one) to crash it. Right-click a
// specific visible vehicle to chase it. Both picks are ray-based so vehicles
// on the figure eight's bridge deck select correctly.
renderer.onRoadClick = (ray) => {
  const car = sim.carNearRay(ray);
  if (car) sim.triggerAccident(car);
};
renderer.onRoadRightClick = (ray) => {
  const car = sim.carNearRay(ray, 9, true);
  if (!car) return false;
  renderer.startChase(car);
  return true;
};

// ?debug diagnostic panel (grew out of the Tesla dropdown hunt — the car has
// no devtools, so a screenshot of this is how ground truth gets off the
// screen). Observability only: it never changes behavior. "build" is the
// served page's Last-Modified — the Pages deploy time of the HTML actually
// running — while "latest main" is fetched from the GitHub API, so the
// pair separates stale-cache from fresh-code at a glance.
if (DEBUG_PANEL) {
  const el = document.createElement('div');
  el.id = 'debug-panel';
  el.textContent = 'debug';
  const line = (text) => {
    const d = document.createElement('div');
    d.textContent = text;
    el.appendChild(d);
    return d;
  };
  line(`build (this page): ${document.lastModified}`);
  const gitLine = line('latest main: fetching…');
  fetch('https://api.github.com/repos/markleary/highway-traffic-simulator/commits/main')
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((c) => {
      gitLine.textContent = `latest main: ${c.sha.slice(0, 7)} · ${c.commit.committer.date}`;
    })
    .catch(() => {
      gitLine.textContent = 'latest main: unavailable (offline or rate-limited)';
    });
  line(`detected: tesla ${TESLA_BROWSER} · touch-ui ${TOUCH_UI}`);
  line(navigator.userAgent);
  line(
    `touch ${navigator.maxTouchPoints}` +
      ` · coarse ${matchMedia('(pointer: coarse)').matches}` +
      ` · no-hover ${matchMedia('(hover: none)').matches}` +
      ` · screen ${screen.width}×${screen.height}` +
      ` · vp ${window.innerWidth}×${window.innerHeight}` +
      ` · dpr ${window.devicePixelRatio}`
  );
  try {
    // same-type getContext returns three's existing context; the debug ext
    // is absent in browsers that already unmask RENDERER (newer Chromium)
    const canvas = document.querySelector('#app canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    line(`gpu: ${gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)}`);
  } catch {
    line('gpu: unavailable');
  }
  document.body.appendChild(el);
}

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
      // Preserve the pose immediately before the final fixed step. Rendering
      // interpolates from it using the leftover accumulator fraction, which
      // removes the hold/jump judder that looks like a doubled vehicle at
      // freeway speeds (especially on high-refresh displays).
      renderer.captureCarPoses(sim.cars);
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
    else renderer.exitChase(); // nobody left to follow: overhead close-up instead
  }
  // CSS keys the speedometer/legend/hint bottom-strip layout off this class
  document.body.classList.toggle('chasing', !!renderer.chaseCar);
  speedo.update(renderer.chaseCar);
  const renderAlpha = params.paused ? 1 : Math.max(0, Math.min(1, acc / H));
  renderer.setRain(sim.rainNow || 0);
  renderer.updateMeters(sim);
  renderer.update(sim.cars, renderAlpha);
  // hover readout: same pick path as click-to-crash, re-run every frame so
  // the nameplate follows whichever car is under the pointer right now
  const hoverRay = renderer.pointerRay();
  renderer.setHoverCar(hoverRay && sim.carNearRay(hoverRay, 9, true));
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
  if (e.code === 'Escape') renderer.exitChase();
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
  if (renderer.chaseCar) renderer.exitChase();
  else renderer.startChase(sim.randomEligibleCar());
});

// The bottom-left legend follows the color mode: the speed gradient only
// explains By speed; By type gets kind swatches (hues match the renderer's
// TYPE_COLORS); Per car has nothing to explain, so it hides.
const legendEl = document.getElementById('legend');
const legendSpeed = legendEl.innerHTML;
const sw = (fill, label) =>
  `<span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;` +
  `background:${fill};margin-right:5px"></i>${label}</span>`;
// "ACC" over "adaptive cruise": the long label ran the legend panel under
// the hint bar, and the hover readout already calls these "ACC car". Keep the
// three model-specific emergency liveries in one striped swatch for the same
// reason: the legend explains the category without growing by two labels.
const legendType =
  `<div class="labels" style="margin-top:0;gap:12px;justify-content:flex-start">` +
  sw('#3987e5', 'human') + sw('#199e70', 'ACC') + sw('#d98e32', 'truck') +
  sw('linear-gradient(90deg,#f4f7f9 0 33%,#242a30 33% 66%,#c93632 66%)', 'emergency') +
  `</div>`;
let legendMode = 'speed';

let fpsLast = performance.now();
let chartsShown = params.showCharts;
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
  // Per car has nothing to explain. (During a chase on narrow windows the
  // legend also yields to the speedometer — CSS, via body.chasing.)
  legendEl.style.display = legendMode === 'random' ? 'none' : '';
  // FPS over the real time since the last tick (the interval isn't exact)
  const nowMs = performance.now();
  el.fpsRow.style.display = params.showFps ? '' : 'none';
  if (params.showFps) el.fps.textContent = (fpsFrames / ((nowMs - fpsLast) / 1000)).toFixed(0);
  fpsFrames = 0;
  fpsLast = nowMs;
  renderer.updateRampLabels(sim.rampFlows());
  charts.update(sim.history, sim.incidentStarts); // applies showCharts to the DOM
  // toggling the chart stack moves the free region's left edge; re-frame a
  // parked auto view around it (measured after the update call above)
  if (chartsShown !== params.showCharts) {
    chartsShown = params.showCharts;
    renderer.refitView();
  }
  el.cars.textContent = s.count;
  el.speed.textContent =
    params.units === 'imperial'
      ? `${(s.avgSpeed / MPH).toFixed(0)} mph`
      : `${(s.avgSpeed / KMH).toFixed(0)} km/h`;
  // integer: a decimal ticking 4×/s jitters (and can resize) the HUD
  el.flow.textContent = `${Math.round(s.flowPerMin)} cars/min`;
  el.inout.textContent = `${s.entered} / ${s.exited}`;
  // h:mm:ss once a sitting passes the hour (a 90-minute run read "90:12"),
  // with the pause/time-scale state on the same line — the spacebar gives
  // no other feedback when the panel is collapsed
  const t = Math.floor(sim.time);
  const pad = (n) => String(n).padStart(2, '0');
  const hr = Math.floor(t / 3600);
  let clock = hr
    ? `${hr}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`
    : `${Math.floor(t / 60)}:${pad(t % 60)}`;
  if (params.paused) clock += ' · paused';
  else if (params.timeScale !== 1) clock += ` · ×${+params.timeScale.toFixed(1)}`;
  el.time.textContent = clock;
}, 250);
