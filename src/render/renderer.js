import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD, RAMPS, LOOP, bounds, pointAt, forwardAt, wrap, elevAt } from '../sim/road.js';
import { params, KMH, MPH } from '../params.js';

const MAX_CARS = 1500;
const MAX_TRUCKS = 400;
const MAX_AMB = 8; // sim.spawnAmbulance caps at the same count (MAX_AMBULANCES)
const STROBE_RED = new THREE.Color(0xff2a2a);
const STROBE_BLUE = new THREE.Color(0x2a6bff);
// 'By type' color mode: the charts' categorical trio (speed/flow/cars series
// hues), so the whole UI speaks one palette. Ambulances stay white.
const TYPE_COLORS = {
  car: new THREE.Color(0x3987e5),
  acc: new THREE.Color(0x199e70),
  truck: new THREE.Color(0xd98e32),
};
const MAX_LIGHTS = MAX_CARS + MAX_TRUCKS;
const RAIN_BOX = 700; // rain sheet footprint (m), follows the camera
const RAIN_HEIGHT = 260;

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
const _sky = new THREE.Color(); // applyWeather scratch

// Light mount points per vehicle kind, in the car's local frame (+z = front,
// +x = driver's left = inward). y/rear/front from the body geometries below.
// 'car' holds one entry per body style, indexed by the same car.id bit that
// picks the loft in update().
const LIGHT_DIMS = {
  car: [
    { rear: -2.3, front: 2.3, halfW: 0.58, y: 0.6, brakeW: 1.15 }, // sedan
    { rear: -2.19, front: 2.19, halfW: 0.62, y: 0.64, brakeW: 1.3 }, // hatchback
  ],
  // acc overrides the shared mount fields: the brake light is a thin
  // full-width strip along the top of the tailgate, and the blinkers are
  // thin low strips — just above the front bumper, riding the rear one
  acc: {
    rear: -2.33, front: 2.2, halfW: 0.62, y: 1.0,
    brakeY: 1.12, brakeW: 1.72, brakeH: 0.07,
    blinkYF: 0.48, blinkYR: 0.3, blinkW: 0.5, blinkH: 0.07,
  },
  truck: { rear: -7.77, front: 7.6, halfW: 0.99, y: 0.95, brakeW: 2.1 }, // front = hood flanks
  ambulance: { rear: -2.69, front: 2.69, halfW: 0.85, y: 1.0, brakeW: 1.9 },
};

export class SceneRenderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    container.appendChild(this.renderer.domElement);

    // DOM overlay for map labels: crisp, constant screen size at any zoom
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    // placeholder colors; applyWeather (via buildRoad) sets the real mood.
    // The background only peeks through where the far plane clips the dome.
    this.scene.background = SKY.horizonDry.clone();
    this.scene.fog = new THREE.Fog(SKY.horizonDry.clone(), 800, 2000);

    this.camera = new THREE.PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      1,
      3000
    );

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 40;
    this.controls.maxDistance = 1400;
    this.setDefaultView(); // after controls exist, so the view target sticks

    this.hemi = new THREE.HemisphereLight(0xd8e2f2, 0x8b7a58, 1.0);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffdcae, 2.1); // golden-hour key light
    this.sun.position.copy(SUN_DIR).multiplyScalar(450);
    this.scene.add(this.sun);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(4000, 64).rotateX(-Math.PI / 2), // reaches the hill ring
      new THREE.MeshStandardMaterial({ color: 0x5c6a49, roughness: 1 })
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
    this._cabinColor = new THREE.Color();
    this._raycaster = new THREE.Raycaster();

    // chase camera state. Yaw/pitch are a held-drag orbit offset around the
    // chased car (0 = the standard behind-the-car framing); on release they
    // ease back to zero (see render) so letting go returns to the follow cam.
    this.chaseCar = null;
    this._chasePos = new THREE.Vector3();
    this._chaseAim = new THREE.Vector3();
    this._chaseYaw = 0;
    this._chasePitch = 0;
    this._chaseDrag = null; // last pointer position while a chase orbit is held
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    // Click detection (as opposed to an orbit drag): small movement, quick
    // release. main.js assigns onRoadClick to receive the ground-plane point.
    this.onRoadClick = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.chaseCar && e.button === 0) {
        // in chase view a left press is an orbit gesture, never a click —
        // the chased car sits center-screen, so letting a micro-drag through
        // the click gate below would crash the car being followed
        this._chaseDrag = { x: e.clientX, y: e.clientY };
        this._press = null;
        return;
      }
      this._press = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      this._chaseDrag = null;
      const press = this._press;
      this._press = null;
      if (!press || !this.onRoadClick) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (dx * dx + dy * dy > 36 || performance.now() - press.t > 500) return;
      this.onRoadClick(this.pickRay(e.clientX, e.clientY));
    });

    // Hover position for the car readout: buttons pressed means an orbit
    // drag (or a touch), not a hover. main.js re-picks against this every
    // frame so the readout tracks traffic moving under a resting pointer.
    this._pointer = null;
    canvas.addEventListener('pointermove', (e) => {
      this._pointer = e.buttons === 0 ? { x: e.clientX, y: e.clientY } : null;
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
    canvas.addEventListener('pointerleave', () => {
      this._pointer = null;
      this._chaseDrag = null;
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

    window.addEventListener('resize', () => this.onResize());
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
    this.hoverTip.position.set(
      this._pos.x,
      this._pos.y + (car.kind === 'truck' ? 4.2 : 2.6),
      this._pos.z
    );
    const imp = params.units === 'imperial';
    const unit = imp ? MPH : KMH;
    const want = params.desiredSpeed * car.v0Factor;
    this.hoverName.textContent = `${car.kind === 'acc' ? 'ACC car' : car.kind} #${car.id}`;
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
      const pts = [];
      const SEG = Math.ceil(LOOP / 2);
      for (let i = 0; i <= SEG; i++) {
        const p = pointAt(((i % SEG) / SEG) * LOOP, off);
        pts.push(new THREE.Vector3(p.x, p.y + 0.04, p.z));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0xb9c2cc, dashSize: 4, gapSize: 6 })
      );
      line.computeLineDistances();
      g.add(line);
    }

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
    this.sunDisc.material.opacity = 0.9 * Math.max(0, 1 - r * 1.6); // storm swallows the sun first
    // clouds are Lambert-lit for puffy facets but sit on an emissive floor so
    // their shaded sides never go charcoal against a bright sky
    _sky.copy(CLOUD_DRY).lerp(CLOUD_WET, r);
    this.cloudMat.color.copy(_sky).multiplyScalar(0.5);
    this.cloudMat.emissive.copy(_sky).multiplyScalar(0.62);
    this.hillMat.color.copy(HILL_DRY).lerp(HILL_WET, r);
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

    // dome + sun ride along with the camera so the horizon never shows a seam
    this.skyGroup = new THREE.Group();
    this.skyGroup.add(this.skyDome, this.sunDisc);
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

  // Trees, bushes and rocks scattered around (and inside) the loop, with a
  // keep-out corridor along the pavement and every ramp. Rebuilt on road
  // changes — the corridor moves with the geometry.
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
    const scatter = (count, dRoad, dRamp) => {
      const out = [];
      let guard = count * 12; // rejection sampling; dense shapes just get fewer
      while (out.length < count && guard-- > 0) {
        const x = (Math.random() * 2 - 1) * R;
        const z = (Math.random() * 2 - 1) * R;
        if (clearOf(road, x, z, dRoad) && clearOf(ramps, x, z, dRamp)) out.push([x, z]);
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
    // DoubleSide forgives winding parity on the hand-built lofts (see loft())
    const mat = () =>
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.9 });
    // matte greenhouse: sloped glass under the low sun flares bright with the
    // body's specular response, reading like an open trunk from chase view
    const cabinMat = () =>
      new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide });
    // passenger cars: two lofted body styles — car.id picks one for life —
    // each a beveled shell plus a darker greenhouse so glass reads at a glance
    this.sedan = new THREE.InstancedMesh(loft(SEDAN_BODY), mat(), MAX_CARS);
    this.sedanCabin = new THREE.InstancedMesh(loft(SEDAN_CABIN), cabinMat(), MAX_CARS);
    this.hatch = new THREE.InstancedMesh(loft(HATCH_BODY), mat(), MAX_CARS);
    this.hatchCabin = new THREE.InstancedMesh(loft(HATCH_CABIN), cabinMat(), MAX_CARS);
    // one four-wheel set serves the sedans and hatchbacks. Track width keeps
    // the outer faces proud of the widest shell (hw 0.95): dead flush and
    // the coplanar faces z-fight — flickering rear wheels.
    this.wheels = new THREE.InstancedMesh(
      wheelsGeo([[0.84, 1.4], [-0.84, 1.4], [0.84, -1.4], [-0.84, -1.4]], 0.34, 0.26),
      wheelMat,
      MAX_CARS
    );
    // semi trucks: conventional-cab tractor loft, box trailer, five axles
    const trailerGeo = new THREE.BoxGeometry(2.45, 3.1, 11.8).translate(0, 1.85, -1.85);
    this.trailer = new THREE.InstancedMesh(trailerGeo, mat(), MAX_TRUCKS);
    this.cab = new THREE.InstancedMesh(loft(TRUCK_CAB), mat(), MAX_TRUCKS);
    this.truckWheels = new THREE.InstancedMesh(
      wheelsGeo(
        [7.3, 4.55, 3.55, -6.15, -7.15].flatMap((z) => [[0.98, z], [-0.98, z]]),
        0.5,
        0.42
      ),
      wheelMat,
      MAX_TRUCKS
    );
    // ACC cars: an angular stainless wedge — unmistakable from above — plus
    // constant dark trim (bumpers, rocker cladding, slatted tonneau) that
    // rides the same matrices, so the paint tints but the composite doesn't
    this.cyber = new THREE.InstancedMesh(
      cybertruckGeo(),
      new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }),
      MAX_CARS
    );
    this.cyberTrim = new THREE.InstancedMesh(
      cyberTrimGeo(),
      new THREE.MeshStandardMaterial({ color: 0x33383e, roughness: 0.85 }),
      MAX_CARS
    );
    // its own wheel set, wider and taller than the cars': the wheels stand
    // fully exposed inside the polygonal arch flares instead of tucking
    // under the shell
    this.cyberWheels = new THREE.InstancedMesh(
      wheelsGeo([[0.98, 1.4], [-0.98, 1.4], [0.98, -1.4], [-0.98, -1.4]], 0.38, 0.28),
      wheelMat,
      MAX_CARS
    );
    // (no front light bar: it's a headlight, and no vehicle here runs
    // headlights — lights are reserved for driver-state signals)
    // dark windshield lying on the hood plane, inset so a body-colored
    // frame (the A-pillars) borders it — the wedge face read as bare metal
    // without it. Rougher than the ambulance's vertical cab glass: this
    // pane tilts at the sky, and a glossy finish washes white in the sun.
    this.cyberGlass = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.48, 0.03, 1.34).rotateX(0.246).translate(0, 1.431, 0.57),
      new THREE.MeshStandardMaterial({ color: 0x161e26, roughness: 0.55, metalness: 0.15 }),
      MAX_CARS
    );
    // ambulance: a Type-I style rig rather than a plain box — hood and cab
    // up front, the taller patient module behind (+z = front, 5.4 m total
    // to match VEHICLE_LEN), dark glass over the cab, red belt stripe on
    // the module. Roof strobes are separate unlit instances whose red/blue
    // swap sides on the hazard blink clock, so the bar reads as flashing
    // from any angle.
    const ambBodyGeo = mergeGeometries([
      new THREE.BoxGeometry(2.3, 2.15, 3.0).translate(0, 1.42, -1.2), // patient module
      new THREE.BoxGeometry(2.05, 1.5, 1.35).translate(0, 1.1, 0.92), // cab
      new THREE.BoxGeometry(1.9, 0.85, 1.2).translate(0, 0.78, 2.1), // hood
    ]);
    const stripeGeo = new THREE.BoxGeometry(2.36, 0.32, 3.0).translate(0, 1.16, -1.2);
    const glassGeo = new THREE.BoxGeometry(2.09, 0.5, 1.1).translate(0, 1.52, 0.98);
    this.ambBody = new THREE.InstancedMesh(ambBodyGeo, mat(), MAX_AMB);
    this.ambStripe = new THREE.InstancedMesh(
      stripeGeo,
      new THREE.MeshStandardMaterial({ color: 0xc63a30, roughness: 0.5, metalness: 0.25 }),
      MAX_AMB
    );
    this.ambGlass = new THREE.InstancedMesh(
      glassGeo,
      new THREE.MeshStandardMaterial({ color: 0x1d2731, roughness: 0.25, metalness: 0.4 }),
      MAX_AMB
    );
    this.ambWheels = new THREE.InstancedMesh(
      wheelsGeo([[0.86, 1.85], [-0.86, 1.85], [0.86, -1.6], [-0.86, -1.6]], 0.4, 0.32),
      wheelMat,
      MAX_AMB
    );
    this.strobes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      MAX_AMB * 2
    );

    // driver-communication lights: red brake bars and amber blinkers, placed
    // per frame at per-kind mount points (unlit materials so they read as
    // light sources); a unit cube scaled per instance
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
    this._meshes = [
      this.sedan, this.sedanCabin, this.hatch, this.hatchCabin, this.wheels,
      this.trailer, this.cab, this.truckWheels,
      this.cyber, this.cyberTrim, this.cyberWheels, this.cyberGlass,
      this.ambBody, this.ambStripe, this.ambGlass, this.ambWheels,
      this.strobes, this.brakeLights, this.blinkers,
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
  }

  // Place one light: the car's local-frame offset rotated into the world.
  // The slope term keeps mounts on the body when the car sits on a grade
  // (a fore/aft offset oz gains slope·oz of height on a pitched car).
  placeLight(mesh, idx, rotY, ox, oy, oz, sx, sy, sz) {
    const d = this._lightDummy;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    d.position.set(
      this._pos.x + ox * cos + oz * sin,
      this._pos.y + oy + this._slope * oz,
      this._pos.z - ox * sin + oz * cos
    );
    d.rotation.set(0, rotY, 0);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    mesh.setMatrixAt(idx, d.matrix);
  }

  update(cars) {
    const desired = params.desiredSpeed;
    const blinkOn = Math.floor(performance.now() / 400) % 2 === 0; // hazard flashers
    let ci = 0; // next free sedan instance
    let hi = 0; // next free hatchback instance
    let ti = 0; // next free truck instance
    let ai = 0; // next free ACC-car instance
    let mi = 0; // next free ambulance instance
    let wi = 0; // next free car wheel-set instance (sedans + hatches)
    let si = 0; // next free strobe instance
    let li = 0; // next free brake-light instance
    let ki = 0; // next free blinker instance
    for (const car of cars) {
      const truck = car.kind === 'truck';
      const acc = car.kind === 'acc';
      const ambu = car.kind === 'ambulance';
      const hatch = car.kind === 'car' && (car.id & 1) === 1; // stable body style per car
      if (truck ? ti >= MAX_TRUCKS : ambu ? mi >= MAX_AMB : (acc ? ai : hatch ? hi : ci) >= MAX_CARS)
        continue;
      this.carPose(car, this._pos, this._tan);
      let rotY = Math.atan2(this._tan.x, this._tan.z);
      if (!car.ramp && car.wreckYaw && car.v < 3) rotY += car.wreckYaw; // skidded askew
      // grade: pitch the body up/down the bridge approaches (rotation order
      // is YXZ so pitch turns about the yawed, car-local right axis); the
      // slope also corrects the light mounts' height in placeLight
      this._slope = car.ramp ? 0 : (elevAt(car.s + 3) - elevAt(car.s - 3)) / 6;
      this._dummy.position.set(this._pos.x, this._pos.y, this._pos.z);
      this._dummy.rotation.set(this._slope === 0 ? 0 : -Math.atan(this._slope), rotY, 0);
      this._dummy.updateMatrix();

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
      this._cabinColor.copy(this._bodyColor).multiplyScalar(0.45);

      if (truck) {
        this.trailer.setMatrixAt(ti, this._dummy.matrix);
        this.cab.setMatrixAt(ti, this._dummy.matrix);
        this.truckWheels.setMatrixAt(ti, this._dummy.matrix);
        this.trailer.setColorAt(ti, this._bodyColor);
        this.cab.setColorAt(ti, this._cabinColor);
        ti++;
      } else if (ambu) {
        // white rig regardless of color mode; incidents keep the amber blink
        if (!car.incident) this._bodyColor.set(0xf4f7f9);
        this.ambBody.setMatrixAt(mi, this._dummy.matrix);
        this.ambStripe.setMatrixAt(mi, this._dummy.matrix);
        this.ambGlass.setMatrixAt(mi, this._dummy.matrix);
        this.ambWheels.setMatrixAt(mi, this._dummy.matrix);
        this.ambBody.setColorAt(mi, this._bodyColor);
        mi++;
        if (!car.incident && si + 1 < MAX_AMB * 2) {
          // light bar on the module's front roof edge — the rig's high point,
          // visible from every angle; red/blue swap sides every blink tick
          this.placeLight(this.strobes, si, rotY, 0.55, 2.6, 0.1, 0.5, 0.22, 0.5);
          this.strobes.setColorAt(si++, blinkOn ? STROBE_RED : STROBE_BLUE);
          this.placeLight(this.strobes, si, rotY, -0.55, 2.6, 0.1, 0.5, 0.22, 0.5);
          this.strobes.setColorAt(si++, blinkOn ? STROBE_BLUE : STROBE_RED);
        }
      } else if (acc) {
        this.cyber.setMatrixAt(ai, this._dummy.matrix);
        this.cyberTrim.setMatrixAt(ai, this._dummy.matrix);
        this.cyberWheels.setMatrixAt(ai, this._dummy.matrix);
        this.cyberGlass.setMatrixAt(ai, this._dummy.matrix);
        this.cyber.setColorAt(ai, this._bodyColor);
        ai++;
      } else {
        const body = hatch ? this.hatch : this.sedan;
        const cabin = hatch ? this.hatchCabin : this.sedanCabin;
        const idx = hatch ? hi++ : ci++;
        body.setMatrixAt(idx, this._dummy.matrix);
        cabin.setMatrixAt(idx, this._dummy.matrix);
        body.setColorAt(idx, this._bodyColor);
        cabin.setColorAt(idx, this._cabinColor);
        if (wi < MAX_CARS) this.wheels.setMatrixAt(wi++, this._dummy.matrix);
      }

      // brake lights + blinkers (incident cars blink their whole body amber)
      if (!car.incident) {
        const L = car.kind === 'car' ? LIGHT_DIMS.car[car.id & 1] : LIGHT_DIMS[car.kind];
        if (car.brakeLit && li < MAX_LIGHTS) {
          this.placeLight(
            this.brakeLights, li++, rotY,
            0, L.brakeY ?? L.y, L.rear,
            L.brakeW, L.brakeH ?? 0.16, 0.1
          );
        }
        if (car.signal !== 0 && blinkOn && ki + 1 < MAX_LIGHTS) {
          const sx = car.signal > 0 ? L.halfW : -L.halfW; // +x local = driver's left
          const bw = L.blinkW ?? 0.22;
          const bh = L.blinkH ?? 0.2;
          this.placeLight(this.blinkers, ki++, rotY, sx, L.blinkYR ?? L.y, L.rear, bw, bh, 0.14);
          this.placeLight(this.blinkers, ki++, rotY, sx, L.blinkYF ?? L.y, L.front, bw, bh, 0.14);
        }
      }
    }
    this.sedan.count = ci;
    this.sedanCabin.count = ci;
    this.hatch.count = hi;
    this.hatchCabin.count = hi;
    this.wheels.count = wi;
    this.trailer.count = ti;
    this.cab.count = ti;
    this.truckWheels.count = ti;
    this.cyber.count = ai;
    this.cyberTrim.count = ai;
    this.cyberWheels.count = ai;
    this.cyberGlass.count = ai;
    this.ambBody.count = mi;
    this.ambStripe.count = mi;
    this.ambGlass.count = mi;
    this.ambWheels.count = mi;
    this.strobes.count = si;
    this.brakeLights.count = li;
    this.blinkers.count = ki;
    for (const m of this._meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  // World position and travel direction of a car, whatever it is doing.
  carPose(car, pos, tan) {
    if (car.ramp) {
      const u = THREE.MathUtils.clamp(car.rampPos / car.ramp.length, 0, 1);
      car.ramp.curve.getPointAt(u, pos);
      car.ramp.curve.getTangentAt(u, tan);
    } else {
      pointAt(car.s, -car.renderLane * ROAD.laneWidth, pos);
      forwardAt(car.s, tan);
    }
  }

  startChase(car) {
    if (!car) return;
    const fresh = !this.chaseCar;
    this.chaseCar = car;
    this.controls.enabled = false;
    if (fresh) {
      this._chaseYaw = 0;
      this._chasePitch = 0;
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

  chaseGoals(posOut, aimOut) {
    this.carPose(this.chaseCar, this._pos, this._tan);
    // hang further back (and higher) behind long vehicles so they don't fill
    // the whole frame
    const back = 14 + Math.max(0, this.chaseCar.len - 4.6);
    const up = this.chaseCar.kind === 'truck' ? 8.5 : 6;
    // spherical offset around the car: at yaw = pitch = 0 this lands exactly
    // on the classic back/up follow position; a held drag swings it around
    const dist = Math.hypot(back, up);
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
    // aim ahead of the car when behind it, at the car itself when abeam, and
    // "through" it from the front — cos(yaw) does all three
    aimOut.copy(this._pos).addScaledVector(this._tan, 16 * cos);
    aimOut.y += 1.5;
  }

  render(dt = 1 / 60) {
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
  updateRampLabels(flows) {
    for (const ramp of RAMPS) {
      const el = this.rampFlowEls[ramp.id];
      if (!el) continue;
      const measured = flows[ramp.id].toFixed(1);
      el.textContent =
        ramp.type === 'on'
          ? `${measured} of ${params[ramp.rateKey]} /min`
          : `${measured}/min (${params[ramp.rateKey]}%)`;
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
    const w = window.innerWidth;
    const charts = document.querySelector('.panel.charts');
    const gui = document.querySelector('.lil-gui.root');
    const left = charts && charts.style.display !== 'none' ? charts.getBoundingClientRect().right : 0;
    const right = gui ? gui.getBoundingClientRect().left : w;
    const frac = Math.max(0.3, (right - left) / w); // usable width fraction
    const centerFrac = (left + right - w) / w; // free-region center, -1..1 of half-width
    const h = Math.max(hz / t, hx / (tH * frac)) * 1.04;
    return { h, hx, tH, frac, centerFrac };
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
  }

  setTopView() {
    this.stopChase();
    const { h, tH, centerFrac } = this.viewFit();
    const shift = -centerFrac * h * tH;
    this.camera.position.set(shift, h, 0.1);
    this.camera.lookAt(shift, 0, 0);
    this.controls.target.set(shift, 0, 0);
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
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// ACC cars: a low-poly Cybertruck-style wedge. The hood is ONE flat plane,
// full width, running unbroken from the fascia's top edge to the roof peak
// (an earlier corner-bevel attempt narrowed that edge and dented the sides).
// From the front it reads: wide rectangular stance, a sharp hood crease up
// top, a large blank stainless face below it — raked back toward the
// bumper, no grille — with the lower corners clipped where the wheel-arch
// flares (trim mesh) wrap. A subtle horizontal crease runs along each side,
// like the real truck's. Same 4.6 m footprint as a regular car (+z = front).
// Non-indexed triangles so computeVertexNormals yields the flat facets.
function cybertruckGeo() {
  const N = (s) => [s * 0.98, 0.98, 2.3];  // fascia top edge / hood crease
  const C = (s) => [s * 0.98, 0.62, 2.22]; // where the lower-corner clip starts
  const A = (s) => [s * 0.8, 0.35, 2.16];  // fascia bottom, narrowed by the clips
  const S = (s) => [s * 1.0, 0.35, 1.9];   // side bottom, behind the clip
  const P = (s) => [s * 0.8, 1.62, -0.25]; // roof peak (sides taper inward)
  const T = (s) => [s * 0.9, 1.18, -2.3];  // tail top
  const B = (s) => [s * 1.0, 0.35, -2.3];  // tail bottom
  const tris = [
    // fascia: one blank six-cornered face, fanned from N(-1)
    [N(-1), N(1), C(1)], [N(-1), C(1), A(1)], [N(-1), A(1), A(-1)], [N(-1), A(-1), C(-1)],
    [N(-1), N(1), P(1)], [N(-1), P(1), P(-1)], // the flat hood, one plane to the peak
    [P(-1), P(1), T(1)], [P(-1), T(1), T(-1)], // bed cover
    [T(1), B(1), B(-1)], [T(1), B(-1), T(-1)], // tail face
    [C(1), A(1), S(1)], [C(-1), S(-1), A(-1)], // lower-corner clip planes
    [S(1), B(1), T(1)], [S(1), T(1), P(1)], [S(1), P(1), N(1)], [S(1), N(1), C(1)], // right side
    [S(-1), T(-1), B(-1)], [S(-1), P(-1), T(-1)], [S(-1), N(-1), P(-1)], [S(-1), C(-1), N(-1)], // left side
    [A(1), A(-1), S(-1)], [A(1), S(-1), S(1)], // underside, nose section
    [S(1), S(-1), B(-1)], [S(1), B(-1), B(1)], // underside, main run
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat(2)), 3));
  geo.computeVertexNormals(); // DoubleSide material corrects any face parity
  return geo;
}

// One cohesive polygonal wheel-arch flare: a hexagonal band hugging the
// wheel (r 0.38 at the axle origin), extruded as a single solid so there
// are no seams between brow and shoulders. Shape coords: x = along the car
// relative to the axle, y = height relative to the axle; the extrusion
// (0.16 deep) becomes the car's lateral thickness after the rotate.
function archGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.72, -0.08); // outer boundary, up and over the wheel
  s.lineTo(-0.33, 0.58);
  s.lineTo(0.33, 0.58);
  s.lineTo(0.72, -0.08);
  s.lineTo(0.58, -0.08); // inner boundary back, ~0.1 m off the tire
  s.lineTo(0.24, 0.46);
  s.lineTo(-0.24, 0.46);
  s.lineTo(-0.58, -0.08);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: false })
    .rotateY(-Math.PI / 2); // shape-x → car z, extrusion depth → car x
}

// Dark backing for a wheel opening: a trapezoid matching the arch's inner
// boundary, so its whole silhouette hides behind the band and the tire. A
// square plate here read as a "dog house" around the wheel from the side —
// the visible shape below the arch must be the tire, nothing else.
function wellGeo() {
  const s = new THREE.Shape();
  s.moveTo(-0.62, -0.12);
  s.lineTo(-0.24, 0.5);
  s.lineTo(0.24, 0.5);
  s.lineTo(0.62, -0.12);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false })
    .rotateY(-Math.PI / 2);
}

// Dark composite trim for the ACC wedge, one instance per truck riding the
// same matrix as the body (like the wheel sets): a heavy vertically-thin
// front bumper with clipped corners tucked under the raked fascia, a plain
// rear bumper (the rear blinker strips sit proud of its outer ends), rocker
// cladding, a slatted tonneau cover over the bed, and the truck's signature
// polygonal wheel-arch flares framing the fully-exposed wheels (the ACC
// wheel set rides wider than the shell for exactly this reason). A dark
// well trapezoid backs each opening so it shows tire and shadow — never
// the body-colored side wall.
function cyberTrimGeo() {
  const slope = Math.atan2(1.62 - 1.18, 2.3 - 0.25); // bed-cover pitch (P to T)
  const parts = [
    new THREE.BoxGeometry(1.96, 0.16, 0.22).translate(0, 0.27, 2.2), // front bumper
    new THREE.BoxGeometry(0.55, 0.16, 0.2).rotateY(0.7).translate(0.9, 0.27, 2.06),
    new THREE.BoxGeometry(0.55, 0.16, 0.2).rotateY(-0.7).translate(-0.9, 0.27, 2.06),
    new THREE.BoxGeometry(1.7, 0.16, 0.14).translate(0, 0.27, -2.26), // rear bumper
    new THREE.BoxGeometry(2.02, 0.15, 2.1).translate(0, 0.3, 0), // rocker cladding
    // tonneau: a recessed panel lying on the bed plane, ribbed with slats
    new THREE.BoxGeometry(1.56, 0.04, 1.95).rotateX(-slope).translate(0, 1.42, -1.27),
  ];
  for (const f of [0.18, 0.38, 0.58, 0.78, 0.95]) {
    parts.push(
      new THREE.BoxGeometry(1.6, 0.05, 0.1)
        .rotateX(-slope)
        .translate(0, 1.62 - 0.44 * f + 0.03, -0.25 - 2.05 * f)
    );
  }
  // arch flare + well backing per wheel (axles at z ±1.4, y 0.38). The
  // flare spans x 0.97–1.13, embedding into the ±1.0 side wall and running
  // flush with the wheel's outer face; the well sits at ±1.02–1.05, between
  // wall and tire, ≥2 cm clear of both (no coplanar pairs).
  for (const zc of [1.4, -1.4]) {
    for (const side of [1, -1]) {
      parts.push(
        archGeo().translate(side === 1 ? 1.13 : -0.97, 0.38, zc),
        wellGeo().translate(side === 1 ? 1.05 : -1.02, 0.38, zc)
      );
    }
  }
  // ExtrudeGeometry is non-indexed while the boxes are indexed; normalize
  // so mergeGeometries accepts the mix
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

// Low-poly vehicle shell: a loft of rectangular cross-sections along the
// vehicle's length (+z = front, same frame as cybertruckGeo). Each section is
// {z, hw, y0, y1} — half-width plus rocker and top heights; walls stitch
// between neighbours and the ends are capped. Non-indexed triangles +
// computeVertexNormals = flat facets, and the DoubleSide vehicle material
// forgives winding parity, exactly like the wedge above.
function loft(sections) {
  const tris = [];
  const corners = sections.map((s) => ({
    tl: [-s.hw, s.y1, s.z],
    tr: [s.hw, s.y1, s.z],
    bl: [-s.hw, s.y0, s.z],
    br: [s.hw, s.y0, s.z],
  }));
  const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d]);
  for (let i = 0; i < corners.length - 1; i++) {
    const f = corners[i]; // the section nearer the nose
    const r = corners[i + 1];
    quad(f.tl, f.tr, r.tr, r.tl); // top
    quad(f.br, f.bl, r.bl, r.br); // bottom
    quad(f.tr, f.br, r.br, r.tr); // right wall
    quad(f.bl, f.tl, r.tl, r.bl); // left wall
  }
  const nose = corners[0];
  const tail = corners[corners.length - 1];
  quad(nose.tl, nose.bl, nose.br, nose.tr);
  quad(tail.tr, tail.br, tail.bl, tail.tl);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat(2)), 3));
  geo.computeVertexNormals();
  return geo;
}

// Cross-sections (nose → tail), meters, matched to the sim's 4.6 m car and
// 16.5 m truck footprints. LIGHT_DIMS up top must track these faces.
const SEDAN_BODY = [
  { z: 2.28, hw: 0.72, y0: 0.42, y1: 0.66 }, // nose face
  { z: 2.1, hw: 0.9, y0: 0.3, y1: 0.75 }, // bumper shelf
  { z: 0.95, hw: 0.95, y0: 0.28, y1: 0.98 }, // hood rising to the cowl
  { z: -1.55, hw: 0.95, y0: 0.28, y1: 1.02 }, // doors through the rear deck
  { z: -2.1, hw: 0.88, y0: 0.32, y1: 0.96 }, // trunk drop
  { z: -2.28, hw: 0.7, y0: 0.44, y1: 0.8 }, // tail face
];
const SEDAN_CABIN = [
  { z: 0.98, hw: 0.78, y0: 0.9, y1: 0.97 }, // cowl
  { z: 0.3, hw: 0.7, y0: 0.9, y1: 1.46 }, // raked windshield to roof
  { z: -0.75, hw: 0.7, y0: 0.9, y1: 1.44 }, // roof
  { z: -1.6, hw: 0.76, y0: 0.9, y1: 0.98 }, // rear glass to deck
];
const HATCH_BODY = [
  { z: 2.17, hw: 0.74, y0: 0.44, y1: 0.7 },
  { z: 1.98, hw: 0.91, y0: 0.3, y1: 0.82 },
  { z: 1.05, hw: 0.95, y0: 0.28, y1: 1.02 },
  { z: -1.95, hw: 0.95, y0: 0.28, y1: 1.06 },
  { z: -2.17, hw: 0.84, y0: 0.38, y1: 1.0 }, // tall tail: hatchback
];
const HATCH_CABIN = [
  { z: 1.02, hw: 0.8, y0: 0.94, y1: 1.0 },
  { z: 0.35, hw: 0.73, y0: 0.94, y1: 1.5 },
  { z: -1.35, hw: 0.73, y0: 0.94, y1: 1.48 }, // long roof
  { z: -2.05, hw: 0.78, y0: 0.94, y1: 1.04 }, // steep tailgate glass
];
const TRUCK_CAB = [
  { z: 8.2, hw: 0.85, y0: 0.55, y1: 1.15 }, // bumper nose
  { z: 8.02, hw: 1.02, y0: 0.35, y1: 1.6 }, // grille
  { z: 6.75, hw: 1.02, y0: 0.32, y1: 1.68 }, // hood
  { z: 6.35, hw: 1.1, y0: 0.32, y1: 2.86 }, // windshield up to the roof
  { z: 4.45, hw: 1.1, y0: 0.32, y1: 2.92 }, // sleeper rear
];

// A merged set of low-poly wheels (cylinders lying on the x axis): one
// [x, z] mount per wheel, radius r, tire width w. Kept as separate meshes
// from the bodies so tires stay dark while instance colors tint the paint.
function wheelsGeo(spots, r, w) {
  return mergeGeometries(
    spots.map(([x, z]) =>
      new THREE.CylinderGeometry(r, r, w, 10).rotateZ(Math.PI / 2).translate(x, r, z)
    )
  );
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
