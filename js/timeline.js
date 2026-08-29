// Canvas Gantt chart: two-tier date header, bars, dependency arrows, drag editing.
//
// The canvas is viewport sized, never timeline sized. An empty spacer inside a
// native scroll container provides the scrollbars; every draw reads scrollTop /
// scrollLeft and paints only the visible rows.

import { formatDay, monthStart, addMonths, weekStart, isoWeek, dayOfWeek, todayDay, civilFromDays, daysFromCivil } from './schedule.js';

export const ZOOM_LEVELS = ['day', 'week', 'month', 'quarter'];
const DAY_WIDTH = { day: 22, week: 6.4, month: 2.3, quarter: 0.9 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const C = {
  // Filled from CSS tokens via syncThemeFromCss().
  canvas: '#ffffff',
  sheet: '#f6f7f9',
  line: '#e4e7eb',
  lineStrong: '#cdd2d8',
  gridDay: '#eff1f4',
  text: '#16191c',
  muted: '#5f676e',
  nonwork: '#f3f4f6',
  selRow: '#e8ecf1',
  hoverRow: '#eef0f3',
  today: '#b0b5b9',
  todayCap: '#5f676e',
  crit: '#16191c',
  link: '#9aa1a6',
  ghost: '#16191c'
};

/**
 * The only colour in the app. Indexed by `sched.health`, i.e. by HEALTH in
 * schedule.js: tint is the open part of a bar, bar the finished part, edge its
 * hairline. Values stay in sync with CSS --h-* tokens via syncThemeFromCss().
 */
export const HEALTH_COLORS = [
  { key: 'none', label: 'Not started', tint: '#e8eef3', bar: '#6d7d8c', edge: '#93a3b2' },
  { key: 'track', label: 'On track', tint: '#d8efe4', bar: '#1b7a54', edge: '#4d9a74' },
  { key: 'risk', label: 'At risk', tint: '#f8ecd0', bar: '#c07a0c', edge: '#d4a64a' },
  { key: 'late', label: 'Behind', tint: '#f6e3e0', bar: '#c2473c', edge: '#d48c84' },
  { key: 'done', label: 'Done', tint: '#eceae6', bar: '#6e6860', edge: '#a39c93' }
];

/** Pull canvas/chrome colours from CSS variables so light/dark stay aligned. */
export function syncThemeFromCss() {
  const cs = getComputedStyle(document.documentElement);
  function read(name, fallback) {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  }
  C.canvas = read('--canvas', C.canvas);
  C.sheet = read('--sheet', C.sheet);
  C.line = read('--line', C.line);
  C.lineStrong = read('--line-strong', C.lineStrong);
  C.gridDay = read('--grid-day', C.gridDay);
  C.text = read('--text', C.text);
  C.muted = read('--muted', C.muted);
  C.nonwork = read('--nonwork', C.nonwork);
  C.selRow = read('--sel', C.selRow);
  C.hoverRow = read('--hover', C.hoverRow);
  C.today = read('--today', C.today);
  C.todayCap = read('--today-cap', C.todayCap);
  C.crit = read('--crit', C.crit);
  C.link = read('--link', C.link);
  C.ghost = read('--ghost', C.ghost);

  const keys = ['none', 'track', 'risk', 'late', 'done'];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const row = HEALTH_COLORS[i];
    row.bar = read('--h-' + key, row.bar);
    row.tint = read('--h-tint-' + key, row.tint);
    row.edge = read('--h-edge-' + key, row.edge);
  }
}
const FONT = '11px "Segoe UI", system-ui, sans-serif';
const FONT_STRONG = '600 11px "Segoe UI", system-ui, sans-serif';
const DASH_GHOST = [3, 2];
const DASH_SOLID = [];

const civil = [0, 0, 0];

export class Timeline {
  constructor(state, els, actions) {
    this.state = state;
    this.els = els;
    this.actions = actions;
    this.ctx = els.canvas.getContext('2d', { alpha: false });
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.pending = false;
    this.hover = { position: -1, part: '' };
    this.drag = null;
    this.origin = 0;
    this.dayW = DAY_WIDTH.week;
    this.contentWidth = 0;
    this.drawBound = this.draw.bind(this);
    this.scratch = { x: 0, xe: 0, y: 0, h: 0, summary: false, milestone: false };
    this.locateScratch = { position: -1, part: '', x: 0, y: 0, row: -1, g: null };
    // measureText caches (per font); cleared on layout, reused across scroll frames.
    this._twFont = new Map();
    this._twStrong = new Map();
    this._drawnDpr = 0;
    this._paneRect = null;
    // Packed dependency-draw cache (rebuilt when sched/links change; scrolled cheaply).
    this._ldSched = null;
    this._ldLinks = null;
    this._ldCount = 0;
    this.arrowHeads = [];

    const scroll = els.scroll;
    scroll.addEventListener('mousedown', this.onMouseDown.bind(this));
    scroll.addEventListener('mousemove', this.onMouseMove.bind(this));
    scroll.addEventListener('mouseleave', this.onMouseLeave.bind(this));
    scroll.addEventListener('dblclick', this.onDoubleClick.bind(this));
    scroll.addEventListener('scroll', this.onScroll.bind(this), { passive: true });
  }

  // --- geometry ---

  get headerH() { return this.state.metrics.headerH; }
  get rowH() { return this.state.metrics.rowH; }

  dayToX(day) {
    return (day - this.origin) * this.dayW - this.state.scrollLeft;
  }

  xToDay(x) {
    return Math.floor((x + this.state.scrollLeft) / this.dayW) + this.origin;
  }

  /** Continuous day index at viewport x (preserves sub-day position). */
  xToDayFloat(x) {
    return (x + this.state.scrollLeft) / this.dayW + this.origin;
  }

  resize() {
    const el = this.els.pane;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this._drawnDpr = 0; // canvas buffer reset clears the transform
    this._paneRect = null;
    const canvas = this.els.canvas;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    this.requestDraw();
  }

  /** Recomputes horizontal extent; call after schedule or zoom changes. */
  layout() {
    const state = this.state;
    const zoom = state.model.doc.view.zoom;
    this.dayW = DAY_WIDTH[zoom] || DAY_WIDTH.week;
    const sched = state.sched;
    const pad = zoom === 'day' ? 3 : 14;
    this.origin = Math.min(sched.projectStart, todayDay()) - pad;
    const end = Math.max(sched.projectFinish, todayDay()) + pad * 3;
    this.contentWidth = Math.max(this.width, Math.ceil((end - this.origin) * this.dayW) + 40);
    const spacer = this.els.spacer;
    spacer.style.width = this.contentWidth + 'px';
    // The extra tail lets the last row clear the horizontal scrollbars.
    spacer.style.height = (state.rows.length * this.rowH + this.headerH + 14) + 'px';
    this._twFont.clear();
    this._twStrong.clear();
  }

  requestDraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(this.drawBound);
  }

  onScroll() {
    const state = this.state;
    const scroll = this.els.scroll;
    state.scrollLeft = scroll.scrollLeft;
    if (state.scrollTop !== scroll.scrollTop) {
      state.scrollTop = scroll.scrollTop;
      this.actions.onVerticalScroll();
    }
    this.requestDraw();
  }

  // --- drawing ---

  draw() {
    this.pending = false;
    const ctx = this.ctx;
    const state = this.state;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    if (this._drawnDpr !== this.dpr) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._drawnDpr = this.dpr;
    }
    ctx.fillStyle = C.canvas;
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const rowH = this.rowH;
    const headerH = this.headerH;
    const rows = state.rows;
    const first = Math.max(0, Math.floor(state.scrollTop / rowH));
    const last = Math.min(rows.length, Math.ceil((state.scrollTop + h - headerH) / rowH) + 1);
    // One civil lookup per frame; reused by today line + cap.
    this._todayX = Math.round(this.dayToX(todayDay()));

    this.drawBands(first, last);
    this.drawGridlines();
    this.drawTodayLine();

    this.clipBody(function () {
      this.drawLinks(first, last);
      this.drawBars(first, last);
      if (this.drag) this.drawDragPreview();
    });

    this.drawHeader();
    this.drawTodayCap();

    // Pane border between header and rows.
    ctx.fillStyle = C.lineStrong;
    ctx.fillRect(0, headerH - 1, w, 1);
  }

  /** Cached measureText for the current ctx.font; avoids re-measure on scroll. */
  textWidth(ctx, text) {
    const font = ctx.font;
    const cache = font === FONT_STRONG ? this._twStrong : this._twFont;
    let w = cache.get(text);
    if (w !== undefined) return w;
    w = ctx.measureText(text).width;
    if (cache.size > 2048) cache.clear();
    cache.set(text, w);
    return w;
  }

  /** Restricts drawing to the row area below the date header. */
  clipBody(fn) {
    const ctx = this.ctx;
    const top = this.headerH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.width, this.height - top);
    ctx.clip();
    fn.call(this);
    ctx.restore();
  }

  rowY(position) {
    return this.headerH + position * this.rowH - this.state.scrollTop;
  }

  drawBands(first, last) {
    const ctx = this.ctx;
    const state = this.state;
    const rowH = this.rowH;
    const w = this.width;
    const headerH = this.headerH;
    const bodyH = this.height - headerH;

    // Non-working days: merge contiguous spans into one fillRect each.
    if (this.dayW >= 3) {
      const cal = state.sched.cal;
      const from = this.xToDay(0);
      const to = this.xToDay(w) + 1;
      ctx.fillStyle = C.nonwork;
      let run = -1;
      for (let d = from; d <= to; d++) {
        if (!cal.isWorking(d)) {
          if (run < 0) run = d;
        } else if (run >= 0) {
          const x0 = Math.round(this.dayToX(run));
          const x1 = Math.round(this.dayToX(d));
          ctx.fillRect(x0, headerH, Math.max(1, x1 - x0), bodyH);
          run = -1;
        }
      }
      if (run >= 0) {
        const x0 = Math.round(this.dayToX(run));
        const x1 = Math.round(this.dayToX(to + 1));
        ctx.fillRect(x0, headerH, Math.max(1, x1 - x0), bodyH);
      }
    }

    // Selected / hovered rows, then separators (one fillStyle for the hairlines).
    const tasks = state.model.doc.tasks;
    const hovered = state.hoverPosition;
    const sel = state.sel;
    const ys = this._bandYs || (this._bandYs = []);
    ys.length = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerH, w, bodyH);
    ctx.clip();
    for (let p = first; p < last; p++) {
      const y = this.rowY(p);
      ys.push(y);
      if (sel.has(tasks[state.rows[p]].id)) {
        ctx.fillStyle = C.selRow;
        ctx.fillRect(0, y, w, rowH);
      } else if (p === hovered) {
        ctx.fillStyle = C.hoverRow;
        ctx.fillRect(0, y, w, rowH);
      }
    }
    ctx.fillStyle = C.line;
    for (let i = 0; i < ys.length; i++) {
      ctx.fillRect(0, ys[i] + rowH - 1, w, 1);
    }
    ctx.restore();
  }

  drawHeader() {
    const ctx = this.ctx;
    const zoom = this.state.model.doc.view.zoom;
    const headerH = this.headerH;
    const tier = headerH / 2;
    const w = this.width;

    ctx.fillStyle = C.sheet;
    ctx.fillRect(0, 0, w, headerH);
    ctx.fillStyle = C.line;
    ctx.fillRect(0, tier, w, 1);

    const from = this.xToDay(-2);
    const to = this.xToDay(w) + 2;

    ctx.textAlign = 'left';
    if (zoom === 'day' || zoom === 'week') {
      this.drawTier(from, to, tier / 2, monthStart, monthLabel, nextMonth, true);
    } else {
      this.drawTier(from, to, tier / 2, yearStart, yearLabel, nextYear, true);
    }

    if (zoom === 'day') {
      this.drawTier(from, to, tier + tier / 2, sameDay, dayLabel, nextDay, false);
    } else if (zoom === 'week') {
      this.drawTier(from, to, tier + tier / 2, weekStart, weekLabel, nextWeek, false);
    } else if (zoom === 'month') {
      this.drawTier(from, to, tier + tier / 2, monthStart, shortMonthLabel, nextMonth, false);
    } else {
      this.drawTier(from, to, tier + tier / 2, quarterStart, quarterLabel, nextQuarter, false);
    }
    ctx.font = FONT;
  }

  /** Generic header tier: walks boundaries and labels each cell. */
  drawTier(from, to, textY, snap, label, next, strong) {
    const ctx = this.ctx;
    let day = snap(from);
    let guard = 0;
    while (day <= to && guard++ < 4096) {
      const nextDay = next(day);
      const x = this.dayToX(day);
      const xe = this.dayToX(nextDay);
      ctx.fillStyle = strong ? C.lineStrong : C.line;
      ctx.fillRect(Math.round(x), textY - this.headerH / 4, 1, this.headerH / 2);
      const text = label(day);
      const width = xe - x;
      if (width > 16) {
        ctx.font = strong ? FONT_STRONG : FONT;
        ctx.fillStyle = strong ? C.text : C.muted;
        const tw = this.textWidth(ctx, text);
        if (tw + 6 <= width) ctx.fillText(text, x + (width - tw) / 2, textY);
        else if (width > 24) ctx.fillText(text, x + 3, textY);
      }
      day = nextDay;
    }
  }

  drawGridlines() {
    const ctx = this.ctx;
    const zoom = this.state.model.doc.view.zoom;
    const from = this.xToDay(0);
    const to = this.xToDay(this.width) + 1;
    const top = this.headerH;
    const h = this.height - top;

    // Fine grid: days (day only), months (month), quarters (quarter).
    if (zoom === 'day' && this.dayW >= 3) {
      ctx.fillStyle = C.gridDay;
      for (let d = from; d <= to; d++) {
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
      }
    } else if (zoom === 'month') {
      ctx.fillStyle = C.gridDay;
      let d = monthStart(from);
      let guard = 0;
      while (d <= to && guard++ < 1024) {
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
        d = addMonths(d, 1);
      }
    } else if (zoom === 'quarter') {
      ctx.fillStyle = C.gridDay;
      let d = quarterStart(from);
      let guard = 0;
      while (d <= to && guard++ < 512) {
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
        d = addMonths(d, 3);
      }
    }

    // Stronger boundaries: ISO weeks (day/week), quarters (month), years (quarter).
    ctx.fillStyle = C.line;
    if (zoom === 'day' || zoom === 'week') {
      for (let d = from; d <= to; d++) {
        if (dayOfWeek(d) !== 1) continue;
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
      }
    } else if (zoom === 'month') {
      let d = quarterStart(from);
      let guard = 0;
      while (d <= to && guard++ < 1024) {
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
        d = addMonths(d, 3);
      }
    } else if (zoom === 'quarter') {
      let d = yearStart(from);
      let guard = 0;
      while (d <= to && guard++ < 512) {
        ctx.fillRect(Math.round(this.dayToX(d)), top, 1, h);
        d = nextYear(d);
      }
    }
  }

  drawTodayLine() {
    const x = this._todayX;
    if (x < -6 || x > this.width + 6) return;
    const ctx = this.ctx;
    ctx.fillStyle = C.today;
    ctx.fillRect(x, this.headerH, 1, this.height - this.headerH);
  }

  drawTodayCap() {
    const x = this._todayX;
    if (x < -6 || x > this.width + 6) return;
    const ctx = this.ctx;
    ctx.fillStyle = C.todayCap;
    ctx.beginPath();
    ctx.moveTo(x - 3.5, this.headerH - 6);
    ctx.lineTo(x + 4.5, this.headerH - 6);
    ctx.lineTo(x + 0.5, this.headerH - 1);
    ctx.closePath();
    ctx.fill();
  }

  barGeometry(row, position, out) {
    const state = this.state;
    const sched = state.sched;
    const rowH = this.rowH;
    const y = this.rowY(position);
    const isSummary = sched.summary[row] === 1;
    const task = state.model.doc.tasks[row];
    const milestone = !isSummary && task.duration <= 0;
    const h = isSummary ? Math.max(5, rowH - 16) : Math.max(8, rowH - 12);
    out.x = this.dayToX(sched.start[row]);
    out.xe = this.dayToX(sched.finish[row] + 1);
    out.y = y + (rowH - h) / 2;
    out.h = h;
    out.summary = isSummary;
    out.milestone = milestone;
    if (milestone) {
      const size = Math.max(6, rowH - 14);
      out.x = this.dayToX(sched.start[row]);
      out.xe = out.x + size;
      out.y = y + (rowH - size) / 2;
      out.h = size;
    }
    return out;
  }

  drawBars(first, last) {
    const ctx = this.ctx;
    const state = this.state;
    const sched = state.sched;
    const tasks = state.model.doc.tasks;
    const showCrit = state.model.doc.view.showCritical;
    const g = this.barScratch || (this.barScratch = { x: 0, xe: 0, y: 0, h: 0, summary: false, milestone: false });
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;

    for (let p = first; p < last; p++) {
      const row = state.rows[p];
      this.barGeometry(row, p, g);
      const crit = showCrit && sched.critical[row] === 1;
      const paint = HEALTH_COLORS[sched.health[row]] || HEALTH_COLORS[0];
      const task = tasks[row];

      if (g.milestone) {
        const labelX = g.xe + 5;
        const barVisible = g.xe >= 0 && g.x <= this.width;
        if (barVisible) {
          const cx = Math.round(g.x + g.h / 2) + 0.5;
          const cy = Math.round(g.y + g.h / 2) + 0.5;
          const r = g.h / 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy - r);
          ctx.lineTo(cx + r, cy);
          ctx.lineTo(cx, cy + r);
          ctx.lineTo(cx - r, cy);
          ctx.closePath();
          ctx.fillStyle = paint.bar;
          ctx.fill();
          ctx.strokeStyle = crit ? C.crit : paint.edge;
          ctx.stroke();
        }
        this.drawBarLabel(labelX, g.y + g.h / 2, task.name);
        continue;
      }

      const x = Math.round(g.x);
      const width = Math.max(2, Math.round(g.xe) - x);
      const shift = this.hover.position === p && this.hover.part && !this.drag ? 13 : 5;
      const labelX = x + width + shift;
      const barVisible = x <= this.width && x + width >= 0;
      if (barVisible) {
        const doneW = Math.round((width * Math.min(100, sched.pct[row])) / 100);
        if (g.summary) {
          ctx.fillStyle = paint.tint;
          ctx.fillRect(x, g.y, width, g.h);
          if (doneW > 0) {
            ctx.fillStyle = paint.bar;
            ctx.fillRect(x, g.y, doneW, g.h);
          }
          ctx.fillStyle = paint.bar;
          ctx.beginPath();
          ctx.moveTo(x, g.y);
          ctx.lineTo(x, g.y + g.h + 4);
          ctx.lineTo(x + 5, g.y + g.h);
          ctx.lineTo(x + 5, g.y);
          ctx.closePath();
          ctx.moveTo(x + width, g.y);
          ctx.lineTo(x + width, g.y + g.h + 4);
          ctx.lineTo(x + width - 5, g.y + g.h);
          ctx.lineTo(x + width - 5, g.y);
          ctx.closePath();
          ctx.fill();
          if (crit) {
            ctx.strokeStyle = C.crit;
            ctx.strokeRect(x + 0.5, g.y + 0.5, width - 1, g.h - 1);
          }
        } else {
          roundRectPath(ctx, x + 0.5, g.y + 0.5, width - 1, g.h - 1, 2);
          ctx.fillStyle = paint.tint;
          ctx.fill();
          if (doneW > 0) {
            ctx.fillStyle = paint.bar;
            ctx.fillRect(x + 1, g.y + 1, Math.max(1, doneW - 2), g.h - 2);
          }
          ctx.strokeStyle = crit ? C.crit : paint.edge;
          ctx.stroke();
          if (this.hover.position === p && this.hover.part && !this.drag) {
            ctx.fillStyle = C.text;
            ctx.beginPath();
            ctx.arc(x + width + 6, g.y + g.h / 2, 3.5, 0, 6.2832);
            ctx.fill();
          }
        }
      }
      this.drawBarLabel(labelX, g.y + g.h / 2, task.name);
    }
  }

  drawBarLabel(x, y, text) {
    if (!text || x >= this.width) return;
    const ctx = this.ctx;
    const tw = this.textWidth(ctx, text);
    if (x + tw < 0) return;
    // Already clipped by clipBody(); no per-label save/clip/restore.
    ctx.fillStyle = C.muted;
    ctx.fillText(text, x, y);
  }

  /** Visible position of a row, or of its nearest visible ancestor. */
  positionOf(row) {
    const map = this.state.positionOfRow;
    return map[row];
  }

  /**
   * Resolve doc.links → packed arrays once per schedule/visibility.
   * Collapsed (hidden-descendant) links are dropped here so scroll frames
   * only pay for drawable edges + viewport rejects.
   */
  ensureLinkDrawCache() {
    const state = this.state;
    const sched = state.sched;
    const links = state.model.doc.links;
    if (this._ldSched === sched && this._ldLinks === links) return;

    this._ldSched = sched;
    this._ldLinks = links;
    const rowOf = sched.rowOf;
    const posOf = state.positionOfRow;
    const rows = state.rows;
    const start = sched.start;
    const finish = sched.finish;
    const n = links.length;

    let pfA = this._ldPf;
    let ptA = this._ldPt;
    let minA = this._ldMin;
    let maxA = this._ldMax;
    let fromDay = this._ldFromDay;
    let toDay = this._ldToDay;
    let flags = this._ldFlags;
    if (!pfA || pfA.length < n) {
      pfA = this._ldPf = new Int32Array(n);
      ptA = this._ldPt = new Int32Array(n);
      minA = this._ldMin = new Int32Array(n);
      maxA = this._ldMax = new Int32Array(n);
      fromDay = this._ldFromDay = new Float64Array(n);
      toDay = this._ldToDay = new Float64Array(n);
      flags = this._ldFlags = new Uint8Array(n);
    }

    let count = 0;
    for (let i = 0; i < n; i++) {
      const link = links[i];
      const rf = rowOf.get(link.from);
      const rt = rowOf.get(link.to);
      if (rf === undefined || rt === undefined) continue;
      const pf = posOf[rf];
      const pt = posOf[rt];
      if (pf < 0 || pt < 0) continue;
      // Collapsed rows map to a summary position; skip links on hidden descendants.
      if (rows[pf] !== rf || rows[pt] !== rt) continue;

      const type = link.type;
      const fromEnd = type === 'FS' || type === 'FF' ? 1 : 0;
      const toStart = type === 'FS' || type === 'SS' ? 2 : 0;
      pfA[count] = pf;
      ptA[count] = pt;
      minA[count] = pf < pt ? pf : pt;
      maxA[count] = pf > pt ? pf : pt;
      fromDay[count] = fromEnd ? finish[rf] + 1 : start[rf];
      toDay[count] = toStart ? start[rt] : finish[rt] + 1;
      flags[count] = fromEnd | toStart;
      count++;
    }
    this._ldCount = count;
    if (count > 1) this._sortLinkDrawByMin(count);
  }

  /** Shell-sort packed link cache by min row position (enables early exit while drawing). */
  _sortLinkDrawByMin(count) {
    const minA = this._ldMin;
    const maxA = this._ldMax;
    const pfA = this._ldPf;
    const ptA = this._ldPt;
    const fromDay = this._ldFromDay;
    const toDay = this._ldToDay;
    const flags = this._ldFlags;
    for (let gap = count >> 1; gap > 0; gap >>= 1) {
      for (let i = gap; i < count; i++) {
        const minV = minA[i];
        const maxV = maxA[i];
        const pfV = pfA[i];
        const ptV = ptA[i];
        const fdV = fromDay[i];
        const tdV = toDay[i];
        const flV = flags[i];
        let j = i;
        for (; j >= gap && minA[j - gap] > minV; j -= gap) {
          const k = j - gap;
          minA[j] = minA[k];
          maxA[j] = maxA[k];
          pfA[j] = pfA[k];
          ptA[j] = ptA[k];
          fromDay[j] = fromDay[k];
          toDay[j] = toDay[k];
          flags[j] = flags[k];
        }
        minA[j] = minV;
        maxA[j] = maxV;
        pfA[j] = pfV;
        ptA[j] = ptV;
        fromDay[j] = fdV;
        toDay[j] = tdV;
        flags[j] = flV;
      }
    }
  }

  drawLinks(first, last) {
    this.ensureLinkDrawCache();
    const count = this._ldCount;
    if (count === 0) return;

    const ctx = this.ctx;
    const state = this.state;
    ctx.strokeStyle = C.link;
    ctx.fillStyle = C.link;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let arrows = 0;
    const heads = this.arrowHeads;
    heads.length = 0;

    const pfA = this._ldPf;
    const ptA = this._ldPt;
    const minA = this._ldMin;
    const maxA = this._ldMax;
    const fromDayA = this._ldFromDay;
    const toDayA = this._ldToDay;
    const flagsA = this._ldFlags;

    // Vertical: keep links that touch or cross the visible row band.
    // first-1 keeps stubs / mid-routing just above the first painted row.
    const lo = first - 1;
    const hi = last;

    // Cache is sorted by minPos — stop once both endpoints start below the band.
    let end = count;
    if (minA[count - 1] > hi) {
      let loIdx = 0;
      let hiIdx = count - 1;
      while (loIdx <= hiIdx) {
        const mid = (loIdx + hiIdx) >> 1;
        if (minA[mid] <= hi) loIdx = mid + 1;
        else hiIdx = mid - 1;
      }
      end = loIdx;
    }

    // Horizontal reject in day-space (same ±80px margin as before; skips path work).
    const origin = this.origin;
    const dayW = this.dayW;
    const scrollLeft = state.scrollLeft;
    const xPad = 80;
    const dayLo = origin + (-xPad + scrollLeft) / dayW;
    const dayHi = origin + (this.width + xPad + scrollLeft) / dayW;

    const headerH = this.headerH;
    const rowH = this.rowH;
    const half = rowH * 0.5;
    const scrollTop = state.scrollTop;
    const yBase = headerH - scrollTop + half;
    const stub = 7;

    for (let i = 0; i < end; i++) {
      if (maxA[i] < lo) continue;

      const fd = fromDayA[i];
      const td = toDayA[i];
      if ((fd < dayLo && td < dayLo) || (fd > dayHi && td > dayHi)) continue;

      const fl = flagsA[i];
      const fromEnd = fl & 1;
      const toStart = fl & 2;
      const sx = (fd - origin) * dayW - scrollLeft;
      const tx = (td - origin) * dayW - scrollLeft;
      const pf = pfA[i];
      const pt = ptA[i];
      const sy = yBase + pf * rowH;
      const ty = yBase + pt * rowH;

      const dir = toStart ? 1 : -1;   // arrow travels in +x when entering a start edge
      const x0 = snap(sx);
      const y0 = snap(sy);
      const x1 = snap(tx);
      const y1 = snap(ty);
      const exit = snap(fromEnd ? sx + stub : sx - stub);
      const entry = snap(tx - dir * stub);

      ctx.moveTo(x0, y0);
      ctx.lineTo(exit, y0);
      if ((dir > 0 && entry >= exit) || (dir < 0 && entry <= exit)) {
        ctx.lineTo(exit, y1);
        ctx.lineTo(x1, y1);
      } else {
        // Not enough room for a straight drop: step around the successor row.
        const rowTop = headerH + pt * rowH - scrollTop;
        const midY = snap(ty > sy ? rowTop - 2 : rowTop + rowH + 2);
        ctx.lineTo(exit, midY);
        ctx.lineTo(entry, midY);
        ctx.lineTo(entry, y1);
        ctx.lineTo(x1, y1);
      }
      heads.push(x1, y1, dir);
      arrows++;
    }
    ctx.stroke();
    if (arrows > 0) {
      ctx.beginPath();
      for (let i = 0; i < arrows; i++) {
        const x = heads[i * 3];
        const y = heads[i * 3 + 1];
        const dir = heads[i * 3 + 2];
        ctx.moveTo(x, y);
        ctx.lineTo(x - dir * 5, y - 3);
        ctx.lineTo(x - dir * 5, y + 3);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  drawDragPreview() {
    const ctx = this.ctx;
    const drag = this.drag;
    const state = this.state;
    const sched = state.sched;
    if (drag.kind === 'link') {
      ctx.strokeStyle = C.ghost;
      ctx.setLineDash(DASH_GHOST);
      ctx.beginPath();
      ctx.moveTo(drag.fromX, drag.fromY);
      ctx.lineTo(drag.x, drag.y);
      ctx.stroke();
      ctx.setLineDash(DASH_SOLID);
      if (drag.targetPosition >= 0) {
        const row = state.rows[drag.targetPosition];
        const y = this.rowY(drag.targetPosition);
        ctx.strokeStyle = C.ghost;
        ctx.strokeRect(Math.round(this.dayToX(sched.start[row])) + 0.5, y + 1.5,
          Math.max(2, Math.round(this.dayToX(sched.finish[row] + 1) - this.dayToX(sched.start[row]))) - 1,
          this.rowH - 4);
      }
      return;
    }
    const y = this.rowY(drag.position);
    const x1 = this.dayToX(drag.previewStart);
    const x2 = this.dayToX(drag.previewFinish + 1);
    ctx.strokeStyle = C.ghost;
    ctx.setLineDash(DASH_GHOST);
    ctx.strokeRect(Math.round(x1) + 0.5, y + 2.5, Math.max(2, Math.round(x2 - x1)) - 1, this.rowH - 6);
    ctx.setLineDash(DASH_SOLID);
    ctx.fillStyle = C.canvas;
    const label = formatDay(drag.previewStart, state.model.doc.view.dateFormat) +
      (drag.kind === 'move' ? '' : '  ' + (sched.cal.span(drag.previewStart, drag.previewFinish)) + 'd');
    const tw = this.textWidth(ctx, label);
    const lx = Math.min(this.width - tw - 6, Math.max(2, x2 + 6));
    ctx.fillRect(lx - 2, y + 3, tw + 4, this.rowH - 8);
    ctx.fillStyle = C.text;
    ctx.fillText(label, lx, y + this.rowH / 2);
  }

  // --- hit testing ---

  paneRect() {
    let r = this._paneRect;
    if (!r) {
      r = this.els.pane.getBoundingClientRect();
      this._paneRect = r;
    }
    return r;
  }

  locate(event) {
    const rect = this.paneRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const out = this.locateScratch;
    out.x = x;
    out.y = y;
    out.g = null;
    out.row = -1;
    if (y < this.headerH) {
      out.position = -1;
      out.part = 'header';
      return out;
    }
    const position = Math.floor((y - this.headerH + this.state.scrollTop) / this.rowH);
    if (position < 0 || position >= this.state.rows.length) {
      out.position = -1;
      out.part = '';
      return out;
    }
    const row = this.state.rows[position];
    const g = this.barGeometry(row, position, this.scratch);
    let part = '';
    if (x >= g.x - 2 && x <= g.xe + 2) {
      if (g.milestone || g.summary) part = 'bar';
      else if (x >= g.xe - 4) part = 'right';
      else if (x <= g.x + 4) part = 'left';
      else part = 'bar';
    } else if (!g.summary && !g.milestone && x > g.xe + 2 && x <= g.xe + 11) {
      part = 'handle';
    }
    out.position = position;
    out.part = part;
    out.row = row;
    out.g = g;
    return out;
  }

  onMouseMove(event) {
    if (this.drag) return;   // the window-level handler owns the drag
    const spot = this.locate(event);
    if (this.state.viewOnly) {
      if (this.els.scroll.style.cursor) this.els.scroll.style.cursor = '';
      if (spot.position !== this.hover.position) {
        this.hover.position = spot.position;
        this.hover.part = '';
        this.requestDraw();
      }
      this.actions.setHoverRow(spot.position);
      return;
    }
    const cursor = spot.part === 'left' || spot.part === 'right' ? 'ew-resize'
      : spot.part === 'handle' ? 'crosshair'
        : spot.part === 'bar' ? 'grab' : '';
    if (this.els.scroll.style.cursor !== cursor) this.els.scroll.style.cursor = cursor;
    if (spot.position !== this.hover.position || spot.part !== this.hover.part) {
      this.hover.position = spot.position;
      this.hover.part = spot.part;
      this.requestDraw();
    }
    this.actions.setHoverRow(spot.position);
  }

  onMouseLeave() {
    if (this.hover.position !== -1) {
      this.hover.position = -1;
      this.hover.part = '';
      this.requestDraw();
    }
    this.actions.setHoverRow(-1);
  }

  onDoubleClick(event) {
    const spot = this.locate(event);
    if (spot.part === 'header') return;
    const onBar = spot.part === 'bar' || spot.part === 'left' || spot.part === 'right' || spot.part === 'handle';
    if (onBar) {
      this.actions.selectPosition(spot.position, false, false);
      this.actions.openDetail();
      return;
    }
    if (this.state.viewOnly) {
      if (spot.position >= 0) {
        this.actions.selectPosition(spot.position, false, false);
        this.actions.openDetail();
      }
      return;
    }
    this.actions.createBar(spot);
  }

  onMouseDown(event) {
    if (event.button !== 0) return;
    const spot = this.locate(event);
    if (spot.position < 0 || !spot.part) return;
    event.preventDefault();
    const state = this.state;
    const row = spot.row;
    const task = state.model.doc.tasks[row];
    this.actions.selectPosition(spot.position, event.shiftKey, event.ctrlKey);
    if (state.viewOnly) return;

    const linking = spot.part === 'handle' || (event.ctrlKey && spot.part === 'bar');
    if (linking) {
      this.drag = {
        kind: 'link', position: spot.position, row: row, id: task.id,
        fromX: spot.g.xe, fromY: spot.g.y + spot.g.h / 2,
        x: spot.x, y: spot.y, targetPosition: -1
      };
    } else if (state.sched.summary[row]) {
      return;
    } else {
      this.drag = {
        kind: spot.part === 'right' ? 'right' : spot.part === 'left' ? 'left' : 'move',
        position: spot.position, row: row, id: task.id,
        grabDay: this.xToDay(spot.x),
        startDay: state.sched.start[row],
        finishDay: state.sched.finish[row],
        previewStart: state.sched.start[row],
        previewFinish: state.sched.finish[row],
        moved: false
      };
    }
    const self = this;
    this.moveHandler = function (e) { self.updateDrag(e); };
    this.upHandler = function (e) { self.endDrag(e); };
    window.addEventListener('mousemove', this.moveHandler);
    window.addEventListener('mouseup', this.upHandler);
    this.requestDraw();
  }

  updateDrag(event) {
    const drag = this.drag;
    if (!drag) return;
    const rect = this.paneRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const state = this.state;
    const cal = state.sched.cal;

    if (drag.kind === 'link') {
      drag.x = x;
      drag.y = y;
      const position = Math.floor((y - this.headerH + state.scrollTop) / this.rowH);
      drag.targetPosition = position >= 0 && position < state.rows.length && position !== drag.position ? position : -1;
      this.requestDraw();
      return;
    }

    const day = this.xToDay(x);
    const delta = day - drag.grabDay;
    if (delta !== 0) drag.moved = true;
    if (drag.kind === 'move') {
      drag.previewStart = cal.next(drag.startDay + delta);
      const span = Math.max(1, cal.span(drag.startDay, drag.finishDay));
      drag.previewFinish = state.model.doc.tasks[drag.row].duration <= 0
        ? drag.previewStart
        : cal.add(drag.previewStart, span - 1);
    } else if (drag.kind === 'right') {
      drag.previewStart = drag.startDay;
      drag.previewFinish = cal.prev(Math.max(drag.startDay, drag.finishDay + delta));
    } else {
      drag.previewStart = cal.next(Math.min(drag.finishDay, drag.startDay + delta));
      drag.previewFinish = drag.finishDay;
    }
    this.requestDraw();
  }

  endDrag(event) {
    window.removeEventListener('mousemove', this.moveHandler);
    window.removeEventListener('mouseup', this.upHandler);
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const state = this.state;
    if (drag.kind === 'link') {
      if (drag.targetPosition >= 0) {
        const targetRow = state.rows[drag.targetPosition];
        this.actions.createLink(drag.id, state.model.doc.tasks[targetRow].id);
      }
      this.requestDraw();
      return;
    }
    if (!drag.moved) {
      this.requestDraw();
      return;
    }
    const cal = state.sched.cal;
    if (drag.kind === 'move') {
      this.actions.moveTask(drag.id, drag.row, drag.previewStart);
    } else if (drag.kind === 'right') {
      this.actions.setDuration(drag.id, cal.span(drag.previewStart, drag.previewFinish));
    } else {
      this.actions.resizeFromStart(drag.id, drag.row, drag.previewStart, cal.span(drag.previewStart, drag.previewFinish));
    }
  }

  /** Scrolls so that `day` sits at `anchorX` (default: one third into the view). */
  scrollToDay(day, anchorX) {
    const ax = anchorX !== undefined ? anchorX : this.width / 3;
    const max = Math.max(0, this.contentWidth - this.width);
    const target = Math.max(0, Math.min(max, (day - this.origin) * this.dayW - ax));
    this.els.scroll.scrollLeft = target;
    this.state.scrollLeft = target;
  }

  /** Pans horizontally until [startDay..finishDay] intersects the viewport. */
  ensureRangeVisible(startDay, finishDay) {
    const left = (startDay - this.origin) * this.dayW;
    const right = (finishDay + 1 - this.origin) * this.dayW;
    const margin = 28;
    const viewL = this.state.scrollLeft;
    const viewR = viewL + this.width;
    if (left >= viewL + margin && right <= viewR - margin) return false;
    let target;
    const max = Math.max(0, this.contentWidth - this.width);
    if (right - left >= this.width - margin * 2) target = Math.max(0, left - margin);
    else if (left < viewL + margin) target = Math.max(0, left - margin);
    else target = Math.max(0, right - this.width + margin);
    target = Math.min(max, target);
    if (Math.abs(target - this.state.scrollLeft) < 1) return false;
    this.els.scroll.scrollLeft = target;
    this.state.scrollLeft = target;
    return true;
  }
}

function snap(v) {
  return Math.round(v) + 0.5;
}

/** Rounded rectangle path; falls back to arcs where roundRect is missing. */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function sameDay(day) { return day; }
function nextDay(day) { return day + 1; }
function nextWeek(day) { return weekStart(day) + 7; }
function nextMonth(day) { return addMonths(monthStart(day), 1); }
function nextQuarter(day) { return addMonths(quarterStart(day), 3); }
function nextYear(day) {
  civilFromDays(day, civil);
  return daysFromCivil(civil[0] + 1, 1, 1);
}

function yearStart(day) {
  civilFromDays(day, civil);
  return daysFromCivil(civil[0], 1, 1);
}

function quarterStart(day) {
  civilFromDays(day, civil);
  return daysFromCivil(civil[0], Math.floor((civil[1] - 1) / 3) * 3 + 1, 1);
}

function dayLabel(day) {
  civilFromDays(day, civil);
  return '' + civil[2];
}

function weekLabel(day) {
  return 'W' + isoWeek(day);
}

function monthLabel(day) {
  civilFromDays(day, civil);
  return MONTHS[civil[1] - 1] + ' ' + civil[0];
}

function shortMonthLabel(day) {
  civilFromDays(day, civil);
  return MONTHS[civil[1] - 1];
}

function quarterLabel(day) {
  civilFromDays(day, civil);
  return 'Q' + (Math.floor((civil[1] - 1) / 3) + 1);
}

function yearLabel(day) {
  civilFromDays(day, civil);
  return '' + civil[0];
}
