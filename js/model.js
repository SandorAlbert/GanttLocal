// Project document + mutations + undo/redo.
//
// History entries are shallow document snapshots (shared tasks/links arrays by
// reference). Mutations copy-on-write those arrays only when they are still
// shared with a history entry. Merged keystrokes skip a new snapshot and can
// update a single row in place — O(1) instead of O(n) slice per typed char.

import { toDay, toISO, todayDay } from './schedule.js';

export const LINK_TYPES = ['FS', 'SS', 'FF', 'SF'];
export const CONSTRAINT_TYPES = ['ASAP', 'SNET', 'FNLT', 'MSO'];
export const DEFAULT_COLUMNS = ['wbs', 'name', 'duration', 'start', 'finish', 'pred', 'pct'];

const HISTORY_LIMIT = 100;
const MERGE_WINDOW_MS = 800;

/** Shallow doc copy for the undo stack. tasks/links stay shared until COW. */
function snapshotDoc(doc) {
  const snap = Object.assign({}, doc);
  // setView mutates view in place; keep history immune to that.
  snap.view = Object.assign({}, doc.view);
  return snap;
}

export function createProject(name) {
  const start = toISO(todayDay());
  return normalize({
    version: 1,
    name: name,
    calendar: { workDays: [1, 2, 3, 4, 5], holidays: [] },
    view: { zoom: 'week', compact: false, columns: DEFAULT_COLUMNS.slice(), widths: {} },
    columnDefs: [],
    tasks: [{ id: 1, level: 0, name: 'New task', start: start, duration: 5 }],
    links: []
  });
}

function num(value, fallback) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTask(raw, fallbackStart) {
  const milestone = !!raw.milestone;
  let duration = Math.max(0, Math.round(num(raw.duration, 1)));
  if (milestone) duration = 0;
  const type = CONSTRAINT_TYPES.indexOf(raw.constraint && raw.constraint.type) >= 0
    ? raw.constraint.type
    : 'ASAP';
  const cdate = raw.constraint && typeof raw.constraint.date === 'string' && toDay(raw.constraint.date) !== null
    ? raw.constraint.date
    : null;
  return {
    id: raw.id,
    level: Math.max(0, Math.round(num(raw.level, 0))),
    name: typeof raw.name === 'string' ? raw.name : '',
    start: toDay(raw.start) !== null ? raw.start : fallbackStart,
    duration: duration,
    milestone: milestone,
    manual: !!raw.manual,
    collapsed: !!raw.collapsed,
    pct: Math.min(100, Math.max(0, Math.round(num(raw.pct, 0)))),
    constraint: { type: type, date: type === 'ASAP' ? null : cdate },
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  };
}

export function normalize(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const fallbackStart = toISO(todayDay());
  const calSrc = src.calendar && typeof src.calendar === 'object' ? src.calendar : {};
  let workDays = Array.isArray(calSrc.workDays)
    ? calSrc.workDays.map(function (d) { return Math.round(num(d, 1)); }).filter(function (d) { return d >= 0 && d <= 6; })
    : [1, 2, 3, 4, 5];
  if (!workDays.length) workDays = [1, 2, 3, 4, 5];
  const holidays = Array.isArray(calSrc.holidays)
    ? calSrc.holidays.filter(function (h) { return typeof h === 'string' && toDay(h) !== null; })
    : [];

  const seen = new Set();
  let maxId = 0;
  const rawTasks = Array.isArray(src.tasks) ? src.tasks : [];
  const tasks = [];
  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i] || {};
    let id = Math.round(num(raw.id, 0));
    if (id <= 0 || seen.has(id)) id = ++maxId;
    seen.add(id);
    if (id > maxId) maxId = id;
    const task = normalizeTask(Object.assign({}, raw, { id: id }), fallbackStart);
    // No orphan indentation: a row may be at most one level deeper than the one above.
    const maxLevel = tasks.length ? tasks[tasks.length - 1].level + 1 : 0;
    if (task.level > maxLevel) task.level = maxLevel;
    tasks.push(task);
  }
  if (!tasks.length) {
    tasks.push(normalizeTask({ id: 1, level: 0, name: 'New task', duration: 5 }, fallbackStart));
  }

  const links = [];
  const linkKeys = new Set();
  const rawLinks = Array.isArray(src.links) ? src.links : [];
  for (let i = 0; i < rawLinks.length; i++) {
    const raw = rawLinks[i] || {};
    const from = Math.round(num(raw.from, 0));
    const to = Math.round(num(raw.to, 0));
    if (from === to || !seen.has(from) || !seen.has(to)) continue;
    const type = LINK_TYPES.indexOf(raw.type) >= 0 ? raw.type : 'FS';
    const key = from + '>' + to;
    if (linkKeys.has(key)) continue;
    linkKeys.add(key);
    links.push({ from: from, to: to, type: type, lag: Math.round(num(raw.lag, 0)) });
  }

  const viewSrc = src.view && typeof src.view === 'object' ? src.view : {};
  const columnDefs = (Array.isArray(src.columnDefs) ? src.columnDefs : [])
    .filter(function (c) { return c && typeof c.key === 'string' && c.key; })
    .map(function (c) {
      return {
        key: c.key,
        label: typeof c.label === 'string' && c.label ? c.label : c.key,
        type: c.type === 'number' || c.type === 'date' ? c.type : 'text',
        width: Math.max(40, Math.round(num(c.width, 90)))
      };
    });
  const customKeys = new Set(columnDefs.map(function (c) { return 'meta.' + c.key; }));
  const columns = (Array.isArray(viewSrc.columns) && viewSrc.columns.length ? viewSrc.columns : DEFAULT_COLUMNS)
    .filter(function (k) {
      return typeof k === 'string' && (k.indexOf('meta.') !== 0 || customKeys.has(k));
    });
  if (columns.indexOf('name') < 0) columns.unshift('name');

  return {
    version: 1,
    name: typeof src.name === 'string' && src.name ? src.name : 'Project',
    calendar: { workDays: workDays, holidays: holidays },
    view: {
      zoom: ['day', 'week', 'month', 'quarter'].indexOf(viewSrc.zoom) >= 0 ? viewSrc.zoom : 'week',
      compact: !!viewSrc.compact,
      showCritical: viewSrc.showCritical !== false,
      dateFormat: viewSrc.dateFormat === 'iso' ? 'iso' : 'dmy',
      gridWidth: Math.max(140, Math.round(num(viewSrc.gridWidth, 560))),
      columns: columns,
      widths: viewSrc.widths && typeof viewSrc.widths === 'object' ? viewSrc.widths : {}
    },
    columnDefs: columnDefs,
    tasks: tasks,
    links: links
  };
}

// --- structural helpers (pure, used by grid/timeline) ---------------------

export function subtreeEnd(tasks, index) {
  const level = tasks[index].level;
  let j = index + 1;
  while (j < tasks.length && tasks[j].level > level) j++;
  return j;
}

export function hasChildren(tasks, index) {
  return index + 1 < tasks.length && tasks[index + 1].level > tasks[index].level;
}

export function parentIndex(tasks, index) {
  const level = tasks[index].level;
  for (let j = index - 1; j >= 0; j--) {
    if (tasks[j].level < level) return j;
  }
  return -1;
}

/** Index of the previous sibling block start, or -1. */
function prevSibling(tasks, index) {
  const level = tasks[index].level;
  for (let j = index - 1; j >= 0; j--) {
    if (tasks[j].level < level) return -1;
    if (tasks[j].level === level) return j;
  }
  return -1;
}

/** Index of the next sibling, or -1. */
function nextSibling(tasks, index) {
  const level = tasks[index].level;
  let j = subtreeEnd(tasks, index);
  if (j >= tasks.length || tasks[j].level !== level) return -1;
  return j;
}

/** Selected rows reduced to the outermost blocks, ascending. */
function topLevelSelection(tasks, ids, idx) {
  const rows = [];
  ids.forEach(function (id) {
    const i = idx.get(id);
    if (i !== undefined) rows.push(i);
  });
  rows.sort(function (a, b) { return a - b; });
  const out = [];
  let covered = -1;
  for (let k = 0; k < rows.length; k++) {
    if (rows[k] < covered) continue;
    out.push(rows[k]);
    covered = subtreeEnd(tasks, rows[k]);
  }
  return out;
}

// --- model ---------------------------------------------------------------

export class Model {
  constructor(doc) {
    this.doc = normalize(doc);
    this.past = [];
    this.future = [];
    this.dirty = false;
    this.listeners = [];
    this._mergeKey = null;
    this._mergeAt = 0;
    this._idx = null;
    this._idxFor = null;
    // Exclusive ownership vs a history snapshot (structural sharing).
    this._tasksOwned = true;
    this._linksOwned = true;
    this._batch = false;
    this._batchMutations = 0;
  }

  subscribe(fn) {
    this.listeners.push(fn);
  }

  emit() {
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i]();
  }

  /** id -> row index, cached until the tasks array identity or structure changes. */
  index() {
    const tasks = this.doc.tasks;
    if (this._idxFor !== tasks) {
      const map = new Map();
      for (let i = 0; i < tasks.length; i++) map.set(tasks[i].id, i);
      this._idx = map;
      this._idxFor = tasks;
    }
    return this._idx;
  }

  task(id) {
    const i = this.index().get(id);
    return i === undefined ? null : this.doc.tasks[i];
  }

  nextId() {
    const tasks = this.doc.tasks;
    let max = 0;
    for (let i = 0; i < tasks.length; i++) if (tasks[i].id > max) max = tasks[i].id;
    return max + 1;
  }

  /**
   * Tasks array safe to mutate (slots or structure). Slices when the current
   * array is still referenced by a history entry. struct: drop the id index.
   */
  _writableTasks(struct) {
    if (!this._tasksOwned) {
      this.doc.tasks = this.doc.tasks.slice();
      this._tasksOwned = true;
      this._idxFor = null;
    } else if (struct) {
      this._idxFor = null;
    }
    return this.doc.tasks;
  }

  /** Run a mutation with undo bookkeeping. fn returns false to abort. */
  mutate(fn, mergeKey) {
    if (this._batch) {
      if (fn() === false) return false;
      this._batchMutations++;
      this.dirty = true;
      this.emit();
      return true;
    }
    const now = performance.now();
    const merge = !!mergeKey && mergeKey === this._mergeKey && now - this._mergeAt < MERGE_WINDOW_MS;
    let before = null;
    if (!merge) {
      before = snapshotDoc(this.doc);
      // Snapshot shares tasks/links until the mutator COWs them.
      this._tasksOwned = false;
      this._linksOwned = false;
    }
    if (fn() === false) {
      if (!merge) {
        this._tasksOwned = true;
        this._linksOwned = true;
      }
      return false;
    }
    if (!merge) {
      this.past.push(before);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this._tasksOwned = this.doc.tasks !== before.tasks;
      this._linksOwned = this.doc.links !== before.links;
    }
    this._mergeKey = mergeKey || null;
    this._mergeAt = now;
    this.future.length = 0;
    this.dirty = true;
    this.emit();
    return true;
  }

  /**
   * Run several mutations as one undo step. Nested mutate() still emit so
   * the schedule stays current (needed for cycle checks) but do not push history.
   */
  transact(fn) {
    if (this._batch) {
      fn();
      return true;
    }
    const before = snapshotDoc(this.doc);
    this._tasksOwned = false;
    this._linksOwned = false;
    this._batch = true;
    this._batchMutations = 0;
    this._mergeKey = null;
    try {
      fn();
    } catch (err) {
      this.doc = before;
      this._tasksOwned = true;
      this._linksOwned = true;
      this._idxFor = null;
      this._batch = false;
      this._batchMutations = 0;
      throw err;
    }
    this._batch = false;
    if (!this._batchMutations) {
      this._tasksOwned = true;
      this._linksOwned = true;
      return true;
    }
    this.past.push(before);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this._tasksOwned = this.doc.tasks !== before.tasks;
    this._linksOwned = this.doc.links !== before.links;
    this._mergeKey = null;
    this._mergeAt = 0;
    this.future.length = 0;
    this.dirty = true;
    this.emit();
    return true;
  }

  get inTransact() { return this._batch; }

  /** View state changes are persisted but never land on the undo stack. */
  setView(changes) {
    Object.assign(this.doc.view, changes);
    this.dirty = true;
    this._mergeKey = null;
    this.emit();
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  undo() {
    if (this._batch || !this.past.length) return false;
    this.future.push(snapshotDoc(this.doc));
    this.doc = this.past.pop();
    this._tasksOwned = true;
    this._linksOwned = true;
    this._idxFor = null;
    this.dirty = true;
    this._mergeKey = null;
    this.emit();
    return true;
  }

  redo() {
    if (this._batch || !this.future.length) return false;
    this.past.push(snapshotDoc(this.doc));
    this.doc = this.future.pop();
    this._tasksOwned = true;
    this._linksOwned = true;
    this._idxFor = null;
    this.dirty = true;
    this._mergeKey = null;
    this.emit();
    return true;
  }

  // --- task mutations ---

  setName(name) {
    const self = this;
    return this.mutate(function () { self.doc.name = name; }, 'name');
  }

  patchTask(id, changes, mergeKey) {
    const self = this;
    return this.mutate(function () {
      const i = self.index().get(id);
      if (i === undefined) return false;
      const next = self._writableTasks(false);
      const task = Object.assign({}, next[i], changes);
      if (changes.milestone === true) task.duration = 0;
      if (typeof task.duration === 'number' && task.duration > 0) task.milestone = false;
      task.duration = Math.max(0, Math.round(task.duration));
      task.pct = Math.min(100, Math.max(0, Math.round(task.pct)));
      next[i] = task;
    }, mergeKey);
  }

  patchTasks(ids, changes) {
    const self = this;
    return this.mutate(function () {
      const idx = self.index();
      const next = self._writableTasks(false);
      let touched = false;
      ids.forEach(function (id) {
        const i = idx.get(id);
        if (i === undefined) return;
        next[i] = Object.assign({}, next[i], changes);
        touched = true;
      });
      if (!touched) return false;
    });
  }

  /**
   * Drag/typed start date. An auto task keeps following its predecessors when
   * dropped at or before its earliest possible date, otherwise it gets a
   * start-no-earlier-than constraint (what MS Project does).
   */
  setStart(id, day, earliestDay) {
    const task = this.task(id);
    if (!task) return false;
    const iso = toISO(day);
    if (task.manual || earliestDay === undefined || earliestDay === null) {
      return this.patchTask(id, { start: iso }, 'start' + id);
    }
    if (day <= earliestDay) {
      return this.patchTask(id, { start: iso, constraint: { type: 'ASAP', date: null } }, 'start' + id);
    }
    return this.patchTask(id, { start: iso, constraint: { type: 'SNET', date: iso } }, 'start' + id);
  }

  insertTask(atIndex, level, extras) {
    const self = this;
    const id = this.nextId();
    const ok = this.mutate(function () {
      const tasks = self.doc.tasks;
      const at = Math.max(0, Math.min(atIndex, tasks.length));
      const maxLevel = at > 0 ? tasks[at - 1].level + 1 : 0;
      const lvl = Math.max(0, Math.min(level === undefined ? (at > 0 ? tasks[at - 1].level : 0) : level, maxLevel));
      const anchor = at > 0 ? tasks[at - 1] : tasks[0];
      const raw = Object.assign({
        id: id, level: lvl, name: '', duration: 1,
        start: anchor ? anchor.start : undefined
      }, extras || {});
      raw.id = id;
      raw.level = lvl;
      const next = self._writableTasks(true);
      next.splice(at, 0, normalizeTask(raw, toISO(todayDay())));
    });
    return ok ? id : null;
  }

  deleteIds(ids) {
    const self = this;
    return this.mutate(function () {
      const tasks = self.doc.tasks;
      const idx = self.index();
      const blocks = topLevelSelection(tasks, ids, idx);
      if (!blocks.length) return false;
      const drop = new Set();
      for (let b = 0; b < blocks.length; b++) {
        const end = subtreeEnd(tasks, blocks[b]);
        for (let i = blocks[b]; i < end; i++) drop.add(tasks[i].id);
      }
      const next = tasks.filter(function (t) { return !drop.has(t.id); });
      if (!next.length) return false;
      // Keep the outline legal after removing a parent row.
      for (let i = 0; i < next.length; i++) {
        const maxLevel = i > 0 ? next[i - 1].level + 1 : 0;
        if (next[i].level > maxLevel) next[i] = Object.assign({}, next[i], { level: maxLevel });
      }
      self.doc.tasks = next;
      self._tasksOwned = true;
      self._idxFor = null;
      self.doc.links = self.doc.links.filter(function (l) { return !drop.has(l.from) && !drop.has(l.to); });
      self._linksOwned = true;
    });
  }

  shiftLevels(ids, delta) {
    const self = this;
    return this.mutate(function () {
      const tasks = self.doc.tasks;
      const blocks = topLevelSelection(tasks, ids, self.index());
      if (!blocks.length) return false;
      const next = self._writableTasks(false);
      let touched = false;
      for (let b = 0; b < blocks.length; b++) {
        const i = blocks[b];
        const end = subtreeEnd(tasks, i);
        if (delta > 0) {
          // Needs a preceding row at the same or deeper level to become a child of.
          if (i === 0 || next[i - 1].level < next[i].level) continue;
        } else if (next[i].level === 0) {
          continue;
        }
        for (let k = i; k < end; k++) {
          next[k] = Object.assign({}, next[k], { level: next[k].level + delta });
        }
        if (delta > 0 && next[i - 1].collapsed) {
          next[i - 1] = Object.assign({}, next[i - 1], { collapsed: false });
        }
        touched = true;
      }
      if (!touched) return false;
    });
  }

  /** Move whole subtrees up/down past the adjacent sibling. */
  moveRows(ids, dir) {
    const self = this;
    return this.mutate(function () {
      const tasks = self.doc.tasks;
      const blocks = topLevelSelection(tasks, ids, self.index());
      if (blocks.length !== 1) return false;
      const i = blocks[0];
      const end = subtreeEnd(tasks, i);
      const block = tasks.slice(i, end);
      if (dir < 0) {
        const prev = prevSibling(tasks, i);
        if (prev < 0) return false;
        const next = self._writableTasks(true);
        next.splice(i, block.length);
        next.splice(prev, 0, ...block);
      } else {
        const nxt = nextSibling(tasks, i);
        if (nxt < 0) return false;
        const nxtEnd = subtreeEnd(tasks, nxt);
        const next = self._writableTasks(true);
        next.splice(i, block.length);
        next.splice(i + (nxtEnd - nxt), 0, ...block);
      }
    });
  }

  toggleCollapse(id) {
    const task = this.task(id);
    if (!task) return false;
    return this.patchTask(id, { collapsed: !task.collapsed });
  }

  setCollapsedAll(collapsed, maxLevel) {
    const self = this;
    return this.mutate(function () {
      const next = self._writableTasks(false);
      for (let i = 0; i < next.length; i++) {
        const want = collapsed && next[i].level >= maxLevel;
        if (!!next[i].collapsed !== want) next[i] = Object.assign({}, next[i], { collapsed: want });
      }
    });
  }

  // --- links ---

  predecessorsOf(id) {
    const out = [];
    const links = this.doc.links;
    for (let i = 0; i < links.length; i++) if (links[i].to === id) out.push(links[i]);
    return out;
  }

  addLink(from, to, type, lag) {
    const self = this;
    return this.mutate(function () {
      if (from === to || !self.index().has(from) || !self.index().has(to)) return false;
      const links = self.doc.links;
      for (let i = 0; i < links.length; i++) {
        if (links[i].from === from && links[i].to === to) return false;
      }
      self.doc.links = links.concat([{
        from: from, to: to,
        type: LINK_TYPES.indexOf(type) >= 0 ? type : 'FS',
        lag: Math.round(lag || 0)
      }]);
      self._linksOwned = true;
    });
  }

  removeLink(from, to) {
    const self = this;
    return this.mutate(function () {
      const next = self.doc.links.filter(function (l) { return !(l.from === from && l.to === to); });
      if (next.length === self.doc.links.length) return false;
      self.doc.links = next;
      self._linksOwned = true;
    });
  }

  /** Replace all predecessors of one task (used by the Predecessors column). */
  setPredecessors(id, list) {
    const self = this;
    return this.mutate(function () {
      const idx = self.index();
      const kept = self.doc.links.filter(function (l) { return l.to !== id; });
      const seen = new Set();
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        if (l.from === id || !idx.has(l.from) || seen.has(l.from)) continue;
        seen.add(l.from);
        kept.push({ from: l.from, to: id, type: l.type || 'FS', lag: Math.round(l.lag || 0) });
      }
      self.doc.links = kept;
      self._linksOwned = true;
    });
  }

  // --- calendar / columns ---

  setCalendar(changes) {
    const self = this;
    return this.mutate(function () {
      self.doc.calendar = Object.assign({}, self.doc.calendar, changes);
    });
  }

  addColumn(key, label, type) {
    const self = this;
    return this.mutate(function () {
      const clean = String(key).replace(/[^A-Za-z0-9_]/g, '');
      if (!clean) return false;
      for (let i = 0; i < self.doc.columnDefs.length; i++) {
        if (self.doc.columnDefs[i].key === clean) return false;
      }
      self.doc.columnDefs = self.doc.columnDefs.concat([{
        key: clean, label: label || clean,
        type: type === 'number' || type === 'date' ? type : 'text',
        width: 90
      }]);
      self.doc.view = Object.assign({}, self.doc.view, {
        columns: self.doc.view.columns.concat(['meta.' + clean])
      });
    });
  }

  removeColumnDef(key) {
    const self = this;
    return this.mutate(function () {
      self.doc.columnDefs = self.doc.columnDefs.filter(function (c) { return c.key !== key; });
      self.doc.view = Object.assign({}, self.doc.view, {
        columns: self.doc.view.columns.filter(function (k) { return k !== 'meta.' + key; })
      });
    });
  }

  setMeta(id, key, value) {
    const task = this.task(id);
    if (!task) return false;
    const meta = Object.assign({}, task.meta);
    if (value === '' || value === null || value === undefined) delete meta[key];
    else meta[key] = value;
    return this.patchTask(id, { meta: meta }, 'meta' + id + key);
  }

  setColumnWidth(key, width) {
    const widths = Object.assign({}, this.doc.view.widths);
    widths[key] = Math.max(40, Math.round(width));
    this.setView({ widths: widths });
  }

  toggleColumn(key) {
    const columns = this.doc.view.columns.slice();
    const at = columns.indexOf(key);
    if (at >= 0) {
      if (key === 'name') return;
      columns.splice(at, 1);
    } else {
      columns.push(key);
    }
    this.setView({ columns: columns });
  }

  toJSON() {
    return this.doc;
  }
}
