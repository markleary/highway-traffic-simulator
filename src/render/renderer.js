import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD, RAMPS, LOOP, bounds, pointAt, forwardAt, wrap, elevAt } from '../sim/road.js';
import { params, KMH, MPH, FT } from '../params.js';
import { isEmergencyVehicle, vehicleLabel } from '../sim/car.js';
import { buildCybertruckGeometry, CYBERTRUCK_LIGHTS, CYBERTRUCK_WHEELS } from './cybertruck.js';
import { buildEVGeometry, EV_LIGHTS, EV_WHEELS } from './ev.js';
import { buildPassengerGeometry, buildPassengerWheels, PASSENGER_LIGHTS, PASSENGER_WHEELS } from './passenger.js';
import { buildPoliceGeometry, POLICE_LIGHTS, POLICE_STROBE, POLICE_WHEELS } from './police.js';
import { buildSemiGeometry, SEMI_LIGHTS, SEMI_WHEELS } from './semi.js';
import { buildAmbulanceGeometry, buildFiretruckGeometry, AMBULANCE_LIGHTS, FIRETRUCK_LIGHTS, AMBULANCE_STROBE, FIRETRUCK_STROBE, AMBULANCE_WHEELS, FIRETRUCK_WHEELS } from './service-vehicles.js';
import { annotateRollingGeometry, makeWheelMaterial } from './wheel-material.js';
import { WheelMotion } from './wheel-motion.js';

const MAX_CARS = 1500;
const MAX_TRUCKS = 400;
const MAX_EMERGENCY = 8; // simulation caps all emergency kinds at this total
const MAX_SHADOWS = MAX_CARS * 4 + MAX_TRUCKS + MAX_EMERGENCY; // every render pool combined
const TRAILER_PAINT = new THREE.Color(0xdce1df);
const STROBE_RED = new THREE.Color(0xff2a2a);
const STROBE_BLUE = new THREE.Color(0x2a6bff);
// 'By type' color mode: the charts' categorical trio (speed/flow/cars series
// hues), so the whole UI speaks one palette. Emergency liveries stay fixed.
const TYPE_COLORS = {
  car: new THREE.Color(0x3987e5),
  acc: new THREE.Color(0x199e70),
  truck: new THREE.Color(0xd98e32),
  ambulance: new THREE.Color(0xf4f7f9),
  police: new THREE.Color(0x242a30),
  firetruck: new THREE.Color(0xc93632),
};
// Brake lamps are paired on every conventional vehicle, and a signaling car
// can also contribute a front/rear blinker pair in the same frame.
const MAX_LIGHTS = (MAX_CARS + MAX_TRUCKS + MAX_EMERGENCY) * 2;
const RAIN_BOX = 700; // rain sheet footprint (m), follows the camera
const RAIN_HEIGHT = 260;
// Chase-view dolly range, as a multiplier on the per-kind follow distance:
// close enough to sit on the bumper, far enough to watch the surrounding
// platoon without leaving the car.
const CHASE_ZOOM_MIN = 0.45;
const CHASE_ZOOM_MAX = 4;
// Hold this long without moving and a touch press becomes "chase this one".
// Matches the panel's long-press tooltips, which train the same gesture.
const LONG_PRESS_MS = 500;

// Browsers report a physical secondary mouse button as button 2. macOS also
// exposes Control-click as a context gesture while retaining button 0, so both
// event shapes must bypass click-to-crash and enter the chase path.
export function isSecondaryClick(event) {
  return event.button === 2 || (event.button === 0 && event.ctrlKey);
}

// Late-afternoon low-poly diorama palette. Every DRY color lerps toward its
// WET partner as sim.rainNow rises (applyWeather), so a storm grades the
// whole scene — sky, fog, hills, clouds — not just the lighting.
const SKY_R = 4500; // dome base radius; buildRoad rescales it to the far plane
const SKY = {
  topDry: new THREE.Color(0x527ab0),
  topWet: new THREE.Color(0x37445e),
  horizonDry: new THREE.Color(0xe8c49a),
  horizonWet: new THREE.Color(0x5a6675),
};
const SUN_DIR = new THREE.Vector3(320, 210, -240).normalize(); // low in the west
const CLOUD_DRY = new THREE.Color(0xf2efe7);
const CLOUD_WET = new THREE.Color(0x525c66);
const HILL_DRY = new THREE.Color(0x77866f); // pre-hazed: hills skip the fog
const HILL_WET = new THREE.Color(0x424c55);
const GROUND_DRY = new THREE.Color(0x5c6a49);
const GROUND_WET = new THREE.Color(0x39464a);
const GLASS_TINT = new THREE.Color(0x263d4c);
const _sky = new THREE.Color(); // applyWeather scratch

// Light mount points per vehicle kind, in the car's local frame (+z = front,
// +x = driver's left = inward). y/rear/front from the body geometries below.
// 'car' holds one entry per body style, indexed by the same car.id bit that
// picks the loft in update().
const LIGHT_DIMS = {
  car: PASSENGER_LIGHTS,
  cybertruck: CYBERTRUCK_LIGHTS,
  ev: EV_LIGHTS,
  truck: SEMI_LIGHTS,
  ambulance: AMBULANCE_LIGHTS,
  police: POLICE_LIGHTS,
  firetruck: FIRETRUCK_LIGHTS,
};

const WHEEL_LAYOUTS = {
  car: PASSENGER_WHEELS,
  cybertruck: CYBERTRUCK_WHEELS,
  ev: EV_WHEELS,
  truck: SEMI_WHEELS,
  ambulance: AMBULANCE_WHEELS,
  police: POLICE_WHEELS,
  firetruck: FIRETRUCK_WHEELS,
};

// Shared presentation dimensions keep the long/tall emergency models out of
// the old kind-by-kind ternaries. Contact-shadow length comes from car.len so
// the rendered footprint follows the physics record automatically.
const RENDER_DIMS = {
  car: { shadowHalfW: 0.92, shadowInset: 0.18, hoverY: 2.6, chaseUp: 6 },
  cybertruck: { shadowHalfW: 1.02, shadowInset: 0.18, hoverY: 2.6, chaseUp: 6 },
  ev: { shadowHalfW: 0.94, shadowInset: 0.18, hoverY: 2.6, chaseUp: 6 },
  truck: { shadowHalfW: 1.25, shadowInset: 0.35, hoverY: 4.5, chaseUp: 8.5 },
  ambulance: {
    shadowHalfW: 1.17, shadowInset: 0.22, hoverY: 3.1, chaseUp: 6,
    strobe: AMBULANCE_STROBE,
  },
  police: {
    shadowHalfW: 1.0, shadowInset: 0.2, hoverY: 2.7, chaseUp: 6,
    strobe: POLICE_STROBE,
  },
  firetruck: {
    shadowHalfW: 1.24, shadowInset: 0.5, hoverY: 4.4, chaseUp: 8.5,
    strobe: FIRETRUCK_STROBE,
  },
};

// Body geometry is independent of the controller/category used for colors.
// The fallback supports external callers with pre-model Car-shaped records.
const modelOf = (car) => car.model ?? (car.kind === 'acc' ? 'cybertruck' : car.kind);

export class SceneRenderer {
  constructor(container) {
    // Measure the CONTAINER, never window.innerWidth/innerHeight. An
    // installed iOS app hands the page a letterboxed initial containing
    // block — window.innerHeight came up 62 px short of the screen on a
    // 440×956 iPhone — while #stage, sized in viewport units, covers it
    // (see index.html). Sizing off the window painted a canvas short of
    // its own box and left a band of page background along the bottom.
    // The window fallbacks are for a detached container (never in the app).
    this.container = container;
    this.viewSize = () => ({
      w: Math.max(1, container.clientWidth || window.innerWidth),
      h: Math.max(1, container.clientHeight || window.innerHeight),
    });
    const { w, h } = this.viewSize();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle false: CSS sizes the canvas to its box (index.html), so
    // the two can't disagree; three.js owns only the drawing buffer.
    this.renderer.setSize(w, h, false);
    // A gentle filmic shoulder keeps the low sun and pale vehicle roofs from
    // clipping while preserving the deliberately saturated toy-diorama palette.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    container.appendChild(this.renderer.domElement);

    // DOM overlay for map labels: crisp, constant screen size at any zoom
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(w, h);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    // placeholder colors; applyWeather (via buildRoad) sets the real mood.
    // The background only peeks through where the far plane clips the dome.
    this.scene.background = SKY.horizonDry.clone();
    this.scene.fog = new THREE.Fog(SKY.horizonDry.clone(), 800, 2000);

    this.camera = new THREE.PerspectiveCamera(50, w / h, 1, 3000);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1400;
    // pan along the ground plane, never in screen space: vertical panning
    // drags controls.target below grade, and then the polar clamp above
    // happily holds the camera underground relative to it. Desktop mice
    // rarely find the pan gesture, but touchscreens with nonstandard event
    // mappings (Tesla's browser) trip it with a plain drag.
    this.controls.screenSpacePanning = false;
    // which auto view ('default' | 'top') the camera is parked in; null once
    // the user orbits/zooms away — refitView() only re-frames parked cameras
    this._autoView = null;
    this.controls.addEventListener('start', () => (this._autoView = null));
    this.setDefaultView(); // after controls exist, so the view target sticks

    this.hemi = new THREE.HemisphereLight(0xd8e2f2, 0x8b7a58, 1.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffdcae, 2.1); // golden-hour key light
    this.sun.position.copy(SUN_DIR).multiplyScalar(450);
    this.scene.add(this.sun);
    // A small, generated sky/ground reflection map gives metal and glass a
    // readable horizon. Baked once; no image downloads or per-frame captures.
    this._environment = proceduralEnvironment(this.renderer);
    this.scene.environment = this._environment.texture;

    this.groundMat = new THREE.MeshStandardMaterial({
      color: GROUND_DRY,
      roughness: 1,
      vertexColors: true,
    });
    const ground = new THREE.Mesh(
      facetedGroundGeo(), // the sole ground surface: no coplanar overlay to flicker
      this.groundMat
    );
    ground.position.y = -0.15;
    this.scene.add(ground);

    this.roadGroup = null;
    this.rampGroup = null;
    this.coneGroup = null;
    this.greenGroup = null;
    this.rampFlowEls = {};
    this._rain = 0;
    this.buildSky(); // before buildRoad: applyWeather drives the sky uniforms
    this.buildRoad();
    this.buildRamps();
    this.buildScenery();
    this.buildWorkZone();
    this.buildCars();
    this.buildRainSheet();

    // faint cross-road marker mirroring the space-time diagram's hovered
    // position (see setRoadCursor); lives outside roadGroup so it survives
    // lane-count and shape rebuilds
    this.roadCursor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false })
    );
    this.roadCursor.visible = false;
    this.scene.add(this.roadCursor);

    this._pos = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._dummy = new THREE.Object3D();
    this._dummy.rotation.order = 'YXZ'; // yaw first, then pitch about the car's own right axis
    this._slope = 0; // current car's road grade (bridge approaches), set per car in update
    this._bodyColor = new THREE.Color();
    this._raycaster = new THREE.Raycaster();
    // Previous fixed-step poses, reused rather than allocated per frame.
    // Physics remains authoritative; this cache only smooths presentation
    // between its 60 Hz steps (see captureCarPoses / carPose).
    this._previousCarPoses = new WeakMap();
    this._wheelMotion = new WheelMotion();
    this._renderAlpha = 1;

    // chase camera state. Yaw/pitch are a held-drag orbit offset around the
    // chased car (0 = the standard behind-the-car framing); on release they
    // ease back to zero (see render) so letting go returns to the follow cam.
    this.chaseCar = null;
    this._chasePos = new THREE.Vector3();
    this._chaseAim = new THREE.Vector3();
    this._chaseYaw = 0;
    this._chasePitch = 0;
    this._chaseDrag = null; // last pointer position while a chase orbit is held
    // Chase-view zoom, as a multiplier on the follow distance. OrbitControls
    // is disabled while chasing, so the wheel and pinch would otherwise do
    // nothing at all: this is the only dolly control chase view has.
    this._chaseZoom = 1;
    this._pointers = new Map(); // live pointerId -> {x, y}, for the pinch gesture
    this._pinch = null;
    this._longPress = 0;
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    // Primary-click detection (as opposed to an orbit drag): small movement,
    // quick release. main.js assigns onRoadClick to crash a picked car, and
    // onVehiclePick to resolve a ray to a visible vehicle (this class then
    // drives the chase itself, from either pick gesture).
    this.onRoadClick = null;
    this.onVehiclePick = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size > 1) {
        // ANY second finger means a two-finger gesture, never a pick: the
        // pinch dolly while chasing, or OrbitControls' own pinch/pan when
        // free. Cancelling has to happen for both, not just the chase case
        // (Codex review): a two-finger gesture held over traffic on the free
        // camera used to leave the FIRST finger's long-press timer armed,
        // which then fired and jumped into a chase on its stale ray.
        this._cancelLongPress();
        this._press = null;
        if (this._pointers.size === 2 && this.chaseCar) {
          this._pinch = { base: this._pointerSpread(), zoom: this._chaseZoom };
          this._chaseDrag = null;
        }
        return;
      }
      // Only the primary button owns click-to-crash. Secondary clicks arrive
      // through `contextmenu` below; without this gate their pointerup used to
      // crash the car before the chase action could run.
      if (e.button !== 0 || isSecondaryClick(e)) {
        this._press = null;
        return;
      }
      if (this.chaseCar && e.button === 0) {
        // in chase view a left press is an orbit gesture, never a click —
        // the chased car sits center-screen, so letting a micro-drag through
        // the click gate below would crash the car being followed
        this._chaseDrag = { x: e.clientX, y: e.clientY };
        this._press = null;
        return;
      }
      this._press = { x: e.clientX, y: e.clientY, t: performance.now() };
      // A finger has no right-click, so a long press is how touch picks a
      // specific vehicle to chase (desktop uses button 2, see contextmenu
      // below). It fires on a timer rather than on release, so the camera
      // cuts over while the finger is still down and the gesture confirms
      // itself; clearing _press stops the release also crashing that car.
      // Before this, a press over 500 ms did nothing at all: the click gate
      // rejected it and the synthesized contextmenu was ignored.
      //
      // Bind the vehicle NOW rather than re-picking when the timer fires:
      // traffic keeps moving through the hold, so the same screen point
      // resolves to whatever has since driven into it. Measured on the
      // default overview, a re-pick returned the touched car only 35% of the
      // time and a DIFFERENT car 57% (just 16% right for free-flowing
      // traffic, which covers ~15 m in 500 ms against a 9 m pick radius).
      // The finger said "that one" (Codex review). No vehicle under it means
      // no timer at all, so a press on empty road stays inert.
      if (e.pointerType !== 'mouse' && this.onVehiclePick) {
        const target = this.onVehiclePick(this.pickRay(e.clientX, e.clientY));
        if (target) {
          this._longPress = setTimeout(() => {
            this._longPress = 0;
            if (!this._press) return; // released, dragged, or a second finger
            this._press = null;
            this.startChase(target);
          }, LONG_PRESS_MS);
        }
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      this._releasePointer(e);
      this._chaseDrag = null;
      this._cancelLongPress();
      const press = this._press;
      this._press = null;
      if (!press || !this.onRoadClick) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (dx * dx + dy * dy > 36 || performance.now() - press.t > 500) return;
      this.onRoadClick(this.pickRay(e.clientX, e.clientY));
    });
    canvas.addEventListener('pointercancel', (e) => {
      this._releasePointer(e);
      this._press = null;
      this._chaseDrag = null;
      this._cancelLongPress();
    });
    // Chase view disables OrbitControls, so the wheel would be dead there.
    // Dolly the follow distance instead; the free camera keeps its own zoom.
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.chaseCar) return;
        e.preventDefault();
        this._zoomChase(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false }
    );
    canvas.addEventListener('contextmenu', (e) => {
      // A native context menu over the 3D canvas is never useful, and it must
      // be suppressed HERE rather than left to OrbitControls, which only does
      // it while enabled. startChase disables controls, so its suppressor
      // returns early exactly when a chase is running: a touch long-press
      // that just started a chase, or a right-click during one, could pop the
      // browser menu on top of the view (Codex review). Suppressing first
      // makes that independent of control state.
      e.preventDefault();
      // Only button 2 or macOS Control-click are desktop secondary clicks; a
      // touch long-press synthesizes this event with the primary button and
      // is handled by its own timer in pointerdown above. No hold here, so
      // picking at event time is exactly right.
      if (!isSecondaryClick(e) || !this.onVehiclePick) return;
      const car = this.onVehiclePick(this.pickRay(e.clientX, e.clientY));
      if (car) this.startChase(car);
    });

    // Hover position for the car readout: buttons pressed means an orbit
    // drag (or a touch), not a hover. main.js re-picks against this every
    // frame so the readout tracks traffic moving under a resting pointer.
    this._pointer = null;
    canvas.addEventListener('pointermove', (e) => {
      this._pointer = e.buttons === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (this._pinch && this._pointers.size >= 2) {
        // pinch out (fingers apart) pulls the camera in, like every map
        const spread = this._pointerSpread();
        if (spread > 1) this._setChaseZoom((this._pinch.base / spread) * this._pinch.zoom);
        return; // a pinch is never also an orbit drag
      }
      // A long press has to hold still to count; a drag is an orbit, not a pick
      if (this._longPress && this._press) {
        const dx = e.clientX - this._press.x;
        const dy = e.clientY - this._press.y;
        if (dx * dx + dy * dy > 64) this._cancelLongPress();
      }
      if (this._chaseDrag && this.chaseCar && e.buttons & 1) {
        // held-drag orbit: horizontal swings around the car, vertical tilts
        this._chaseYaw += (e.clientX - this._chaseDrag.x) * 0.008;
        if (this._chaseYaw > Math.PI) this._chaseYaw -= 2 * Math.PI; // ease-back
        if (this._chaseYaw < -Math.PI) this._chaseYaw += 2 * Math.PI; // takes the short way
        this._chasePitch = THREE.MathUtils.clamp(
          this._chasePitch + (e.clientY - this._chaseDrag.y) * 0.005,
          -0.32, // just above the pavement
          0.9 // well short of straight down
        );
        this._chaseDrag = { x: e.clientX, y: e.clientY };
      }
    });
    canvas.addEventListener('pointerleave', (e) => {
      this._pointer = null;
      this._chaseDrag = null;
      this._releasePointer(e);
      this._cancelLongPress();
    });

    // nameplate above the hovered car (see setHoverCar)
    const tip = document.createElement('div');
    tip.className = 'map-label hover';
    this.hoverName = document.createElement('div');
    this.hoverSub = document.createElement('div');
    this.hoverSub.className = 'sub';
    tip.append(this.hoverName, this.hoverSub);
    this.hoverTip = new CSS2DObject(tip);
    this.hoverTip.center.set(0.5, 1); // bottom-center anchor: label floats above
    this.hoverTip.visible = false;
    this.scene.add(this.hoverTip);

    // Viewport changes resize the buffers AND re-frame the road. Rotating a
    // phone swings the aspect ratio hard, and viewFit()'s distance is
    // computed from it: a fit made in landscape leaves the loop hanging out
    // both sides of the portrait frame (and a portrait fit wastes half a
    // landscape screen). refitView only moves a camera still parked in an
    // auto view, so an orbited camera — and a chase, which nulls _autoView —
    // is left alone. The settle timer is for iOS: innerWidth/innerHeight
    // read stale while the rotation animates, and in an installed app the
    // status/home-bar insets land a frame after that, so every trigger
    // re-measures once the dust has settled.
    const onViewport = () => {
      this.onResize();
      clearTimeout(this._resizeSettle);
      this._resizeSettle = setTimeout(() => {
        this.onResize();
        this.refitView();
      }, 300);
    };
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    // visualViewport fires where `resize` doesn't: iOS collapsing the URL
    // bar in a browser tab, and the on-screen keyboard on any platform
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewport);
    // ...and a ResizeObserver on the container catches what no window event
    // reports at all: the box changing under us. That is the installed-app
    // case — iOS settles its letterboxed containing block after first
    // paint, so #stage's viewport-unit height can land AFTER boot with no
    // resize event to announce it.
    if (typeof ResizeObserver !== 'undefined') {
      this._boxObserver = new ResizeObserver(onViewport);
      this._boxObserver.observe(container);
    }
  }

  // --- chase-view dolly + gesture bookkeeping ---------------------------
  // Distance between the first two live pointers, for the pinch gesture.
  _pointerSpread() {
    const [a, b] = [...this._pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _setChaseZoom(z) {
    this._chaseZoom = THREE.MathUtils.clamp(z, CHASE_ZOOM_MIN, CHASE_ZOOM_MAX);
  }

  _zoomChase(factor) {
    this._setChaseZoom(this._chaseZoom * factor);
  }

  _releasePointer(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
  }

  _cancelLongPress() {
    if (this._longPress) clearTimeout(this._longPress);
    this._longPress = 0;
  }

  // World-space pointer ray from a screen position, for elevation-aware car
  // picking (sim.carNearRay). A ground-plane hit point — the old approach —
  // lands metres past a car on the figure eight's bridge deck.
  pickRay(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    return { origin: this._raycaster.ray.origin.clone(), dir: this._raycaster.ray.direction.clone() };
  }

  // Pointer ray under the resting pointer, or null (off-canvas / mid-drag).
  pointerRay() {
    return this._pointer ? this.pickRay(this._pointer.x, this._pointer.y) : null;
  }

  // Hover readout: nameplate above a car with its live speed and desired
  // speed in parens. Called every frame with the car under the pointer (or
  // null), so the text and anchor stay current as the car drives on.
  setHoverCar(car) {
    this.hoverTip.visible = !!car;
    if (!car) return;
    this.carPose(car, this._pos, this._tan);
    const dims = RENDER_DIMS[modelOf(car)] ?? RENDER_DIMS.car;
    this.hoverTip.position.set(
      this._pos.x,
      this._pos.y + dims.hoverY,
      this._pos.z
    );
    const imp = params.units === 'imperial';
    const unit = imp ? MPH : KMH;
    const want = params.desiredSpeed * car.v0Factor;
    this.hoverName.textContent = `${vehicleLabel(car)} #${car.id}`;
    this.hoverSub.textContent =
      `${Math.round(car.v / unit)} (${Math.round(want / unit)}) ${imp ? 'mph' : 'km/h'}`;
  }

  // The road is rebuilt whenever the lane count or the loop shape changes.
  // Everything is swept along the lane-0 centerline in signed lateral offsets
  // (positive = outward): the outer edge is fixed and lanes grow inward, so
  // ramps and cars' lane-0 geometry hold still when the lane count changes.
  buildRoad() {
    if (this.roadGroup) {
      this.roadGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.roadGroup);
    }
    const g = new THREE.Group();
    const outer = ROAD.laneWidth / 2; // outer edge of lane 0
    const inner = outer - params.lanes * ROAD.laneWidth;

    const paving = (offOut, offIn, color) =>
      new THREE.Mesh(
        loopStrip(offOut, offIn, 0),
        new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide })
      );
    g.add(paving(outer, inner - 1.0, 0x33363b)); // travel lanes + inner apron
    // breakdown lane: slightly darker strip outside the travel lanes
    g.add(paving(outer + ROAD.shoulderWidth, outer, 0x2b2e34));

    const edge = (off, color) =>
      new THREE.Mesh(
        loopStrip(off + 0.15, off - 0.15, 0.02),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
      );
    g.add(edge(outer - 0.2, 0xc8cfd6)); // white outer edge line
    g.add(edge(inner + 0.2, 0xd9b64a)); // yellow inner edge line

    for (let l = 1; l < params.lanes; l++) {
      const off = outer - l * ROAD.laneWidth;
      // Actual pavement-width paint, not a one-pixel GL line: close chase
      // views retain a readable stripe. Approx. 10 ft marks / 30 ft gaps.
      g.add(new THREE.Mesh(
        dashedLaneGeo(off),
        new THREE.MeshBasicMaterial({ color: 0xb9c2cc, side: THREE.DoubleSide })
      ));
    }

    // Two subtle wheel-polished ribbons per lane break up the perfectly flat
    // asphalt. They are one merged mesh, so the extra road detail costs a
    // single draw call regardless of lane count or loop size.
    const wear = [];
    for (let l = 0; l < params.lanes; l++) {
      const center = -l * ROAD.laneWidth;
      for (const track of [-0.78, 0.78]) {
        wear.push(loopStrip(center + track + 0.16, center + track - 0.16, 0.045));
      }
    }
    g.add(
      new THREE.Mesh(
        mergeGeometries(wear),
        new THREE.MeshBasicMaterial({
          color: 0x1c2025,
          transparent: true,
          opacity: 0.16,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          side: THREE.DoubleSide,
        })
      )
    );

    this.buildBridgeInto(g); // concrete under any elevated span (figure eight)

    this.roadGroup = g;
    this.scene.add(g);

    // haze, zoom range, and clip plane all scale with how far the fitted
    // cameras sit from the road — big road scales push the overhead view
    // past the defaults tuned for the 1x loop
    const { h } = this.viewFit();
    this._fogFit = h; // weather scales fog from this base (applyWeather)
    this.applyWeather();
    this.controls.maxDistance = Math.max(1400, h * 1.5);
    this.camera.far = Math.max(6000, h * 4); // floor covers the sky dome + hills
    this.camera.updateProjectionMatrix();
    // keep the dome comfortably inside the far plane at any road scale
    this.skyDome.scale.setScalar((this.camera.far * 0.75) / SKY_R);
  }

  // Bridge dressing wherever the shape's elevation profile leaves the
  // ground (the figure eight's crossing): concrete skirts hang from both
  // pavement edges — running to the ground on the low approaches, so they
  // read as embankments, and hanging 1 m at the span, so the road below
  // passes under an open deck — plus two piers straddling the crossing.
  // Purely cosmetic, like the elevation itself; flat shapes build nothing.
  buildBridgeInto(g) {
    const spans = [];
    let start = null;
    for (let s = 0; s <= LOOP; s += 2) {
      const up = s < LOOP && elevAt(s) > 0.05;
      if (up && start === null) start = s;
      if (!up && start !== null) {
        spans.push([start, s]);
        start = null;
      }
    }
    if (!spans.length) return;
    const outer = ROAD.laneWidth / 2 + ROAD.shoulderWidth;
    const inner = ROAD.laneWidth / 2 - params.lanes * ROAD.laneWidth - 1.0;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8f9190,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (const [s0, s1] of spans) {
      g.add(new THREE.Mesh(bridgeSkirt(s0, s1, outer), mat));
      g.add(new THREE.Mesh(bridgeSkirt(s0, s1, inner), mat));
      const mid = (s0 + s1) / 2;
      for (const ds of [-28, 28]) {
        pointAt(mid + ds, (outer + inner) / 2, p);
        if (p.y < 3) continue; // hump too low here for a pier to read
        forwardAt(mid + ds, t);
        const hgt = p.y - 0.6; // stop under the deck slab
        const pier = new THREE.Mesh(
          new THREE.BoxGeometry(outer - inner - 6, hgt, 1.4),
          mat
        );
        pier.position.set(p.x, hgt / 2 - 0.15, p.z);
        pier.rotation.y = Math.atan2(t.x, t.z); // broad side across the deck
        g.add(pier);
      }
    }
  }

  // Weather mood, driven every frame from sim.rainNow via setRain: darker
  // bluer sky, fog pulled in, dimmer lights, and the rain sheet fading in.
  setRain(r) {
    if (r === this._rain) return;
    this._rain = r;
    this.applyWeather();
  }

  applyWeather() {
    const r = this._rain;
    const h = this._fogFit;
    this.skyMat.uniforms.topColor.value.copy(SKY.topDry).lerp(SKY.topWet, r);
    _sky.copy(SKY.horizonDry).lerp(SKY.horizonWet, r);
    this.skyMat.uniforms.horizonColor.value.copy(_sky);
    this.scene.background.copy(_sky); // matches the dome where the far plane clips it
    this.scene.fog.color.copy(_sky); // distance fades into the horizon band
    this.scene.fog.near = h * 1.35 * (1 - 0.45 * r);
    this.scene.fog.far = h * 3.2 * (1 - 0.45 * r);
    // storms dim harder than they used to: the daylit ground reads wrong
    // staying bright under a slate sky (the old black scene hid this)
    this.sun.intensity = 2.1 * (1 - 0.65 * r);
    this.hemi.intensity = 1.0 * (1 - 0.45 * r);
    this.scene.environmentIntensity = 0.8 * (1 - 0.65 * r);
    this.sunDisc.material.opacity = 0.9 * Math.max(0, 1 - r * 1.6); // storm swallows the sun first
    // clouds are Lambert-lit for puffy facets but sit on an emissive floor so
    // their shaded sides never go charcoal against a bright sky
    _sky.copy(CLOUD_DRY).lerp(CLOUD_WET, r);
    this.cloudMat.color.copy(_sky).multiplyScalar(0.5);
    this.cloudMat.emissive.copy(_sky).multiplyScalar(0.62);
    this.hillMat.color.copy(HILL_DRY).lerp(HILL_WET, r);
    this.groundMat.color.copy(GROUND_DRY).lerp(GROUND_WET, r);
    if (this.terrainReliefMat) {
      this.terrainReliefMat.color.copy(GROUND_DRY).lerp(GROUND_WET, r);
    }
    this.sunHalo.material.opacity = 0.16 * Math.max(0, 1 - r * 1.8);
    if (this.rainPts) {
      this.rainPts.visible = r > 0.03;
      this.rainPts.material.opacity = 0.45 * r;
    }
  }

  // Everything above the horizon: the gradient dome, the sun disc, and a slow
  // carousel of flat-shaded clouds — plus the hill ring that closes it off.
  // All shape-independent (hills sit outside the biggest road's extents), so
  // this builds once; only the dome's scale tracks the camera (buildRoad).
  buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: SKY.topDry.clone() },
        horizonColor: { value: SKY.horizonDry.clone() },
      },
      vertexShader: `
        varying float vH;
        void main() {
          vH = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        varying float vH;
        void main() {
          float t = pow(clamp(vH, 0.0, 1.0), 0.55);
          gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 24, 12), this.skyMat);
    this.skyDome.renderOrder = -1; // paint first; everything else draws over it
    this.skyDome.frustumCulled = false;

    this.sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(150, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffe3b0,
        fog: false,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      })
    );
    this.sunDisc.position.copy(SUN_DIR).multiplyScalar(3900); // inside the dome
    this.sunHalo = new THREE.Mesh(
      new THREE.CircleGeometry(310, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffd5a0,
        fog: false,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      })
    );
    this.sunHalo.position.copy(SUN_DIR).multiplyScalar(3895);

    // dome + sun ride along with the camera so the horizon never shows a seam
    this.skyGroup = new THREE.Group();
    this.skyGroup.add(this.skyDome, this.sunHalo, this.sunDisc);
    this.scene.add(this.skyGroup);

    // clouds: merged icosahedron puffs, instanced, on a slow carousel spin.
    // World-fixed (not camera-tied) so they parallax over the map; fog is off
    // because distance fog would eat them entirely on small road scales.
    this.cloudMat = new THREE.MeshLambertMaterial({ color: CLOUD_DRY, flatShading: true, fog: false });
    const N_CLOUDS = 16;
    const clouds = new THREE.InstancedMesh(cloudGeo(), this.cloudMat, N_CLOUDS);
    const d = new THREE.Object3D();
    for (let i = 0; i < N_CLOUDS; i++) {
      const a = (i / N_CLOUDS) * Math.PI * 2 + Math.random() * 0.6;
      // high and pushed out past the biggest road: a low cloud drifting
      // through the default view reads as a boulder sitting on the map
      const rad = 1000 + Math.random() * 1400;
      d.position.set(Math.cos(a) * rad, 280 + Math.random() * 150, Math.sin(a) * rad);
      d.rotation.set(0, Math.random() * Math.PI * 2, 0);
      d.scale.setScalar(0.8 + Math.random() * 1.1);
      d.updateMatrix();
      clouds.setMatrixAt(i, d.matrix);
    }
    clouds.frustumCulled = false; // instance bounds aren't the geometry's
    this.cloudSpin = new THREE.Group();
    this.cloudSpin.add(clouds);
    this.scene.add(this.cloudSpin);

    // hill ring on the horizon: overlapping low-poly cones, one merged mesh.
    // Unlit — a lit hill this side of the sun renders as a charcoal wall —
    // with per-cone brightness baked as vertex color so the overlaps read as
    // hazy layered ridges. Pre-hazed color instead of fog (they'd sit past
    // fog.far and vanish).
    const cones = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2;
      const rad = 2650 + Math.random() * 850;
      const hgt = 90 + Math.random() * 170;
      const cone = new THREE.ConeGeometry(280 + Math.random() * 400, hgt, 5 + Math.floor(Math.random() * 3));
      cone.rotateY(Math.random() * Math.PI);
      cone.translate(Math.cos(a) * rad, hgt / 2 - 6, Math.sin(a) * rad);
      const shade = 0.8 + Math.random() * 0.35;
      cones.push(colored(cone, new THREE.Color(shade, shade, shade).getHex()));
    }
    this.hillMat = new THREE.MeshBasicMaterial({ color: HILL_DRY, vertexColors: true, fog: false });
    this.hillMesh = new THREE.Mesh(mergeGeometries(cones), this.hillMat);
    this.scene.add(this.hillMesh);
  }

  // Broad ground relief plus trees, bushes and rocks scattered around (and
  // inside) the loop, with a keep-out corridor along the pavement and every
  // ramp. Rebuilt on road changes — the corridor moves with the geometry.
  buildScenery() {
    if (this.greenGroup) {
      this.greenGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.greenGroup);
    }
    const road = []; // flat [x, z, ...] samples of the lane-0 centerline
    const ramps = [];
    const p = new THREE.Vector3();
    for (let s = 0; s < LOOP; s += 5) {
      pointAt(s, 0, p);
      road.push(p.x, p.z);
    }
    for (const ramp of RAMPS) {
      for (let i = 0; i <= 12; i++) {
        ramp.curve.getPointAt(i / 12, p);
        ramps.push(p.x, p.z);
      }
    }
    const clearOf = (arr, x, z, dist) => {
      const dd = dist * dist;
      for (let i = 0; i < arr.length; i += 2) {
        const dx = arr[i] - x;
        const dz = arr[i + 1] - z;
        if (dx * dx + dz * dz < dd) return false;
      }
      return true;
    };
    const b = bounds();
    const R = Math.max(b.halfX, b.halfZ) + 420; // scatter square half-size
    const scatter = (count, dRoad, dRamp, dOther = 0) => {
      const out = [];
      let guard = count * 12; // rejection sampling; dense shapes just get fewer
      while (out.length < count && guard-- > 0) {
        const x = (Math.random() * 2 - 1) * R;
        const z = (Math.random() * 2 - 1) * R;
        const separate = !dOther || out.every(([ox, oz]) => (
          (ox - x) ** 2 + (oz - z) ** 2 >= dOther ** 2
        ));
        if (
          separate
          && clearOf(road, x, z, dRoad)
          && clearOf(ramps, x, z, dRamp)
        ) out.push([x, z]);
      }
      return out;
    };

    const g = new THREE.Group();
    const d = new THREE.Object3D();
    const tint = new THREE.Color();
    // one InstancedMesh per prop kind; vertex colors carry the trunk/canopy
    // split and the per-instance color multiplies the whole prop for variety
    const plant = (geo, spots, s0, ds, autumn = false) => {
      const mesh = new THREE.InstancedMesh(
        geo,
        new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
        spots.length
      );
      spots.forEach(([x, z], i) => {
        const k = s0 + Math.random() * ds;
        d.position.set(x, 0, z);
        d.rotation.set(0, Math.random() * Math.PI * 2, 0);
        d.scale.set(k, k * (0.9 + Math.random() * 0.25), k);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        const v = 0.85 + Math.random() * 0.3;
        if (autumn && Math.random() < 0.18) tint.setRGB(1.5 * v, 0.85 * v, 0.4 * v);
        else tint.setRGB(v, v, v);
        mesh.setColorAt(i, tint);
      });
      mesh.frustumCulled = false;
      g.add(mesh);
    };
    plant(pineGeo(), scatter(160, 30, 18), 0.7, 0.7);
    plant(broadleafGeo(), scatter(120, 30, 18), 0.7, 0.6, true);
    plant(bushGeo(), scatter(70, 21, 12), 0.8, 0.9);
    plant(rockGeo(), scatter(30, 19, 12), 0.6, 1.0);

    // Sparse, broad mounds make the landscape visibly dimensional from the
    // normal overview without bringing back the coplanar patch overlay that
    // flickered. One low-poly InstancedMesh adds a single draw call. The
    // generous center keep-out exceeds the largest mound radius, leaving a
    // clear verge around roads, ramps and both levels of the eight crossing.
    const moundSpots = scatter(
      Math.min(44, Math.max(26, Math.round(R / 24))),
      115,
      95,
      100
    );
    this.terrainReliefMat = new THREE.MeshStandardMaterial({
      color: GROUND_DRY.clone().lerp(GROUND_WET, this._rain),
      roughness: 1,
      flatShading: true,
    });
    const mounds = new THREE.InstancedMesh(
      terrainMoundGeo(),
      this.terrainReliefMat,
      moundSpots.length
    );
    moundSpots.forEach(([x, z], i) => {
      const sx = 38 + Math.random() * 24;
      const sz = sx * (0.8 + Math.random() * 0.4);
      d.position.set(x, -0.15, z);
      d.rotation.set(0, Math.random() * Math.PI * 2, 0);
      d.scale.set(sx, 22 + Math.random() * 8, sz);
      d.updateMatrix();
      mounds.setMatrixAt(i, d.matrix);
      const v = 0.98 + Math.random() * 0.03;
      tint.setRGB(v, v, v);
      mounds.setColorAt(i, tint);
    });
    mounds.frustumCulled = false;
    g.add(mounds);
    this.greenGroup = g;
    g.visible = !!params.scenery;
    this.scene.add(g);
  }

  // A sheet of falling points that rides along with the camera — cheap
  // (one geometry, y-wrap per frame) but it sells the storm.
  buildRainSheet() {
    const N = 2200;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * RAIN_BOX;
      pos[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
      pos[i * 3 + 2] = (Math.random() - 0.5) * RAIN_BOX;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainPts = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0x9fb6cc,
        size: 0.7,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      })
    );
    this.rainPts.visible = false;
    this.rainPts.frustumCulled = false;
    this.scene.add(this.rainPts);
  }

  // Rebuilt on shape changes; ramp curves live in road.js and are already new.
  buildRamps() {
    if (this.rampGroup) {
      this.rampGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
        if (o.isCSS2DObject) o.element.remove(); // CSS2DRenderer never GCs the div itself
      });
      this.scene.remove(this.rampGroup);
    }
    const g = new THREE.Group();
    this.rampFlowEls = {};
    this.meterSignals = []; // {rampId, group, redMat, greenMat}, driven by updateMeters
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a3d44,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    const lineMat = new THREE.LineBasicMaterial({ color: 0xc8cfd6 });
    for (const ramp of RAMPS) {
      g.add(new THREE.Mesh(rampRibbon(ramp.curve, 6.0), mat));
      // Outer (right-hand) edge line runs the full ramp; the inner one stops
      // short of the merge/diverge area so it doesn't scribble on the road.
      g.add(rampEdgeLine(ramp.curve, 2.7, lineMat, 0, 1));
      if (ramp.type === 'on') g.add(rampEdgeLine(ramp.curve, -2.7, lineMat, 0, 0.55));
      else g.add(rampEdgeLine(ramp.curve, -2.7, lineMat, 0.45, 1));
      if (ramp.type === 'on') g.add(this.buildMeter(ramp));

      // Label at the ramp's outer end, nudged past the pavement.
      const el = document.createElement('div');
      el.className = `map-label ${ramp.type}`;
      const name = document.createElement('div');
      name.textContent = ramp.label;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = '—';
      el.append(name, sub);
      this.rampFlowEls[ramp.id] = sub;
      const atStart = ramp.type === 'on'; // on-ramps enter at u=0, exits leave at u=1
      const anchor = ramp.curve.getPointAt(atStart ? 0 : 1);
      const dir = ramp.curve.getTangentAt(atStart ? 0 : 1);
      if (atStart) dir.negate();
      anchor.addScaledVector(dir, 16);
      anchor.y = 2;
      const labelObj = new CSS2DObject(el);
      labelObj.position.copy(anchor);
      g.add(labelObj);
    }
    this.rampGroup = g;
    this.scene.add(g);
  }

  // Ramp-meter dressing at an on-ramp's stop line (the start of its merge
  // zone, mirroring the sim's held-queue wall): a painted stop bar plus a
  // two-lamp signal on the driver's-right shoulder. Hidden unless metering
  // is on; updateMeters drives visibility and the lamp swap every frame.
  buildMeter(ramp) {
    const group = new THREE.Group();
    const u = (ramp.length - ramp.mergeZone) / ramp.length;
    const pt = ramp.curve.getPointAt(u);
    const tan = ramp.curve.getTangentAt(u);
    const yaw = Math.atan2(tan.x, tan.z);
    const side = new THREE.Vector3(tan.z, 0, -tan.x); // driver's right

    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(5.2, 0.04, 0.45),
      new THREE.MeshBasicMaterial({ color: 0xd8dde2 })
    );
    bar.position.set(pt.x, 0.03, pt.z);
    bar.rotation.y = yaw;
    group.add(bar);

    const post = new THREE.Group();
    post.position.set(pt.x + side.x * 3.9, 0, pt.z + side.z * 3.9);
    post.rotation.y = yaw;
    const dark = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.85 });
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.9, 0.16), dark);
    pole.position.y = 1.45;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.52, 1.05, 0.3), dark);
    head.position.y = 3.2;
    // unlit lamps read as light sources; slightly proud of the head so they
    // show from every angle (same trick as the vehicle light bars)
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff4040 });
    const greenMat = new THREE.MeshBasicMaterial({ color: 0x14351c });
    const red = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), redMat);
    red.position.y = 3.42;
    const green = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), greenMat);
    green.position.y = 2.98;
    post.add(pole, head, red, green);
    group.add(post);

    group.visible = false;
    this.meterSignals.push({ rampId: ramp.id, group, redMat, greenMat });
    return group;
  }

  // Meter visibility + lamp state, called every frame from main.js with the sim.
  updateMeters(sim) {
    for (const m of this.meterSignals) {
      m.group.visible = !!params.metering;
      if (!m.group.visible) continue;
      const st = sim.rampState.get(m.rampId);
      const green = st && st.greenUntil > sim.time;
      m.redMat.color.set(green ? 0x3a1518 : 0xff4040);
      m.greenMat.color.set(green ? 0x3ef06a : 0x14351c);
    }
  }

  // Everything that depends on the loop geometry, after a shape change.
  // (The sim must have been reset first so road.js holds the new shape.)
  onRoadChanged() {
    this.buildRoad();
    this.buildRamps();
    this.buildScenery(); // re-scatter: the keep-out corridor moved
    this.buildWorkZone(); // zone position is a % of the loop: it maps across shapes
    this.setDefaultView();
  }

  onWorkZoneChanged() {
    this.buildWorkZone();
  }

  // Traffic cones for the work zone: a diagonal taper sweeping the closed
  // (innermost) lane shut, a cone line just inside the open-lane boundary
  // through the zone, and a short taper back open at the end. Mirrors
  // sim.workZone()'s geometry, derived from the same params.
  buildWorkZone() {
    if (this.coneGroup) {
      this.coneGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.coneGroup);
      this.coneGroup = null;
    }
    if (!params.workZone) return;
    const lane = params.lanes - 1;
    const W = ROAD.laneWidth;
    const len = Math.min(params.workZoneLen, LOOP - 100);
    const sStart = wrap((params.workZonePos / 100) * LOOP);
    const innerEdge = -(lane + 0.5) * W + 0.35; // just off the yellow line
    const line = -(lane - 0.5) * W - 0.35; // just inside the open-lane boundary

    // (s, lateral) stations: approach taper, the zone line, closing taper
    const spots = [];
    const TAPER = 60;
    for (let i = 0; i <= 10; i++) {
      spots.push([sStart - TAPER + (i / 10) * TAPER, innerEdge + (i / 10) * (line - innerEdge)]);
    }
    for (let d = 12; d < len - 8; d += 12) spots.push([sStart + d, line]);
    for (let i = 0; i <= 4; i++) {
      spots.push([sStart + len - 8 + (i / 4) * 8, line + (i / 4) * (innerEdge - line)]);
    }

    const cones = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.34, 0.85, 8).translate(0, 0.42, 0),
      new THREE.MeshStandardMaterial({ color: 0xff7a1f, roughness: 0.8 }),
      spots.length
    );
    // locals: this runs from the constructor before the pooled vectors exist
    const pos = new THREE.Vector3();
    const d = new THREE.Object3D();
    for (let i = 0; i < spots.length; i++) {
      pointAt(wrap(spots[i][0] + LOOP), spots[i][1], pos);
      d.position.set(pos.x, pos.y, pos.z); // pos.y: cones ride any bridge
      d.updateMatrix();
      cones.setMatrixAt(i, d.matrix);
    }
    cones.frustumCulled = false;
    this.coneGroup = new THREE.Group();
    this.coneGroup.add(cones);
    this.scene.add(this.coneGroup);
  }

  buildCars() {
    // Procedural body panels keep the faceted style; show their inner faces
    // as well when the camera looks through an open wheel arch.
    const bodyMat = new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.25,
      side: THREE.DoubleSide,
    });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.9 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xaeb8bf, roughness: 0.42, metalness: 0.55 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: GLASS_TINT,
      roughness: 0.48,
      metalness: 0.08,
      side: THREE.DoubleSide,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2d3237, roughness: 0.82 });
    const indicatorLensMat = new THREE.MeshStandardMaterial({
      color: 0x8a5d16,
      roughness: 0.45,
      metalness: 0.08,
    });
    const rearLensMat = new THREE.MeshStandardMaterial({ color: 0x761c22, roughness: 0.42 });
    // Named procedural parts preserve body styles while separating paint,
    // glass and wheel openings. Both styles still share one wheel pool.
    const passengerLensMat = new THREE.MeshStandardMaterial({ color: 0xe0e8ed, roughness: 0.35 });
    for (const [prefix, hatch] of [['sedan', false], ['hatch', true]]) {
      const parts = buildPassengerGeometry(hatch);
      this[prefix] = new THREE.InstancedMesh(parts.body, bodyMat, MAX_CARS);
      this[prefix + 'Cabin'] = new THREE.InstancedMesh(parts.glass, glassMat, MAX_CARS);
      this[prefix + 'Trim'] = new THREE.InstancedMesh(parts.trim, trimMat, MAX_CARS);
      this[prefix + 'FrontLenses'] = new THREE.InstancedMesh(parts.frontLens, passengerLensMat, MAX_CARS);
      this[prefix + 'Indicators'] = new THREE.InstancedMesh(parts.indicators, indicatorLensMat, MAX_CARS);
      this[prefix + 'RearLenses'] = new THREE.InstancedMesh(parts.rearLens, rearLensMat, MAX_CARS);
      this['_' + prefix + 'Meshes'] = ['', 'Cabin', 'Trim', 'FrontLenses', 'Indicators', 'RearLenses'].map(suffix => this[prefix + suffix]);
    }
    const passengerWheels = buildPassengerWheels();
    this.wheels = new THREE.InstancedMesh(passengerWheels.wheels, wheelMat, MAX_CARS);
    this.hubs = new THREE.InstancedMesh(passengerWheels.hubs, hubMat, MAX_CARS);
    // Tractor and trailer keep visible clearance above their real dual tires.
    const semi = buildSemiGeometry();
    const metalMat = new THREE.MeshStandardMaterial({ color: 0xb3bec5, roughness: 0.48, metalness: 0.55 });
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8ece9, roughness: 0.55 });
    this._truckMeshes = [];
    for (const [name, part, material] of [
      ['cab', 'cab', bodyMat], ['trailer', 'trailer', bodyMat],
      ['truckGlass', 'glass', glassMat], ['truckTrim', 'trim', trimMat],
      ['truckFrontLenses', 'frontLens', passengerLensMat], ['truckRearLenses', 'rearLens', rearLensMat],
      ['truckIndicators', 'indicators', indicatorLensMat], ['truckWheels', 'wheels', wheelMat],
      ['truckHubs', 'hubs', metalMat], ['truckChassis', 'chassis', trimMat],
      ['truckMetal', 'metal', metalMat], ['truckReflectorWhite', 'reflectorWhite', whiteMat],
      ['truckReflectorRed', 'reflectorRed', new THREE.MeshStandardMaterial({ color: 0xbc3035, roughness: 0.6 })],
    ]) {
      this[name] = new THREE.InstancedMesh(semi[part], material, MAX_TRUCKS);
      this._truckMeshes.push(this[name]);
    }
    // Geometry providers share metres / +z-forward / road-level origin. An
    // authored asset could later supply the same buffers without touching
    // the simulation or instance update path.
    const cyber = buildCybertruckGeometry();
    this.cyber = new THREE.InstancedMesh(cyber.body,
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.72 }), MAX_CARS);
    this.cyberTrim = new THREE.InstancedMesh(cyber.trim, trimMat, MAX_CARS);
    this.cyberWheels = new THREE.InstancedMesh(cyber.wheels, wheelMat, MAX_CARS);
    this.cyberHubs = new THREE.InstancedMesh(cyber.hubs,
      new THREE.MeshStandardMaterial({ color: 0x353b42, roughness: 0.6, metalness: 0.35 }), MAX_CARS);
    this.cyberGlass = new THREE.InstancedMesh(cyber.glass,
      new THREE.MeshStandardMaterial({ color: 0x182b3c, roughness: 0.24, metalness: 0.22 }), MAX_CARS);
    // Pale dormant lens: its signature light bar is visible in daylight,
    // while red brake and amber turn lamps still communicate driver state.
    this.cyberFrontLens = new THREE.InstancedMesh(cyber.frontLens,
      new THREE.MeshStandardMaterial({ color: 0xe7edf0, roughness: 0.32 }), MAX_CARS);
    this.cyberRearLens = new THREE.InstancedMesh(cyber.rearLens, rearLensMat, MAX_CARS);
    // A standard-car-length EV shares the ACC controller with the pickup.
    // Every part is instanced, and only the body receives analytical colors.
    const ev = buildEVGeometry();
    this.ev = new THREE.InstancedMesh(ev.body, bodyMat, MAX_CARS);
    this.evGlass = new THREE.InstancedMesh(ev.glass, glassMat, MAX_CARS);
    this.evTrim = new THREE.InstancedMesh(ev.trim, trimMat, MAX_CARS);
    this.evWheels = new THREE.InstancedMesh(ev.wheels, wheelMat, MAX_CARS);
    this.evHubs = new THREE.InstancedMesh(ev.hubs,
      new THREE.MeshStandardMaterial({ color: 0x656f79, roughness: 0.48, metalness: 0.4 }), MAX_CARS);
    this.evFrontLens = new THREE.InstancedMesh(ev.frontLens,
      new THREE.MeshStandardMaterial({ color: 0xe7edf0, roughness: 0.32 }), MAX_CARS);
    this.evRearLens = new THREE.InstancedMesh(ev.rearLens, rearLensMat, MAX_CARS);
    this._evMeshes = [this.ev, this.evGlass, this.evTrim, this.evWheels,
      this.evHubs, this.evFrontLens, this.evRearLens];
    const ambulance = buildAmbulanceGeometry();
    this._ambMeshes = [];
    for (const [name, part, material] of [
      ['ambBody', 'body', bodyMat], ['ambGlass', 'glass', glassMat], ['ambTrim', 'trim', trimMat],
      ['ambStripe', 'stripe', new THREE.MeshStandardMaterial({ color: 0xc63a30, roughness: 0.5, metalness: 0.25 })],
      ['ambEquipment', 'equipment', metalMat],
      ['ambMarkings', 'markings', new THREE.MeshStandardMaterial({ color: 0x236c9a, roughness: 0.6 })],
      ['ambFrontLenses', 'frontLens', passengerLensMat], ['ambRearLenses', 'rearLens', rearLensMat],
      ['ambWheels', 'wheels', wheelMat], ['ambHubs', 'hubs', metalMat],
    ]) {
      this[name] = new THREE.InstancedMesh(ambulance[part], material, MAX_EMERGENCY);
      this._ambMeshes.push(this[name]);
    }

    // A contrasting patrol livery reads as police even between strobe flashes.
    const police = buildPoliceGeometry();
    const policeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.54, metalness: 0.12 });
    const policeTrimMat = new THREE.MeshStandardMaterial({ color: 0x11161b, roughness: 0.78, metalness: 0.18 });
    this._policeMeshes = [];
    for (const [name, part, material] of [
      ['policeBody', 'body', bodyMat], ['policeRoof', 'roof', policeWhiteMat],
      ['policeGlass', 'glass', glassMat], ['policePanels', 'panels', policeWhiteMat],
      ['policeTrim', 'trim', policeTrimMat], ['policeFrontLenses', 'frontLens', passengerLensMat],
      ['policeRearLenses', 'rearLens', rearLensMat], ['policeIndicators', 'indicators', indicatorLensMat],
      ['policeWheels', 'wheels', wheelMat], ['policeHubs', 'hubs', metalMat],
    ]) {
      this[name] = new THREE.InstancedMesh(police[part], material, MAX_EMERGENCY);
      this._policeMeshes.push(this[name]);
    }

    // A compact pumper with separate dark pump faces and silver equipment.
    const fire = buildFiretruckGeometry();
    this._fireMeshes = [];
    for (const [name, part, material] of [
      ['fireBody', 'body', bodyMat], ['fireGlass', 'glass', glassMat], ['fireTrim', 'trim', trimMat],
      ['fireStripe', 'stripe', new THREE.MeshStandardMaterial({ color: 0xf0c64b, roughness: 0.48, metalness: 0.18 })],
      ['fireEquipment', 'equipment', metalMat], ['fireFrontLenses', 'frontLens', passengerLensMat],
      ['fireRearLenses', 'rearLens', rearLensMat], ['fireIndicators', 'indicators', indicatorLensMat],
      ['fireWheels', 'wheels', wheelMat], ['fireHubs', 'hubs', metalMat],
    ]) {
      this[name] = new THREE.InstancedMesh(fire[part], material, MAX_EMERGENCY);
      this._fireMeshes.push(this[name]);
    }

    // Rotate each axle in the vertex shader while retaining one batched tire
    // mesh and one hub mesh per model. Both share a single angle per vehicle.
    this._wheelAngles = {};
    for (const [model, tires, hubs] of [
      ['car', this.wheels, this.hubs],
      ['truck', this.truckWheels, this.truckHubs],
      ['cybertruck', this.cyberWheels, this.cyberHubs],
      ['ev', this.evWheels, this.evHubs],
      ['ambulance', this.ambWheels, this.ambHubs],
      ['police', this.policeWheels, this.policeHubs],
      ['firetruck', this.fireWheels, this.fireHubs],
    ]) {
      const angles = new THREE.InstancedBufferAttribute(new Float32Array(tires.instanceMatrix.count), 1);
      angles.setUsage(THREE.DynamicDrawUsage);
      this._wheelAngles[model] = angles;
      for (const mesh of [tires, hubs]) {
        annotateRollingGeometry(mesh.geometry, WHEEL_LAYOUTS[model]);
        mesh.geometry.setAttribute('wheelAngle', angles);
        mesh.material = makeWheelMaterial(mesh.material);
      }
    }

    this.strobes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX_EMERGENCY * 2
    );

    // Driver-communication lights: paired red lamps (the ACC keeps its thin
    // tailgate strip) and amber blinkers, placed per frame at per-kind mounts.
    // Unlit materials make the scaled unit cubes read as light sources.
    const lightGeo = new THREE.BoxGeometry(1, 1, 1);
    this.brakeLights = new THREE.InstancedMesh(
      lightGeo,
      new THREE.MeshBasicMaterial({ color: 0xff3030 }),
      MAX_LIGHTS
    );
    this.blinkers = new THREE.InstancedMesh(
      lightGeo,
      new THREE.MeshBasicMaterial({ color: 0xffb226 }),
      MAX_LIGHTS
    );
    // One instanced, translucent footprint pool grounds every vehicle. Each
    // matrix supplies its own width/length, avoiding a mesh per vehicle kind.
    this.contactShadows = new THREE.InstancedMesh(
      contactShadowGeo(),
      new THREE.MeshBasicMaterial({
        color: 0x11151a,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      MAX_SHADOWS
    );
    this._meshes = [
      ...this._sedanMeshes, ...this._hatchMeshes, this.wheels, this.hubs,
      ...this._truckMeshes,
      this.cyber, this.cyberTrim, this.cyberWheels, this.cyberHubs,
      this.cyberGlass, this.cyberFrontLens, this.cyberRearLens,
      ...this._evMeshes,
      ...this._ambMeshes, ...this._policeMeshes, ...this._fireMeshes,
      this.contactShadows, this.strobes, this.brakeLights, this.blinkers,
    ];
    for (const m of this._meshes) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      // three.js culls an InstancedMesh by its BASE geometry's bounding
      // sphere — one car-sized blob at the world origin, ignoring where the
      // instances are. Any camera pose that doesn't contain the loop's center
      // (easy in chase view on big roads) would cull every vehicle at once.
      m.frustumCulled = false;
      this.scene.add(m);
    }
    this._lightDummy = new THREE.Object3D();
    this._shadowDummy = new THREE.Object3D();
    this._shadowDummy.rotation.order = 'YXZ';
  }

  // Place one light: the car's local-frame offset rotated into the world.
  // The slope term keeps mounts on the body when the car sits on a grade
  // (a fore/aft offset oz gains slope·oz of height on a pitched car). localYaw
  // lets a corner lamp wrap around a tapered bumper without special geometry.
  placeLight(mesh, idx, rotY, ox, oy, oz, sx, sy, sz, localYaw = 0) {
    const d = this._lightDummy;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    d.position.set(
      this._pos.x + ox * cos + oz * sin,
      this._pos.y + oy + this._slope * oz,
      this._pos.z - ox * sin + oz * cos
    );
    d.rotation.set(0, rotY + localYaw, 0);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    mesh.setMatrixAt(idx, d.matrix);
  }

  // Called after each physics step, using the resolved speed (including jam
  // and collision stops). Simulation time keeps pause/time scale consistent.
  advanceWheels(cars, dt) {
    for (const car of cars) {
      this._wheelMotion.advance(car, dt, (WHEEL_LAYOUTS[modelOf(car)] ?? WHEEL_LAYOUTS.car).radius);
    }
  }

  // Called immediately before each fixed simulation step. If a display frame
  // runs several steps, later captures overwrite earlier ones, leaving the
  // state directly before the final step—the correct interpolation endpoint.
  captureCarPoses(cars) {
    for (const car of cars) {
      let pose = this._previousCarPoses.get(car);
      if (!pose) {
        pose = {};
        this._previousCarPoses.set(car, pose);
      }
      pose.state = car.state;
      pose.ramp = car.ramp;
      pose.s = car.s;
      pose.renderLane = car.renderLane;
      pose.rampPos = car.rampPos;
    }
  }

  update(cars, renderAlpha = 1) {
    this._renderAlpha = THREE.MathUtils.clamp(renderAlpha, 0, 1);
    const desired = params.desiredSpeed;
    const blinkOn = Math.floor(performance.now() / 400) % 2 === 0; // hazard flashers
    let ci = 0; // next free sedan instance
    let hi = 0; // next free hatchback instance
    let ti = 0; // next free truck instance
    let ai = 0; // next free Cybertruck instance
    let ei = 0; // next free EV instance
    let mi = 0; // next free ambulance instance
    let pi = 0; // next free police-interceptor instance
    let fi = 0; // next free fire-truck instance
    let wi = 0; // next free car wheel-set instance (sedans + hatches)
    let sh = 0; // next shared contact-shadow instance
    let si = 0; // next free strobe instance
    let li = 0; // next free brake-light instance
    let ki = 0; // next free blinker instance
    for (const car of cars) {
      const model = modelOf(car);
      const truck = model === 'truck';
      const cyber = model === 'cybertruck';
      const ev = model === 'ev';
      const ambu = car.kind === 'ambulance';
      const police = car.kind === 'police';
      const firetruck = car.kind === 'firetruck';
      const emergency = isEmergencyVehicle(car.kind);
      const dims = RENDER_DIMS[model] ?? RENDER_DIMS.car;
      const hatch = model === 'car' && (car.id & 1) === 1; // stable body style per car
      if (
        truck ? ti >= MAX_TRUCKS
          : ambu ? mi >= MAX_EMERGENCY
            : police ? pi >= MAX_EMERGENCY
              : firetruck ? fi >= MAX_EMERGENCY
                : (cyber ? ai : ev ? ei : hatch ? hi : ci) >= MAX_CARS
      )
        continue;
      const poseS = this.carPose(car, this._pos, this._tan);
      let rotY = Math.atan2(this._tan.x, this._tan.z);
      if (!car.ramp && car.wreckYaw && car.v < 3) rotY += car.wreckYaw; // skidded askew
      // grade: pitch the body up/down the bridge approaches (rotation order
      // is YXZ so pitch turns about the yawed, car-local right axis); the
      // slope also corrects the light mounts' height in placeLight
      this._slope = car.ramp ? 0 : (elevAt(poseS + 3) - elevAt(poseS - 3)) / 6;
      this._dummy.position.set(this._pos.x, this._pos.y, this._pos.z);
      this._dummy.rotation.set(this._slope === 0 ? 0 : -Math.atan(this._slope), rotY, 0);
      this._dummy.updateMatrix();

      if (sh < MAX_SHADOWS) {
        const d = this._shadowDummy;
        const pitch = this._slope === 0 ? 0 : -Math.atan(this._slope);
        d.position.set(this._pos.x, this._pos.y + 0.045, this._pos.z);
        d.rotation.set(pitch, rotY, 0);
        d.scale.set(
          dims.shadowHalfW,
          1,
          Math.max(1, car.len / 2 - dims.shadowInset)
        );
        d.updateMatrix();
        this.contactShadows.setMatrixAt(sh++, d.matrix);
      }

      if (car.incident) {
        this._bodyColor.set(blinkOn ? 0xffa726 : 0x5c3a12); // amber hazards
      } else if (params.colorMode === 'speed') {
        const t = THREE.MathUtils.clamp(car.v / desired, 0, 1);
        this._bodyColor.setHSL(t * 0.33, 0.85, 0.5);
      } else if (params.colorMode === 'type') {
        this._bodyColor.copy(TYPE_COLORS[car.kind] ?? TYPE_COLORS.car);
      } else {
        this._bodyColor.setHSL(car.hue, 0.65, 0.55);
      }
      // Per-car presentation exposes bare stainless; analytical modes retain
      // their full speed/type tint so the vehicle remains readable as data.
      if (cyber && !car.incident && params.colorMode === 'random') this._bodyColor.set(0xbfc6c9);
      // Emergency liveries remain recognizable under every color mode.
      if (emergency && !car.incident) this._bodyColor.copy(TYPE_COLORS[car.kind]);
      if (truck) {
        this._wheelAngles.truck.setX(ti, this._wheelMotion.angle(car, this._renderAlpha));
        for (const mesh of this._truckMeshes) mesh.setMatrixAt(ti, this._dummy.matrix);
        // Neutral dry-van panels contrast with the cab paint in presentation
        // mode; speed/type/hazard colors still cover the complete vehicle.
        this.trailer.setColorAt(ti, params.colorMode === 'random' && !car.incident ? TRAILER_PAINT : this._bodyColor);
        this.cab.setColorAt(ti, this._bodyColor);
        ti++;
      } else if (ambu) {
        this._wheelAngles.ambulance.setX(mi, this._wheelMotion.angle(car, this._renderAlpha));
        for (const mesh of this._ambMeshes) mesh.setMatrixAt(mi, this._dummy.matrix);
        this.ambBody.setColorAt(mi, this._bodyColor);
        mi++;
      } else if (police) {
        this._wheelAngles.police.setX(pi, this._wheelMotion.angle(car, this._renderAlpha));
        for (const mesh of this._policeMeshes) mesh.setMatrixAt(pi, this._dummy.matrix);
        this.policeBody.setColorAt(pi, this._bodyColor);
        pi++;
      } else if (firetruck) {
        this._wheelAngles.firetruck.setX(fi, this._wheelMotion.angle(car, this._renderAlpha));
        for (const mesh of this._fireMeshes) mesh.setMatrixAt(fi, this._dummy.matrix);
        this.fireBody.setColorAt(fi, this._bodyColor);
        fi++;
      } else if (cyber) {
        this._wheelAngles.cybertruck.setX(ai, this._wheelMotion.angle(car, this._renderAlpha));
        this.cyber.setMatrixAt(ai, this._dummy.matrix);
        this.cyberTrim.setMatrixAt(ai, this._dummy.matrix);
        this.cyberWheels.setMatrixAt(ai, this._dummy.matrix);
        this.cyberHubs.setMatrixAt(ai, this._dummy.matrix);
        this.cyberGlass.setMatrixAt(ai, this._dummy.matrix);
        this.cyberFrontLens.setMatrixAt(ai, this._dummy.matrix);
        this.cyberRearLens.setMatrixAt(ai, this._dummy.matrix);
        this.cyber.setColorAt(ai, this._bodyColor);
        ai++;
      } else if (ev) {
        this._wheelAngles.ev.setX(ei, this._wheelMotion.angle(car, this._renderAlpha));
        for (const mesh of this._evMeshes) mesh.setMatrixAt(ei, this._dummy.matrix);
        this.ev.setColorAt(ei++, this._bodyColor);
      } else {
        const body = hatch ? this.hatch : this.sedan;
        const idx = hatch ? hi++ : ci++;
        for (const mesh of hatch ? this._hatchMeshes : this._sedanMeshes) mesh.setMatrixAt(idx, this._dummy.matrix);
        body.setColorAt(idx, this._bodyColor);
        if (wi < MAX_CARS) {
          this._wheelAngles.car.setX(wi, this._wheelMotion.angle(car, this._renderAlpha));
          this.wheels.setMatrixAt(wi, this._dummy.matrix);
          this.hubs.setMatrixAt(wi++, this._dummy.matrix);
        }
      }

      if (emergency && !car.incident && si + 1 < MAX_EMERGENCY * 2) {
        // Two unlit blocks form each roof bar. Their type-specific mount keeps
        // the police bar low and the fire-engine bar above its forward cab.
        const S = dims.strobe;
        this.placeLight(this.strobes, si, rotY, S.x, S.y, S.z, S.sx, S.sy, S.sz);
        this.strobes.setColorAt(si++, blinkOn ? STROBE_RED : STROBE_BLUE);
        this.placeLight(this.strobes, si, rotY, -S.x, S.y, S.z, S.sx, S.sy, S.sz);
        this.strobes.setColorAt(si++, blinkOn ? STROBE_BLUE : STROBE_RED);
      }

      // brake lights + blinkers (incident cars blink their whole body amber)
      if (!car.incident) {
        const L = model === 'car' ? LIGHT_DIMS.car[car.id & 1] : LIGHT_DIMS[model];
        if (car.brakeLit) {
          if (L.brakeHalfW != null && li + 1 < MAX_LIGHTS) {
            // Conventional paired lamps sit directly over the dormant red
            // lenses. The actual lens geometry now carries the live state;
            // there is no separate full-width brake bar to cross rear seams.
            for (const side of [-1, 1]) {
              this.placeLight(
                this.brakeLights, li++, rotY,
                side * L.brakeHalfW, L.brakeY, L.brakeZ,
                L.brakeW, L.brakeH, L.brakeDepth ?? 0.025
              );
            }
          } else if (li < MAX_LIGHTS) {
            // Both electric bodies use a thin full-width rear strip.
            this.placeLight(
              this.brakeLights, li++, rotY,
              0, L.brakeY ?? L.y, L.brakeZ ?? L.rear,
              L.brakeW, L.brakeH ?? 0.16, 0.025
            );
          }
        }
        if (car.signal !== 0 && blinkOn && ki + 1 < MAX_LIGHTS) {
          const dir = car.signal > 0 ? 1 : -1; // +x local = driver's left
          const sxRear = dir * (L.blinkHalfWR ?? L.halfW);
          const sxFront = dir * (L.blinkHalfWF ?? L.halfW);
          const bw = L.blinkW ?? 0.22;
          const bh = L.blinkH ?? 0.2;
          this.placeLight(
            this.blinkers, ki++, rotY,
            sxRear, L.blinkYR ?? L.y, L.blinkZR ?? L.rear,
            L.blinkWR ?? bw, L.blinkHR ?? bh, L.blinkDepthR ?? 0.14
          );
          this.placeLight(
            this.blinkers, ki++, rotY,
            sxFront, L.blinkYF ?? L.y, L.blinkZF ?? L.front,
            L.blinkWF ?? bw, L.blinkHF ?? bh, L.blinkDepthF ?? 0.14,
            dir * (L.blinkYawF ?? 0)
          );
        }
      }
    }
    for (const mesh of this._sedanMeshes) mesh.count = ci;
    for (const mesh of this._hatchMeshes) mesh.count = hi;
    this.wheels.count = wi;
    this.hubs.count = wi;
    for (const mesh of this._truckMeshes) mesh.count = ti;
    this.cyber.count = ai;
    this.cyberTrim.count = ai;
    this.cyberWheels.count = ai;
    this.cyberHubs.count = ai;
    this.cyberGlass.count = ai;
    for (const mesh of this._evMeshes) mesh.count = ei;
    this.cyberFrontLens.count = ai;
    this.cyberRearLens.count = ai;
    for (const mesh of this._ambMeshes) mesh.count = mi;
    for (const mesh of this._policeMeshes) mesh.count = pi;
    for (const mesh of this._fireMeshes) mesh.count = fi;
    this.contactShadows.count = sh;
    this.strobes.count = si;
    this.brakeLights.count = li;
    this.blinkers.count = ki;
    for (const angles of Object.values(this._wheelAngles)) angles.needsUpdate = true;
    for (const m of this._meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // World position and travel direction of a car, whatever it is doing.
  carPose(car, pos, tan) {
    const prev = this._previousCarPoses.get(car);
    // Never interpolate across a mainline/ramp transition: the coordinates
    // belong to different curves and blending them would cut across terrain.
    const continuous = prev && prev.state === car.state && prev.ramp === car.ramp;
    if (car.ramp) {
      const rampPos = continuous
        ? THREE.MathUtils.lerp(prev.rampPos, car.rampPos, this._renderAlpha)
        : car.rampPos;
      const u = THREE.MathUtils.clamp(rampPos / car.ramp.length, 0, 1);
      car.ramp.curve.getPointAt(u, pos);
      car.ramp.curve.getTangentAt(u, tan);
      return null;
    } else {
      let s = car.s;
      let renderLane = car.renderLane;
      if (continuous) {
        // Wrapped loop coordinates need the short signed displacement; a
        // naïve lerp near s=0 would sweep the vehicle around the whole loop.
        let ds = car.s - prev.s;
        if (ds > LOOP / 2) ds -= LOOP;
        else if (ds < -LOOP / 2) ds += LOOP;
        s = wrap(prev.s + ds * this._renderAlpha);
        renderLane = THREE.MathUtils.lerp(
          prev.renderLane,
          car.renderLane,
          this._renderAlpha
        );
      }
      pointAt(s, -renderLane * ROAD.laneWidth, pos);
      forwardAt(s, tan);
      return s;
    }
  }

  startChase(car) {
    if (!car) return;
    const fresh = !this.chaseCar;
    this.chaseCar = car;
    this._autoView = null;
    this.controls.enabled = false;
    if (fresh) {
      this._chaseYaw = 0;
      this._chasePitch = 0;
      this._chaseZoom = 1; // a new chase starts at the standard framing
      this._chaseDrag = null;
      // snap straight to the follow position instead of flying across the map
      this.chaseGoals(this._chasePos, this._chaseAim);
      this.camera.position.copy(this._chasePos);
      this.camera.lookAt(this._chaseAim);
    }
  }

  stopChase() {
    this.chaseCar = null;
    this._chaseDrag = null;
    if (this.controls) this.controls.enabled = true;
  }

  // Leaving a chase (esc, the touch button, the chased car despawning):
  // plain stopChase() would strand the camera in the low follow shot while
  // controls.target still points at the stale pre-chase spot — the next
  // controls.update() swings around to face empty ground. Land on the
  // focusOnS overhead close-up of where the chase ended instead, the same
  // view as the space-time diagram's click-through. The view-cycle setters
  // keep calling stopChase() directly — they reposition the camera
  // themselves.
  exitChase() {
    const car = this.chaseCar;
    this.stopChase();
    if (car) this.focusOnS(car.s);
  }

  chaseGoals(posOut, aimOut) {
    this.carPose(this.chaseCar, this._pos, this._tan);
    // hang further back (and higher) behind long vehicles so they don't fill
    // the whole frame
    const back = 14 + Math.max(0, this.chaseCar.len - 4.6);
    const up = (RENDER_DIMS[modelOf(this.chaseCar)] ?? RENDER_DIMS.car).chaseUp;
    // spherical offset around the car: at yaw = pitch = 0 this lands exactly
    // on the classic back/up follow position; a held drag swings it around,
    // and the wheel/pinch dolly scales the radius (which leaves the framing
    // ELEVATION alone, since that comes from atan2(up, back) below)
    const dist = Math.hypot(back, up) * this._chaseZoom;
    const el = THREE.MathUtils.clamp(Math.atan2(up, back) + this._chasePitch, 0.06, 1.35);
    const cos = Math.cos(this._chaseYaw);
    const sin = Math.sin(this._chaseYaw);
    const bx = -(this._tan.x * cos - this._tan.z * sin); // -tangent rotated by yaw
    const bz = -(this._tan.x * sin + this._tan.z * cos);
    posOut.set(
      this._pos.x + bx * dist * Math.cos(el),
      this._pos.y + dist * Math.sin(el),
      this._pos.z + bz * dist * Math.cos(el)
    );
    // Keep the vehicle in frame at close dolly distances and while orbiting.
    // A fixed 16 m look-ahead aimed past it and pushed it off-screen at the
    // front-quarter view. The ordinary rear chase keeps its road preview.
    const lookAhead = 16 * Math.max(0, cos) ** 3
      * THREE.MathUtils.clamp((this._chaseZoom - CHASE_ZOOM_MIN) / (1 - CHASE_ZOOM_MIN), 0, 1);
    aimOut.copy(this._pos).addScaledVector(this._tan, lookAhead);
    aimOut.y += 1.5;
  }

  render(dt = 1 / 60) {
    // window dragged to a different-density display (no resize event fires
    // for that): re-apply the capped pixel ratio so the 3D view stays crisp
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(dpr);
    if (this.chaseCar) {
      // released orbit eases back behind the car (wall-clock: camera feel,
      // not physics, so it behaves the same at any time scale or paused)
      if (!this._chaseDrag && (this._chaseYaw !== 0 || this._chasePitch !== 0)) {
        const decay = Math.exp(-3.5 * dt);
        this._chaseYaw = Math.abs(this._chaseYaw) < 0.002 ? 0 : this._chaseYaw * decay;
        this._chasePitch = Math.abs(this._chasePitch) < 0.002 ? 0 : this._chasePitch * decay;
      }
      this.chaseGoals(this._v1, this._v2);
      // Ease in *simulation* time so the camera keeps pace with the car at
      // any time scale (the car covers dt × timeScale of world distance per
      // real frame); fall back to wall-clock while paused so the camera can
      // still settle onto its static target.
      const easeDt = params.paused ? dt : dt * params.timeScale;
      const k = 1 - Math.exp(-5 * easeDt); // exponential smoothing, framerate-safe
      this._chasePos.lerp(this._v1, k);
      this._chaseAim.lerp(this._v2, Math.min(1, k * 1.5));
      this.camera.position.copy(this._chasePos);
      this.camera.lookAt(this._chaseAim);
    } else {
      this.controls.update();
    }
    // the sky rides with the camera so the horizon never shows a seam; the
    // sun disc re-billboards because the offset to it changes as we move
    this.skyGroup.position.set(this.camera.position.x, 0, this.camera.position.z);
    this.sunDisc.lookAt(this.camera.position);
    this.sunHalo.lookAt(this.camera.position);
    // scenery toggle applies live (panel writes params, we read — as ever)
    const scenery = !!params.scenery;
    if (this.greenGroup.visible !== scenery) {
      this.greenGroup.visible = scenery;
      this.cloudSpin.visible = scenery;
      this.hillMesh.visible = scenery;
    }
    if (scenery) this.cloudSpin.rotation.y += 0.003 * dt; // lazy wall-clock drift
    if (this.rainPts.visible) {
      // wall-clock fall (rain is scenery, not physics), sheet follows the camera
      const arr = this.rainPts.geometry.attributes.position.array;
      const drop = 90 * dt;
      for (let i = 1; i < arr.length; i += 3) {
        arr[i] -= drop;
        if (arr[i] < 0) arr[i] += RAIN_HEIGHT;
      }
      this.rainPts.geometry.attributes.position.needsUpdate = true;
      this.rainPts.position.set(this.camera.position.x, 0, this.camera.position.z);
    }
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  // Measured vs. requested flow, so it's visible when a ramp can't keep up
  // (queue backing up) or how much traffic an exit share amounts to.
  updateRampLabels(flows, queues, demand) {
    for (const ramp of RAMPS) {
      const el = this.rampFlowEls[ramp.id];
      if (!el) continue;
      const measured = flows[ramp.id].toFixed(1);
      if (ramp.type !== 'on') {
        el.textContent = `${measured}/min (${params[ramp.rateKey]}%)`;
        continue;
      }
      // The queue is the cost the achieved rate is hiding: 6-of-30 reads the
      // same whether the ramp is starved or backed up twenty cars deep. Only
      // shown once cars are actually waiting, so a free-flowing ramp label
      // stays as short as it was.
      const queued = queues?.[ramp.id] ?? 0;
      const upstream = demand?.[ramp.id]?.waiting ?? 0;
      el.textContent =
        `${measured} of ${params[ramp.rateKey]} /min` +
        (queued ? ` · ${queued} on ramp` : '') + (upstream ? ` · ${upstream} upstream` : '');
    }
  }

  // Show (or hide, with null) a faint line across the road at loop position
  // s — the counterpart of the space-time diagram's hover readout.
  setRoadCursor(s) {
    if (s === null || s === undefined) {
      this.roadCursor.visible = false;
      return;
    }
    const outer = ROAD.laneWidth / 2 + ROAD.shoulderWidth; // shoulder's outer edge
    const inner = ROAD.laneWidth / 2 - params.lanes * ROAD.laneWidth - 1.0; // incl. apron
    pointAt(s, (outer + inner) / 2, this._pos);
    forwardAt(s, this._tan);
    this.roadCursor.position.set(this._pos.x, this._pos.y + 0.06, this._pos.z);
    this.roadCursor.rotation.y = Math.atan2(this._tan.x, this._tan.z);
    this.roadCursor.scale.set(outer - inner, 1, 1.4);
    this.roadCursor.visible = true;
  }

  // Camera framing: fit the loop (plus ramps and labels) into the free
  // horizontal region between the charts panel (left) and the control panel
  // (right), and aim the camera at that region's center. Measured from the
  // live DOM so it adapts to hidden panels; main.js re-fits once the panels
  // exist, and view buttons / shape changes re-measure on every call.
  viewFit() {
    const b = bounds();
    const m = 120; // pavement, ramps (tips reach ~105 m out), and their labels
    const hx = b.halfX + m;
    const hz = b.halfZ + m;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const tH = t * this.camera.aspect;
    // the canvas's own box, not the window's — same reason as the sizing
    // above, and the panel rects below share its origin either way
    const { w, h: viewH } = this.viewSize();
    const charts = document.querySelector('.panel.charts');
    const gui = document.querySelector('.lil-gui.root');
    const left = charts && charts.style.display !== 'none' ? charts.getBoundingClientRect().right : 0;
    // a collapsed gui is just a title bar in the corner — don't surrender a
    // full-height column to it (on a phone that would squeeze the road into
    // half the screen); reserve its width only while it hangs low
    const guiRect = gui && gui.getBoundingClientRect();
    const right = guiRect && guiRect.bottom > viewH * 0.4 ? guiRect.left : w;
    const frac = Math.max(0.3, (right - left) / w); // usable width fraction
    const centerFrac = (left + right - w) / w; // free-region center, -1..1 of half-width
    const h = Math.max(hz / t, hx / (tH * frac)) * 1.04;
    return { h, hx, tH, frac, centerFrac };
  }

  // A side panel toggled (charts shown/hidden, control panel opened or
  // collapsed): the free region viewFit measures has moved, so re-frame the
  // camera — but only if it is still parked in an auto view. A camera the
  // user has orbited or zoomed is theirs; never yank it.
  refitView() {
    if (this._autoView === 'default') this.setDefaultView();
    else if (this._autoView === 'top') this.setTopView();
  }

  setDefaultView() {
    this.stopChase();
    const { h, hx, tH, frac, centerFrac } = this.viewFit();
    // Pull back far enough for both the overhead fit and the horizontal
    // frustum — wide shapes (Speedway) hit the panels first.
    const dist = Math.max(h * 0.8, (hx / (tH * frac)) * 1.1);
    const shift = -centerFrac * dist * tH;
    this.camera.position.set(shift, dist * 0.554, dist * 0.831); // ≈34° elevation
    this.camera.lookAt(shift, 0, 0);
    if (this.controls) this.controls.target.set(shift, 0, 0);
    this._autoView = 'default';
  }

  setTopView() {
    this.stopChase();
    const { h, tH, centerFrac } = this.viewFit();
    const shift = -centerFrac * h * tH;
    this.camera.position.set(shift, h, 0.1);
    this.camera.lookAt(shift, 0, 0);
    this.controls.target.set(shift, 0, 0);
    this._autoView = 'top';
  }

  // Overhead close-up on loop position s — the space-time diagram's
  // click-through, so a diagram cell can be inspected on the road live.
  // Fixed height rather than road-scale-fitted: jam waves are the same
  // physical size on every road, and they're what gets clicked on.
  focusOnS(s) {
    this.stopChase();
    const mid = -((params.lanes - 1) * ROAD.laneWidth) / 2; // between the edge lines
    pointAt(s, mid, this._pos);
    this.camera.position.set(this._pos.x, this._pos.y + 170, this._pos.z + 0.1);
    this.camera.lookAt(this._pos.x, this._pos.y, this._pos.z);
    this.controls.target.set(this._pos.x, this._pos.y, this._pos.z);
    this._autoView = null; // a close-up, not a fit — panel toggles leave it be
  }

  onResize() {
    const { w, h } = this.viewSize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); // CSS owns the display size
    this.labelRenderer.setSize(w, h);
  }
}

function dashedLaneGeo(offset) {
  const count = Math.max(1, Math.round(LOOP / (40 * FT)));
  const period = LOOP / count; // even spacing across the wrap seam
  const tris = [];
  const point = (s, lateral) => {
    const p = pointAt(wrap(s), lateral);
    return [p.x, p.y + 0.035, p.z];
  };
  for (let i = 0; i < count; i++) {
    for (let step = 0; step < 3; step++) {
      const s0 = i * period + step * (10 * FT / 3);
      const s1 = s0 + 10 * FT / 3;
      const a = point(s0, offset - 0.075);
      const b = point(s0, offset + 0.075);
      const c = point(s1, offset + 0.075);
      const d = point(s1, offset - 0.075);
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return triangleSurfaceGeo(tris);
}

// Low-resolution linear-light environment, generated entirely from colors.
// The broad horizon supplies the reflection edge that makes flat steel read
// as metal; roughness prefiltering keeps it soft and low-poly rather than chrome.
function proceduralEnvironment(renderer) {
  const width = 128;
  const height = 64;
  const pixels = new Float32Array(width * height * 4);
  const sky = new THREE.Color(0xb5cbe1);
  const horizon = new THREE.Color(0xf3e3c9);
  const ground = new THREE.Color(0x596351);
  const c = new THREE.Color();
  for (let y = 0; y < height; y++) {
    // Equirectangular v runs from the ground pole to the sky pole.
    const altitude = Math.sin(((y + 0.5) / height - 0.5) * Math.PI);
    if (altitude >= 0) c.copy(horizon).lerp(sky, Math.pow(altitude, 0.35));
    else c.copy(horizon).lerp(ground, Math.min(1, -altitude * 7));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels.set([c.r, c.g, c.b, 1], i);
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  const generator = new THREE.PMREMGenerator(renderer);
  const result = generator.fromEquirectangular(texture);
  texture.dispose();
  generator.dispose();
  return result;
}

// A single colored ground surface replaces the old stack of patch planes.
// Every triangle owns its three color vertices, so each cell can carry a
// restrained value shift without another depth layer (and therefore without
// z-fighting at long camera distances). The jittered grid avoids a conspicuous
// radial fan or checkerboard while remaining deterministic between reloads.
function facetedGroundGeo() {
  const radius = 4000;
  const divisions = 45;
  const step = (radius * 2) / divisions;
  const points = [];
  const hash = (x, z, salt = 0) => {
    const n = Math.sin(x * 127.1 + z * 311.7 + salt * 73.3) * 43758.5453;
    return n - Math.floor(n);
  };
  for (let iz = 0; iz <= divisions; iz++) {
    const row = [];
    for (let ix = 0; ix <= divisions; ix++) {
      const edge = ix === 0 || iz === 0 || ix === divisions || iz === divisions;
      const jitter = edge ? 0 : step * 0.15;
      row.push([
        -radius + ix * step + (hash(ix, iz, 1) - 0.5) * jitter,
        0,
        -radius + iz * step + (hash(ix, iz, 2) - 0.5) * jitter,
      ]);
    }
    points.push(row);
  }

  const positions = [];
  const colors = [];
  const normals = [];
  const addTriangle = (a, b, c, value) => {
    positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      colors.push(value, value, value);
      normals.push(0, 1, 0);
    }
  };
  for (let iz = 0; iz < divisions; iz++) {
    for (let ix = 0; ix < divisions; ix++) {
      const cx = -radius + (ix + 0.5) * step;
      const cz = -radius + (iz + 0.5) * step;
      if (cx * cx + cz * cz > (radius + step * 0.65) ** 2) continue;
      const a = points[iz][ix];
      const b = points[iz][ix + 1];
      const c = points[iz + 1][ix];
      const d = points[iz + 1][ix + 1];
      const base = 0.97
        + 0.035 * Math.sin(ix * 0.58 + iz * 0.31)
        + 0.02 * Math.sin(ix * 0.17 - iz * 0.49);
      const split = (hash(ix, iz, 3) - 0.5) * 0.014;
      if ((ix + iz) & 1) {
        addTriangle(a, c, b, base + split);
        addTriangle(b, c, d, base - split);
      } else {
        addTriangle(a, d, b, base + split);
        addTriangle(a, c, d, base - split);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  return geo;
}

function triangleSurfaceGeo(tris) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat(2)), 3));
  geo.computeVertexNormals();
  return geo;
}

// Soft-edged shadows would fight the graphic style; a twelve-sided translucent
// footprint grounds each vehicle and remains cheap enough to instance by kind.
function contactShadowGeo() {
  return new THREE.CircleGeometry(1, 12)
    .rotateX(-Math.PI / 2)
    .translate(0, 0.002, 0);
}

// --- scenery geometry ------------------------------------------------------

// Paint a whole geometry one vertex color (normalized to non-indexed so mixed
// primitives can merge), letting one vertex-colored material carry a prop's
// trunk/canopy split in a single instanced draw.
function colored(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function pineGeo() {
  return mergeGeometries([
    colored(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6).translate(0, 0.8, 0), 0x7a5a3e),
    colored(new THREE.ConeGeometry(2.3, 3.4, 7).translate(0, 3.0, 0), 0x41684a),
    colored(new THREE.ConeGeometry(1.7, 2.8, 7).translate(0, 5.1, 0), 0x487252),
    colored(new THREE.ConeGeometry(1.05, 2.1, 7).translate(0, 6.9, 0), 0x50795a),
  ]);
}

function broadleafGeo() {
  return mergeGeometries([
    colored(new THREE.CylinderGeometry(0.26, 0.36, 2.4, 6).translate(0, 1.2, 0), 0x7a5a3e),
    colored(
      new THREE.IcosahedronGeometry(2.7, 0).scale(1, 0.85, 1).translate(0, 4.3, 0),
      0x5e8a4a
    ),
  ]);
}

function bushGeo() {
  return colored(
    new THREE.IcosahedronGeometry(1.2, 0).scale(1, 0.62, 1).translate(0, 0.6, 0),
    0x628549
  );
}

function rockGeo() {
  return colored(
    new THREE.DodecahedronGeometry(1.0, 0).scale(1, 0.7, 1).translate(0, 0.45, 0),
    0x969a92
  );
}

// A broad, shallow irregular dome with two rings of deliberately flat faces.
// Instance scaling turns this small template into rolling 50–100 m features;
// its perimeter sits below the base ground so no edge seam can flicker.
function terrainMoundGeo() {
  const segments = 9;
  const outer = [];
  const inner = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ro = 0.96 + 0.08 * Math.sin(i * 2.37);
    const ri = 0.49 + 0.05 * Math.cos(i * 1.91);
    outer.push([Math.cos(a) * ro, -0.04, Math.sin(a) * ro]);
    inner.push([
      Math.cos(a + 0.1) * ri,
      0.09 + 0.018 * Math.sin(i * 2.11),
      Math.sin(a + 0.1) * ri,
    ]);
  }
  const peak = [0.08, 0.18, -0.04];
  const tris = [];
  for (let i = 0; i < segments; i++) {
    const n = (i + 1) % segments;
    tris.push(
      [outer[i], inner[i], outer[n]],
      [outer[n], inner[i], inner[n]],
      [inner[i], peak, inner[n]]
    );
  }
  return triangleSurfaceGeo(tris);
}

// One cloud: a few squashed icosahedron puffs merged into a single clump;
// instancing scatters and scales it into a whole sky's worth.
function cloudGeo() {
  const puff = (r, x, y, z) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, 0.5, 1);
    g.translate(x, y, z);
    return g;
  };
  return mergeGeometries([
    puff(20, 0, 0, 0),
    puff(13, 17, -2, 5),
    puff(11, -16, -3, -4),
    puff(9, 4, -2, -13),
  ]);
}

// Triangle strip swept around the whole loop between two lateral offsets
// (positive = outward of lane 0's centerline), riding the shape's elevation
// (pointAt's y) with `y` added as a small lift. Used for pavement and the
// solid edge lines; same vertex layout and winding as rampRibbon below.
function loopStrip(offOut, offIn, y) {
  const N = Math.ceil(LOOP / 2); // ~2 m samples: chord error is sub-mm at our radii
  const positions = new Float32Array((N + 1) * 2 * 3);
  const normals = new Float32Array((N + 1) * 2 * 3);
  const indices = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const s = ((i % N) / N) * LOOP; // i = N wraps to s = 0: the seam is exact
    pointAt(s, offOut, a);
    pointAt(s, offIn, b);
    const o = i * 6;
    positions[o] = a.x;
    positions[o + 1] = a.y + y;
    positions[o + 2] = a.z;
    positions[o + 3] = b.x;
    positions[o + 4] = b.y + y;
    positions[o + 5] = b.z;
    normals.set([0, 1, 0, 0, 1, 0], o);
    if (i < N) {
      const v = i * 2;
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

// Vertical concrete ribbon hanging from one pavement edge over [s0, s1]:
// top rides the deck, bottom is the deck minus 1 m clamped to the ground —
// embankment on the approaches, open span where the bridge is high.
function bridgeSkirt(s0, s1, off) {
  const n = Math.max(2, Math.ceil((s1 - s0) / 3));
  const positions = new Float32Array((n + 1) * 2 * 3);
  const indices = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    pointAt(s0 + ((s1 - s0) * i) / n, off, p);
    const o = i * 6;
    positions[o] = p.x;
    positions[o + 1] = p.y + 0.01;
    positions[o + 2] = p.z;
    positions[o + 3] = p.x;
    positions[o + 4] = Math.max(-0.2, p.y - 1.0); // -0.2: tuck under the ground plane
    positions[o + 5] = p.z;
    if (i < n) {
      const v = i * 2;
      indices.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals(); // DoubleSide material forgives the winding
  return geo;
}

// Edge line following a curve at a lateral offset (+ = right of travel),
// drawn only over the [u0, u1] stretch of the curve.
function rampEdgeLine(curve, offset, material, u0, u1) {
  const pts = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const u = u0 + (i / N) * (u1 - u0);
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.crossVectors(t, up).normalize();
    pts.push(new THREE.Vector3(p.x + side.x * offset, 0.02, p.z + side.z * offset));
  }
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material);
}

// Flat ribbon mesh following a curve, used for ramp pavement. Sits slightly
// below the main road so the overlap near merge/diverge points never z-fights.
function rampRibbon(curve, width) {
  const N = 80;
  const half = width / 2;
  const positions = new Float32Array((N + 1) * 2 * 3);
  const normals = new Float32Array((N + 1) * 2 * 3);
  const indices = [];
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.crossVectors(t, up).normalize();
    const o = i * 6;
    positions[o] = p.x + side.x * half;
    positions[o + 1] = -0.05;
    positions[o + 2] = p.z + side.z * half;
    positions[o + 3] = p.x - side.x * half;
    positions[o + 4] = -0.05;
    positions[o + 5] = p.z - side.z * half;
    normals.set([0, 1, 0, 0, 1, 0], o);
    if (i < N) {
      const a = i * 2;
      // wound counter-clockwise seen from above, matching the +y normals
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}
