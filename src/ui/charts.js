import { params, KMH, MPH } from '../params.js';
import { LOOP, RAMPS } from '../sim/road.js';

// Live rolling charts of average speed and flow over the last 5 minutes,
// plus a space-time diagram (position × time speed heatmap) on the same
// time axis. Two separate mini-charts (never a dual axis); series hues come
// from the validated dark-surface categorical palette. Sim-time based:
// pausing the simulation pauses the charts.
const WINDOW = 300; // seconds shown
const W = 320; // logical canvas size (CSS px)
const H = 56;
const DIAG_H = 120;
const SPEED_COLOR = '#3987e5';
const FLOW_COLOR = '#199e70';
const CARS_COLOR = '#d98e32';
const INCIDENT_SHADE = 'rgba(230, 103, 103, 0.16)';
// Empty road (no vehicle in the bin): dim green, so free-flowing *traffic*
// shows as bright trajectories against it and jams as red bands.
const EMPTY_COLOR = 'hsl(120, 25%, 24%)';
// Incident-start marker on the diagram: dark solid red, kin to the line
// charts' incident bands but distinct from the bright jam-red of the heatmap.
const INCIDENT_START = '#8f2b2b';

export class ChartPanel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'panel charts';
    this.speed = this.makeChart('Average speed', SPEED_COLOR);
    this.flow = this.makeChart('Flow past start', FLOW_COLOR);
    this.cars = this.makeChart('Cars on road', CARS_COLOR);
    this.diag = this.makeDiagram();
    document.body.appendChild(this.el);
    this.history = [];
    this.incidentStarts = [];
    this.onHoverS = null; // set by main.js: reports the hovered loop position (or null)
  }

  makeChart(title, color) {
    const wrap = document.createElement('div');
    wrap.className = 'chart';
    const head = document.createElement('div');
    head.className = 'chead';
    const name = document.createElement('span');
    name.innerHTML = `<i style="background:${color}"></i>${title}`;
    const value = document.createElement('span');
    value.className = 'cval';
    value.textContent = '—';
    head.append(name, value);
    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    wrap.append(head, canvas);
    this.el.appendChild(wrap);

    const chart = { canvas, ctx, color, value, hoverT: null };
    // crosshair: hover pins the readout to the sample under the cursor
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      chart.hoverT = (e.clientX - r.left) / r.width; // 0..1 across the window
    });
    canvas.addEventListener('pointerleave', () => (chart.hoverT = null));
    return chart;
  }

  update(history, incidentStarts = []) {
    this.el.style.display = params.showCharts ? '' : 'none';
    if (!params.showCharts) {
      if (this.onHoverS) this.onHoverS(null); // don't leave a stale road marker
      return;
    }
    this.history = history;
    this.incidentStarts = incidentStarts;
    const imp = params.units === 'imperial';
    const spd = imp ? MPH : KMH;
    const unit = imp ? 'mph' : 'km/h';
    this.draw(this.speed, (p) => p.v / spd, (x) => `${x.toFixed(0)} ${unit}`);
    this.draw(this.flow, (p) => p.f, (x) => `${x.toFixed(1)}/min`);
    this.draw(this.cars, (p) => p.n, (x) => `${Math.round(x)}`);
    this.drawDiagram((x) => `${(x / spd).toFixed(0)} ${unit}`);
  }

  // Space-time diagram: each column is one second, bottom→top is one lap of
  // the loop (s = 0 at the bottom), color = mean speed of the vehicles in
  // each 10 m stretch. Jam waves show up as red bands crawling upstream —
  // sloping down-right — while the cars carrying them drive up-right.
  makeDiagram() {
    const wrap = document.createElement('div');
    wrap.className = 'chart';
    const head = document.createElement('div');
    // 'tall' reserves two text lines: the hover readout is long enough to
    // wrap, and without the reservation the whole panel above would jump
    head.className = 'chead tall';
    const name = document.createElement('span');
    name.innerHTML =
      '<i style="background:linear-gradient(90deg, hsl(0 90% 50%), hsl(60 90% 50%), hsl(120 70% 45%))"></i>Space–time (position × time)';
    const value = document.createElement('span');
    value.className = 'cval';
    value.textContent = '';
    head.append(name, value);
    const canvas = document.createElement('canvas');
    canvas.className = 'diagram';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = DIAG_H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    wrap.append(head, canvas);
    this.el.appendChild(wrap);

    // heat columns accumulate in an offscreen ring buffer (1 px per sample,
    // 1 px per bin); the visible canvas just blits + annotates it
    const d = { wrap, canvas, ctx, value, hoverT: null, hoverY: null, off: null, offCtx: null, cursor: 0, lastT: -1 };
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      d.hoverT = (e.clientX - r.left) / r.width;
      d.hoverY = (e.clientY - r.top) / r.height;
    });
    canvas.addEventListener('pointerleave', () => (d.hoverT = null));
    return d;
  }

  drawDiagram(fmt) {
    const d = this.diag;
    d.wrap.style.display = params.showDiagram ? '' : 'none';
    if (!params.showDiagram) {
      if (this.onHoverS) this.onHoverS(null);
      return;
    }
    const { ctx } = d;
    ctx.clearRect(0, 0, W, DIAG_H);
    const history = this.history;
    const last = history[history.length - 1];
    if (!last || !last.bins) {
      d.value.textContent = '';
      if (this.onHoverS) this.onHoverS(null);
      return;
    }
    const nBins = last.bins.length;

    // (re)create the ring on first use, on sim reset, or when the road shape
    // changed the bin count. Resets are detected by history's array identity —
    // sim.reset() replaces the array — because the time-went-backwards check
    // alone goes blind if the reset happens while this panel is hidden and the
    // new run's clock overtakes the old lastT before it is shown again (the
    // ring would then blit stale columns from the previous run as if current).
    if (!d.off || d.off.height !== nBins || d.histRef !== history || last.t < d.lastT) {
      d.off = document.createElement('canvas');
      d.off.width = WINDOW;
      d.off.height = nBins;
      d.offCtx = d.off.getContext('2d');
      d.cursor = 0;
      d.lastT = -1;
      d.histRef = history;
    }
    // paint columns for samples not yet drawn (also catches up after the
    // panel was hidden; history never outlives the ring's WINDOW columns)
    for (const p of history) {
      if (p.t <= d.lastT) continue;
      this.paintColumn(d, p, nBins);
      d.lastT = p.t;
    }

    // blit the ring so columns line up with the other charts' time axis
    const tNow = last.t;
    const t0 = Math.max(0, tNow - WINDOW);
    const span = Math.max(tNow - t0, 30);
    const xs = (t) => ((t - t0) / span) * W;
    const n = history.length; // the last n ring columns are history[0..n-1]
    const x0 = xs(history[0].t);
    const colW = (xs(tNow) + W / span - x0) / n; // newest column stays visible
    let start = (d.cursor - n) % WINDOW;
    if (start < 0) start += WINDOW;
    ctx.imageSmoothingEnabled = false;
    if (start + n <= WINDOW) {
      ctx.drawImage(d.off, start, 0, n, nBins, x0, 0, n * colW, DIAG_H);
    } else {
      const n1 = WINDOW - start;
      ctx.drawImage(d.off, start, 0, n1, nBins, x0, 0, n1 * colW, DIAG_H);
      ctx.drawImage(d.off, 0, 0, n - n1, nBins, x0 + n1 * colW, 0, (n - n1) * colW, DIAG_H);
    }

    // ramp positions as ticks on the left edge (colors match the map labels)
    for (const ramp of RAMPS) {
      const s = ramp.type === 'on' ? ramp.sJoin : ramp.sDiverge;
      const y = DIAG_H * (1 - s / LOOP);
      ctx.fillStyle = ramp.type === 'on' ? '#7ec8a0' : '#d9b64a';
      ctx.fillRect(0, y - 1, 5, 2);
    }

    // incident starts: a solid dark red line per triggered incident, kin to
    // the line charts' bands. Drawn from the sim's start-time log rather than
    // the samples' any-incident flag, so an incident that begins while
    // another is still live gets its own line. Clip against the displayed
    // window start (t0), not the first sample's time — an incident triggered
    // in the first second after a reset predates every sample but its time
    // is still on the axis.
    ctx.fillStyle = INCIDENT_START;
    for (const tInc of this.incidentStarts) {
      if (tInc >= t0 && tInc <= tNow) {
        ctx.fillRect(xs(tInc) - 0.75, 0, 1.5, DIAG_H);
      }
    }

    // hover: pin the readout to the (time, position) cell under the cursor.
    // Empty road has no speed to read, so snap to the nearest measured bin
    // in the column (wrapped in s, like the loop) — the same way the other
    // charts snap the crosshair to their line; the s= readout says where it
    // landed. Only a column with no traffic anywhere reads as a dash.
    if (d.hoverT !== null) {
      const tH = t0 + d.hoverT * span;
      let nearest = history[0];
      for (const p of history) if (Math.abs(p.t - tH) < Math.abs(nearest.t - tH)) nearest = p;
      const cursor = Math.min(nBins - 1, Math.max(0, Math.floor((1 - d.hoverY) * nBins)));
      let bin = -1;
      for (let off = 0; off < nBins && bin < 0; off++) {
        const below = (cursor - off + nBins) % nBins;
        const above = (cursor + off) % nBins;
        if (nearest.bins[below] >= 0) bin = below;
        else if (nearest.bins[above] >= 0) bin = above;
      }
      const x = xs(nearest.t);
      const y = DIAG_H * (1 - ((bin < 0 ? cursor : bin) + 0.5) / nBins);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1.5, y - 1.5, 3, 3);
      if (bin < 0) {
        d.value.textContent = '—';
      } else {
        const at = `s=${Math.round(((bin + 0.5) / nBins) * LOOP)} m`;
        const ago = Math.round(nearest.t >= tNow ? 0 : tNow - nearest.t);
        d.value.textContent = `${fmt(nearest.bins[bin])} · ${at} · ${ago}s ago`;
      }
      // mirror the hovered loop position onto the road itself (same s as the
      // readout: the snapped bin, or the raw cursor over an empty column)
      if (this.onHoverS) this.onHoverS((((bin < 0 ? cursor : bin) + 0.5) / nBins) * LOOP);
    } else {
      d.value.textContent = '';
      if (this.onHoverS) this.onHoverS(null);
    }
  }

  paintColumn(d, p, nBins) {
    const ctx = d.offCtx;
    const x = d.cursor % WINDOW;
    const v0 = Math.max(params.desiredSpeed, 0.1);
    ctx.clearRect(x, 0, 1, nBins);
    for (let b = 0; b < nBins; b++) {
      const v = p.bins[b];
      if (v < 0) {
        ctx.fillStyle = EMPTY_COLOR;
      } else {
        const t = Math.min(Math.max(v / v0, 0), 1);
        ctx.fillStyle = `hsl(${t * 120}, 85%, 50%)`; // matches the car colors
      }
      ctx.fillRect(x, nBins - 1 - b, 1, 1); // s = 0 at the bottom
    }
    d.cursor++;
  }

  draw(chart, get, fmt) {
    const { ctx, color } = chart;
    ctx.clearRect(0, 0, W, H);
    const history = this.history;
    if (history.length < 2) {
      chart.value.textContent = '—';
      return;
    }
    const tNow = history[history.length - 1].t;
    const t0 = Math.max(0, tNow - WINDOW);
    const span = Math.max(tNow - t0, 30); // stable scale while filling up
    const xs = (t) => ((t - t0) / span) * W;

    let max = 0;
    for (const p of history) max = Math.max(max, get(p));
    max = niceMax(max);
    const ys = (v) => H - 2 - (v / max) * (H - 12);

    // incident band (annotation, not a series)
    ctx.fillStyle = INCIDENT_SHADE;
    for (let i = 0; i < history.length; i++) {
      if (!history[i].inc) continue;
      let j = i;
      while (j + 1 < history.length && history[j + 1].inc) j++;
      ctx.fillRect(xs(history[i].t) - 0.5, 0, xs(history[j].t) - xs(history[i].t) + 1.5, H);
      i = j;
    }

    // recessive midline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, ys(max / 2));
    ctx.lineTo(W, ys(max / 2));
    ctx.stroke();

    // area + 2px line
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = xs(history[i].t);
      const y = ys(get(history[i]));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(xs(tNow), H);
    ctx.lineTo(xs(history[0].t), H);
    ctx.closePath();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;

    // y-max tick label (text token, not series color)
    ctx.fillStyle = 'rgba(159, 176, 192, 0.85)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(fmt(max), 3, 9);

    // crosshair + pinned readout under the cursor
    if (chart.hoverT !== null) {
      const tH = t0 + chart.hoverT * span;
      let nearest = history[0];
      for (const p of history) if (Math.abs(p.t - tH) < Math.abs(nearest.t - tH)) nearest = p;
      const x = xs(nearest.t);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, ys(get(nearest)), 2.5, 0, Math.PI * 2);
      ctx.fill();
      const ago = Math.round(tNow - nearest.t);
      chart.value.textContent = `${fmt(get(nearest))} · ${ago}s ago`;
    } else {
      chart.value.textContent = fmt(get(history[history.length - 1]));
    }
  }
}

// Round an axis maximum up to a "nice" value; fine-grained steps so one fast
// outlier doesn't double the scale and squash the curve.
function niceMax(x) {
  if (x <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (x <= m * mag) return m * mag;
  }
  return 10 * mag;
}
