import * as THREE from 'three';
import { params } from './params.js';
import { ROAD, LOOP, pointAt, forwardAt } from './sim/road.js';
import { isEmergencyVehicle } from './sim/car.js';

// Subtle ambient audio, opt-in via the panel's Sound toggle (params.sound).
// Nothing loads and no AudioContext exists until the user first enables it,
// so the default experience stays byte-identical to the silent one.
//
// The mix is a diorama soundscape, not game feedback: a freeway tire-hum bed
// whose level follows traffic density and speed, positional sirens on the
// emergency vehicles, a positional one-shot when an accident happens, and a
// rain bed following sim.rainNow. There is deliberately no music and no UI
// chrome sound.
//
// Distance model: every sound scales with the camera's distance from the
// road. The beds can't be point sources (the whole loop emits), so the
// traffic bed attenuates like a line source, ref/(ref + d), off the camera's
// distance to the nearest sampled centerline point; sirens and crashes are
// true WebAudio PannerNodes around a listener posed from the camera every
// frame, so they also pan and fall off as the camera moves. Sirens get a
// small manual doppler via playbackRate from their closing speed - WebAudio
// removed its native doppler years ago.
//
// Pause semantics mirror the renderer's: physics sounds (traffic hum,
// sirens) duck to silence while the sim is paused, but rain - a wall-clock
// cosmetic whose droplets keep falling on screen - keeps playing, and a
// click-to-crash while paused still thumps (the wreck appears immediately).
// The whole context suspends with a hidden tab: rAF stalls there, the sim
// freezes, and a hum over a frozen world reads as broken.

const ASSETS = {
  traffic: 'assets/audio/traffic-loop.mp3',
  rain: 'assets/audio/rain-loop.mp3',
  crash: 'assets/audio/crash.mp3',
  ambulance: 'assets/audio/siren-ambulance-loop.mp3',
  police: 'assets/audio/siren-police-loop.mp3',
  firetruck: 'assets/audio/siren-firetruck-loop.mp3',
};

const SPEED_OF_SOUND = 343; // m/s; feeds the sirens' subtle doppler shift
const BED_REF = 70; // m; camera distance where the traffic bed sits at half level
// Per-sound levels, tuned quiet: this is ambience under a visual, not a game
// mix. The master gain stays 1 and only ramps for the on/off toggle.
const LEVEL = { traffic: 0.5, rain: 0.42, siren: 0.65, crash: 0.85 };

export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.failed = false; // no WebAudio at all; the toggle becomes inert
    this.buffers = {};
    this.sirens = new Map(); // car -> { panner, gain, src, rate, dying }
    this.seenIncidents = new WeakSet();
    this.armed = false; // don't voice incidents that predate sound-on
    this.statTimer = 0;
    this.intensity = 0; // traffic bed drive, re-derived at 4 Hz
    this.offTime = 0;
    this.roadKey = '';
    this.roadPts = null;
    this._v = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._camPrev = null; // last camera position, for the doppler's listener term
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.suspend();
      else if (params.sound) this.ctx.resume().catch(() => {});
    });
  }

  // Called by the panel toggle's onChange, inside the click's user gesture -
  // that gesture is what lets Safari create/resume the context at all. The
  // frame-loop update() handles everything after this.
  unlock() {
    if (!params.sound) return;
    this.ensureContext();
    if (this.ctx) this.ctx.resume().catch(() => {});
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  ensureContext() {
    if (this.ctx || this.failed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      this.failed = true;
      console.warn('audio: WebAudio unavailable, Sound toggle does nothing');
      return;
    }
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); // the toggle's fade lives here
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    // physics sounds route through this extra gain so pausing the sim can
    // duck them together; rain and crash impacts ride master directly
    this.physics = ctx.createGain();
    this.physics.connect(this.master);
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    this.trafficGain.connect(this.physics);
    this.sirenGroup = ctx.createGain();
    this.sirenGroup.connect(this.physics);
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainGain.connect(this.master);
    this.sfxGroup = ctx.createGain();
    this.sfxGroup.connect(this.master);
    for (const [id, url] of Object.entries(ASSETS)) this.load(id, url);
    // enabled without a gesture (console, future code path): stay suspended
    // until any interaction, the standard unlock pattern
    const unlock = () => {
      if (params.sound && this.ctx.state === 'suspended' && !document.hidden) {
        this.ctx.resume().catch(() => {});
      }
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  async load(id, url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers[id] = buf;
      // the two beds start looping immediately at gain 0; update() drives
      // their levels, so late-arriving buffers just fade in when ready
      if (id === 'traffic') this.loopSource(buf, this.trafficGain);
      if (id === 'rain') this.loopSource(buf, this.rainGain);
    } catch (err) {
      console.warn(`audio: failed to load ${url}`, err);
    }
  }

  loopSource(buffer, dest) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(dest);
    src.start();
    return src;
  }

  makePanner(refDistance) {
    const p = this.ctx.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.rolloffFactor = 1.2;
    return p;
  }

  // Older Safari exposes only the setter methods, not the AudioParams.
  setPos(node, x, y, z) {
    if (node.positionX) {
      node.positionX.value = x;
      node.positionY.value = y;
      node.positionZ.value = z;
    } else {
      node.setPosition(x, y, z);
    }
  }

  // Per render frame from main.js. dt is wall-clock seconds.
  update(dt, sim, camera) {
    if (!params.sound) {
      // fade out, then suspend so a disabled toggle costs nothing
      if (this.ctx && this.ctx.state === 'running') {
        this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
        if ((this.offTime += dt) > 0.6) this.suspend();
      }
      this.armed = false;
      return;
    }
    this.offTime = 0;
    this.ensureContext();
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') return; // waiting on the unlock gesture
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(1, now, 0.15);
    this.physics.gain.setTargetAtTime(params.paused ? 0 : 1, now, 0.2);
    this.updateListener(camera);
    this.updateBeds(dt, sim, camera, now);
    this.updateSirens(dt, sim, camera, now);
    this.updateCrashes(sim);
  }

  updateListener(camera) {
    const l = this.ctx.listener;
    const p = camera.position;
    const f = camera.getWorldDirection(this._t);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  updateBeds(dt, sim, camera, now) {
    // Bed drive: how much road noise the traffic makes. Density times speed,
    // with a floor so a dead-stop jam still idles faintly. 4 Hz is plenty -
    // the gain smoothing hides the steps.
    if ((this.statTimer -= dt) <= 0) {
      this.statTimer = 0.25;
      let n = 0;
      let v = 0;
      for (const c of sim.cars) {
        n++;
        v += c.v;
      }
      const avg = n ? v / n : 0;
      this.intensity = Math.min(1, n / 140) * (0.25 + 0.75 * Math.min(1, avg / 27));
    }
    const d = this.roadDistance(camera.position);
    const att = BED_REF / (BED_REF + d); // line source: ~1/d, not 1/d²
    this.trafficGain.gain.setTargetAtTime(LEVEL.traffic * this.intensity * att, now, 0.15);
    this.rainGain.gain.setTargetAtTime(LEVEL.rain * (sim.rainNow || 0), now, 0.3);
  }

  // Camera distance to the nearest sampled centerline point. Samples are
  // ~25 m apart (elevation included, so the eight's bridge counts) and
  // rebuild whenever the road geometry changes.
  roadDistance(p) {
    const key = `${params.roadShape}:${params.roadScale}:${LOOP.toFixed(1)}`;
    if (key !== this.roadKey) {
      this.roadKey = key;
      const n = Math.min(200, Math.max(64, Math.round(LOOP / 25)));
      this.roadPts = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pointAt((i / n) * LOOP, 0, this._v);
        this.roadPts[i * 3] = this._v.x;
        this.roadPts[i * 3 + 1] = this._v.y;
        this.roadPts[i * 3 + 2] = this._v.z;
      }
    }
    let best = Infinity;
    const a = this.roadPts;
    for (let i = 0; i < a.length; i += 3) {
      const dx = p.x - a[i];
      const dy = p.y - a[i + 1];
      const dz = p.z - a[i + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  }

  updateSirens(dt, sim, camera, now) {
    // Listener velocity, differenced from the camera path: a chase camera
    // moving with a siren must hear rate 1, not a fleeing source. A view
    // teleport (focusOnS, view buttons) reads as an absurd speed for one
    // frame; treat anything over 150 m/s as a jump and call it stationary.
    if (this._camPrev && dt > 0) {
      this._camVel.copy(camera.position).sub(this._camPrev).divideScalar(dt);
      if (this._camVel.length() > 150) this._camVel.set(0, 0, 0);
    }
    this._camPrev = (this._camPrev || new THREE.Vector3()).copy(camera.position);
    // Derive the active set from sim.cars each frame rather than trusting a
    // cache: a reset while paused leaves sim's own cache stale until the
    // next step, and a stale entry would strand a looping siren.
    const active = [];
    for (const c of sim.cars) {
      if (isEmergencyVehicle(c.kind) && c.state === 'main' && !c.incident) active.push(c);
    }
    for (const car of active) {
      if (this.sirens.has(car) || !this.buffers[car.kind]) continue;
      const panner = this.makePanner(45);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers[car.kind];
      src.loop = true;
      src.connect(panner).connect(gain).connect(this.sirenGroup);
      // random start phase so two responders of one kind never sound cloned
      src.start(0, Math.random() * src.buffer.duration);
      this.sirens.set(car, { panner, gain, src, rate: 1, dying: 0 });
    }
    for (const [car, s] of this.sirens) {
      if (!active.includes(car)) {
        // fade before stop: a hard cut clicks, and wrecked responders
        // (incident set) or despawns should sound like the siren dying
        s.gain.gain.setTargetAtTime(0, now, 0.12);
        if ((s.dying += dt) > 0.7) {
          s.src.stop();
          s.src.disconnect();
          s.panner.disconnect();
          s.gain.disconnect();
          this.sirens.delete(car);
        }
        continue;
      }
      s.dying = 0;
      pointAt(car.s, -car.renderLane * ROAD.laneWidth, this._v);
      this.setPos(s.panner, this._v.x, this._v.y + 1.5, this._v.z);
      s.gain.gain.setTargetAtTime(LEVEL.siren, now, 0.1);
      // Doppler: closing speed of the source toward the listener, relative
      // velocities, clamped subtle. Uses the visual speed (timeScale
      // included), so fast-forward shifts harder.
      forwardAt(car.s, this._t);
      const dx = camera.position.x - this._v.x;
      const dz = camera.position.z - this._v.z;
      const dist = Math.hypot(dx, dz) || 1;
      const vWorld = params.paused ? 0 : car.v * params.timeScale;
      const closing =
        ((this._t.x * vWorld - this._camVel.x) * dx + (this._t.z * vWorld - this._camVel.z) * dz) /
        dist;
      const target = THREE.MathUtils.clamp(1 + closing / SPEED_OF_SOUND, 0.95, 1.05);
      s.rate += (target - s.rate) * Math.min(1, 4 * dt);
      s.src.playbackRate.value = s.rate;
    }
  }

  updateCrashes(sim) {
    // First armed pass after sound-on: swallow whatever already happened so
    // enabling audio next to three old wrecks doesn't play a thump salvo.
    if (!this.armed) {
      for (const inc of sim.incidents) this.seenIncidents.add(inc);
      this.armed = true;
      return;
    }
    for (const inc of sim.incidents) {
      if (inc.kind !== 'accident' || this.seenIncidents.has(inc)) continue;
      this.seenIncidents.add(inc);
      const car = inc.cars[0];
      if (!car || !this.buffers.crash) continue;
      pointAt(car.s, -car.renderLane * ROAD.laneWidth, this._v);
      const panner = this.makePanner(90); // a crash carries further than a siren
      this.setPos(panner, this._v.x, this._v.y + 1, this._v.z);
      const src = this.ctx.createBufferSource();
      src.buffer = this.buffers.crash;
      src.connect(panner).connect(this.sfxGroup);
      src.onended = () => {
        src.disconnect();
        panner.disconnect();
      };
      src.start();
    }
  }
}
