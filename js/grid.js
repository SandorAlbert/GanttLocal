// Virtualized task table: fixed row pool, one shared cell editor.

import { hasChildren } from './model.js';
import { formatDay, parseDateInput, parsePredecessors, toISO } from './schedule.js';
import { HEALTH_COLORS } from './timeline.js';

const CELL_FONT = '12px "Segoe UI", system-ui, -apple-system, sans-serif';
const HEAD_FONT = '600 12px "Segoe UI", system-ui, -apple-system, sans-serif';

const COLUMNS = {
  wbs: { label: 'WBS', width: 54, align: 'right', num: true, edit: false },
  name: { label: 'Task name', width: 260, tree: true },
  duration: { label: 'Days', width: 46, align: 'right', num: true },
  start: { label: 'Start', width: 88, num: true },
  finish: { label: 'Finish', width: 88, num: true },
  pred: { label: 'Depends on', width: 108, num: true },
  pct: { label: '%', width: 52, align: 'right', num: true, dot: true },
  slack: { label: 'Slack', width: 46, align: 'right', num: true, edit: false },
  notes: { label: 'Notes', width: 180 }
};

export function columnMeta(state, key) {
  if (COLUMNS[key]) return COLUMNS[key];
  if (key.indexOf('meta.') === 0) {
    const defs = state.model.doc.columnDefs;
    for (let i = 0; i < defs.length; i++) {
      if ('meta.' + defs[i].key === key) {
        return {
          label: defs[i].label, width: defs[i].width,
          num: defs[i].type !== 'text', custom: defs[i]
        };
      }
    }
  }
  return null;
}

export const ALL_BUILTIN_COLUMNS = Object.keys(COLUMNS);
export function builtinLabel(key) {
  return COLUMNS[key] ? COLUMNS[key].label : key;
}

export class Grid {
  constructor(state, els, actions) {
    this.state = state;
    this.els = els;
    this.actions = actions;
    this.pool = [];
    this.headCells = [];
    this.layout = [];
    this.totalWidth = 0;
    this.editing = null;
    this.hitScratch = { position: 0, col: 0, x: 0, y: 0 };
    // measureText caches (per font); column-fit widths reused until plan/view inputs change.
    this._twCell = new Map();
    this._twHead = new Map();
    this._measureBold = null;
    this._colCache = null;

    this.editor = document.createElement('input');
    this.editor.id = 'cellEditor';
    this.editor.className = 'cell-editor';
    this.editor.autocomplete = 'off';
    this.editor.spellcheck = false;
    this.editor.style.display = 'none';
    els.rows.appendChild(this.editor);

    els.body.addEventListener('scroll', this.onBodyScroll.bind(this), { passive: true });
    els.rows.addEventListener('mousedown', this.onMouseDown.bind(this));
    els.rows.addEventListener('dblclick', this.onDoubleClick.bind(this));
    els.body.addEventListener('mousemove', this.onHoverMove.bind(this), { passive: true });
    els.body.addEventListener('mouseleave', this.onHoverLeave.bind(this), { passive: true });
    els.head.addEventListener('mousedown', this.onHeadMouseDown.bind(this));
    els.body.addEventListener('keydown', this.onKeyDown.bind(this));
    this.editor.addEventListener('keydown', this.onEditorKeyDown.bind(this));
    this.editor.addEventListener('blur', this.commit.bind(this, false));
  }

  // --- layout ---

  buildLayout() {
    const state = this.state;
    const keys = state.model.doc.view.columns;
    const widths = state.model.doc.view.widths;
    const layout = [];
    let x = 0;
    for (let i = 0; i < keys.length; i++) {
      const meta = columnMeta(state, keys[i]);
      if (!meta) continue;
      const w = Math.max(40, Math.round(widths[keys[i]] || meta.width));
      layout.push({ key: keys[i], meta: meta, x: x, w: w });
      x += w;
    }
    this.layout = layout;
    this.totalWidth = x;
    this.els.rows.style.width = x + 'px';
    this.els.headInner.style.width = x + 'px';
    this.buildHead();
    this.pool.length = 0;
    const rows = this.els.rows;
    while (rows.firstChild) rows.removeChild(rows.firstChild);
    rows.appendChild(this.editor);
  }

  /** Canvas text measure matching the grid fonts; cached by string per font. */
  textWidth(text, bold) {
    const t = text || '';
    const cache = bold ? this._twHead : this._twCell;
    let w = cache.get(t);
    if (w !== undefined) return w;
    if (!this._measure) this._measure = document.createElement('canvas').getContext('2d');
    if (this._measureBold !== bold) {
      this._measure.font = bold ? HEAD_FONT : CELL_FONT;
      this._measureBold = bold;
    }
    w = this._measure.measureText(t).width;
    if (cache.size > 4096) cache.clear();
    cache.set(t, w);
    return w;
  }

  /** True when cached column widths still match plan data and fit-relevant view flags. */
  _colCacheValid() {
    const c = this._colCache;
    if (!c) return false;
    const state = this.state;
    const doc = state.model.doc;
    const view = doc.view;
    if (c.tasks !== doc.tasks || c.links !== doc.links || c.calendar !== doc.calendar) return false;
    if (c.columnDefs !== doc.columnDefs) return false;
    if (c.dateFormat !== view.dateFormat) return false;
    if (c.showCritical !== !!view.showCritical) return false;
    if (c.columns !== view.columns.join('\0')) return false;
    const rows = state.rows;
    const cached = c.rows;
    if (cached.length !== rows.length) return false;
    for (let i = 0; i < rows.length; i++) {
      if (cached[i] !== rows[i]) return false;
    }
    return true;
  }

  /** Drop text + column caches and snapshot the inputs that invalidate them. */
  _resetColCache() {
    this._twCell.clear();
    this._twHead.clear();
    const state = this.state;
    const doc = state.model.doc;
    const view = doc.view;
    this._colCache = {
      tasks: doc.tasks,
      links: doc.links,
      calendar: doc.calendar,
      columnDefs: doc.columnDefs,
      dateFormat: view.dateFormat,
      showCritical: !!view.showCritical,
      columns: view.columns.join('\0'),
      rows: state.rows.slice(),
      widths: Object.create(null)
    };
  }

  /** Minimum width for one column from header + longest visible cell. */
  measureColumnWidth(key) {
    if (!this._colCacheValid()) this._resetColCache();
    const hit = this._colCache.widths[key];
    if (hit !== undefined) return hit;

    let col = null;
    for (let i = 0; i < this.layout.length; i++) {
      if (this.layout[i].key === key) {
        col = this.layout[i];
        break;
      }
    }
    if (!col) return 40;
    const meta = col.meta;
    const state = this.state;
    const sched = state.sched;
    const tasks = state.model.doc.tasks;
    const rows = state.rows;
    const showCrit = key === 'name' && !!state.model.doc.view.showCritical;
    const tree = key === 'name' && meta.tree;
    const isName = key === 'name';
    const dot = !!meta.dot;
    let max = Math.ceil(this.textWidth(meta.label, true)) + 14;
    for (let p = 0; p < rows.length; p++) {
      const row = rows[p];
      const text = this.cellText(row, key);
      let extra = 12;
      if (tree) extra += 16 + tasks[row].level * 12;
      if (dot) extra += 12;
      if (showCrit && sched.critical[row]) extra += 8;
      const bold = isName && sched.summary[row] === 1;
      const w = Math.ceil(this.textWidth(text, bold)) + extra;
      if (w > max) max = w;
    }
    max = Math.max(40, max);
    this._colCache.widths[key] = max;
    return max;
  }

  /** Auto-fit every column, then return a grid-pane width that fits the table. */
  fitPaneToContent() {
    if (!this._colCacheValid()) this._resetColCache();
    const widths = Object.assign({}, this.state.model.doc.view.widths);
    const cache = this._colCache.widths;
    for (let i = 0; i < this.layout.length; i++) {
      const key = this.layout[i].key;
      let w = cache[key];
      if (w === undefined) {
        w = this.measureColumnWidth(key);
      }
      widths[key] = w;
    }
    this.state.model.doc.view.widths = widths;
    this.buildLayout();
    const paneW = Math.max(140, Math.min(this.totalWidth, window.innerWidth - 220));
    this.state.model.setView({ widths: widths, gridWidth: paneW });
    return paneW;
  }

  buildHead() {
    const inner = this.els.headInner;
    while (inner.firstChild) inner.removeChild(inner.firstChild);
    this.headCells.length = 0;
    for (let i = 0; i < this.layout.length; i++) {
      const col = this.layout[i];
      const cell = document.createElement('div');
      cell.className = 'gh' + (col.meta.align === 'right' ? ' r' : '');
      cell.style.left = col.x + 'px';
      cell.style.width = col.w + 'px';
      cell.textContent = col.meta.label;
      cell.dataset.key = col.key;
      const grip = document.createElement('div');
      grip.className = 'grip';
      cell.appendChild(grip);
      inner.appendChild(cell);
      this.headCells.push(cell);
    }
  }

  // --- values ---

  cellText(row, key) {
    const state = this.state;
    const model = state.model;
    const sched = state.sched;
    const task = model.doc.tasks[row];
    const fmt = model.doc.view.dateFormat;
    switch (key) {
      case 'wbs': return sched.wbs[row];
      case 'name': return task.name;
      case 'duration': return sched.summary[row] ? '' + sched.span[row] : '' + task.duration;
      case 'start': return formatDay(sched.start[row], fmt);
      case 'finish': return formatDay(sched.finish[row], fmt);
      case 'pred': return sched.pred[row];
      case 'pct': return '' + Math.round(sched.pct[row]);
      case 'slack': return sched.summary[row] ? '' : '' + sched.slack[row];
      case 'notes': {
        const notes = task.notes;
        for (let i = 0, len = notes.length; i < len; i++) {
          const c = notes.charCodeAt(i);
          if (c < 32 || (c === 32 && i + 1 < len && notes.charCodeAt(i + 1) === 32)) {
            return notes.replace(/\s+/g, ' ');
          }
        }
        return notes;
      }
      default: {
        if (key.indexOf('meta.') !== 0) return '';
        const v = task.meta[key.slice(5)];
        return v === undefined || v === null ? '' : '' + v;
      }
    }
  }

  editable(row, key) {
    if (this.state.viewOnly) return false;
    const meta = columnMeta(this.state, key);
    if (!meta || meta.edit === false) return false;
    const isSummary = this.state.sched.summary[row] === 1;
    if (isSummary && (key === 'duration' || key === 'start' || key === 'finish' || key === 'pct')) return false;
    return true;
  }

  applyEdit(row, key, text) {
    const state = this.state;
    const model = state.model;
    const task = model.doc.tasks[row];
    const sched = state.sched;
    const value = text.trim();
    switch (key) {
      case 'name':
        return model.patchTask(task.id, { name: value }, 'name' + task.id);
      case 'notes':
        return model.patchTask(task.id, { notes: value }, 'notes' + task.id);
      case 'duration': {
        const n = parseFloat(value.replace(',', '.'));
        if (!Number.isFinite(n) || n < 0) return false;
        const days = Math.round(n);
        return model.patchTask(task.id, { duration: days, milestone: days === 0 }, 'dur' + task.id);
      }
      case 'pct': {
        const n = parseFloat(value.replace(',', '.'));
        if (!Number.isFinite(n)) return false;
        return model.patchTask(task.id, { pct: n }, 'pct' + task.id);
      }
      case 'start': {
        const day = parseDateInput(value, sched.start[row]);
        if (day === null) return false;
        const earliest = sched.earliest[row] < 0 ? null : sched.earliest[row];
        return model.setStart(task.id, day, earliest);
      }
      case 'finish': {
        const day = parseDateInput(value, sched.finish[row]);
        if (day === null || day < sched.start[row]) return false;
        const days = sched.cal.span(sched.start[row], day);
        return model.patchTask(task.id, { duration: days, milestone: false }, 'fin' + task.id);
      }
      case 'pred': {
        const list = parsePredecessors(value);
        if (!list) return false;
        return model.setPredecessors(task.id, list);
      }
      default: {
        if (key.indexOf('meta.') !== 0) return false;
        const def = columnMeta(state, key).custom;
        let out = value;
        if (def.type === 'number') {
          const n = parseFloat(value.replace(',', '.'));
          if (value && !Number.isFinite(n)) return false;
          out = value ? n : '';
        } else if (def.type === 'date' && value) {
          const day = parseDateInput(value);
          if (day === null) return false;
          out = toISO(day);
        }
        return model.setMeta(task.id, def.key, out);
      }
    }
  }

  // --- render ---

  render() {
    const state = this.state;
    const rows = state.rows;
    const rowH = state.metrics.rowH;
    const view = this.els.body;
    const height = view.clientHeight;
    this.els.rows.style.height = rows.length * rowH + 'px';

    const first = Math.max(0, Math.floor(state.scrollTop / rowH) - 1);
    const last = Math.min(rows.length, Math.ceil((state.scrollTop + height) / rowH) + 1);
    const need = last - first;

    while (this.pool.length < need) this.pool.push(this.makeRow());
    for (let p = 0; p < this.pool.length; p++) {
      const slot = this.pool[p];
      if (p >= need) {
        if (slot.visible) {
          slot.el.style.display = 'none';
          slot.visible = false;
        }
        continue;
      }
      if (!slot.visible) {
        slot.el.style.display = '';
        slot.visible = true;
      }
      this.paintRow(slot, first + p);
    }
    this.els.rows.style.transform = 'translateY(' + -state.scrollTop + 'px)';
    if (this.editing) this.placeEditor();
  }

  makeRow() {
    const el = document.createElement('div');
    el.className = 'gr';
    const cells = [];
    for (let i = 0; i < this.layout.length; i++) {
      const col = this.layout[i];
      const cell = document.createElement('div');
      let cls = 'gc';
      if (col.meta.align === 'right') cls += ' r';
      if (col.meta.num) cls += ' num';
      if (col.meta.dot) cls += ' pctcell';
      cell.className = cls;
      cell.style.left = col.x + 'px';
      cell.style.width = col.w + 'px';
      if (col.meta.tree) {
        const twist = document.createElement('span');
        twist.className = 'twist';
        const text = document.createElement('span');
        text.className = 'tx';
        cell.appendChild(twist);
        cell.appendChild(text);
        cells.push({ el: cell, text: text, twist: twist, value: null, pad: -1, tone: '' });
      } else if (col.meta.dot) {
        // The one place in the table that carries the progress colour.
        const dot = document.createElement('span');
        dot.className = 'dot';
        const text = document.createElement('span');
        cell.appendChild(dot);
        cell.appendChild(text);
        cells.push({ el: cell, text: text, dot: dot, value: null, pad: -1, tone: '' });
      } else {
        cells.push({ el: cell, text: cell, value: null, pad: -1, tone: '' });
      }
      el.appendChild(cell);
    }
    this.els.rows.appendChild(el);
    return { el: el, cells: cells, index: -1, visible: true, cls: '' };
  }

  paintRow(slot, position) {
    const state = this.state;
    const row = state.rows[position];
    const task = state.model.doc.tasks[row];
    const sched = state.sched;
    const rowH = state.metrics.rowH;

    if (slot.index !== position) {
      slot.el.style.top = position * rowH + 'px';
      slot.index = position;
    }
    let cls = 'gr';
    if (sched.summary[row]) cls += ' sum';
    if (state.sel.has(task.id)) cls += ' sel';
    if (position === state.cursor) cls += ' cur';
    if (state.model.doc.view.showCritical && sched.critical[row]) cls += ' crit';
    if (sched.cycleIds.has(task.id)) cls += ' bad';
    if (position === state.hoverPosition) cls += ' hov';   // kept last, see paintHover
    if (cls !== slot.cls) {
      slot.el.className = cls;
      slot.cls = cls;
    }

    for (let c = 0; c < this.layout.length; c++) {
      const col = this.layout[c];
      const cell = slot.cells[c];
      const value = this.cellText(row, col.key);
      if (cell.value !== value) {
        cell.text.textContent = value;
        cell.value = value;
      }
      if (col.meta.tree) {
        const indent = task.level * 12;
        const textPad = 16 + indent;
        if (cell.pad !== textPad) {
          cell.text.style.marginLeft = textPad + 'px';
          cell.twist.style.left = 2 + indent + 'px';
          cell.pad = textPad;
        }
        const glyph = hasChildren(state.model.doc.tasks, row) ? (task.collapsed ? '+' : '\u2212') : '';
        if (cell.twist.textContent !== glyph) cell.twist.textContent = glyph;
      } else if (col.meta.dot) {
        const tone = HEALTH_COLORS[sched.health[row]].bar;
        if (cell.tone !== tone) {
          cell.dot.style.background = tone;
          cell.tone = tone;
        }
      }
    }
  }

  /** Only the hover class changed; touching classNames is cheaper than a repaint. */
  paintHover() {
    const hovered = this.state.hoverPosition;
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i];
      if (!slot.visible || slot.index < 0) continue;
      const want = slot.index === hovered;
      const has = slot.cls.length > 4 && slot.cls.lastIndexOf(' hov') === slot.cls.length - 4;
      if (want === has) continue;
      const cls = want ? slot.cls + ' hov' : slot.cls.slice(0, -4);
      slot.el.className = cls;
      slot.cls = cls;
    }
  }

  onHoverMove(event) {
    const spot = this.hit(event);
    this.actions.setHoverRow(spot ? spot.position : -1);
  }

  onHoverLeave() {
    this.actions.setHoverRow(-1);
  }

  // --- interaction ---

  onBodyScroll() {
    const left = this.els.body.scrollLeft;
    this.els.headInner.style.transform = 'translateX(' + -left + 'px)';
    if (this.editing) this.placeEditor();
  }

  hit(event) {
    const rect = this.els.body.getBoundingClientRect();
    const x = event.clientX - rect.left + this.els.body.scrollLeft;
    const y = event.clientY - rect.top + this.state.scrollTop;
    const position = Math.floor(y / this.state.metrics.rowH);
    if (position < 0 || position >= this.state.rows.length) return null;
    let col = -1;
    for (let i = 0; i < this.layout.length; i++) {
      if (x >= this.layout[i].x && x < this.layout[i].x + this.layout[i].w) {
        col = i;
        break;
      }
    }
    const out = this.hitScratch;
    out.position = position;
    out.col = col < 0 ? this.layout.length - 1 : col;
    out.x = x;
    out.y = y;
    return out;
  }

  onMouseDown(event) {
    if (event.button !== 0) return;
    const spot = this.hit(event);
    if (!spot) return;
    this.commit(true);
    const state = this.state;
    const row = state.rows[spot.position];
    const task = state.model.doc.tasks[row];
    const col = this.layout[spot.col];

    // Outline twisty.
    if (col.meta.tree) {
      const indent = task.level * 12;
      const twistLeft = 2 + indent;
      if (spot.x >= col.x + twistLeft && spot.x < col.x + twistLeft + 12 && hasChildren(state.model.doc.tasks, row)) {
        state.model.toggleCollapse(task.id);
        return;
      }
    }

    this.els.body.focus();
    if (event.shiftKey && state.cursor >= 0) {
      this.actions.selectRange(state.cursor, spot.position);
    } else if (event.ctrlKey) {
      if (state.sel.has(task.id)) state.sel.delete(task.id);
      else state.sel.add(task.id);
      state.cursor = spot.position;
    } else {
      const already = state.sel.has(task.id) && state.sel.size === 1 && state.cursor === spot.position;
      state.sel.clear();
      state.sel.add(task.id);
      state.cursor = spot.position;
      state.cursorCol = spot.col;
      if (already && this.editable(row, col.key)) {
        this.actions.requestRender();
        this.beginEdit(spot.position, spot.col, null);
        return;
      }
    }
    state.cursorCol = spot.col;
    this.actions.revealTask(row);
    this.actions.requestRender();
  }

  onDoubleClick(event) {
    const spot = this.hit(event);
    if (!spot) return;
    const row = this.state.rows[spot.position];
    const col = this.layout[spot.col];
    if (this.editable(row, col.key)) this.beginEdit(spot.position, spot.col, null);
    else this.actions.openDetail();
  }

  onHeadMouseDown(event) {
    const target = event.target;
    if (!target.classList.contains('grip')) return;
    const key = target.parentNode.dataset.key;
    let col = null;
    for (let i = 0; i < this.layout.length; i++) if (this.layout[i].key === key) col = this.layout[i];
    if (!col) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = col.w;
    const self = this;
    let dragging = false;
    function move(e) {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < 3) return;
        dragging = true;
      }
      const w = Math.max(40, startW + e.clientX - startX);
      col.w = w;
      self.state.model.doc.view.widths[key] = w;
      self.buildLayout();
      self.render();
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) self.state.model.setColumnWidth(key, col.w);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  // --- editing ---

  beginEdit(position, colIndex, initial) {
    const state = this.state;
    if (position < 0 || position >= state.rows.length) return;
    const row = state.rows[position];
    const col = this.layout[colIndex];
    if (!col || !this.editable(row, col.key)) return;
    this.editing = { position: position, col: colIndex, key: col.key, row: row };
    this.editor.style.display = 'block';
    this.editor.className = 'cell-editor' + (col.meta.align === 'right' ? ' r' : '');
    this.editor.value = initial === null ? this.cellText(row, col.key) : initial;
    this.placeEditor();
    this.editor.focus();
    if (initial === null) this.editor.select();
  }

  placeEditor() {
    const edit = this.editing;
    if (!edit) return;
    const col = this.layout[edit.col];
    const rowH = this.state.metrics.rowH;
    this.editor.style.left = col.x + 'px';
    this.editor.style.width = col.w + 'px';
    this.editor.style.top = edit.position * rowH + 'px';
    this.editor.style.height = rowH + 'px';
  }

  commit(keepFocus) {
    const edit = this.editing;
    if (!edit) return false;
    this.editing = null;
    this.editor.style.display = 'none';
    const text = this.editor.value;
    const before = this.cellText(edit.row, edit.key);
    let changed = false;
    if (text !== before) {
      const ok = this.applyEdit(edit.row, edit.key, text);
      if (ok === false) this.actions.warn('Value not accepted: ' + text);
      changed = ok !== false;
    }
    if (keepFocus) this.els.body.focus();
    if (!changed) this.actions.requestRender();
    return changed;
  }

  cancel() {
    if (!this.editing) return;
    this.editing = null;
    this.editor.style.display = 'none';
    this.els.body.focus();
    this.actions.requestRender();
  }

  onEditorKeyDown(event) {
    const edit = this.editing;
    if (!edit) return;
    // The editor lives inside the grid body, so nothing may reach the grid's
    // own key handler while a cell is open.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const position = edit.position;
      const col = edit.col;
      this.commit(true);
      this.moveCursor(position + (event.shiftKey ? -1 : 1), col, false);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const position = edit.position;
      const col = edit.col;
      this.commit(true);
      this.stepCell(position, col, event.shiftKey ? -1 : 1);
    }
  }

  stepCell(position, colIndex, dir) {
    let col = colIndex + dir;
    let pos = position;
    if (col < 0) {
      col = this.layout.length - 1;
      pos--;
    } else if (col >= this.layout.length) {
      col = 0;
      pos++;
    }
    if (pos < 0 || pos >= this.state.rows.length) return;
    this.moveCursor(pos, col, false);
    const row = this.state.rows[pos];
    if (this.editable(row, this.layout[col].key)) this.beginEdit(pos, col, null);
  }

  moveCursor(position, colIndex, extend) {
    const state = this.state;
    const pos = Math.max(0, Math.min(position, state.rows.length - 1));
    if (extend) {
      this.actions.selectRange(state.cursor, pos);
    } else {
      const id = state.model.doc.tasks[state.rows[pos]].id;
      state.sel.clear();
      state.sel.add(id);
    }
    state.cursor = pos;
    state.cursorCol = Math.max(0, Math.min(colIndex, this.layout.length - 1));
    this.ensureVisible(pos);
    this.actions.revealTask(this.state.rows[pos]);
    this.actions.requestRender();
  }

  ensureVisible(position) {
    const state = this.state;
    const rowH = state.metrics.rowH;
    const height = this.els.body.clientHeight;
    let top = state.scrollTop;
    if (position * rowH < top) top = position * rowH;
    else if ((position + 1) * rowH > top + height) top = (position + 1) * rowH - height;
    if (top !== state.scrollTop) this.actions.setScrollTop(top);
  }

  onKeyDown(event) {
    const state = this.state;
    const key = event.key;
    if (event.altKey) return;   // Alt+Shift+arrows are outline commands, handled globally
    if (event.ctrlKey || event.metaKey) return;
    switch (key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveCursor(state.cursor + 1, state.cursorCol, event.shiftKey);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this.moveCursor(state.cursor - 1, state.cursorCol, event.shiftKey);
        return;
      case 'ArrowRight':
        event.preventDefault();
        this.moveCursor(state.cursor, state.cursorCol + 1, false);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        this.moveCursor(state.cursor, state.cursorCol - 1, false);
        return;
      case 'PageDown':
        event.preventDefault();
        this.moveCursor(state.cursor + Math.floor(this.els.body.clientHeight / state.metrics.rowH), state.cursorCol, event.shiftKey);
        return;
      case 'PageUp':
        event.preventDefault();
        this.moveCursor(state.cursor - Math.floor(this.els.body.clientHeight / state.metrics.rowH), state.cursorCol, event.shiftKey);
        return;
      case 'Home':
        event.preventDefault();
        this.moveCursor(0, state.cursorCol, event.shiftKey);
        return;
      case 'End':
        event.preventDefault();
        this.moveCursor(state.rows.length - 1, state.cursorCol, event.shiftKey);
        return;
      case 'Tab':
        event.preventDefault();
        this.stepCell(state.cursor, state.cursorCol, event.shiftKey ? -1 : 1);
        return;
      case 'Enter':
      case 'F2':
        event.preventDefault();
        this.beginEdit(state.cursor, state.cursorCol, null);
        return;
      case ' ':
        event.preventDefault();
        this.actions.toggleCollapseCursor();
        return;
      case 'Escape':
        event.preventDefault();
        return;
      default:
        break;
    }
    if (key.length === 1 && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      this.beginEdit(state.cursor, state.cursorCol, key);
    }
  }

  /** Forces every pooled row to repaint, e.g. after the row height changed. */
  invalidate() {
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i];
      slot.index = -1;
      slot.cls = '';
      for (let c = 0; c < slot.cells.length; c++) {
        slot.cells[c].value = null;
        slot.cells[c].pad = -1;
        slot.cells[c].tone = '';
      }
    }
  }
}
