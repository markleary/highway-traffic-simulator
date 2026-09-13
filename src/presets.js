import { params, DEFAULTS, ownDisplay } from './params.js';

// Scenario presets: one-click parameter setups that stage the good demos.
// The parameter space (shape × scale × interchanges × lanes × traffic knobs ×
// events) is big enough that reaching an interesting regime takes slider
// archaeology; each preset is a curated regime, calibrated against the smoke
// scenarios and the feature PRs that discovered it.
//
// Applying spreads DEFAULTS back in first (predictable stage, nothing
// inherited from the last slider session), preserves the user's display
// preferences unless the preset itself asks for them, resets the sim, and
// runs the preset's `after` hook (stage an emergency vehicle, trigger wrecks).
// All presets stay on the default circle so applying never rebuilds geometry
// slowly — the drama is in the traffic, not the scenery.

// user display preferences that survive a preset unless its patch overrides
const KEEP = ['units', 'showCharts', 'showDiagram', 'showFundamental', 'showFps', 'colorMode', 'scenery', 'sound'];

export const PRESETS = {
  rush: {
    label: 'Rush hour',
    tip: 'Both on-ramps flood at 30 cars/min with exits nearly closed. Jams grow backwards from the merges and the loop slowly chokes.',
    // mix pinned (with meters, its A/B partner): the demo's drama was
    // calibrated at 0% ACC — at the ambient 20% default, ACC wave-damping
    // absorbs the jams metering exists to fix and the comparison goes flat
    patch: { initialCars: 100, onRampA: 30, onRampB: 30, offRampA: 5, offRampB: 5,
             truckShare: 10, accShare: 0 },
  },
  meters: {
    label: 'Metered rush hour',
    tip: 'The Rush hour demand with one car released per green at each on-ramp. Compare mainline speed, achieved flow, and ramp waiting over several runs. The outcome depends on demand and meter rate; a faster mainline is not guaranteed.',
    patch: {
      initialCars: 100,
      onRampA: 30,
      onRampB: 30,
      offRampA: 5,
      offRampB: 5,
      truckShare: 10, // pinned with rush — see note there
      accShare: 0,
      metering: true,
      // Deliberately restrictive release rate for an observable queue/flow
      // tradeoff. The smoke benchmark reports paired outcomes across seeds;
      // this rate does not guarantee a faster mainline.
      meterRate: 8,
      showCharts: true,
    },
  },
  storm: {
    label: 'Accident storm',
    tip: 'Tailgating traffic (0.9 s headways) with two fresh wrecks: fragile flow collapsing. Click cars to add pileups; raise Duration to make it worse.',
    patch: { initialCars: 130, timeHeadway: 0.9, rubberneck: 0.7 },
    after: (sim) => {
      sim.triggerRandomAccident();
      sim.triggerRandomAccident();
    },
  },
  // Presets whose demo lives in a chart force that chart visible (the patch
  // wins over the preserved display prefs) — a user who hid the charts would
  // otherwise apply the regime and see nothing of what the tip advertises.
  accLab: {
    label: 'ACC wave lab',
    tip: 'An edge-of-instability regime: watch stop-and-go stripes, then raise Adaptive cruise % and press Reset to compare. The idealized controller can damp the waves; real commercial ACC varies. Cars are colored by type.',
    patch: {
      initialCars: 130,
      onRampA: 14,
      onRampB: 14,
      offRampA: 5,
      offRampB: 5,
      colorMode: 'type',
      showCharts: true,
      showDiagram: true,
    },
  },
  sweep: {
    label: 'Fundamental diagram',
    tip: 'A near-empty road filling up with no exits: watch the flow × density chart trace the inverted U live — up the free-flow diagonal, over the crest, down the congested branch.',
    patch: {
      initialCars: 20,
      onRampA: 25,
      onRampB: 25,
      offRampA: 0,
      offRampB: 0,
      showCharts: true,
      showFundamental: true,
    },
  },
  cones: {
    label: 'Lane closure crunch',
    tip: 'A work zone cones off the inner lane under moderate inflow: zipper merging at the taper, a queue growing behind it, and the capacity drop in the flow chart.',
    patch: {
      initialCars: 110,
      onRampA: 12,
      onRampB: 12,
      offRampA: 4,
      offRampB: 4,
      workZone: true,
      workZonePos: 35,
      workZoneLen: 300,
      showCharts: true,
    },
  },
  downpour: {
    label: 'Sudden downpour',
    tip: 'A minute of stable dry traffic — then a storm rolls in. Wet capacity drops below the inflow, the space-time diagram stripes with stop-and-go, and the charts shade blue while it lasts; flow recovers as the rain clears.',
    patch: {
      initialCars: 75,
      onRampA: 8,
      onRampB: 8,
      offRampA: 6,
      offRampB: 6,
      showCharts: true,
      showDiagram: true,
    },
    after: (sim) => sim.startStorm(60), // dry baseline first, storm at 1:00
  },
  siren: {
    label: 'Ambulance run',
    tip: 'A repeatable ambulance siren run in moderate traffic: watch drivers clear decisively while it commits to useful passing openings. The Events button instead dispatches an ambulance, police car, or fire truck at random.',
    patch: { initialCars: 65 },
    after: (sim) => sim.spawnEmergencyVehicle('ambulance'),
  },
  defaults: {
    label: 'Factory defaults',
    tip: 'Back to the out-of-the-box settings (your units and chart toggles stay).',
    patch: {},
  },
};

// Headless-safe: touches only params and the sim. The caller owns the
// renderer/panel refresh (renderer.onRoadChanged + a panel rebuild).
export function applyPreset(key, sim) {
  const preset = PRESETS[key];
  if (!preset) return;
  const keep = {};
  for (const k of KEEP) keep[k] = params[k];
  Object.assign(params, DEFAULTS, keep, preset.patch);
  // a preset that stages a chart owns that toggle: the demo lives in it, so
  // a later viewport flip must not auto-hide it (params.watchViewport)
  for (const k of Object.keys(preset.patch)) if (k.startsWith('show')) ownDisplay(k);
  params.paused = false; // a demo that starts frozen looks broken
  sim.reset();
  preset.after?.(sim);
}
