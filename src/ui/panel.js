import GUI from 'lil-gui';
import { params, KMH, MPH, FT } from '../params.js';

// params holds SI values only. Sliders with units bind to a proxy object in
// display units and write converted SI back on change; toggling units tears
// the panel down and rebuilds it with new labels, ranges and proxy values.
export function buildPanel({ sim, renderer }) {
  let gui = null;
  const rebuild = () => {
    if (gui) gui.destroy();
    // defer: destroying the GUI from inside its own onChange handler
    gui = makeGui({ sim, renderer, onUnitsChange: () => setTimeout(rebuild, 0) });
  };
  rebuild();
}

function makeGui({ sim, renderer, onUnitsChange }) {
  const imp = params.units === 'imperial';
  const spd = imp ? MPH : KMH; // speed display unit → m/s
  const spdU = imp ? 'mph' : 'km/h';
  const acc = imp ? FT : 1;    // length/accel display unit → m
  const lenU = imp ? 'ft' : 'm';
  const accU = imp ? 'ft/s²' : 'm/s²';

  const ui = {
    desiredSpeed: Math.round(params.desiredSpeed / spd),
    rampSpeed: Math.round(params.rampSpeed / spd),
    minGap: Number((params.minGap / acc).toFixed(1)),
    maxAccel: Number((params.maxAccel / acc).toFixed(1)),
    comfortBrake: Number((params.comfortBrake / acc).toFixed(1)),
    laneChangeThreshold: Number((params.laneChangeThreshold / acc).toFixed(2)),
    safeBrake: Number((params.safeBrake / acc).toFixed(1)),
  };

  const gui = new GUI({ title: 'Traffic Controls' });
  gui
    .add(params, 'units', { 'Imperial (mph)': 'imperial', 'Metric (km/h)': 'metric' })
    .name('Units')
    .onChange(onUnitsChange);

  const fSim = gui.addFolder('Simulation');
  fSim.add(params, 'paused').name('Paused').listen();
  fSim.add(params, 'timeScale', 0.1, 8, 0.1).name('Time scale');
  fSim.add(params, 'initialCars', 0, 300, 5).name('Cars on reset');
  fSim.add({ reset: () => sim.reset() }, 'reset').name('↻ Reset simulation');

  const fRoad = gui.addFolder('Road');
  fRoad
    .add(params, 'lanes', 2, 4, 1)
    .name('Lanes')
    .onChange(() => {
      sim.onLaneCountChanged();
      renderer.buildRoad();
    });

  const fDrv = gui.addFolder('Drivers');
  fDrv
    .add(ui, 'desiredSpeed', ...(imp ? [25, 90, 1] : [40, 145, 1]))
    .name(`Desired speed (${spdU})`)
    .onChange((v) => (params.desiredSpeed = v * spd));
  fDrv.add(params, 'speedVariation', 0, 0.4, 0.01).name('Speed spread');
  fDrv.add(params, 'timeHeadway', 0.6, 3, 0.1).name('Time headway (s)');
  fDrv
    .add(ui, 'minGap', ...(imp ? [2, 20, 0.5] : [0.5, 6, 0.1]))
    .name(`Min gap (${lenU})`)
    .onChange((v) => (params.minGap = v * acc));
  fDrv
    .add(ui, 'maxAccel', ...(imp ? [1.5, 10, 0.5] : [0.5, 3, 0.1]))
    .name(`Max accel (${accU})`)
    .onChange((v) => (params.maxAccel = v * acc));
  fDrv
    .add(ui, 'comfortBrake', ...(imp ? [1.5, 13, 0.5] : [0.5, 4, 0.1]))
    .name(`Comfort brake (${accU})`)
    .onChange((v) => (params.comfortBrake = v * acc));

  const fLc = gui.addFolder('Lane changing');
  fLc.add(params, 'politeness', 0, 1, 0.05).name('Politeness');
  fLc
    .add(ui, 'laneChangeThreshold', ...(imp ? [0.15, 3.3, 0.05] : [0.05, 1, 0.05]))
    .name(`Incentive threshold (${accU})`)
    .onChange((v) => (params.laneChangeThreshold = v * acc));
  fLc
    .add(ui, 'safeBrake', ...(imp ? [6.5, 26, 0.5] : [2, 8, 0.5]))
    .name(`Safe braking limit (${accU})`)
    .onChange((v) => (params.safeBrake = v * acc));
  fLc.close();

  const fRamps = gui.addFolder('Ramps');
  fRamps.add(params, 'onRampA', 0, 40, 0.5).name('On-ramp A (cars/min)');
  fRamps.add(params, 'onRampB', 0, 40, 0.5).name('On-ramp B (cars/min)');
  fRamps.add(params, 'offRampA', 0, 50, 1).name('Exit A share (%)');
  fRamps.add(params, 'offRampB', 0, 50, 1).name('Exit B share (%)');
  fRamps
    .add(ui, 'rampSpeed', ...(imp ? [20, 60, 5] : [30, 100, 5]))
    .name(`Ramp speed (${spdU})`)
    .onChange((v) => (params.rampSpeed = v * spd));

  const fView = gui.addFolder('View');
  fView
    .add(params, 'colorMode', { 'By speed': 'speed', 'Per car': 'random' })
    .name('Car colors');
  fView.add({ top: () => renderer.setTopView() }, 'top').name('Overhead view');
  fView.add({ def: () => renderer.setDefaultView() }, 'def').name('Perspective view');
  fView.close();

  return gui;
}
