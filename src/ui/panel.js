import GUI from 'lil-gui';
import { params } from '../params.js';

export function buildPanel({ sim, renderer }) {
  const gui = new GUI({ title: 'Traffic Controls' });

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
  fDrv.add(params, 'desiredSpeedKmh', 40, 140, 1).name('Desired speed (km/h)');
  fDrv.add(params, 'speedVariation', 0, 0.4, 0.01).name('Speed spread');
  fDrv.add(params, 'timeHeadway', 0.6, 3, 0.1).name('Time headway (s)');
  fDrv.add(params, 'minGap', 0.5, 6, 0.1).name('Min gap (m)');
  fDrv.add(params, 'maxAccel', 0.5, 3, 0.1).name('Max accel (m/s²)');
  fDrv.add(params, 'comfortBrake', 0.5, 4, 0.1).name('Comfort brake (m/s²)');

  const fLc = gui.addFolder('Lane changing');
  fLc.add(params, 'politeness', 0, 1, 0.05).name('Politeness');
  fLc.add(params, 'laneChangeThreshold', 0.05, 1, 0.05).name('Incentive threshold');
  fLc.add(params, 'safeBrake', 2, 8, 0.5).name('Safe braking limit');
  fLc.close();

  const fRamps = gui.addFolder('Ramps');
  fRamps.add(params, 'onRampA', 0, 40, 0.5).name('On-ramp A (cars/min)');
  fRamps.add(params, 'onRampB', 0, 40, 0.5).name('On-ramp B (cars/min)');
  fRamps.add(params, 'offRampA', 0, 50, 1).name('Exit A share (%)');
  fRamps.add(params, 'offRampB', 0, 50, 1).name('Exit B share (%)');
  fRamps.add(params, 'rampSpeedKmh', 30, 100, 5).name('Ramp speed (km/h)');

  const fView = gui.addFolder('View');
  fView
    .add(params, 'colorMode', { 'By speed': 'speed', 'Per car': 'random' })
    .name('Car colors');
  fView.add({ top: () => renderer.setTopView() }, 'top').name('Overhead view');
  fView.add({ def: () => renderer.setDefaultView() }, 'def').name('Perspective view');
  fView.close();

  return gui;
}
