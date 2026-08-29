// Wiring: state, render loop, toolbar, shortcuts, detail panel, settings.

import { Model, createProject, hasChildren, parentIndex, LINK_TYPES, subtreeEnd } from './model.js';
import { compute, toDay, toISO, formatDay, parseDateInput, todayDay, parsePredecessors } from './schedule.js';
import { Grid, ALL_BUILTIN_COLUMNS, builtinLabel } from './grid.js';
import { Timeline, HEALTH_COLORS, syncThemeFromCss } from './timeline.js';
import { Store, exportFile, exportHtml, importFile } from './store.js';
import { createChat } from './chat.js';

const el = function (id) { return document.getElementById(id); };

const els = {
  toolbar: el('toolbar'),
  projectSelect: el('projectSelect'),
  saveState: el('saveState'),
  gridPane: el('gridPane'),
  head: el('gridHead'),
  headInner: el('gridHeadInner'),
  body: el('gridBody'),
  rows: el('gridRows'),
  splitter: el('splitter'),
  pane: el('chartPane'),
  canvas: el('chartCanvas'),
  scroll: el('chartScroll'),
  spacer: el('chartSpacer'),
  panel: el('panel'),
  statusInfo: el('statusInfo'),
  statusProblem: el('statusProblem'),
  dialog: el('settingsDialog'),
  help: el('helpDialog')
};

const state = {
  model: null,
  sched: null,
  rows: [],
  positionOfRow: new Int32Array(0),
  sel: new Set(),
  cursor: 0,
  cursorCol: 0,
  hoverPosition: -1,
  scrollTop: 0,
  scrollLeft: 0,
  viewOnly: false,
  metrics: { rowH: 22, headerH: 40 }
};

/** What each colour means, in the order of HEALTH_COLORS. Read during boot. */
const HEALTH_HELP = [
  'Not started. Today is still before the first working day of the task.',
  'On track. At least as far along as the working time already spent.',
  'At risk. Up to 10 percentage points short of the time spent.',
  'Behind. More than 10 points short, or past its finish and not marked done.',
  'Done. Marked 100%, even if it finished later than planned.'
];

const store = new Store(setSaveState);
let grid = null;
let timeline = null;
let chat = null;
let renderPending = false;
let columnSignature = '';
let warnUntil = 0;
let warnText = '';

// --- boot ----------------------------------------------------------------

const actions = {
  requestRender: requestRender,
  setScrollTop: setScrollTop,
  onVerticalScroll: function () { grid.render(); },
  revealTask: revealTask,
  selectRange: selectRange,
  selectPosition: selectPosition,
  setHoverRow: setHoverRow,
  openDetail: function () { setPanel(true); },
  warn: warn,
  toggleCollapseCursor: toggleCollapseCursor,
  createLink: createLink,
  createBar: createBar,
  moveTask: moveTask,
  setDuration: setDuration,
  resizeFromStart: resizeFromStart,
  fitGridPaneToContent: fitGridPaneToContent
};

boot();

const THEME_KEY = 'gantt-theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, persist) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  if (persist !== false) {
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
  }
  syncThemeFromCss();
  if (typeof buildLegend === 'function') buildLegend();
  const helpStates = el('helpStates');
  if (helpStates) {
    while (helpStates.firstChild) helpStates.removeChild(helpStates.firstChild);
  }
  if (timeline) {
    timeline.requestDraw();
  }
}

function loadSavedTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem(THEME_KEY) || 'light'; } catch (err) { /* ignore */ }
  applyTheme(saved === 'dark' ? 'dark' : 'light', false);
}

async function boot() {
  loadSavedTheme();
  grid = new Grid(state, els, actions);
  timeline = new Timeline(state, els, actions);
  chat = createChat({
    el: el,
    state: state,
    store: store,
    warn: warn,
    requestRender: requestRender,
    createLink: createLink,
    LINK_TYPES: LINK_TYPES
  });
  buildLegend();

  const packed = window.GANTT_VIEW;
  if (packed && packed.doc) {
    state.viewOnly = true;
    document.body.classList.add('view-only');
    openDoc(packed.name || packed.doc.name || 'Project', packed.doc);
    wireUI();
    return;
  }

  let names = [];
  try {
    names = await store.list();
  } catch (err) {
    fatal('The local server is not answering. Start the app with start.cmd and open http://127.0.0.1:8765/');
    return;
  }
  if (!names.length) {
    const doc = createProject('Project');
    await store.create('Project', doc);
    names = ['Project'];
  }
  const wanted = new URLSearchParams(location.search).get('p');
  const name = names.indexOf(wanted) >= 0 ? wanted : names[0];
  fillProjects(names, name);
  let doc;
  try {
    doc = await store.load(name);
  } catch (err) {
    fatal(String(err.message || err));
    return;
  }
  openDoc(name, doc);
  wireUI();
}

function fatal(text) {
  els.statusProblem.textContent = text;
  setSaveState('error');
}

function fillProjects(names, current) {
  const sel = els.projectSelect;
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  for (let i = 0; i < names.length; i++) {
    const opt = document.createElement('option');
    opt.value = names[i];
    opt.textContent = names[i];
    if (names[i] === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

function openDoc(name, doc) {
  state.model = new Model(doc);
  state.sel.clear();
  state.cursor = 0;
  state.cursorCol = 0;
  state.hoverPosition = -1;
  state.scrollTop = 0;
  els.scroll.scrollTop = 0;
  els.scroll.scrollLeft = 0;
  if (!state.viewOnly) store.attach(state.model, name);
  state.model.subscribe(onModelChange);
  applyMetrics();
  columnSignature = '';
  recompute();
  if (state.rows.length) state.sel.add(state.model.doc.tasks[state.rows[0]].id);
  timeline.resize();
  timeline.layout();
  timeline.scrollToDay(todayDay());
  refreshPanel();
  requestRender();
  setSaveState('saved');
  document.title = state.model.doc.name + ' - GanttLocal';
}

function applyMetrics() {
  const view = state.model.doc.view;
  state.metrics.rowH = view.compact ? 18 : 22;
  const root = document.documentElement.style;
  root.setProperty('--row-h', state.metrics.rowH + 'px');
  root.setProperty('--head-h', state.metrics.headerH + 'px');
  if (view.gridWidth) root.setProperty('--grid-w', Math.max(140, view.gridWidth) + 'px');
}

// --- derived state -------------------------------------------------------

function onModelChange() {
  recompute();
  store.touch();
  refreshPanel();
  requestRender();
}

function recompute() {
  const model = state.model;
  state.sched = compute(model.doc);
  rebuildRows();
  const signature = model.doc.view.columns.join('|') + '#' + JSON.stringify(model.doc.view.widths) +
    '#' + model.doc.columnDefs.map(function (c) { return c.key + c.label + c.type; }).join('|');
  if (signature !== columnSignature) {
    columnSignature = signature;
    grid.buildLayout();
  }
  timeline.layout();
  if (state.cursor >= state.rows.length) state.cursor = Math.max(0, state.rows.length - 1);
}

function rebuildRows() {
  const tasks = state.model.doc.tasks;
  const rows = state.rows;
  rows.length = 0;
  if (state.positionOfRow.length !== tasks.length) state.positionOfRow = new Int32Array(tasks.length);
  const posOf = state.positionOfRow;
  let hideBelow = -1;
  let lastVisible = -1;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (hideBelow >= 0 && task.level > hideBelow) {
      posOf[i] = lastVisible;
      continue;
    }
    hideBelow = -1;
    rows.push(i);
    lastVisible = rows.length - 1;
    posOf[i] = lastVisible;
    if (task.collapsed && hasChildren(tasks, i)) hideBelow = task.level;
  }
}

function requestRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(function () {
    renderPending = false;
    grid.render();
    timeline.requestDraw();
    updateStatus();
    updateToolbar();
  });
}

function fitGridPaneToContent() {
  const w = grid.fitPaneToContent();
  document.documentElement.style.setProperty('--grid-w', w + 'px');
  timeline.resize();
  requestRender();
}

function setScrollTop(top) {
  const max = Math.max(0, els.scroll.scrollHeight - els.scroll.clientHeight);
  const next = Math.max(0, Math.min(top, max));
  if (next === state.scrollTop) return;
  els.scroll.scrollTop = next;
  state.scrollTop = next;
}

function revealTask(row) {
  if (row < 0 || row >= state.model.doc.tasks.length) return;
  if (timeline.ensureRangeVisible(state.sched.start[row], state.sched.finish[row])) timeline.requestDraw();
}

// --- selection -----------------------------------------------------------

function selectRange(fromPosition, toPosition) {
  const a = Math.min(fromPosition, toPosition);
  const b = Math.max(fromPosition, toPosition);
  state.sel.clear();
  for (let p = a; p <= b && p < state.rows.length; p++) {
    if (p < 0) continue;
    state.sel.add(state.model.doc.tasks[state.rows[p]].id);
  }
  state.cursor = toPosition;
}

function selectPosition(position, shift, ctrl) {
  if (position < 0 || position >= state.rows.length) return;
  const id = state.model.doc.tasks[state.rows[position]].id;
  if (shift && state.cursor >= 0) {
    selectRange(state.cursor, position);
  } else if (ctrl) {
    if (state.sel.has(id)) state.sel.delete(id);
    else state.sel.add(id);
    state.cursor = position;
  } else {
    state.sel.clear();
    state.sel.add(id);
    state.cursor = position;
  }
  revealTask(state.rows[position]);
  requestRender();
}

/** One hovered row, mirrored in both panes so the eye can follow it across. */
function setHoverRow(position) {
  const pos = position >= 0 && position < state.rows.length ? position : -1;
  if (state.hoverPosition === pos) return;
  state.hoverPosition = pos;
  grid.paintHover();
  timeline.requestDraw();
}

function selectedIds() {
  const out = [];
  for (let p = 0; p < state.rows.length; p++) {
    const id = state.model.doc.tasks[state.rows[p]].id;
    if (state.sel.has(id)) out.push(id);
  }
  return out;
}

function cursorTask() {
  if (state.cursor < 0 || state.cursor >= state.rows.length) return null;
  return state.model.doc.tasks[state.rows[state.cursor]];
}

function cursorRow() {
  if (state.cursor < 0 || state.cursor >= state.rows.length) return -1;
  return state.rows[state.cursor];
}

// --- editing actions -----------------------------------------------------

function addTask() {
  const tasks = state.model.doc.tasks;
  const row = cursorRow();
  const level = row >= 0 ? tasks[row].level : 0;
  const at = row >= 0 ? row + 1 : tasks.length;
  const id = state.model.insertTask(at, level);
  if (id === null) return;
  selectNewTask(id);
}

/** Chart double-click on empty space: a new task whose bar starts at that day. */
function createBar(spot) {
  if (state.viewOnly) return;
  const tasks = state.model.doc.tasks;
  let at = tasks.length;
  let level = 0;
  if (spot && spot.position >= 0 && spot.position < state.rows.length) {
    const row = state.rows[spot.position];
    at = subtreeEnd(tasks, row);
    level = tasks[row].level;
  }
  const extras = { duration: 5 };
  if (spot) {
    const day = state.sched.cal.next(timeline.xToDay(spot.x));
    const iso = toISO(day);
    extras.start = iso;
    extras.constraint = { type: 'SNET', date: iso };
  }
  const id = state.model.insertTask(at, level, extras);
  if (id === null) return;
  selectNewTask(id);
}

function selectNewTask(id) {
  state.sel.clear();
  state.sel.add(id);
  const position = state.positionOfRow[state.model.index().get(id)];
  state.cursor = position;
  state.cursorCol = Math.max(0, grid.layout.findIndex(function (c) { return c.key === 'name'; }));
  requestRender();
  grid.ensureVisible(state.cursor);
  revealTask(state.rows[state.cursor]);
  grid.beginEdit(state.cursor, state.cursorCol, '');
}

function deleteSelected() {
  const ids = selectedIds();
  if (!ids.length || state.viewOnly) return;
  openDeleteTasksConfirm(ids);
}

function countTasksRemoved(ids) {
  const tasks = state.model.doc.tasks;
  const idx = state.model.index();
  const idSet = new Set(ids);
  const roots = [];
  for (let i = 0; i < ids.length; i++) {
    const row = idx.get(ids[i]);
    if (row === undefined) continue;
    let covered = false;
    let p = parentIndex(tasks, row);
    while (p >= 0) {
      if (idSet.has(tasks[p].id)) {
        covered = true;
        break;
      }
      p = parentIndex(tasks, p);
    }
    if (!covered) roots.push(row);
  }
  const drop = new Set();
  for (let r = 0; r < roots.length; r++) {
    const end = subtreeEnd(tasks, roots[r]);
    for (let i = roots[r]; i < end; i++) drop.add(tasks[i].id);
  }
  return drop.size;
}

function openDeleteTasksConfirm(ids) {
  const tasks = state.model.doc.tasks;
  const idx = state.model.index();
  const total = countTasksRemoved(ids);
  const msg = el('deleteTasksMessage');
  if (ids.length === 1) {
    const row = idx.get(ids[0]);
    const name = row === undefined ? 'this task' : (tasks[row].name || 'Untitled');
    if (total > 1) {
      msg.textContent = 'Delete "' + name + '" and its ' + (total - 1) +
        ' child task' + (total - 1 === 1 ? '' : 's') + '?';
    } else {
      msg.textContent = 'Delete "' + name + '"?';
    }
  } else if (total > ids.length) {
    msg.textContent = 'Delete ' + ids.length + ' selected tasks (' + total +
      ' including children)?';
  } else {
    msg.textContent = 'Delete ' + ids.length + ' selected tasks?';
  }
  el('deleteTasksDialog').showModal();
  el('deleteTasksOk').focus();
}

function confirmDeleteTasks() {
  const ids = selectedIds();
  el('deleteTasksDialog').close();
  if (!ids.length) return;
  const position = state.cursor;
  if (!state.model.deleteIds(ids)) {
    warn('Cannot delete the last remaining task');
    return;
  }
  state.sel.clear();
  state.cursor = Math.max(0, Math.min(position, state.rows.length - 1));
  if (state.rows.length) state.sel.add(state.model.doc.tasks[state.rows[state.cursor]].id);
  requestRender();
}

function shiftLevel(delta) {
  const ids = selectedIds();
  if (!ids.length) return;
  if (!state.model.shiftLevels(ids, delta)) warn(delta > 0 ? 'Nothing above to indent under' : 'Already at the top level');
  restoreCursorTo(ids[0]);
}

function moveRows(dir) {
  const ids = selectedIds();
  if (ids.length !== 1) {
    warn('Select a single task to move');
    return;
  }
  if (state.model.moveRows(ids, dir)) restoreCursorTo(ids[0]);
}

function restoreCursorTo(id) {
  const row = state.model.index().get(id);
  if (row === undefined) return;
  const position = state.positionOfRow[row];
  if (position >= 0) state.cursor = position;
  requestRender();
}

function toggleCollapseCursor() {
  const task = cursorTask();
  if (!task) return;
  const row = cursorRow();
  if (hasChildren(state.model.doc.tasks, row)) state.model.toggleCollapse(task.id);
}

function toggleMilestone() {
  const ids = selectedIds();
  if (!ids.length) return;
  const first = state.model.task(ids[0]);
  const makeMilestone = !(first.duration <= 0);
  for (let i = 0; i < ids.length; i++) {
    const row = state.model.index().get(ids[i]);
    if (state.sched.summary[row]) continue;
    state.model.patchTask(ids[i],
      makeMilestone ? { duration: 0, milestone: true } : { duration: 1, milestone: false },
      'milestone');
  }
}

function linkSelected() {
  const ids = selectedIds();
  if (ids.length < 2) {
    warn('Select two or more tasks to link');
    return;
  }
  for (let i = 1; i < ids.length; i++) createLink(ids[i - 1], ids[i]);
}

function unlinkSelected() {
  const ids = selectedIds();
  const set = new Set(ids);
  const links = state.model.doc.links;
  const doomed = [];
  for (let i = 0; i < links.length; i++) {
    if (set.has(links[i].from) && set.has(links[i].to)) doomed.push(links[i]);
  }
  if (!doomed.length) {
    warn('No links between the selected tasks');
    return;
  }
  for (let i = 0; i < doomed.length; i++) state.model.removeLink(doomed[i].from, doomed[i].to);
}

function createLink(from, to, type, lag, opts) {
  opts = opts || {};
  const silent = !!opts.silent;
  if (from === to || !state.model.index().has(from) || !state.model.index().has(to)) {
    if (!silent) warn('One of those tasks is missing');
    return { ok: false, reason: 'missing' };
  }
  if (outlineRelated(from, to)) {
    if (!silent) warn('Cannot link a summary to its own descendant (or the reverse)');
    return { ok: false, reason: 'outline' };
  }
  const before = state.sched.cycleIds.size;
  if (!state.model.addLink(from, to, type || 'FS', lag || 0)) {
    if (!silent) warn('Those tasks are already linked');
    return { ok: false, reason: 'duplicate' };
  }
  if (state.sched.cycleIds.size > before) {
    if (state.model.inTransact) state.model.removeLink(from, to);
    else state.model.undo();
    if (!silent) warn('That link would create a circular dependency');
    return { ok: false, reason: 'cycle' };
  }
  return { ok: true };
}

/** True when one task is an outline ancestor of the other (WBS parent/child). */
function outlineRelated(a, b) {
  const idx = state.model.index();
  const parent = state.sched && state.sched.parent;
  if (!parent) return false;
  const ra = idx.get(a);
  const rb = idx.get(b);
  if (ra === undefined || rb === undefined) return false;
  let row = rb;
  while (row >= 0) {
    const p = parent[row];
    if (p < 0) break;
    if (p === ra) return true;
    row = p;
  }
  row = ra;
  while (row >= 0) {
    const p = parent[row];
    if (p < 0) break;
    if (p === rb) return true;
    row = p;
  }
  return false;
}

function moveTask(id, row, day) {
  const task = state.model.task(id);
  if (!task) return;
  if (task.constraint.type === 'FNLT') {
    state.model.patchTask(id, { start: toISO(day) }, 'move' + id);
    return;
  }
  const earliest = state.sched.earliest[row];
  state.model.setStart(id, day, earliest < 0 ? null : earliest);
}

function setDuration(id, days) {
  state.model.patchTask(id, { duration: days, milestone: days === 0 }, 'dur' + id);
}

function resizeFromStart(id, row, day, days) {
  const task = state.model.task(id);
  if (!task) return;
  const changes = { start: toISO(day), duration: days, milestone: days === 0 };
  if (!task.manual && task.constraint.type !== 'FNLT') {
    const earliest = state.sched.earliest[row];
    changes.constraint = earliest >= 0 && day > earliest
      ? { type: 'SNET', date: toISO(day) }
      : { type: 'ASAP', date: null };
  }
  state.model.patchTask(id, changes, 'resize' + id);
}

// --- status / toolbar ----------------------------------------------------

function warn(text) {
  warnText = text;
  warnUntil = performance.now() + 4000;
  els.statusProblem.textContent = text;
  requestRender();
}

function setSaveState(kind, detail) {
  const node = els.saveState;
  node.classList.toggle('err', kind === 'error' || kind === 'stale');
  node.classList.toggle('stale', kind === 'stale');
  node.title = '';
  if (kind === 'saved') node.textContent = 'saved';
  else if (kind === 'saving') node.textContent = 'saving...';
  else if (kind === 'unsaved') node.textContent = 'editing...';
  else if (kind === 'stale') {
    node.textContent = 'file changed';
    node.title = 'Click to reload from disk. Ctrl+S overwrites.';
  }
  else node.textContent = 'not saved';
  if (kind === 'stale') els.statusProblem.textContent = 'The file changed on disk. Click “file changed” to reload, or Ctrl+S to overwrite with this version.';
  if (kind === 'error' && detail) els.statusProblem.textContent = 'Save failed: ' + detail;
}

async function reloadFromDisk() {
  if (state.viewOnly || !store.stale || !store.name) return;
  if (!confirm('Reload this project from disk? Edits in this window that are not on disk will be discarded.')) return;
  try {
    if (store.timer) {
      clearTimeout(store.timer);
      store.timer = 0;
    }
    const name = store.name;
    const doc = await store.load(name);
    openDoc(name, doc);
    if (chat) await chat.onProjectChange();
  } catch (err) {
    warn(String(err.message || err));
  }
}

function updateStatus() {
  const sched = state.sched;
  const doc = state.model.doc;
  const fmt = doc.view.dateFormat;
  let done = 0;
  let leaves = 0;
  for (let i = 0; i < doc.tasks.length; i++) {
    if (sched.summary[i]) continue;
    leaves++;
    done += sched.pct[i];
  }
  els.statusInfo.textContent =
    doc.tasks.length + ' tasks, ' + doc.links.length + ' links   ' +
    formatDay(sched.projectStart, fmt) + ' - ' + formatDay(sched.projectFinish, fmt) +
    '   ' + sched.cal.span(sched.projectStart, sched.projectFinish) + ' working days   ' +
    (leaves ? Math.round(done / leaves) : 0) + '% complete';

  if (performance.now() < warnUntil) {
    els.statusProblem.textContent = warnText;
  } else if (sched.problems.length) {
    els.statusProblem.textContent = sched.problems.length === 1
      ? sched.problems[0].text
      : sched.problems[0].text + ' (+' + (sched.problems.length - 1) + ' more)';
  } else if (!store.stale && !store.failed) {
    els.statusProblem.textContent = '';
  }
}

function updateToolbar() {
  const zoom = state.model.doc.view.zoom;
  const buttons = el('zoomGroup').children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('on', buttons[i].dataset.zoom === zoom);
  }
  el('btnUndo').disabled = !state.model.canUndo();
  el('btnRedo').disabled = !state.model.canRedo();
  el('btnDetail').classList.toggle('on', !els.panel.hidden);
}

// --- detail panel --------------------------------------------------------

function setPanel(open) {
  els.panel.hidden = !open;
  timeline.resize();
  timeline.layout();
  refreshPanel();
  requestRender();
}

function refreshPanel() {
  if (els.panel.hidden) return;
  const task = cursorTask();
  const row = cursorRow();
  const active = document.activeElement;
  const fmt = state.model.doc.view.dateFormat;
  const fields = ['fName', 'fDuration', 'fPct', 'fStart', 'fFinish', 'fNotes', 'fConstraintDate'];
  if (!task) {
    for (let i = 0; i < fields.length; i++) el(fields[i]).value = '';
    el('panelTitle').textContent = 'No task';
    return;
  }
  const sched = state.sched;
  const isSummary = sched.summary[row] === 1;
  el('panelTitle').textContent = sched.wbs[row] + '  ' + (task.name || '(unnamed)');
  setField('fName', task.name, active);
  setField('fDuration', isSummary ? sched.span[row] : task.duration, active);
  setField('fPct', isSummary ? Math.round(sched.pct[row]) : task.pct, active);
  setField('fStart', formatDay(sched.start[row], fmt), active);
  setField('fFinish', formatDay(sched.finish[row], fmt), active);
  setField('fNotes', task.notes, active);
  setField('fConstraintDate', task.constraint.date ? formatDay(toDay(task.constraint.date), fmt) : '', active);
  el('fMilestone').checked = !isSummary && task.duration <= 0;
  el('fManual').checked = task.manual;
  el('fConstraint').value = task.constraint.type;
  el('fDuration').disabled = isSummary;
  el('fPct').disabled = isSummary;
  el('fStart').disabled = isSummary;
  el('fMilestone').disabled = isSummary;
  el('fManual').disabled = isSummary;
  el('fConstraint').disabled = isSummary;
  el('fConstraintDate').disabled = isSummary || task.constraint.type === 'ASAP';
  el('panelMeta').textContent = 'id ' + task.id + '   slack ' + (isSummary ? '-' : sched.slack[row] + 'd') +
    (sched.critical[row] ? '   critical' : '');
  buildPredList(task);
  buildCustomFields(task);
  if (state.viewOnly) {
    const nodes = els.panel.querySelectorAll('input, textarea, select, button');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].id === 'panelClose') continue;
      nodes[i].disabled = true;
    }
  }
}

function setField(id, value, active) {
  const node = el(id);
  if (node === active) return;
  const text = value === null || value === undefined ? '' : String(value);
  if (node.value !== text) node.value = text;
}

function buildPredList(task) {
  const host = el('predList');
  while (host.firstChild) host.removeChild(host.firstChild);
  const links = state.model.predecessorsOf(task.id);
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const pred = state.model.task(link.from);
    const rowEl = document.createElement('div');
    rowEl.className = 'pred';

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = link.from + '  ' + (pred ? pred.name : '?');
    rowEl.appendChild(who);

    const type = document.createElement('select');
    for (let t = 0; t < LINK_TYPES.length; t++) {
      const opt = document.createElement('option');
      opt.value = LINK_TYPES[t];
      opt.textContent = LINK_TYPES[t];
      type.appendChild(opt);
    }
    type.value = link.type;
    type.onchange = function () {
      setLink(task.id, link.from, type.value, link.lag);
    };
    rowEl.appendChild(type);

    const lag = document.createElement('input');
    lag.type = 'number';
    lag.step = '1';
    lag.value = String(link.lag);
    lag.onchange = function () {
      setLink(task.id, link.from, link.type, parseInt(lag.value, 10) || 0);
    };
    rowEl.appendChild(lag);

    const drop = document.createElement('button');
    drop.textContent = '\u00d7';
    drop.title = 'Remove';
    drop.onclick = function () {
      state.model.removeLink(link.from, task.id);
    };
    rowEl.appendChild(drop);
    host.appendChild(rowEl);
  }
}

function setLink(to, from, type, lag) {
  const links = state.model.predecessorsOf(to).map(function (l) {
    return l.from === from ? { from: from, type: type, lag: lag } : l;
  });
  state.model.setPredecessors(to, links);
}

function buildCustomFields(task) {
  const host = el('customList');
  while (host.firstChild) host.removeChild(host.firstChild);
  const defs = state.model.doc.columnDefs;
  el('customHead').hidden = defs.length === 0;
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const label = document.createElement('label');
    label.textContent = def.label;
    const input = document.createElement('input');
    input.value = task.meta[def.key] === undefined ? '' : String(task.meta[def.key]);
    input.autocomplete = 'off';
    input.onchange = function () {
      let value = input.value.trim();
      if (def.type === 'number' && value) {
        const n = parseFloat(value.replace(',', '.'));
        if (!Number.isFinite(n)) {
          warn('Not a number: ' + value);
          return;
        }
        value = n;
      } else if (def.type === 'date' && value) {
        const day = parseDateInput(value);
        if (day === null) {
          warn('Not a date: ' + value);
          return;
        }
        value = toISO(day);
      }
      state.model.setMeta(task.id, def.key, value);
    };
    label.appendChild(input);
    host.appendChild(label);
  }
}

// --- legend and help -----------------------------------------------------

/** Status-bar legend, built from the palette so both can never drift apart. */
function buildLegend() {
  const host = el('legend');
  while (host.firstChild) host.removeChild(host.firstChild);
  for (let i = 0; i < HEALTH_COLORS.length; i++) {
    const paint = HEALTH_COLORS[i];
    const item = document.createElement('span');
    item.className = 'lg';
    item.title = HEALTH_HELP[i];
    const swatch = document.createElement('i');
    swatch.style.background = paint.bar;
    swatch.style.borderColor = paint.edge;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(paint.label));
    host.appendChild(item);
  }
}

/** The same five states in the help window, drawn as little bars. */
function buildHelpStates() {
  const host = el('helpStates');
  if (host.firstChild) return;
  for (let i = 0; i < HEALTH_COLORS.length; i++) {
    const paint = HEALTH_COLORS[i];
    const swatch = document.createElement('span');
    swatch.className = 'sw';
    swatch.style.background = 'linear-gradient(90deg, ' + paint.bar + ' 55%, ' + paint.tint + ' 55%)';
    swatch.style.borderColor = paint.edge;
    const text = document.createElement('span');
    text.textContent = HEALTH_HELP[i];
    host.appendChild(swatch);
    host.appendChild(text);
  }
}

function openHelp(target) {
  buildHelpStates();
  if (!els.help.open) els.help.showModal();
  const section = target ? el(target) : null;
  el('helpBody').scrollTop = section ? Math.max(0, section.offsetTop - 12) : 0;
  markHelpSection(target || 'h-start');
}

function markHelpSection(id) {
  const buttons = el('helpNav').children;
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('on', buttons[i].dataset.target === id);
  }
}

// --- settings ------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Holidays are stored as ISO but shown in the chosen display format. */
function holidayText(doc) {
  const fmt = doc.view.dateFormat;
  return doc.calendar.holidays.map(function (iso) { return formatDay(toDay(iso), fmt); }).join('\n');
}

function openSettings() {
  const doc = state.model.doc;
  el('sName').value = store.name || doc.name;
  el('sHolidays').value = holidayText(doc);
  el('sDateFormat').value = doc.view.dateFormat;
  el('sCompact').checked = !!doc.view.compact;
  el('sCritical').checked = doc.view.showCritical !== false;
  el('sDark').checked = currentTheme() === 'dark';
  const path = 'data/' + store.name + '.json';
  el('sPath').textContent = path;
  el('sPath').title = path;

  const days = el('sWorkDays');
  while (days.firstChild) days.removeChild(days.firstChild);
  for (let d = 1; d <= 7; d++) {
    const index = d % 7;
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = doc.calendar.workDays.indexOf(index) >= 0;
    box.onchange = function () {
      const set = new Set(state.model.doc.calendar.workDays);
      if (box.checked) set.add(index);
      else set.delete(index);
      const list = Array.from(set).sort();
      if (!list.length) {
        box.checked = true;
        return;
      }
      state.model.setCalendar({ workDays: list });
    };
    label.appendChild(box);
    label.appendChild(document.createTextNode(DAY_NAMES[index]));
    days.appendChild(label);
  }

  const cols = el('sColumns');
  while (cols.firstChild) cols.removeChild(cols.firstChild);
  for (let i = 0; i < ALL_BUILTIN_COLUMNS.length; i++) {
    const key = ALL_BUILTIN_COLUMNS[i];
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = doc.view.columns.indexOf(key) >= 0;
    box.disabled = key === 'name';
    box.onchange = function () { state.model.toggleColumn(key); };
    label.appendChild(box);
    const text = document.createElement('span');
    text.className = 'lbl';
    text.textContent = builtinLabel(key);
    label.appendChild(text);
    cols.appendChild(label);
  }

  const custom = el('sCustomCols');
  while (custom.firstChild) custom.removeChild(custom.firstChild);
  for (let i = 0; i < doc.columnDefs.length; i++) {
    const def = doc.columnDefs[i];
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = doc.view.columns.indexOf('meta.' + def.key) >= 0;
    box.onchange = function () { state.model.toggleColumn('meta.' + def.key); };
    const drop = document.createElement('button');
    drop.textContent = '\u00d7';
    drop.title = 'Delete field and its values stay in the file';
    drop.onclick = function () {
      state.model.removeColumnDef(def.key);
      openSettings();
    };
    label.appendChild(box);
    const text = document.createElement('span');
    text.className = 'lbl';
    text.textContent = def.label + ' (' + def.type + ')';
    label.appendChild(text);
    label.appendChild(drop);
    custom.appendChild(label);
  }

  if (!els.dialog.open) els.dialog.showModal();
  refreshDeleteProjectState();
  refreshAssistantSettings();
}

async function refreshAssistantSettings() {
  const hint = el('sGpuHint');
  const box = el('sGpu');
  const layers = el('sGpuLayers');
  if (!box || !layers) return;
  try {
    const res = await fetch('api/assistant/settings', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {
      hint.textContent = data.error || 'Assistant settings unavailable';
      box.disabled = true;
      layers.disabled = true;
      return;
    }
    box.disabled = false;
    box.checked = !!data.gpuEnabled;
    layers.value = String(data.nGpuLayers === undefined ? -1 : data.nGpuLayers);
    layers.disabled = !box.checked;
    hint.textContent = data.gpuHint || 'Optional local LLM GPU offload (Vulkan: NVIDIA, AMD, Intel).';
    hint.className = data.gpuEnabled && !data.gpuOffloadSupported ? 'hint warn' : 'hint';
  } catch (err) {
    hint.textContent = String(err.message || err);
    box.disabled = true;
    layers.disabled = true;
  }
}

async function saveAssistantSettings() {
  const box = el('sGpu');
  const layers = el('sGpuLayers');
  const hint = el('sGpuHint');
  try {
    const res = await fetch('api/assistant/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gpuEnabled: box.checked,
        nGpuLayers: parseInt(layers.value, 10)
      })
    });
    const data = await res.json();
    if (!res.ok) {
      warn(data.error || 'Could not save assistant settings');
      return;
    }
    layers.disabled = !box.checked;
    if (data.nGpuLayers !== undefined) layers.value = String(data.nGpuLayers);
    hint.textContent = data.gpuHint || '';
    hint.className = data.gpuEnabled && !data.gpuOffloadSupported ? 'hint warn' : 'hint';
    if (chat) await chat.refreshStatus();
  } catch (err) {
    warn(String(err.message || err));
  }
}

function refreshDeleteProjectState() {
  const count = els.projectSelect.options.length;
  const only = count <= 1;
  el('sDeleteOnlyHint').hidden = !only;
  el('sDelete').disabled = state.viewOnly || only;
}

function sanitizeProjectName(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 64);
}

function openNewProjectDialog() {
  if (state.viewOnly) return;
  const input = el('newProjectName');
  input.value = 'Project 2';
  el('newProjectDialog').showModal();
  input.focus();
  input.select();
}

async function createNewProject() {
  if (state.viewOnly) return;
  const name = sanitizeProjectName(el('newProjectName').value);
  if (!name) {
    warn('That name cannot be used as a file name');
    return;
  }
  el('newProjectOk').disabled = true;
  try {
    await store.save(true);
    await store.create(name, createProject(name));
    fillProjects(await store.list(), name);
    openDoc(name, await store.load(name));
    history.replaceState(null, '', '?p=' + encodeURIComponent(name));
    if (chat) await chat.onProjectChange();
    el('newProjectDialog').close();
  } catch (err) {
    warn(String(err.message || err));
  } finally {
    el('newProjectOk').disabled = false;
  }
}

function openDeleteProjectConfirm() {
  if (state.viewOnly || els.projectSelect.options.length <= 1) return;
  const name = store.name;
  el('deleteProjectName').textContent = name;
  el('deleteProjectLabel').textContent = name;
  const input = el('deleteProjectConfirm');
  input.value = '';
  el('deleteProjectOk').disabled = true;
  el('deleteProjectDialog').showModal();
  input.focus();
}

function syncDeleteProjectConfirm() {
  el('deleteProjectOk').disabled = el('deleteProjectConfirm').value !== store.name;
}

async function deleteCurrentProject() {
  if (state.viewOnly || el('deleteProjectConfirm').value !== store.name) return;
  if (els.projectSelect.options.length <= 1) {
    warn('You cannot delete the only remaining project');
    return;
  }
  const name = store.name;
  el('deleteProjectOk').disabled = true;
  try {
    if (store.timer) {
      clearTimeout(store.timer);
      store.timer = 0;
    }
    await store.save(true);
    if (store.stale) {
      warn('This project was changed on disk. Reload it, then try again.');
      syncDeleteProjectConfirm();
      return;
    }
    await store.delete(name);
  } catch (err) {
    syncDeleteProjectConfirm();
    warn(String(err.message || err));
    return;
  }
  el('deleteProjectDialog').close();
  els.dialog.close();
  const names = await store.list();
  const next = names[0];
  fillProjects(names, next);
  try {
    openDoc(next, await store.load(next));
    history.replaceState(null, '', '?p=' + encodeURIComponent(next));
    if (chat) await chat.onProjectChange();
  } catch (err) {
    fatal(String(err.message || err));
  }
}

// --- UI wiring -----------------------------------------------------------

function wireUI() {
  el('btnAdd').onclick = addTask;
  el('btnDelete').onclick = deleteSelected;
  el('deleteTasksCancel').onclick = function () { el('deleteTasksDialog').close(); };
  el('deleteTasksOk').onclick = confirmDeleteTasks;
  el('btnMilestone').onclick = toggleMilestone;
  el('btnIndent').onclick = function () { shiftLevel(1); };
  el('btnOutdent').onclick = function () { shiftLevel(-1); };
  el('btnUp').onclick = function () { moveRows(-1); };
  el('btnDown').onclick = function () { moveRows(1); };
  el('btnLink').onclick = linkSelected;
  el('btnUnlink').onclick = unlinkSelected;
  el('btnUndo').onclick = function () { state.model.undo(); requestRender(); };
  el('btnRedo').onclick = function () { state.model.redo(); requestRender(); };
  el('btnToday').onclick = function () { timeline.scrollToDay(todayDay()); };
  el('gridFitCols').onclick = function () { fitGridPaneToContent(); };
  el('btnCollapse').onclick = function () { state.model.setCollapsedAll(true, 0); };
  el('btnExpand').onclick = function () { state.model.setCollapsedAll(false, 0); };
  el('btnDetail').onclick = function () { setPanel(els.panel.hidden); };
  el('panelClose').onclick = function () { setPanel(false); };
  el('btnSettings').onclick = openSettings;
  el('sClose').onclick = function () { els.dialog.close(); };
  if (chat) chat.wire();
  el('sDelete').onclick = openDeleteProjectConfirm;
  el('deleteProjectCancel').onclick = function () { el('deleteProjectDialog').close(); };
  el('deleteProjectConfirm').oninput = syncDeleteProjectConfirm;
  el('deleteProjectConfirm').onkeydown = function (event) {
    if (event.key === 'Enter' && !el('deleteProjectOk').disabled) {
      event.preventDefault();
      deleteCurrentProject();
    }
  };
  el('deleteProjectOk').onclick = deleteCurrentProject;
  el('btnNewProject').onclick = openNewProjectDialog;
  el('newProjectCancel').onclick = function () { el('newProjectDialog').close(); };
  el('newProjectOk').onclick = createNewProject;
  el('newProjectName').onkeydown = function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      createNewProject();
    }
  };
  els.saveState.onclick = function () { reloadFromDisk(); };
  el('btnHelp').onclick = function () { openHelp(null); };
  el('helpClose').onclick = function () { els.help.close(); };

  const navButtons = el('helpNav').children;
  for (let i = 0; i < navButtons.length; i++) {
    const target = navButtons[i].dataset.target;
    navButtons[i].onclick = function () { openHelp(target); };
  }
  const helpBody = el('helpBody');
  const helpSections = helpBody.getElementsByTagName('section');
  helpBody.addEventListener('scroll', function () {
    const y = helpBody.scrollTop + 24;
    let active = helpSections[0].id;
    for (let i = 0; i < helpSections.length; i++) {
      if (helpSections[i].offsetTop <= y) active = helpSections[i].id;
    }
    markHelpSection(active);
  }, { passive: true });

  const zoomButtons = el('zoomGroup').children;
  for (let i = 0; i < zoomButtons.length; i++) {
    const zoom = zoomButtons[i].dataset.zoom;
    zoomButtons[i].onclick = function () {
      if (state.model.doc.view.zoom === zoom) return;
      const anchorX = timeline.width / 2;
      const anchorDay = timeline.xToDayFloat(anchorX);
      state.model.setView({ zoom: zoom });
      timeline.layout();
      timeline.scrollToDay(anchorDay, anchorX);
      requestRender();
    };
  }

  els.projectSelect.onchange = async function () {
    const name = els.projectSelect.value;
    await store.save(true);
    try {
      const doc = await store.load(name);
      openDoc(name, doc);
      history.replaceState(null, '', '?p=' + encodeURIComponent(name));
      if (chat) await chat.onProjectChange();
    } catch (err) {
      warn(String(err.message || err));
    }
  };

  // Panel field bindings.
  bindText('fName', function (task, value) { return { name: value }; });
  bindText('fNotes', function (task, value) { return { notes: value }; });
  el('fDuration').onchange = function () {
    const task = cursorTask();
    if (!task) return;
    const n = Math.max(0, Math.round(parseFloat(el('fDuration').value) || 0));
    state.model.patchTask(task.id, { duration: n, milestone: n === 0 });
  };
  el('fPct').onchange = function () {
    const task = cursorTask();
    if (!task) return;
    state.model.patchTask(task.id, { pct: parseFloat(el('fPct').value) || 0 });
  };
  el('fStart').onchange = function () {
    const task = cursorTask();
    const row = cursorRow();
    if (!task) return;
    const day = parseDateInput(el('fStart').value, state.sched.start[row]);
    if (day === null) {
      warn('Not a date: ' + el('fStart').value);
      refreshPanel();
      return;
    }
    moveTask(task.id, row, day);
  };
  el('fMilestone').onchange = function () {
    const task = cursorTask();
    if (!task) return;
    const on = el('fMilestone').checked;
    state.model.patchTask(task.id, on ? { duration: 0, milestone: true } : { duration: 1, milestone: false });
  };
  el('fManual').onchange = function () {
    const task = cursorTask();
    if (!task) return;
    state.model.patchTask(task.id, { manual: el('fManual').checked });
  };
  el('fConstraint').onchange = function () {
    const task = cursorTask();
    const row = cursorRow();
    if (!task) return;
    const type = el('fConstraint').value;
    const date = type === 'ASAP' ? null : (task.constraint.date || toISO(state.sched.start[row]));
    state.model.patchTask(task.id, { constraint: { type: type, date: date } });
  };
  el('fConstraintDate').onchange = function () {
    const task = cursorTask();
    if (!task) return;
    const day = parseDateInput(el('fConstraintDate').value);
    if (day === null) {
      warn('Not a date: ' + el('fConstraintDate').value);
      refreshPanel();
      return;
    }
    state.model.patchTask(task.id, { constraint: { type: task.constraint.type, date: toISO(day) } });
  };
  el('predAdd').onclick = function () {
    const task = cursorTask();
    if (!task) return;
    const list = parsePredecessors(el('predInput').value);
    if (!list || !list.length) {
      warn('Use the form 12, 12SS or 12FS+2d');
      return;
    }
    for (let i = 0; i < list.length; i++) {
      if (!state.model.task(list[i].from)) {
        warn('No task with id ' + list[i].from);
        continue;
      }
      createLink(list[i].from, task.id, list[i].type, list[i].lag);
    }
    el('predInput').value = '';
  };
  el('predInput').onkeydown = function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      el('predAdd').click();
    }
  };

  // Settings bindings.
  el('sName').onchange = async function () {
    const raw = el('sName').value.trim();
    const name = raw.replace(/[^A-Za-z0-9 _.\-]/g, '').trim();
    if (!name) {
      el('sName').value = store.name;
      warn('That name cannot be used as a file name');
      return;
    }
    el('sName').value = name;
    if (name === store.name) {
      state.model.setName(name);
      document.title = name + ' - GanttLocal';
      return;
    }
    const previous = store.name;
    try {
      if (store.timer) {
        clearTimeout(store.timer);
        store.timer = 0;
      }
      await store.save(true);
      await store.rename(previous, name);
    } catch (err) {
      el('sName').value = previous;
      warn(String(err.message || err));
      return;
    }
    state.model.setName(name);
    document.title = name + ' - GanttLocal';
    fillProjects(await store.list(), name);
    history.replaceState(null, '', '?p=' + encodeURIComponent(name));
    const path = 'data/' + name + '.json';
    el('sPath').textContent = path;
    el('sPath').title = path;
    if (chat) await chat.onProjectChange();
  };
  el('sHolidays').onchange = function () {
    const list = el('sHolidays').value.split(/[\r\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    const clean = [];
    for (let i = 0; i < list.length; i++) {
      const day = parseDateInput(list[i]);
      if (day === null) {
        warn('Ignored holiday: ' + list[i]);
        continue;
      }
      clean.push(toISO(day));
    }
    state.model.setCalendar({ holidays: clean });
    el('sHolidays').value = holidayText(state.model.doc);
  };
  el('sDateFormat').onchange = function () {
    state.model.setView({ dateFormat: el('sDateFormat').value });
    el('sHolidays').value = holidayText(state.model.doc);
    requestRender();
  };
  el('sCompact').onchange = function () {
    state.model.setView({ compact: el('sCompact').checked });
    applyMetrics();
    grid.invalidate();
    timeline.layout();
    requestRender();
  };
  el('sCritical').onchange = function () {
    state.model.setView({ showCritical: el('sCritical').checked });
    requestRender();
  };
  el('sDark').onchange = function () {
    applyTheme(el('sDark').checked ? 'dark' : 'light', true);
    requestRender();
  };
  el('sGpu').onchange = function () {
    el('sGpuLayers').disabled = !el('sGpu').checked;
    saveAssistantSettings();
  };
  el('sGpuLayers').onchange = function () { saveAssistantSettings(); };
  el('sAddCol').onclick = function () {
    const raw = el('sNewCol').value.trim();
    if (!raw) return;
    if (!state.model.addColumn(raw.replace(/\s+/g, ''), raw, el('sNewColType').value)) {
      warn('That field already exists');
      return;
    }
    el('sNewCol').value = '';
    openSettings();
  };
  el('sExport').onclick = function () { exportFile(store.name, state.model.doc); };
  el('sExportHtml').onclick = async function () {
    await store.save(true);
    try {
      await exportHtml(store.name);
    } catch (err) {
      warn(String(err.message || err));
    }
  };
  el('sImport').onclick = async function () {
    let picked;
    try {
      picked = await importFile();
    } catch (err) {
      warn('Not a valid JSON file');
      return;
    }
    if (!picked) return;
    const name = picked.name.replace(/[^A-Za-z0-9 _.\-]/g, '').trim() || 'Imported';
    try {
      await store.create(name, picked.doc);
      fillProjects(await store.list(), name);
      openDoc(name, await store.load(name));
      if (chat) await chat.onProjectChange();
      els.dialog.close();
    } catch (err) {
      warn(String(err.message || err));
    }
  };

  // Wheel over the grid drives the shared vertical scroll.
  els.body.addEventListener('wheel', function (event) {
    if (event.ctrlKey) return;
    if (event.shiftKey) return;
    els.scroll.scrollTop += event.deltaMode === 1 ? event.deltaY * state.metrics.rowH : event.deltaY;
    event.preventDefault();
  }, { passive: false });

  // Splitter.
  els.splitter.addEventListener('mousedown', function (event) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = els.gridPane.clientWidth;
    let dragging = false;
    function move(e) {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < 3) return;
        dragging = true;
      }
      const w = Math.max(140, Math.min(startW + e.clientX - startX, window.innerWidth - 220));
      document.documentElement.style.setProperty('--grid-w', w + 'px');
      timeline.resize();
      timeline.layout();
      grid.render();
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragging) state.model.setView({ gridWidth: els.gridPane.clientWidth });
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  els.splitter.addEventListener('dblclick', function (event) {
    event.preventDefault();
    fitGridPaneToContent();
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', function () {
    timeline.resize();
    timeline.layout();
    requestRender();
  });
  window.addEventListener('beforeunload', function (event) {
    if (state.viewOnly) return;
    if (state.model && state.model.dirty) {
      store.save(false);
      event.preventDefault();
      event.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', function () {
    if (state.viewOnly) return;
    if (document.visibilityState === 'hidden' && state.model && state.model.dirty) store.save(false);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      timeline.resize();
      timeline.layout();
      grid.render();
    }).observe(els.pane);
  }

  // Held open for as long as this window lives. The launcher stops the server
  // when the last one disappears; nothing else uses the connection.
  if (!state.viewOnly && window.EventSource) {
    try {
      new EventSource('api/session');
    } catch (err) {
      /* server started without --auto-exit, nothing to keep alive */
    }
  }

  els.body.focus();
}

function bindText(id, build) {
  const node = el(id);
  const commit = function () {
    const task = cursorTask();
    if (!task) return;
    state.model.patchTask(task.id, build(task, node.value), id + task.id);
  };
  node.onchange = commit;
}

function onKeyDown(event) {
  const target = document.activeElement;
  const tag = target ? target.tagName : '';
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (event.key === 'F1') {
    event.preventDefault();
    openHelp(null);
    return;
  }

  if (event.key === 'F4') {
    event.preventDefault();
    setPanel(els.panel.hidden);
    return;
  }

  if (event.ctrlKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      if (!state.viewOnly) store.save(true);
      return;
    }
    if (inField) return;
    if (state.viewOnly) return;
    if (key === 'a') {
      event.preventDefault();
      state.sel.clear();
      for (let i = 0; i < state.rows.length; i++) {
        state.sel.add(state.model.doc.tasks[state.rows[i]].id);
      }
      requestRender();
      return;
    }
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) state.model.redo();
      else state.model.undo();
      requestRender();
      return;
    }
    if (key === 'y') {
      event.preventDefault();
      state.model.redo();
      requestRender();
      return;
    }
    if (key === 'l') {
      event.preventDefault();
      linkSelected();
      return;
    }
    return;
  }

  if (inField) return;

  if (event.key === '?') {
    event.preventDefault();
    openHelp(null);
    return;
  }

  if (state.viewOnly) return;
  if (document.querySelector('dialog[open]')) return;

  if (event.altKey && event.shiftKey) {
    if (event.key === 'ArrowRight') { event.preventDefault(); shiftLevel(1); return; }
    if (event.key === 'ArrowLeft') { event.preventDefault(); shiftLevel(-1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveRows(-1); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveRows(1); return; }
  }
  if (event.key === 'Insert') {
    event.preventDefault();
    addTask();
    return;
  }
  if (event.key === 'Delete') {
    event.preventDefault();
    deleteSelected();
    return;
  }
}
