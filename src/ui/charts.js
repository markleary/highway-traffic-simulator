import { params, KMH, MPH } from '../params.js';

// Live rolling charts of average speed and flow over the last 5 minutes.
// Two separate mini-charts (never a dual axis); series hues come from the
// validated dark-surface categorical palette. Sim-time based: pausing the
// simulation pauses the charts.
const WINDOW = 300; // seconds shown
const W = 320; // logical canvas size (CSS px)
const H = 56;
const SPEED_COLOR = '#3987e5';
const FLOW_COLOR = '#199e70';
const INCIDENT_SHADE = 'rgba(230, 103, 103, 0.16)';

export class ChartPanel {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'panel charts';
    this.speed = this.makeChart('Average speed', SPEED_COLOR);
    this.flow = this.makeChart('Flow past start', FLOW_COLOR);
    document.body.appendChild(this.el);
    this.history = [];
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

  update(history) {
    this.el.style.display = params.showCharts ? '' : 'none';
    if (!params.showCharts) return;
    this.history = history;
    const imp = params.units === 'imperial';
    const spd = imp ? MPH : KMH;
    const unit = imp ? 'mph' : 'km/h';
    this.draw(this.speed, (p) => p.v / spd, (x) => `${x.toFixed(0)} ${unit}`);
    this.draw(this.flow, (p) => p.f, (x) => `${x.toFixed(1)}/min`);
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
