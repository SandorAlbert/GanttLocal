// Assertions for the date, calendar, scheduling and outline logic.
// Runs in the browser via tests/tests.html and in Node via `node js/tests.mjs`.

import { Model, normalize, createProject } from './model.js';
import {
  compute, toDay, toISO, formatDay, parseDateInput, dayOfWeek, buildCalendar,
  formatPredecessors, parsePredecessors, isoWeek, HEALTH
} from './schedule.js';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) passed++;
  else failures.push(name + ': got ' + a + ', expected ' + b);
}

function ok(name, value) {
  check(name, !!value, true);
}

/** Builds a normalized document from a compact description. */
function doc(tasks, links, extra) {
  return normalize(Object.assign({
    name: 'T',
    calendar: { workDays: [1, 2, 3, 4, 5], holidays: [] },
    tasks: tasks,
    links: links || []
  }, extra || {}));
}

function dates(result, field) {
  const out = [];
  for (let i = 0; i < result[field].length; i++) out.push(toISO(result[field][i]));
  return out;
}

// --- dates ---------------------------------------------------------------

check('toDay epoch', toDay('1970-01-01'), 0);
check('toISO round trip', toISO(toDay('2026-08-19')), '2026-08-19');
check('leap day', toISO(toDay('2028-02-29')), '2028-02-29');
check('reject bad day', toDay('2026-02-30'), null);
check('reject junk', toDay('19.08.2026'), null);
check('weekday wednesday', dayOfWeek(toDay('2026-08-19')), 3);
check('weekday sunday', dayOfWeek(toDay('2026-08-23')), 0);
check('parse iso', toISO(parseDateInput('2026-08-19')), '2026-08-19');
check('parse german', toISO(parseDateInput('19.08.2026')), '2026-08-19');
check('parse short year', toISO(parseDateInput('19.8.26')), '2026-08-19');
check('parse day month', toISO(parseDateInput('1.9.', toDay('2026-08-19'))), '2026-09-01');
check('parse slash', toISO(parseDateInput('19/08/2026')), '2026-08-19');
check('parse junk', parseDateInput('tomorrow'), null);
check('iso week', isoWeek(toDay('2026-08-19')), 34);
check('display dmy', formatDay(toDay('2026-08-19'), 'dmy'), '19.08.2026');
check('display dmy pads', formatDay(toDay('2026-01-02'), 'dmy'), '02.01.2026');
check('display iso', formatDay(toDay('2026-08-19'), 'iso'), '2026-08-19');
check('dmy is the default display format', normalize({}).view.dateFormat, 'dmy');
check('an explicit iso setting is kept', normalize({ view: { dateFormat: 'iso' } }).view.dateFormat, 'iso');

// --- working-day calendar ------------------------------------------------

const cal = buildCalendar([1, 2, 3, 4, 5], ['2026-08-26'], toDay('2026-08-01'), toDay('2026-10-01'));
check('friday plus one workday is monday',
  toISO(cal.add(toDay('2026-08-21'), 1)), '2026-08-24');
check('skips the holiday',
  toISO(cal.add(toDay('2026-08-25'), 1)), '2026-08-27');
check('snap forward over weekend',
  toISO(cal.next(toDay('2026-08-22'))), '2026-08-24');
check('snap backward over weekend',
  toISO(cal.prev(toDay('2026-08-23'))), '2026-08-21');
check('inclusive span of one week', cal.span(toDay('2026-08-17'), toDay('2026-08-21')), 5);
check('span skipping weekend and holiday',
  cal.span(toDay('2026-08-24'), toDay('2026-08-28')), 4);
check('negative add', toISO(cal.add(toDay('2026-08-24'), -1)), '2026-08-21');

const calCacheDoc = doc([{ id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 }]);
const beforeHoliday = compute(calCacheDoc);
check('five-day task finishes Friday', dates(beforeHoliday, 'finish'), ['2026-08-28']);
calCacheDoc.calendar.holidays.push('2026-08-26');
const afterHoliday = compute(calCacheDoc);
check('in-place holiday invalidates calendar cache', dates(afterHoliday, 'finish'), ['2026-08-31']);

// --- link types ----------------------------------------------------------

const chain = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 3 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FS' }]));
check('FS start', dates(chain, 'start'), ['2026-08-24', '2026-08-27']);
check('FS finish', dates(chain, 'finish'), ['2026-08-26', '2026-08-28']);

const lag = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 3 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FS', lag: 2 }]));
check('FS with lag crosses the weekend', dates(lag, 'start')[1], '2026-08-31');

const negative = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FS', lag: -2 }]));
check('FS with negative lag overlaps', dates(negative, 'start')[1], '2026-08-27');

const ss = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'SS', lag: 3 }]));
check('SS with lag', dates(ss, 'start')[1], '2026-08-27');

const ff = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FF' }]));
check('FF aligns finishes', dates(ff, 'finish')[1], dates(ff, 'finish')[0]);
check('FF derives the start', dates(ff, 'start')[1], '2026-08-27');

const sf = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-09-07', duration: 5 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'SF' }]));
check('SF finishes at the predecessor start', dates(sf, 'finish')[1], '2026-09-07');

const milestone = compute(doc([
  { id: 1, level: 0, name: 'M', start: '2026-08-24', duration: 0, milestone: true },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FS' }]));
check('milestone successor starts the same day', dates(milestone, 'start'), ['2026-08-24', '2026-08-24']);
check('milestone finish equals start', dates(milestone, 'finish')[0], '2026-08-24');

// --- summaries -----------------------------------------------------------

const rolled = compute(doc([
  { id: 1, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 2, level: 1, name: 'A', start: '2026-08-25', duration: 3, pct: 100 },
  { id: 3, level: 1, name: 'B', start: '2026-09-01', duration: 2, pct: 0 }
]));
check('summary spans its children', [dates(rolled, 'start')[0], dates(rolled, 'finish')[0]],
  ['2026-08-25', '2026-09-02']);
check('summary is flagged', Array.from(rolled.summary), [1, 0, 0]);
check('summary duration in working days', rolled.span[0], 7);
check('summary percent is duration weighted', Math.round(rolled.pct[0]), 60);
check('wbs codes', rolled.wbs, ['1', '1.1', '1.2']);

const fromSummary = compute(doc([
  { id: 1, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 2, level: 1, name: 'A', start: '2026-08-24', duration: 3 },
  { id: 3, level: 1, name: 'B', start: '2026-08-24', duration: 2 },
  { id: 4, level: 0, name: 'Next', start: '2026-08-24', duration: 1 }
], [{ from: 1, to: 4, type: 'FS' }]));
check('successor of a summary follows its rolled up finish',
  dates(fromSummary, 'start')[3], '2026-08-27');

const intoSummary = compute(doc([
  { id: 1, level: 0, name: 'Kickoff', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 3, level: 1, name: 'A', start: '2026-08-24', duration: 3 },
  { id: 4, level: 1, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FS' }]));
check('a link into a summary pushes its children',
  [dates(intoSummary, 'start')[2], dates(intoSummary, 'start')[3]], ['2026-08-26', '2026-08-26']);
check('child keeps its own later date when the parent floor is earlier',
  dates(compute(doc([
    { id: 1, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
    { id: 2, level: 1, name: 'A', start: '2026-09-07', duration: 2 }
  ])), 'start')[1], '2026-09-07');

const ignored = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 3, level: 1, name: 'B', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 2, type: 'FF' }]));
check('FF into a summary is reported', ignored.problems.length, 1);

// --- constraints and manual scheduling -----------------------------------

const snet = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2, constraint: { type: 'SNET', date: '2026-09-07' } }
], [{ from: 1, to: 2, type: 'FS' }]));
check('SNET wins over the predecessor', dates(snet, 'start')[1], '2026-09-07');

const mso = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 10 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2, constraint: { type: 'MSO', date: '2026-08-26' } }
], [{ from: 1, to: 2, type: 'FS' }]));
check('MSO pins the start', dates(mso, 'start')[1], '2026-08-26');
check('MSO conflict is reported', mso.problems.length, 1);

const fnlt = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 10, constraint: { type: 'FNLT', date: '2026-08-28' } }
]));
check('FNLT violation is reported', fnlt.problems.length, 1);

const manual = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2, manual: true }
], [{ from: 1, to: 2, type: 'FS' }]));
check('a manual task ignores its predecessor', dates(manual, 'start')[1], '2026-08-24');

// --- cycles --------------------------------------------------------------

const cyclic = compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 },
  { id: 3, level: 0, name: 'C', start: '2026-08-24', duration: 2 }
], [
  { from: 1, to: 2, type: 'FS' },
  { from: 2, to: 3, type: 'FS' },
  { from: 3, to: 1, type: 'FS' }
]));
check('cycle members are listed', cyclic.cycleIds.size, 3);
ok('cycle is reported', cyclic.problems.length > 0);
ok('cyclic tasks still get dates', cyclic.finish[0] >= cyclic.start[0]);

// --- critical path -------------------------------------------------------

const cp = compute(doc([
  { id: 1, level: 0, name: 'Start', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'Long', start: '2026-08-24', duration: 10 },
  { id: 3, level: 0, name: 'Short', start: '2026-08-24', duration: 3 },
  { id: 4, level: 0, name: 'End', start: '2026-08-24', duration: 2 }
], [
  { from: 1, to: 2, type: 'FS' },
  { from: 1, to: 3, type: 'FS' },
  { from: 2, to: 4, type: 'FS' },
  { from: 3, to: 4, type: 'FS' }
]));
check('critical flags follow the long branch', Array.from(cp.critical), [1, 1, 0, 1]);
check('slack on the critical chain is zero', [cp.slack[0], cp.slack[1], cp.slack[3]], [0, 0, 0]);
check('the short branch has slack', cp.slack[2], 7);

// --- health (progress against the clock) ---------------------------------

// Thursday. A Monday-to-Friday task that started on the 24th has spent 3 of
// its 5 days, so 60% is the pace it should be keeping.
const now = toDay('2026-08-27');

function healthOf(pct) {
  return compute(doc([
    { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5, pct: pct }
  ]), now).health[0];
}

check('expected pace counts working days only', Math.round(compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 5 }
]), now).expected[0]), 60);
check('untouched work mid-run is behind', healthOf(0), HEALTH.late);
check('a little short of the pace is at risk', healthOf(55), HEALTH.risk);
check('exactly on the pace is on track', healthOf(60), HEALTH.track);
check('ahead of the pace is on track', healthOf(80), HEALTH.track);
check('finished work is done', healthOf(100), HEALTH.done);

check('work that has not begun yet is neutral', compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-09-07', duration: 2 }
]), now).health[0], HEALTH.none);
check('an unfinished task past its finish is behind', compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-17', duration: 5, pct: 50 }
]), now).health[0], HEALTH.late);
check('a late finish still counts as done', compute(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-17', duration: 5, pct: 100 }
]), now).health[0], HEALTH.done);

check('a missed milestone is behind', compute(doc([
  { id: 1, level: 0, name: 'M', start: '2026-08-25', duration: 0, milestone: true }
]), now).health[0], HEALTH.late);
check('a future milestone is neutral', compute(doc([
  { id: 1, level: 0, name: 'M', start: '2026-09-07', duration: 0, milestone: true }
]), now).health[0], HEALTH.none);

const rolledHealth = compute(doc([
  { id: 1, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 2, level: 1, name: 'A', start: '2026-08-24', duration: 5, pct: 100 },
  { id: 3, level: 1, name: 'B', start: '2026-08-24', duration: 5, pct: 0 }
]), now);
check('a summary is judged on its rolled up numbers',
  [rolledHealth.pct[0], rolledHealth.health[0]], [50, HEALTH.risk]);
check('and its children keep their own verdicts',
  [rolledHealth.health[1], rolledHealth.health[2]], [HEALTH.done, HEALTH.late]);

// --- outline editing -----------------------------------------------------

const model = new Model(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 },
  { id: 3, level: 0, name: 'C', start: '2026-08-24', duration: 2 }
], [{ from: 1, to: 3, type: 'FS' }]));

model.shiftLevels([2], 1);
check('indent', model.doc.tasks.map(function (t) { return t.level; }), [0, 1, 0]);
model.shiftLevels([2], 1);
check('cannot indent twice under the same parent',
  model.doc.tasks.map(function (t) { return t.level; }), [0, 1, 0]);
model.shiftLevels([2], -1);
check('outdent', model.doc.tasks.map(function (t) { return t.level; }), [0, 0, 0]);
model.undo();
check('undo restores the indent', model.doc.tasks.map(function (t) { return t.level; }), [0, 1, 0]);
model.redo();
check('redo replays the outdent', model.doc.tasks.map(function (t) { return t.level; }), [0, 0, 0]);

// Undo must not alias into live rows: merged patches COW once, then edit in place.
const hist = new Model(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
]));
const beforeTasks = hist.doc.tasks;
hist.patchTask(1, { name: 'A1' }, 'name1');
const afterFirst = hist.doc.tasks;
hist.patchTask(1, { name: 'A2' }, 'name1');
hist.patchTask(1, { name: 'A3' }, 'name1');
check('merged patches collapse to one history entry', hist.past.length, 1);
check('merged patches leave the final value', hist.task(1).name, 'A3');
ok('first patch COWs the tasks array', afterFirst !== beforeTasks);
ok('merged follow-ups reuse the owned tasks array', hist.doc.tasks === afterFirst);
hist.undo();
check('undo restores the pre-merge name', hist.task(1).name, 'A');
ok('undo restores the snapshotted tasks array', hist.doc.tasks === beforeTasks);
hist.redo();
check('redo restores the merged final name', hist.task(1).name, 'A3');
ok('redo restores the post-merge tasks array', hist.doc.tasks === afterFirst);
hist.undo();
const snapRow = hist.doc.tasks[0];
hist.patchTask(1, { name: 'Z' });
ok('edit after undo COWs away from the undo snapshot', hist.doc.tasks !== beforeTasks);
check('history snapshot row stays pristine', snapRow.name, 'A');
hist.undo();
check('undo after a later edit restores the pre-merge name', hist.task(1).name, 'A');
hist.redo();
check('redo restores the post-undo edit', hist.task(1).name, 'Z');
hist.patchTask(2, { duration: 9 }, 'dur2');
hist.undo();
check('undo after a later edit restores duration', hist.task(2).duration, 2);
check('and keeps the prior redoable name', hist.task(1).name, 'Z');

// Name-only edits share the tasks array with history; the next row patch must COW.
const share = new Model(doc([{ id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 }]));
share.setName('Project');
const sharedTasks = share.doc.tasks;
ok('name edit leaves tasks shared with history', share.past[0].tasks === sharedTasks);
share.patchTask(1, { name: 'B' });
ok('row patch COWs after a shared name snapshot', share.doc.tasks !== sharedTasks);
check('shared history row is unchanged', share.past[0].tasks[0].name, 'A');
share.undo();
check('undo restores the name-edit era task', share.task(1).name, 'A');

const batch = new Model(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
]));
batch.transact(function () {
  batch.patchTask(1, { name: 'X' });
  batch.patchTask(2, { duration: 9 });
  batch.insertTask(2, 0, { name: 'C', duration: 1 });
});
check('transact collapses several mutations to one history entry', batch.past.length, 1);
check('transact applied every nested edit', [
  batch.task(1).name, batch.task(2).duration, batch.doc.tasks.length
], ['X', 9, 3]);
batch.undo();
check('undo restores the pre-transact document', [
  batch.task(1).name, batch.task(2).duration, batch.doc.tasks.length
], ['A', 2, 2]);
batch.redo();
check('redo restores the whole transact', [
  batch.task(1).name, batch.task(2).duration, batch.doc.tasks.length
], ['X', 9, 3]);
const emptyBatch = new Model(doc([
  { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 }
]));
emptyBatch.transact(function () { emptyBatch.patchTask(99, { name: 'nope' }); });
check('empty transact does not push history', emptyBatch.past.length, 0);

model.moveRows([3], -1);
check('move up swaps siblings', model.doc.tasks.map(function (t) { return t.id; }), [1, 3, 2]);
model.moveRows([3], 1);
check('move down restores order', model.doc.tasks.map(function (t) { return t.id; }), [1, 2, 3]);

const outline = new Model(doc([
  { id: 1, level: 0, name: 'Phase 1', start: '2026-08-24', duration: 1 },
  { id: 2, level: 1, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 3, level: 1, name: 'B', start: '2026-08-24', duration: 2 },
  { id: 4, level: 0, name: 'Phase 2', start: '2026-08-24', duration: 1 },
  { id: 5, level: 1, name: 'C', start: '2026-08-24', duration: 2 }
]));
outline.moveRows([1], 1);
check('moving a summary takes its children and clears the next sibling block',
  outline.doc.tasks.map(function (t) { return t.id; }), [4, 5, 1, 2, 3]);
check('levels survive the move', outline.doc.tasks.map(function (t) { return t.level; }), [0, 1, 0, 1, 1]);
outline.moveRows([1], -1);
check('moving back restores the order', outline.doc.tasks.map(function (t) { return t.id; }), [1, 2, 3, 4, 5]);
check('a child cannot pass its parent', outline.moveRows([2], -1), false);
outline.moveRows([2], 1);
check('children reorder inside the parent', outline.doc.tasks.map(function (t) { return t.id; }), [1, 3, 2, 4, 5]);
check('moving several rows at once is refused', outline.moveRows([2, 3], 1), false);

const dateSorted = new Model(doc([
  { id: 1, level: 0, name: 'Late phase', start: '2026-09-10', duration: 1 },
  { id: 2, level: 1, name: 'Later child', start: '2026-09-03', duration: 1 },
  { id: 3, level: 1, name: 'Earlier child', start: '2026-09-01', duration: 1 },
  { id: 4, level: 0, name: 'Early phase', start: '2026-08-20', duration: 1 },
  { id: 5, level: 1, name: 'Phase child', start: '2026-08-12', duration: 1 },
  { id: 6, level: 0, name: 'Middle task', start: '2026-08-25', duration: 1 }
]));
dateSorted.sortByDate(new Map([[1, 10], [2, 3], [3, 1], [4, 2], [5, 0], [6, 5]]));
check('date sort orders sibling subtrees recursively',
  dateSorted.doc.tasks.map(function (t) { return t.id; }), [4, 5, 6, 1, 3, 2]);
check('date sort keeps hierarchy levels',
  dateSorted.doc.tasks.map(function (t) { return t.level; }), [0, 1, 0, 0, 1, 1]);
dateSorted.undo();
check('undo restores the pre-sort outline',
  dateSorted.doc.tasks.map(function (t) { return t.id; }), [1, 2, 3, 4, 5, 6]);

const cascade = new Model(doc([
  { id: 1, level: 0, name: 'Phase', start: '2026-08-24', duration: 1 },
  { id: 2, level: 1, name: 'A', start: '2026-08-24', duration: 2 },
  { id: 3, level: 1, name: 'B', start: '2026-08-24', duration: 2 },
  { id: 4, level: 0, name: 'C', start: '2026-08-24', duration: 2 }
], [{ from: 2, to: 4, type: 'FS' }]));
cascade.deleteIds([1]);
check('deleting a summary removes its children',
  cascade.doc.tasks.map(function (t) { return t.id; }), [4]);
check('deleting drops the orphaned links', cascade.doc.links.length, 0);

const dup = new Model(doc([{ id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 }]));
const newId = dup.insertTask(1, 0);
check('insert allocates a fresh id', newId, 2);
check('insert lands below', dup.doc.tasks.length, 2);

const placed = new Model(doc([{ id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 }]));
const placedId = placed.insertTask(1, 0, {
  start: '2026-09-01', duration: 5, constraint: { type: 'SNET', date: '2026-09-01' }
});
check('insert extras start', placed.task(placedId).start, '2026-09-01');
check('insert extras duration', placed.task(placedId).duration, 5);
check('insert extras constraint', placed.task(placedId).constraint.type, 'SNET');

check('addLink refuses duplicates',
  [model.addLink(1, 3, 'FS', 0), model.doc.links.length], [false, 1]);
check('predecessor text', formatPredecessors(model, 3), '1');
check('predecessor text with type and lag',
  formatPredecessors(new Model(doc([
    { id: 1, level: 0, name: 'A', start: '2026-08-24', duration: 2 },
    { id: 2, level: 0, name: 'B', start: '2026-08-24', duration: 2 }
  ], [{ from: 1, to: 2, type: 'SS', lag: -2 }])), 2), '1SS-2d');
check('parse predecessors', parsePredecessors('3, 4SS+2d, 5FF-1d'), [
  { from: 3, type: 'FS', lag: 0 },
  { from: 4, type: 'SS', lag: 2 },
  { from: 5, type: 'FF', lag: -1 }
]);
check('parse predecessors rejects junk', parsePredecessors('3, abc'), null);

// --- normalization -------------------------------------------------------

const repaired = normalize({
  tasks: [
    { id: 1, level: 5, name: 'A', start: 'nonsense', duration: -3 },
    { id: 1, level: 9, name: 'dup id', duration: 2.6 },
    { id: 3, level: 1, name: 'C', duration: 1, milestone: true }
  ],
  links: [
    { from: 1, to: 1, type: 'FS' },
    { from: 1, to: 3, type: 'XX' },
    { from: 1, to: 3, type: 'FS' },
    { from: 9, to: 3, type: 'FS' }
  ]
});
check('levels are clamped to legal outline',
  repaired.tasks.map(function (t) { return t.level; }), [0, 1, 1]);
check('duplicate ids are reassigned',
  repaired.tasks.map(function (t) { return t.id; }), [1, 2, 3]);
check('durations are cleaned', repaired.tasks.map(function (t) { return t.duration; }), [0, 3, 0]);
check('self links, unknown ids and duplicates are dropped', repaired.links.length, 1);
check('unknown link types fall back to FS', repaired.links[0].type, 'FS');
check('a fresh project is valid', createProject('X').tasks.length, 1);

// --- scale ---------------------------------------------------------------
// Synthetic phased graphs: 1 summary + 9 chained leaves per phase.
// 20/50/80 phases → 200 / 500 / 800 rows (matches Stress ~506 and RNA ~793).
// Budgets catch catastrophic regressions; they leave headroom for CI-ish machines.
// Do not weaken the 200-task / 8 ms frame budget.

/** @returns {{ doc: object, n: number }} */
function buildPhasedScale(phases) {
  const kids = 9;
  const stride = kids + 1;
  const tasks = [];
  const links = [];
  for (let phase = 0; phase < phases; phase++) {
    const base = phase * stride;
    tasks.push({ id: base + 1, level: 0, name: 'Phase ' + phase, start: '2026-08-24', duration: 1 });
    for (let k = 1; k <= kids; k++) {
      const id = base + 1 + k;
      tasks.push({ id: id, level: 1, name: 'Task ' + id, start: '2026-08-24', duration: 2, pct: k * 10 });
      if (k > 1) links.push({ from: id - 1, to: id, type: 'FS', lag: 0 });
    }
    if (phase > 0) links.push({ from: (phase - 1) * stride + 1, to: base + 1, type: 'FS', lag: 0 });
  }
  return doc(tasks, links);
}

/**
 * Warm once, then average `iters` computes. Returns { ms, result }.
 * Budgets are absolute ms ceilings (not relative to this machine).
 */
function benchCompute(document, iters) {
  compute(document);
  let result = null;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) result = compute(document);
  return { ms: (performance.now() - t0) / iters, result: result };
}

const scaleTimings = [];

const big = buildPhasedScale(20);
check('200 rows', big.tasks.length, 200);
const bench200 = benchCompute(big, 20);
const perCompute = bench200.ms;
scaleTimings.push({ n: 200, ms: perCompute, budget: 8 });
ok('200 tasks reschedule in well under a frame (' + perCompute.toFixed(2) + ' ms)', perCompute < 8);
check('no problems at scale', bench200.result.problems.length, 0);
check('every phase is critical', Array.from(bench200.result.critical).filter(function (v) { return v; }).length, 200);
check('json round trip is stable',
  JSON.stringify(normalize(JSON.parse(JSON.stringify(big)))), JSON.stringify(big));

// Stress-scale (~500) — measured ~0.3–0.5 ms on a fast desktop; 25 ms ≈ 50× headroom.
const mid = buildPhasedScale(50);
check('500 rows', mid.tasks.length, 500);
const bench500 = benchCompute(mid, 12);
scaleTimings.push({ n: 500, ms: bench500.ms, budget: 25 });
ok('500 tasks (Stress scale) reschedule under budget (' + bench500.ms.toFixed(2) + ' ms)', bench500.ms < 25);
check('no problems at 500', bench500.result.problems.length, 0);
check('500-scale result length', bench500.result.start.length, 500);

// RNA-scale (~800) — measured ~0.4–0.6 ms; 40 ms catches O(n²) blowups without CI flakes.
const large = buildPhasedScale(80);
check('800 rows', large.tasks.length, 800);
const bench800 = benchCompute(large, 8);
scaleTimings.push({ n: 800, ms: bench800.ms, budget: 40 });
ok('800 tasks (RNA scale) reschedule under budget (' + bench800.ms.toFixed(2) + ' ms)', bench800.ms < 40);
check('no problems at 800', bench800.result.problems.length, 0);
check('800-scale result length', bench800.result.start.length, 800);

function formatScaleLine(t) {
  return 'reschedule of ' + t.n + ' tasks: ' + t.ms.toFixed(2) + ' ms (budget < ' + t.budget + ' ms)';
}
const scaleReport = scaleTimings.map(formatScaleLine).join('\n');

// --- report --------------------------------------------------------------

const summary = failures.length
  ? failures.length + ' of ' + (passed + failures.length) + ' checks failed'
  : 'all ' + passed + ' checks passed';

if (typeof document !== 'undefined') {
  const out = document.createElement('pre');
  out.textContent = summary + (failures.length ? '\n\n' + failures.join('\n') : '') +
    '\n\n' + scaleReport;
  out.style.color = failures.length ? '#c0392b' : '#111';
  document.body.appendChild(out);
} else {
  console.log(summary);
  if (failures.length) {
    console.log(failures.join('\n'));
    process.exitCode = 1;
  }
  console.log(scaleReport);
}
