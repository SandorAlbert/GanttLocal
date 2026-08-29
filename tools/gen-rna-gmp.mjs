// Builds data/RNA GMP Program.json — large realistic GMP / RNA / change-control demo.
import { writeFileSync } from 'node:fs';
import { normalize } from '../js/model.js';
import { compute, toISO, toDay, todayDay } from '../js/schedule.js';

const OWNERS = {
  GOV: ['KLM', 'JRP'],
  QA: ['QAS', 'MST'],
  CC: ['AWC', 'DLH'],
  VAL: ['VAL', 'SRV'],
  RNA: ['PNV', 'BIO'],
  FAC: ['ENG', 'CST'],
  QC: ['ANL', 'QC1'],
  RA: ['REG', 'DOC']
};

const CC_TEMPLATES = [
  'CC-%ID% Initiation and scope definition',
  'CC-%ID% Impact assessment (quality/regulatory)',
  'CC-%ID% Risk evaluation and mitigation plan',
  'CC-%ID% Affected SOP and form revision',
  'CC-%ID% Validation / verification protocol',
  'CC-%ID% Execution and raw data package',
  'CC-%ID% QA review and effectiveness check',
  'CC-%ID% Closure and trend entry'
];

const RNA_DS_TASKS = [
  'Plasmid template release and chain of custody',
  'In vitro transcription (IVT) parameter set',
  'IVT engineering run %N%',
  'dsRNA clearance and digest study',
  'TFF ultrafiltration/diafiltration cycle',
  'Oligo dT capture chromatography',
  'Anion exchange polish chromatography',
  'Bulk dsRNA drug substance hold study',
  'Drug substance container closure selection',
  'Drug substance stability protocol draft'
];

const RNA_DP_TASKS = [
  'LNP formulation design of experiments',
  'Encapsulation efficiency method development',
  'Sterile filtration process simulation',
  'Visual inspection qualification',
  'Labeling and serialization readiness',
  'Drug product fill line readiness review',
  'Cold chain shipping qualification',
  'Drug product stability campaign launch'
];

const GMP_TASKS = [
  'GDP data integrity assessment',
  'Deviation and CAPA trend review',
  'Annual product quality review prep',
  'Internal GMP audit schedule',
  'Supplier quality agreement renewal',
  'Batch record lifecycle review',
  'Training matrix and curricula update',
  'Environmental monitoring trend report',
  'Calibration program gap assessment',
  'Quality management review minutes'
];

let id = 0;
const tasks = [];
const links = [];
const taskByKey = new Map();

function ownerFor(area) {
  const pool = OWNERS[area] || OWNERS.GOV;
  return pool[id % pool.length];
}

function task(name, level, duration, extra = {}) {
  id++;
  const t = {
    id,
    level,
    name,
    start: extra.start || toISO(todayDay() - 60),
    duration: duration,
    milestone: duration === 0,
    manual: false,
    collapsed: extra.collapsed === true,
    pct: extra.pct !== undefined ? extra.pct : 0,
    constraint: extra.constraint || { type: 'ASAP', date: null },
    notes: extra.notes || '',
    meta: Object.assign({
      owner: extra.owner || ownerFor(extra.area || 'GOV'),
      area: extra.area || 'GOV',
      risk: extra.risk || 'Medium'
    }, extra.meta || {})
  };
  tasks.push(t);
  if (extra.key) taskByKey.set(extra.key, id);
  return id;
}

function link(from, to, type = 'FS', lag = 0) {
  links.push({ from, to, type, lag });
}

function chain(ids, type = 'FS', lag = 0) {
  for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], type, lag);
}

function addStream(streamName, area, items, opts = {}) {
  const streamLevel = opts.streamLevel !== undefined ? opts.streamLevel : 1;
  const taskLevel = streamLevel + 1;
  const dur = opts.dur !== undefined ? opts.dur : 5;
  const streamId = task(streamName, streamLevel, 1, { area, collapsed: false, pct: 0 });
  const ids = [];
  for (let i = 0; i < items.length; i++) {
    const name = typeof items[i] === 'string' ? items[i] : items[i].name;
    const d = typeof items[i] === 'object' ? items[i].dur : dur;
    const pct = typeof items[i] === 'object' ? (items[i].pct || 0) : (opts.pct || 0);
    ids.push(task(name, taskLevel, d, {
      area,
      pct,
      risk: typeof items[i] === 'object' ? items[i].risk : undefined,
      constraint: typeof items[i] === 'object' ? items[i].constraint : undefined
    }));
  }
  chain(ids, opts.linkType || 'FS', opts.lag || 0);
  return { streamId, ids };
}

function ccId(n) {
  return '2026-' + String(n).padStart(3, '0');
}

// --- program structure ---------------------------------------------------

const phaseGate = [];

// 1. Governance
task('RNA GMP facility program', 0, 1, { area: 'GOV', collapsed: false, pct: 15, key: 'root' });

task('Program governance', 0, 1, { area: 'GOV', collapsed: true, pct: 40 });
const gov = addStream('Governance and IMP', 'GOV', [
  'Program charter and scope baseline',
  'Integrated master plan (IMP) approval',
  'Stage-gate definition and KPIs',
  'Program risk register v1',
  'Monthly governance board cadence',
  'Budget and resource loading model',
  'Communication plan (internal/external)',
  { name: 'Program baseline milestone', dur: 0, pct: 100 }
], { dur: 4 });
phaseGate.push(gov.ids[gov.ids.length - 1]);

// 2. GMP quality system
const gmpPhase = task('GMP quality system', 0, 1, { area: 'QA', collapsed: true, pct: 22 });
const gmpStreams = [];
for (let s = 0; s < 6; s++) {
  const names = GMP_TASKS.map(function (t, i) { return t + ' (cycle ' + (s + 1) + ')'; });
  gmpStreams.push(addStream('QA stream ' + (s + 1), 'QA', names, { dur: 6, pct: s < 2 ? 100 : s < 4 ? 55 : 0 }));
}
link(phaseGate[0], gmpStreams[0].ids[0], 'FS', 5);
for (let s = 1; s < gmpStreams.length; s++) {
  link(gmpStreams[s - 1].ids[4], gmpStreams[s].ids[0], 'FS', 2);
}

// 3. Change control program (large)
task('Change control program', 0, 1, { area: 'CC', collapsed: true, pct: 18 });
const ccStreams = [];
const ccCategories = [
  ['CC system and procedures', 'CC'],
  ['Manufacturing process changes', 'RNA'],
  ['Facility and utilities changes', 'FAC'],
  ['Computerized system changes', 'VAL'],
  ['Analytical method changes', 'QC'],
  ['Documentation and labeling', 'RA'],
  ['Temporary changes and extensions', 'CC'],
  ['Major regulatory changes', 'RA']
];

let ccNum = 1;
for (let c = 0; c < ccCategories.length; c++) {
  const cat = ccCategories[c][0];
  const area = ccCategories[c][1];
  const items = [];
  for (let b = 0; b < 6; b++) {
    const cid = ccId(ccNum++);
    for (let t = 0; t < CC_TEMPLATES.length; t++) {
      items.push({
        name: CC_TEMPLATES[t].replace(/%ID%/g, cid),
        dur: t === 0 ? 3 : t === CC_TEMPLATES.length - 1 ? 0 : 5,
        pct: c === 0 && b === 0 && t < 4 ? 100 : c < 2 && t < 2 ? 40 : 0,
        risk: t === 2 ? 'High' : t === 5 ? 'Medium' : 'Low'
      });
    }
  }
  ccStreams.push(addStream(cat, area, items, { dur: 4, lag: 1 }));
}
link(gmpStreams[0].ids[2], ccStreams[0].ids[0], 'FS', 0);
for (let c = 1; c < ccStreams.length; c++) {
  link(ccStreams[c - 1].ids[2], ccStreams[c].ids[0], 'FS', 3);
}

// Cross-link change controls to GMP (many dependencies)
for (let c = 0; c < ccStreams.length; c++) {
  const ids = ccStreams[c].ids;
  link(gmpStreams[c % gmpStreams.length].ids[4], ids[2], 'FS', 3);
}

// 4. Facility & utilities
task('GMP facility and utilities', 0, 1, { area: 'FAC', collapsed: true, pct: 10 });
const facItems = [
  'Basis of design (BOD) sign-off',
  'Cleanroom classification and URS',
  'HVAC concept design review',
  'WFI generation and distribution URS',
  'Clean steam and process gases URS',
  'Material and personnel flow mapping',
  'Construction work package release',
  'HVAC installation and SAT',
  'Cleanroom certification (ISO 7/8)',
  'EM program qualification',
  'Utility PQ and ongoing monitoring',
  { name: 'Facility ready for equipment install', dur: 0, pct: 0 }
];
const fac = addStream('Facility CQV', 'FAC', facItems, { dur: 8 });
link(ccStreams[2].ids[10], fac.ids[0], 'FS', 10);
phaseGate.push(fac.ids[fac.ids.length - 1]);

// 5. RNA drug substance
task('RNA drug substance manufacturing', 0, 1, { area: 'RNA', collapsed: true, pct: 8 });
const dsStreams = [];
for (let s = 0; s < 8; s++) {
  const items = RNA_DS_TASKS.map(function (t) {
    return t.replace('%N%', '' + (s + 1));
  });
  items.push({ name: 'DS campaign ' + (s + 1) + ' release review', dur: 0, pct: 0 });
  dsStreams.push(addStream('DS line ' + (s + 1), 'RNA', items, {
    dur: 7,
    pct: s === 0 ? 35 : 0
  }));
}
link(fac.ids[fac.ids.length - 3], dsStreams[0].ids[0], 'FS', 5);
for (let s = 1; s < dsStreams.length; s++) {
  link(dsStreams[s - 1].ids[3], dsStreams[s].ids[0], 'FS', 8);
  link(dsStreams[s - 1].ids[7], dsStreams[s].ids[5], 'FS', 4);
}

// 6. RNA drug product
task('RNA drug product and fill-finish', 0, 1, { area: 'RNA', collapsed: true, pct: 5 });
const dpStreams = [];
for (let s = 0; s < 7; s++) {
  const items = RNA_DP_TASKS.concat([
    'PPQ protocol ' + (s + 1) + ' draft',
    'PPQ lot ' + (s + 1) + ' execution',
    { name: 'DP lot ' + (s + 1) + ' QP release', dur: 0, pct: 0 }
  ]);
  dpStreams.push(addStream('DP suite ' + (s + 1), 'RNA', items, { dur: 6 }));
}
link(dsStreams[2].ids[6], dpStreams[0].ids[0], 'FS', 0);
for (let s = 1; s < dpStreams.length; s++) {
  link(dpStreams[s - 1].ids[3], dpStreams[s].ids[0], 'FS', 4);
}
link(dsStreams[4].ids[8], dpStreams[0].ids[2], 'FS', 5);
link(dpStreams[0].ids[2], dpStreams[2].ids[6], 'FS', 5);

// 7. Analytical & QC
task('Analytical and QC laboratories', 0, 1, { area: 'QC', collapsed: true, pct: 12 });
const qcMethods = [
  'mRNA identity (RT-qPCR) validation',
  'Purity (RP-HPLC) validation',
  'dsRNA ELISA validation',
  'LNP size and PDI (DLS) validation',
  'Potency cell-based assay validation',
  'Residual solvents GC validation',
  'Bioburden and endotoxin methods',
  'Reference standard qualification',
  'Stability indicating method summary',
  'Labware and reference material chain',
  'OOS/OOT investigation playbook',
  { name: 'QC method package approved', dur: 0, pct: 0 }
];
const qc = addStream('QC method validation', 'QC', qcMethods, { dur: 10, pct: 20 });
link(gmpStreams[3].ids[0], qc.ids[0], 'FS', 0);
link(dsStreams[0].ids[4], qc.ids[2], 'FS', 10);

// 8. Validation & qualification
task('Validation and qualification (CQV)', 0, 1, { area: 'VAL', collapsed: true, pct: 7 });
const valStreams = [];
for (let s = 0; s < 6; s++) {
  valStreams.push(addStream('CQV package ' + (s + 1), 'VAL', [
    'Validation master plan update',
    'URS to DQ traceability matrix',
    'IQ protocol execution',
    'OQ protocol execution',
    'PQ protocol execution',
    'Cleaning validation summary',
    'Process validation stage ' + (s + 1),
    { name: 'CQV package ' + (s + 1) + ' signed', dur: 0, pct: s === 0 ? 0 : 0 }
  ], { dur: 8 }));
}
link(fac.ids[2], valStreams[0].ids[0], 'FS', 0);
link(qc.ids[4], valStreams[0].ids[0], 'FS', 0);
for (let s = 1; s < valStreams.length; s++) {
  link(valStreams[s - 1].ids[5], valStreams[s].ids[0], 'FS', 5);
}

// 9. Regulatory
task('Regulatory and batch release', 0, 1, { area: 'RA', collapsed: true, pct: 3 });
const reg = addStream('Regulatory dossier', 'RA', [
  'Health authority meeting request',
  'Module 3 quality overall summary',
  'Manufacturing process description',
  'Control strategy and QbD summary',
  'GMP inspection readiness gap',
  'Batch record and logbook review',
  'QP certification workflow',
  'Annual report and post-approval plan',
  { name: 'Inspection readiness milestone', dur: 0, pct: 0, constraint: { type: 'FNLT', date: toISO(todayDay() + 1600) } }
], { dur: 12, pct: 5 });
link(dpStreams[3].ids[dpStreams[3].ids.length - 2], reg.ids[0], 'FS', 15);
link(ccStreams[7].ids[20], reg.ids[0], 'FS', 0);

// 10. Tech transfer & PPQ
task('Tech transfer and PPQ campaign', 0, 1, { area: 'RNA', collapsed: true, pct: 0 });
const ttStreams = [];
for (let s = 0; s < 5; s++) {
  ttStreams.push(addStream('PPQ wave ' + (s + 1), 'RNA', [
    'Tech transfer protocol',
    'Engineering batch at receiving site',
    'PPQ protocol approval',
    'PPQ lot A manufacturing',
    'PPQ lot B manufacturing',
    'PPQ lot C manufacturing',
    'Statistical review and report',
    { name: 'PPQ wave ' + (s + 1) + ' complete', dur: 0, pct: 0 }
  ], { dur: 9 }));
}
link(reg.ids[reg.ids.length - 2], ttStreams[0].ids[0], 'FS', 0);
link(valStreams[5].ids[6], ttStreams[0].ids[0], 'FS', 0);
chain([ttStreams[0].ids[3], ttStreams[1].ids[0], ttStreams[2].ids[0]], 'FS', 10);
for (let s = 1; s < ttStreams.length; s++) {
  link(ttStreams[s - 1].ids[6], ttStreams[s].ids[0], 'FS', 7);
}

// Cross-stream dependencies between CC, RNA, GMP, QC, validation, and regulatory.
const linkKey = new Set(links.map(function (l) { return l.from + '>' + l.to; }));
function addCross(from, to, lag) {
  if (from >= to || linkKey.has(from + '>' + to)) return;
  linkKey.add(from + '>' + to);
  links.push({ from: from, to: to, type: 'FS', lag: lag || 0 });
}
for (let c = 0; c < ccStreams.length; c++) {
  addCross(ccStreams[c].ids[3], gmpStreams[c % gmpStreams.length].ids[6], 2);
  addCross(ccStreams[c].ids[7], qc.ids[c % qc.ids.length], 0);
}
for (let s = 0; s < dsStreams.length; s++) {
  addCross(dsStreams[s].ids[4], qc.ids[Math.min(s + 2, qc.ids.length - 1)], 3);
}
for (let s = 0; s < dpStreams.length; s++) {
  addCross(dpStreams[s].ids[3], reg.ids[Math.min(s + 1, reg.ids.length - 1)], 7);
}

// Milestone constraints on a few RNA engineering runs
for (let s = 0; s < dsStreams.length; s++) {
  if (dsStreams[s].ids[3]) {
    tasks[dsStreams[s].ids[3] - 1].constraint = { type: 'SNET', date: toISO(todayDay() + 60 + s * 25) };
  }
}

const doc = normalize({
  version: 1,
  name: 'RNA GMP Program',
  calendar: {
    workDays: [1, 2, 3, 4, 5],
    holidays: [
      '2026-01-01', '2026-07-04', '2026-11-26', '2026-12-24', '2026-12-25',
      '2027-01-01', '2027-07-04', '2027-11-25', '2027-12-24', '2027-12-25'
    ]
  },
  view: {
    zoom: 'week',
    compact: false,
    showCritical: true,
    dateFormat: 'dmy',
    gridWidth: 620,
    columns: ['wbs', 'name', 'duration', 'start', 'finish', 'pct', 'pred', 'slack', 'meta.area', 'meta.owner', 'meta.risk'],
    widths: {
      wbs: 52,
      name: 300,
      duration: 44,
      start: 86,
      finish: 86,
      pct: 48,
      pred: 110,
      slack: 44,
      'meta.area': 56,
      'meta.owner': 56,
      'meta.risk': 58
    }
  },
  columnDefs: [
    { key: 'area', label: 'Area', type: 'text', width: 56 },
    { key: 'owner', label: 'Owner', type: 'text', width: 56 },
    { key: 'risk', label: 'Risk', type: 'text', width: 58 }
  ],
  tasks: tasks,
  links: links
});

const sched = compute(doc);
const problems = sched.problems.length;
const leaves = tasks.filter(function (_, i) { return !sched.summary[i]; }).length;

writeFileSync('data/RNA GMP Program.json', JSON.stringify(doc, null, 1) + '\n', 'utf8');

console.log('tasks:', tasks.length);
console.log('links:', links.length);
console.log('leaf tasks:', leaves);
console.log('schedule:', toISO(sched.projectStart), '->', toISO(sched.projectFinish));
console.log('working days span:', sched.cal.span(sched.projectStart, sched.projectFinish));
console.log('schedule problems:', problems);
if (problems) sched.problems.slice(0, 5).forEach(function (p) { console.log(' -', p.text); });
