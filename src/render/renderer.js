import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { ROAD, RAMPS, pointAt, forwardAt } from '../sim/road.js';
import { params } from '../params.js';

const MAX_CARS = 1500;
const BG = 0x0e1512;

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
      new THREE.CircleGeometry(1200, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x2c3a2e, roughness: 1 })
    );
    ground.position.y = -0.15;
    this.scene.add(ground);

    this.roadGroup = null;
    this.buildRoad();
    this.buildRamps();
    this.buildCars();

    this._pos = new THREE.Vector3();
    this._tan = new THREE.Vector3();
    this._dummy = new THREE.Object3D();
    this._bodyColor = new THREE.Color();
    this._cabinColor = new THREE.Color();

    window.addEventListener('resize', () => this.onResize());
  }

  // The road is rebuilt whenever the lane count changes: the outer edge is
  // fixed and lanes grow inward, so ramps and cars' lane-0 geometry hold still.
  buildRoad() {
    if (this.roadGroup) {
      this.roadGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.roadGroup);
    }
    const g = new THREE.Group();
    const outer = ROAD.outerR;
    const inner = outer - params.lanes * ROAD.laneWidth;

    const asphalt = new THREE.Mesh(
      new THREE.RingGeometry(inner - 1.0, outer + 1.0, 220).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 1 })
    );
    g.add(asphalt);

    const edge = (r, color) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.15, r + 0.15, 220).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color })
      );
      m.position.y = 0.02;
      return m;
    };
    g.add(edge(outer - 0.2, 0xc8cfd6)); // white outer edge line
    g.add(edge(inner + 0.2, 0xd9b64a)); // yellow inner edge line

    for (let l = 1; l < params.lanes; l++) {
      const r = outer - l * ROAD.laneWidth;
      const pts = [];
      const SEG = 256;
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        pts.push(new THREE.Vector3(r * Math.cos(a), 0.04, r * Math.sin(a)));
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
  }

  buildRamps() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3a3d44,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    const lineMat = new THREE.LineBasicMaterial({ color: 0xc8cfd6 });
    for (const ramp of RAMPS) {
      this.scene.add(new THREE.Mesh(rampRibbon(ramp.curve, 6.0), mat));
      // Outer (right-hand) edge line runs the full ramp; the inner one stops
      // short of the merge/diverge area so it doesn't scribble on the road.
      this.scene.add(rampEdgeLine(ramp.curve, 2.7, lineMat, 0, 1));
      if (ramp.type === 'on') this.scene.add(rampEdgeLine(ramp.curve, -2.7, lineMat, 0, 0.55));
      else this.scene.add(rampEdgeLine(ramp.curve, -2.7, lineMat, 0.45, 1));

      // Label at the ramp's outer end, nudged past the pavement.
      const el = document.createElement('div');
      el.className = `map-label ${ramp.type}`;
      el.textContent = ramp.label;
      const atStart = ramp.type === 'on'; // on-ramps enter at u=0, exits leave at u=1
      const anchor = ramp.curve.getPointAt(atStart ? 0 : 1);
      const dir = ramp.curve.getTangentAt(atStart ? 0 : 1);
      if (atStart) dir.negate();
      anchor.addScaledVector(dir, 16);
      anchor.y = 2;
      const labelObj = new CSS2DObject(el);
      labelObj.position.copy(anchor);
      this.scene.add(labelObj);
    }
  }

  buildCars() {
    const bodyGeo = new THREE.BoxGeometry(1.9, 1.15, 4.55).translate(0, 0.85, 0);
    const cabinGeo = new THREE.BoxGeometry(1.65, 0.72, 2.3).translate(0, 1.68, -0.25);
    const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.25 });
    this.body = new THREE.InstancedMesh(bodyGeo, mat(), MAX_CARS);
    this.cabin = new THREE.InstancedMesh(cabinGeo, mat(), MAX_CARS);
    for (const m of [this.body, this.cabin]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      this.scene.add(m);
    }
  }

  update(cars) {
    const n = Math.min(cars.length, MAX_CARS);
    const desired = params.desiredSpeed;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      let rotY;
      if (car.state === 'main') {
        pointAt(car.s, -car.renderLane * ROAD.laneWidth, this._pos);
        forwardAt(car.s, this._tan);
        rotY = Math.atan2(this._tan.x, this._tan.z);
      } else {
        const u = THREE.MathUtils.clamp(car.rampPos / car.ramp.length, 0, 1);
        car.ramp.curve.getPointAt(u, this._pos);
        car.ramp.curve.getTangentAt(u, this._tan);
        rotY = Math.atan2(this._tan.x, this._tan.z);
      }
      this._dummy.position.set(this._pos.x, 0, this._pos.z);
      this._dummy.rotation.set(0, rotY, 0);
      this._dummy.updateMatrix();
      this.body.setMatrixAt(i, this._dummy.matrix);
      this.cabin.setMatrixAt(i, this._dummy.matrix);

      if (params.colorMode === 'speed') {
        const t = THREE.MathUtils.clamp(car.v / desired, 0, 1);
        this._bodyColor.setHSL(t * 0.33, 0.85, 0.5);
      } else {
        this._bodyColor.setHSL(car.hue, 0.65, 0.55);
      }
      this.body.setColorAt(i, this._bodyColor);
      this.cabin.setColorAt(i, this._cabinColor.copy(this._bodyColor).multiplyScalar(0.45));
    }
    this.body.count = n;
    this.cabin.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.cabin.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.cabin.instanceColor) this.cabin.instanceColor.needsUpdate = true;
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }

  // The view target sits east of the loop's center so the scene shifts left
  // on screen, keeping interchange A and its labels clear of the control
  // panel that occupies the right edge.
  setDefaultView() {
    this.camera.position.set(100, 270, 405);
    this.camera.lookAt(100, 0, 0);
    if (this.controls) this.controls.target.set(100, 0, 0);
  }

  setTopView() {
    this.camera.position.set(100, 660, 0.1);
    this.camera.lookAt(100, 0, 0);
    this.controls.target.set(100, 0, 0);
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }
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
