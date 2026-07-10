import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROAD, RAMPS, LOOP, bounds, pointAt, forwardAt, wrap } from '../sim/road.js';
import { params, KMH, MPH } from '../params.js';

const MAX_CARS = 1500;
const MAX_TRUCKS = 400;
const MAX_AMB = 8; // sim.spawnAmbulance caps at the same count (MAX_AMBULANCES)
const STROBE_RED = new THREE.Color(0xff2a2a);
const STROBE_BLUE = new THREE.Color(0x2a6bff);
const MAX_LIGHTS = MAX_CARS + MAX_TRUCKS;
const BG = 0x0e1512;

// Light mount points per vehicle kind, in the car's local frame (+z = front,
// +x = driver's left = inward). y/rear/front from the body geometries below.
const LIGHT_DIMS = {
  car: { rear: -2.29, front: 2.29, halfW: 0.78, y: 0.95, brakeW: 1.5 },
  acc: { rear: -2.31, front: 2.31, halfW: 0.78, y: 1.0, brakeW: 1.7 }, // full-width light bar
  truck: { rear: -7.77, front: 8.21, halfW: 1.05, y: 0.95, brakeW: 2.1 },
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
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.Fog(BG, 800, 2000);

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

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x36462f, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
    sun.position.set(250, 380, -180);
    this.scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(2400, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2c3a2e, roughness: 1 })
    );
    ground.position.y = -0.15;
    this.scene.add(ground);

    this.roadGroup = null;
    this.rampGroup = null;
    this.coneGroup = null;
    this.rampFlowEls = {};
    this.buildRoad();
    this.buildRamps();
    this.buildWorkZone();
    this.buildCars();

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
    this._bodyColor = new THREE.Color();
    this._cabinColor = new THREE.Color();
    this._raycaster = new THREE.Raycaster();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    // chase camera state
    this.chaseCar = null;
    this._chasePos = new THREE.Vector3();
    this._chaseAim = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    // Click detection (as opposed to an orbit drag): small movement, quick
    // release. main.js assigns onRoadClick to receive the ground-plane point.
    this.onRoadClick = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this._press = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    canvas.addEventListener('pointerup', (e) => {
      const press = this._press;
      this._press = null;
      if (!press || !this.onRoadClick) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (dx * dx + dy * dy > 36 || performance.now() - press.t > 500) return;
      const pt = this.pickGround(e.clientX, e.clientY);
      if (pt) this.onRoadClick(pt);
    });

    // Hover position for the car readout: buttons pressed means an orbit
    // drag (or a touch), not a hover. main.js re-picks against this every
    // frame so the readout tracks traffic moving under a resting pointer.
    this._pointer = null;
    canvas.addEventListener('pointermove', (e) => {
      this._pointer = e.buttons === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener('pointerleave', () => {
      this._pointer = null;
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

  // Ray from a screen position onto the ground plane (y = 0).
  pickGround(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this._raycaster.ray.intersectPlane(this._groundPlane, out) ? out : null;
  }

  // Ground point under the resting pointer, or null (off-canvas / mid-drag).
  pointerGround() {
    return this._pointer ? this.pickGround(this._pointer.x, this._pointer.y) : null;
  }

  // Hover readout: nameplate above a car with its live speed and desired
  // speed in parens. Called every frame with the car under the pointer (or
  // null), so the text and anchor stay current as the car drives on.
  setHoverCar(car) {
    this.hoverTip.visible = !!car;
    if (!car) return;
    this.carPose(car, this._pos, this._tan);
    this.hoverTip.position.set(this._pos.x, car.kind === 'truck' ? 4.2 : 2.6, this._pos.z);
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
        pts.push(new THREE.Vector3(p.x, 0.04, p.z));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color: 0xb9c2cc, dashSize: 4, gapSize: 6 })
      );
      line.computeLineDistances();
      g.add(line);
    }

    this.roadGroup = g;
    this.scene.add(g);

    // haze, zoom range, and clip plane all scale with how far the fitted
    // cameras sit from the road — big road scales push the overhead view
    // past the defaults tuned for the 1x loop
    const { h } = this.viewFit();
    this.scene.fog.near = h * 1.35;
    this.scene.fog.far = h * 3.2;
    this.controls.maxDistance = Math.max(1400, h * 1.5);
    this.camera.far = Math.max(3000, h * 4);
    this.camera.updateProjectionMatrix();
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
      d.position.set(pos.x, 0, pos.z);
      d.updateMatrix();
      cones.setMatrixAt(i, d.matrix);
    }
    cones.frustumCulled = false;
    this.coneGroup = new THREE.Group();
    this.coneGroup.add(cones);
    this.scene.add(this.coneGroup);
  }

  buildCars() {
    const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.25 });
    // passenger cars: body + cabin
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.15, 4.55).translate(0, 0.85, 0);
    const cabinGeo = new THREE.BoxGeometry(1.65, 0.72, 2.3).translate(0, 1.68, -0.25);
    this.body = new THREE.InstancedMesh(bodyGeo, mat(), MAX_CARS);
    this.cabin = new THREE.InstancedMesh(cabinGeo, mat(), MAX_CARS);
    // semi trucks: trailer (rear-biased) + tractor cab at the front
    const trailerGeo = new THREE.BoxGeometry(2.45, 3.1, 11.8).translate(0, 1.85, -1.85);
    const cabGeo = new THREE.BoxGeometry(2.35, 2.7, 3.8).translate(0, 1.55, 6.3);
    this.trailer = new THREE.InstancedMesh(trailerGeo, mat(), MAX_TRUCKS);
    this.cab = new THREE.InstancedMesh(cabGeo, mat(), MAX_TRUCKS);
    // ACC cars: an angular stainless wedge — unmistakable from above
    this.cyber = new THREE.InstancedMesh(
      cybertruckGeo(),
      new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }),
      MAX_CARS
    );
    // ambulance: white box van with a red belt stripe; roof strobes are
    // separate unlit instances whose red/blue swap sides on the hazard
    // blink clock, so the bar reads as flashing from any angle
    const vanGeo = new THREE.BoxGeometry(2.25, 2.05, 5.4).translate(0, 1.33, 0);
    const stripeGeo = new THREE.BoxGeometry(2.31, 0.3, 5.46).translate(0, 1.05, 0);
    this.ambBody = new THREE.InstancedMesh(vanGeo, mat(), MAX_AMB);
    this.ambStripe = new THREE.InstancedMesh(
      stripeGeo,
      new THREE.MeshStandardMaterial({ color: 0xc63a30, roughness: 0.5, metalness: 0.25 }),
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
    for (const m of [this.body, this.cabin, this.trailer, this.cab, this.cyber, this.ambBody, this.ambStripe, this.strobes, this.brakeLights, this.blinkers]) {
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
  placeLight(mesh, idx, rotY, ox, oy, oz, sx, sy, sz) {
    const d = this._lightDummy;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    d.position.set(this._pos.x + ox * cos + oz * sin, oy, this._pos.z - ox * sin + oz * cos);
    d.rotation.set(0, rotY, 0);
    d.scale.set(sx, sy, sz);
    d.updateMatrix();
    mesh.setMatrixAt(idx, d.matrix);
  }

  update(cars) {
    const desired = params.desiredSpeed;
    const blinkOn = Math.floor(performance.now() / 400) % 2 === 0; // hazard flashers
    let ci = 0; // next free car instance
    let ti = 0; // next free truck instance
    let ai = 0; // next free ACC-car instance
    let mi = 0; // next free ambulance instance
    let si = 0; // next free strobe instance
    let li = 0; // next free brake-light instance
    let ki = 0; // next free blinker instance
    for (const car of cars) {
      const truck = car.kind === 'truck';
      const acc = car.kind === 'acc';
      const ambu = car.kind === 'ambulance';
      if (truck ? ti >= MAX_TRUCKS : ambu ? mi >= MAX_AMB : (acc ? ai : ci) >= MAX_CARS) continue;
      this.carPose(car, this._pos, this._tan);
      let rotY = Math.atan2(this._tan.x, this._tan.z);
      if (!car.ramp && car.wreckYaw && car.v < 3) rotY += car.wreckYaw; // skidded askew
      this._dummy.position.set(this._pos.x, 0, this._pos.z);
      this._dummy.rotation.set(0, rotY, 0);
      this._dummy.updateMatrix();

      if (car.incident) {
        this._bodyColor.set(blinkOn ? 0xffa726 : 0x5c3a12); // amber hazards
      } else if (params.colorMode === 'speed') {
        const t = THREE.MathUtils.clamp(car.v / desired, 0, 1);
        this._bodyColor.setHSL(t * 0.33, 0.85, 0.5);
      } else {
        this._bodyColor.setHSL(car.hue, 0.65, 0.55);
      }
      this._cabinColor.copy(this._bodyColor).multiplyScalar(0.45);

      if (truck) {
        this.trailer.setMatrixAt(ti, this._dummy.matrix);
        this.cab.setMatrixAt(ti, this._dummy.matrix);
        this.trailer.setColorAt(ti, this._bodyColor);
        this.cab.setColorAt(ti, this._cabinColor);
        ti++;
      } else if (ambu) {
        // white van regardless of color mode; incidents keep the amber blink
        if (!car.incident) this._bodyColor.set(0xf4f7f9);
        this.ambBody.setMatrixAt(mi, this._dummy.matrix);
        this.ambStripe.setMatrixAt(mi, this._dummy.matrix);
        this.ambBody.setColorAt(mi, this._bodyColor);
        mi++;
        if (!car.incident && si + 1 < MAX_AMB * 2) {
          // roof bar: red/blue swap sides every blink tick
          this.placeLight(this.strobes, si, rotY, 0.6, 2.55, 1.6, 0.5, 0.22, 0.5);
          this.strobes.setColorAt(si++, blinkOn ? STROBE_RED : STROBE_BLUE);
          this.placeLight(this.strobes, si, rotY, -0.6, 2.55, 1.6, 0.5, 0.22, 0.5);
          this.strobes.setColorAt(si++, blinkOn ? STROBE_BLUE : STROBE_RED);
        }
      } else if (acc) {
        this.cyber.setMatrixAt(ai, this._dummy.matrix);
        this.cyber.setColorAt(ai, this._bodyColor);
        ai++;
      } else {
        this.body.setMatrixAt(ci, this._dummy.matrix);
        this.cabin.setMatrixAt(ci, this._dummy.matrix);
        this.body.setColorAt(ci, this._bodyColor);
        this.cabin.setColorAt(ci, this._cabinColor);
        ci++;
      }

      // brake lights + blinkers (incident cars blink their whole body amber)
      if (!car.incident) {
        const L = LIGHT_DIMS[car.kind];
        if (car.brakeLit && li < MAX_LIGHTS) {
          this.placeLight(this.brakeLights, li++, rotY, 0, L.y, L.rear, L.brakeW, 0.16, 0.1);
        }
        if (car.signal !== 0 && blinkOn && ki + 1 < MAX_LIGHTS) {
          const sx = car.signal > 0 ? L.halfW : -L.halfW; // +x local = driver's left
          this.placeLight(this.blinkers, ki++, rotY, sx, L.y, L.rear, 0.22, 0.2, 0.14);
          this.placeLight(this.blinkers, ki++, rotY, sx, L.y, L.front, 0.22, 0.2, 0.14);
        }
      }
    }
    this.body.count = ci;
    this.cabin.count = ci;
    this.trailer.count = ti;
    this.cab.count = ti;
    this.cyber.count = ai;
    this.ambBody.count = mi;
    this.ambStripe.count = mi;
    this.strobes.count = si;
    this.brakeLights.count = li;
    this.blinkers.count = ki;
    for (const m of [this.body, this.cabin, this.trailer, this.cab, this.cyber, this.ambBody, this.ambStripe, this.strobes, this.brakeLights, this.blinkers]) {
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
      // snap straight to the follow position instead of flying across the map
      this.chaseGoals(this._chasePos, this._chaseAim);
      this.camera.position.copy(this._chasePos);
      this.camera.lookAt(this._chaseAim);
    }
  }

  stopChase() {
    this.chaseCar = null;
    if (this.controls) this.controls.enabled = true;
  }

  chaseGoals(posOut, aimOut) {
    this.carPose(this.chaseCar, this._pos, this._tan);
    // hang further back (and higher) behind long vehicles so they don't fill
    // the whole frame
    const back = 14 + Math.max(0, this.chaseCar.len - 4.6);
    const up = this.chaseCar.kind === 'truck' ? 8.5 : 6;
    posOut.copy(this._pos).addScaledVector(this._tan, -back);
    posOut.y += up;
    aimOut.copy(this._pos).addScaledVector(this._tan, 16);
    aimOut.y += 1.5;
  }

  render(dt = 1 / 60) {
    if (this.chaseCar) {
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
    this.roadCursor.position.set(this._pos.x, 0.06, this._pos.z);
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

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// ACC cars: a low-poly angular pickup wedge — one unbroken line from the
// nose up to a roof peak, then straight down to the tail. Same 4.6 m
// footprint as a regular car (+z = front, matching the box geometries).
// Non-indexed triangles so computeVertexNormals yields the flat facets.
function cybertruckGeo() {
  const y0 = 0.35; // ground clearance
  const zF = 2.3;  // nose
  const zT = -2.3; // tail
  const zP = -0.25; // roof peak, just behind the midpoint
  const A = (s) => [s * 1.0, y0, zF];    // nose, beltline width
  const B = (s) => [s * 1.0, y0, zT];    // tail bottom
  const F = (s) => [s * 0.95, 0.98, zF]; // hood leading edge
  const P = (s) => [s * 0.8, 1.62, zP];  // roof peak (sides taper inward)
  const T = (s) => [s * 0.9, 1.18, zT];  // tail top
  const tris = [
    [F(-1), F(1), P(1)], [F(-1), P(1), P(-1)], // hood + windshield plane
    [P(-1), P(1), T(1)], [P(-1), T(1), T(-1)], // bed cover
    [A(-1), A(1), F(1)], [A(-1), F(1), F(-1)], // nose face
    [T(1), B(1), B(-1)], [T(1), B(-1), T(-1)], // tail face
    [A(1), B(1), T(1)], [A(1), T(1), P(1)], [A(1), P(1), F(1)], // right side
    [A(-1), T(-1), B(-1)], [A(-1), P(-1), T(-1)], [A(-1), F(-1), P(-1)], // left side
    [A(1), A(-1), B(-1)], [A(1), B(-1), B(1)], // underside
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris.flat(2)), 3));
  geo.computeVertexNormals(); // DoubleSide material corrects any face parity
  return geo;
}

// Flat triangle strip swept around the whole loop between two lateral offsets
// (positive = outward of lane 0's centerline). Used for pavement and the
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
    positions[o + 1] = y;
    positions[o + 2] = a.z;
    positions[o + 3] = b.x;
    positions[o + 4] = y;
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
