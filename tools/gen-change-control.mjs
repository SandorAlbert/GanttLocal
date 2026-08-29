// Builds data/Change Control.json — one biotech GMP change-control example.
import { mkdirSync, writeFileSync } from 'node:fs';
import { normalize } from '../js/model.js';
import { compute, toISO, todayDay } from '../js/schedule.js';

const START = toISO(todayDay() - 28);

let id = 0;
const tasks = [];
const links = [];

function task(name, level, duration, extra = {}) {
  id++;
  tasks.push({
    id,
    level,
    name,
    start: extra.start || START,
    duration,
    milestone: duration === 0,
    manual: !!extra.manual,
    collapsed: extra.collapsed === true,
    pct: extra.pct !== undefined ? extra.pct : 0,
    constraint: extra.constraint || { type: 'ASAP', date: null },
    notes: extra.notes || '',
    meta: {
      owner: extra.owner || '',
      area: extra.area || '',
      risk: extra.risk || ''
    }
  });
  return id;
}

function link(from, to, type = 'FS', lag = 0) {
  links.push({ from, to, type, lag });
}

function chain(ids) {
  for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i]);
}

const root = task('CC-2026-018 IVT scale-up 5 L to 30 L (mRNA DS)', 0, 1, {
  area: 'QA', owner: 'QAS', risk: 'High', pct: 35,
  notes: 'Major GMP change: in-vitro transcription scale-up for mRNA drug substance. ICH Q9/Q10, EU GMP Ch. 1, 21 CFR 211.'
});

const init = task('1. Initiation', 1, 1, { area: 'QA', owner: 'CCB', risk: 'Low', pct: 100 });
const tDraft = task('Draft change request and rationale', 2, 3, { area: 'MSAT', owner: 'PNV', risk: 'Low', pct: 100 });
const tClass = task('Classify major / minor and site impact', 2, 2, { area: 'QA', owner: 'QAS', risk: 'Low', pct: 100 });
const tNumber = task('Assign CC-2026-018 and change owner', 2, 0, { area: 'QA', owner: 'QAS', risk: 'Low', pct: 100 });
chain([tDraft, tClass, tNumber]);

const impact = task('2. Impact assessment', 1, 1, { area: 'QA', owner: 'QAS', risk: 'High', pct: 70 });
const tPq = task('Product quality and CQA impact', 2, 4, { area: 'MSAT', owner: 'PNV', risk: 'High', pct: 100 });
const tMfg = task('Manufacturing process and batch record', 2, 5, { area: 'MFG', owner: 'MFG', risk: 'High', pct: 80 });
const tQc = task('QC methods, specs and sampling plan', 2, 4, { area: 'QC', owner: 'ANL', risk: 'Medium', pct: 75 });
const tVal = task('Validation / qualification impact', 2, 4, { area: 'VAL', owner: 'VAL', risk: 'High', pct: 60 });
const tReg = task('Regulatory (CTA / variation) impact', 2, 3, { area: 'RA', owner: 'REG', risk: 'High', pct: 50 });
const tSup = task('Materials, single-use and supply', 2, 3, { area: 'SCM', owner: 'SCM', risk: 'Medium', pct: 90 });
const tDi = task('Data integrity and computerized systems', 2, 2, { area: 'CSV', owner: 'CSV', risk: 'Low', pct: 100 });
const tIar = task('Impact assessment report', 2, 3, { area: 'QA', owner: 'QAS', risk: 'High', pct: 40 });
link(tNumber, tPq);
link(tNumber, tMfg);
link(tNumber, tQc);
link(tNumber, tVal);
link(tNumber, tReg);
link(tNumber, tSup);
link(tNumber, tDi);
link(tPq, tIar);
link(tMfg, tIar);
link(tQc, tIar);
link(tVal, tIar);
link(tReg, tIar);
link(tSup, tIar);
link(tDi, tIar);

const risk = task('3. Risk assessment (ICH Q9)', 1, 1, { area: 'QA', owner: 'QAS', risk: 'High', pct: 45 });
const tFmea = task('Process FMEA (IVT, TFF, dsRNA clearance)', 2, 5, { area: 'MSAT', owner: 'PNV', risk: 'High', pct: 55 });
const tMit = task('Risk mitigations and residual ranking', 2, 3, { area: 'QA', owner: 'QAS', risk: 'High', pct: 30 });
const tRpt = task('Risk report for CCB', 2, 2, { area: 'QA', owner: 'QAS', risk: 'Medium', pct: 15 });
link(tIar, tFmea);
chain([tFmea, tMit, tRpt]);

const ccb = task('4. Change Review Board', 1, 1, { area: 'QA', owner: 'CCB', risk: 'High', pct: 20 });
const tPkg = task('Assemble CCB package (impact, risk, plan)', 2, 3, { area: 'QA', owner: 'QAS', risk: 'Medium', pct: 25 });
const tCcb1 = task('CCB-1 draft review', 2, 0, {
  area: 'QA', owner: 'CCB', risk: 'High', pct: 0,
  constraint: { type: 'SNET', date: '2026-09-08' }
});
const tAct = task('Close CCB-1 actions', 2, 4, { area: 'MSAT', owner: 'PNV', risk: 'Medium', pct: 0 });
const tCcb2 = task('CCB-2 approval to implement', 2, 0, {
  area: 'QA', owner: 'CCB', risk: 'High', pct: 0,
  constraint: { type: 'SNET', date: '2026-09-22' }
});
link(tRpt, tPkg);
chain([tPkg, tCcb1, tAct, tCcb2]);

const docs = task('5. Controlled documents', 1, 1, { area: 'QA', owner: 'DOC', risk: 'Medium', pct: 0 });
const tMbr = task('Revise master batch record (30 L IVT)', 2, 6, { area: 'MFG', owner: 'MFG', risk: 'High', pct: 0 });
const tSop = task('SOP revisions (IVT, TFF, sampling)', 2, 5, { area: 'QA', owner: 'DOC', risk: 'Medium', pct: 0 });
const tSpec = task('DS spec and IPC limit review', 2, 4, { area: 'QC', owner: 'ANL', risk: 'High', pct: 0 });
const tProt = task('PPQ and cleaning validation protocols', 2, 6, { area: 'VAL', owner: 'VAL', risk: 'High', pct: 0 });
const tTrain = task('Training materials and matrix update', 2, 3, { area: 'QA', owner: 'TRN', risk: 'Low', pct: 0 });
link(tCcb2, tMbr);
link(tCcb2, tSop);
link(tCcb2, tSpec);
link(tCcb2, tProt);
link(tCcb2, tTrain);

const impl = task('6. Implementation', 1, 1, { area: 'MFG', owner: 'MFG', risk: 'High', pct: 0 });
const tSus = task('Qualify 30 L single-use IVT assembly', 2, 8, { area: 'VAL', owner: 'VAL', risk: 'High', pct: 0 });
const tSuite = task('Suite / equipment readiness (bioreactor, TFF)', 2, 5, { area: 'ENG', owner: 'ENG', risk: 'Medium', pct: 0 });
const tEng = task('Engineering / demonstration run', 2, 5, { area: 'MSAT', owner: 'PNV', risk: 'High', pct: 0 });
const tPpq = task('PPQ lots (n=3) at 30 L', 2, 15, { area: 'MFG', owner: 'MFG', risk: 'High', pct: 0 });
const tVer = task('QC method verification (dsRNA, integrity, yield)', 2, 8, { area: 'QC', owner: 'ANL', risk: 'High', pct: 0 });
const tGmp = task('GMP training complete before PPQ', 2, 2, { area: 'QA', owner: 'TRN', risk: 'Low', pct: 0 });
link(tMbr, tSus);
link(tProt, tSus);
link(tSop, tSuite);
link(tSus, tEng);
link(tSuite, tEng);
link(tTrain, tGmp);
link(tSop, tGmp);
link(tGmp, tPpq);
link(tEng, tPpq);
link(tSpec, tVer);
link(tPpq, tVer, 'SS', 2);

const close = task('7. QA close-out', 1, 1, { area: 'QA', owner: 'QAS', risk: 'Medium', pct: 0 });
const tPack = task('Evidence pack and batch data review', 2, 5, { area: 'QA', owner: 'QAS', risk: 'High', pct: 0 });
const tEff = task('Effectiveness check (yield, purity, dsRNA)', 2, 5, { area: 'QC', owner: 'ANL', risk: 'Medium', pct: 0 });
const tVar = task('Regulatory notification / variation', 2, 4, { area: 'RA', owner: 'REG', risk: 'High', pct: 0 });
const tClose = task('Close CC-2026-018 and trend', 2, 0, { area: 'QA', owner: 'QAS', risk: 'Low', pct: 0 });
link(tPpq, tPack);
link(tVer, tPack);
link(tPack, tEff);
link(tReg, tVar);
link(tCcb2, tVar, 'FS', 5);
link(tEff, tClose);
link(tVar, tClose);

const doc = normalize({
  version: 1,
  name: 'Change Control',
  calendar: { workDays: [1, 2, 3, 4, 5], holidays: [] },
  view: {
    zoom: 'week',
    compact: false,
    showCritical: true,
    dateFormat: 'dmy',
    gridWidth: 640,
    columns: ['wbs', 'name', 'duration', 'start', 'finish', 'pred', 'pct', 'meta.area', 'meta.owner', 'meta.risk'],
    widths: {
      wbs: 44, name: 280, duration: 44, start: 78, finish: 78, pred: 72, pct: 40,
      'meta.area': 52, 'meta.owner': 52, 'meta.risk': 56
    }
  },
  columnDefs: [
    { key: 'area', label: 'Area', type: 'text', width: 52 },
    { key: 'owner', label: 'Owner', type: 'text', width: 52 },
    { key: 'risk', label: 'Risk', type: 'text', width: 56 }
  ],
  tasks,
  links
});

const sched = compute(doc);
mkdirSync('data', { recursive: true });
writeFileSync('data/Change Control.json', JSON.stringify(doc, null, 1) + '\n', 'utf8');

console.log('tasks:', tasks.length, 'links:', links.length);
console.log('schedule:', toISO(sched.projectStart), '->', toISO(sched.projectFinish));
console.log('problems:', sched.problems.length);
sched.problems.slice(0, 8).forEach(function (p) { console.log(' -', p.text); });
