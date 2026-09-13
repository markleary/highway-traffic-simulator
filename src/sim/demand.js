import { vehicleSpec } from './car.js';

// Upstream arrivals are requests, not cars in the rendered world. One byte
// preserves each request's controller/body choice without allocating a Car
// (or an object per waiting driver). Releasing complete chunks keeps storage
// proportional to the current backlog; an overloaded entrance never drops it.
const REQUESTS = [
  ['car', 'car'], ['car', 'ev'], ['car', 'cybertruck'],
  ['acc', 'car'], ['acc', 'ev'], ['acc', 'cybertruck'],
  ['truck', 'truck'],
];
const CHUNK_SIZE = 1024;

function requestCode(spec) {
  const code = REQUESTS.findIndex(([kind, model]) => kind === spec.kind && model === spec.model);
  if (code < 0) throw new Error(`Invalid ramp request: ${spec.kind}/${spec.model}`);
  return code;
}

// A private stream keeps arrival timing independent of how many cars the
// entrance admits, and of the random decisions those cars make downstream.
function randomStream(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export class RampDemand {
  constructor(seed = Math.floor(Math.random() * 4294967296)) {
    this.requested = 0;
    this.admitted = 0;
    this._chunks = [];
    this._read = 0;
    this._write = CHUNK_SIZE;
    this._head = null;
    this._remaining = null; // integrated rate until the next request, in vehicles
    this._mode = null;
    this._random = randomStream(seed);
  }

  get waiting() { return this.requested - this.admitted; }

  enqueue(spec) {
    const code = requestCode(spec);
    if (this._write === CHUNK_SIZE) {
      this._chunks.push(new Uint8Array(CHUNK_SIZE));
      this._write = 0;
    }
    this._chunks[this._chunks.length - 1][this._write++] = code;
    this.requested++;
  }

  peek() {
    if (!this.waiting) return null;
    if (!this._head) {
      const [kind, model] = REQUESTS[this._chunks[0][this._read]];
      this._head = vehicleSpec(kind, model);
    }
    return this._head;
  }

  admit() {
    const spec = this.peek();
    if (!spec) return null;
    this._head = null;
    this.admitted++;
    this._read++;
    if (this._read === CHUNK_SIZE) {
      this._chunks.shift();
      this._read = 0;
    }
    if (!this.waiting) {
      this._chunks.length = 0;
      this._read = 0;
      this._write = CHUNK_SIZE;
    }
    return spec;
  }

  advance(h, ratePerSecond, mode, sampleSpec) {
    if (!(h > 0) || !(ratePerSecond > 0)) return;
    const nextMode = mode === 'regular' ? 'regular' : 'random';
    if (this._mode !== nextMode) {
      // A live mode edit starts the new headway process. Already requested
      // vehicles keep their FIFO positions and identities.
      this._mode = nextMode;
      this._remaining = null;
    }
    const interval = () => nextMode === 'regular'
      ? 1
      : -Math.log(Math.max(Number.MIN_VALUE, this._random()));
    this._remaining ??= interval();
    let exposure = h * ratePerSecond;
    // Integrated rate preserves unfinished headways across live rate edits.
    // Zero rate pauses only new demand; the simulation still drains this FIFO.
    while (exposure + 1e-12 >= this._remaining) {
      exposure = Math.max(0, exposure - this._remaining);
      this.enqueue(sampleSpec());
      this._remaining = interval();
    }
    this._remaining -= exposure;
  }

  stats() {
    return { requested: this.requested, admitted: this.admitted, waiting: this.waiting };
  }
}
