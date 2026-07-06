import { params, KMH, MPH } from '../params.js';

// Dashboard-style speedometer shown while the chase camera follows a car:
// a 270° gauge with ticks, a progress arc, a needle, and a digital readout.
// Visible only in chase mode; scale follows the units setting.
const W = 180;
const H = 110;
const CX = W / 2;
const CY = 62;
const R = 44;
const ARC_START = Math.PI * 0.75; // 135° — down-left
const ARC_SWEEP = Math.PI * 1.5;  // 270° clockwise, ends down-right
const ARC_COLOR = '#3987e5';

export class Speedometer {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'panel speedo';
    this.el.style.display = 'none';
    this.canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.cap = document.createElement('div');
    this.cap.className = 'cap';
    this.el.append(this.canvas, this.cap);
    document.body.appendChild(this.el);
    this.shown = 0; // smoothed displayed speed
  }

  update(car) {
    if (!car) {
      if (this.el.style.display !== 'none') this.el.style.display = 'none';
      this.shown = 0;
      return;
    }
    this.el.style.display = '';

    const imp = params.units === 'imperial';
    const unit = imp ? MPH : KMH;
    const maxDisp = imp ? 100 : 160;
    const v = car.v / unit;
    this.shown += (v - this.shown) * 0.12;
    const frac = Math.min(Math.max(this.shown / maxDisp, 0), 1);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    // track + progress arcs
    ctx.lineWidth = 7;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.arc(CX, CY, R, ARC_START, ARC_START + ARC_SWEEP);
    ctx.stroke();
    if (frac > 0.005) {
      ctx.strokeStyle = ARC_COLOR;
      ctx.beginPath();
      ctx.arc(CX, CY, R, ARC_START, ARC_START + frac * ARC_SWEEP);
      ctx.stroke();
    }

    // ticks: minor each 10th of the sweep, major every other one
    for (let i = 0; i <= 10; i++) {
      const a = ARC_START + (i / 10) * ARC_SWEEP;
      const major = i % 2 === 0;
      const r0 = R + 6;
      const r1 = r0 + (major ? 6 : 3.5);
      ctx.strokeStyle = `rgba(219, 228, 238, ${major ? 0.55 : 0.28})`;
      ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0);
      ctx.lineTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
      ctx.stroke();
    }

    // needle + hub
    const na = ARC_START + frac * ARC_SWEEP;
    ctx.strokeStyle = '#e66767';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(na) * (R - 7), CY + Math.sin(na) * (R - 7));
    ctx.stroke();
    ctx.fillStyle = '#dbe4ee';
    ctx.beginPath();
    ctx.arc(CX, CY, 3, 0, Math.PI * 2);
    ctx.fill();

    // digital readout (text tokens, not the series color)
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 21px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(this.shown)), CX, CY + 28);
    ctx.fillStyle = '#9fb0c0';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(imp ? 'mph' : 'km/h', CX, CY + 40);
    ctx.textAlign = 'left';

    this.cap.textContent = `following car #${car.id}${statusOf(car)}`;
  }
}

function statusOf(car) {
  if (car.incident) return car.incident.kind === 'accident' ? ' · crashed!' : ' · broken down';
  if (car.state === 'onramp') return ' · entering';
  if (car.state === 'offramp') return ' · leaving';
  if (car.exitRamp) return ` · → ${car.exitRamp.label}`;
  return '';
}
