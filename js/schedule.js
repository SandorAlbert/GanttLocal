// Date utilities + the scheduling engine.
//
// Dates are integer day numbers (days since 1970-01-01). A cached working-day
// calendar over the project horizon turns "add N working days" into an array
// lookup, so a full reschedule is a couple of linear passes.

const MS_DAY = 86400000;
const NEG = -2000000000;
const POS = 2000000000;

// --- dates ---------------------------------------------------------------

/** Parse `len` decimal digits at `i` without allocating substrings. */
function digitsAt(s, i, len) {
  let n = 0;
  for (let k = 0; k < len; k++) {
    const c = s.charCodeAt(i + k);
    if (c < 48 || c > 57) return -1;
    n = n * 10 + (c - 48);
  }
  return n;
}

/** 'YYYY-MM-DD' -> day number, or null when unparseable. */
export function toDay(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return null;
  if (iso.charCodeAt(4) !== 45 || iso.charCodeAt(7) !== 45) return null;
  const y = digitsAt(iso, 0, 4);
  const m = digitsAt(iso, 5, 2);
  const d = digitsAt(iso, 8, 2);
  if (y < 0 || m < 0 || d < 0) return null;
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  if (d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

export function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Howard Hinnant's days_from_civil; no Date allocation. */
export function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. Writes into `out` to avoid allocation. */
export function civilFromDays(day, out) {
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  out[0] = y + (m <= 2 ? 1 : 0);
  out[1] = m;
  out[2] = d;
  return out;
}

const civil = [0, 0, 0];

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

export function toISO(day) {
  civilFromDays(day, civil);
  return civil[0] + '-' + pad2(civil[1]) + '-' + pad2(civil[2]);
}

export function formatDay(day, format) {
  civilFromDays(day, civil);
  if (format === 'dmy') return pad2(civil[2]) + '.' + pad2(civil[1]) + '.' + civil[0];
  return civil[0] + '-' + pad2(civil[1]) + '-' + pad2(civil[2]);
}

/** Accepts 2026-08-19, 19.08.2026, 19.8.26, 19.8. (current year), 8/19/2026. */
export function parseDateInput(text, referenceDay) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return safeCivil(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})$/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return safeCivil(y, +m[2], +m[1]);
  }
  m = /^(\d{1,2})[.\/](\d{1,2})\.?$/.exec(s);
  if (m) {
    civilFromDays(referenceDay === undefined ? todayDay() : referenceDay, civil);
    return safeCivil(civil[0], +m[2], +m[1]);
  }
  return null;
}

function safeCivil(y, m, d) {
  if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

export function todayDay() {
  const now = new Date();
  return daysFromCivil(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** 0 = Sunday. 1970-01-01 was a Thursday. */
export function dayOfWeek(day) {
  return ((day % 7) + 11) % 7;
}

export function monthStart(day) {
  civilFromDays(day, civil);
  return daysFromCivil(civil[0], civil[1], 1);
}

export function addMonths(day, count) {
  civilFromDays(day, civil);
  let y = civil[0];
  let m = civil[1] + count;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return daysFromCivil(y, m, Math.min(civil[2], daysInMonth(y, m)));
}

export function weekStart(day) {
  // ISO weeks start on Monday.
  return day - ((dayOfWeek(day) + 6) % 7);
}

export function isoWeek(day) {
  const thursday = weekStart(day) + 3;
  civilFromDays(thursday, civil);
  const jan1 = daysFromCivil(civil[0], 1, 1);
  return 1 + Math.floor((thursday - jan1) / 7);
}

// --- working-day calendar ------------------------------------------------

let cachedCalendar = null;

/**
 * Working-day lookup tables over [min, max].
 *  isWork[d-min]  1 when the day is a working day
 *  idx[d-min]     ordinal of the day among working days (rounded up for non-working days)
 *  nth[k]         day number of the k-th working day
 */
export function buildCalendar(workDays, holidays, min, max) {
  const mask = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < workDays.length; i++) mask[workDays[i]] = 1;
  if (mask.indexOf(1) < 0) mask[1] = mask[2] = mask[3] = mask[4] = mask[5] = 1;

  let perWeek = 0;
  for (let i = 0; i < 7; i++) perWeek += mask[i];

  const holiSet = holidays.length ? new Set() : null;
  for (let i = 0; i < holidays.length; i++) {
    const d = toDay(holidays[i]);
    if (d !== null) holiSet.add(d);
  }

  const span = max - min + 1;
  const isWork = new Uint8Array(span);
  const idx = new Int32Array(span);
  let count = 0;
  for (let i = 0; i < span; i++) {
    const day = min + i;
    const work = mask[dayOfWeek(day)] === 1 && !(holiSet && holiSet.has(day)) ? 1 : 0;
    isWork[i] = work;
    idx[i] = count;
    count += work;
  }
  const nth = new Int32Array(Math.max(1, count));
  let k = 0;
  for (let i = 0; i < span; i++) if (isWork[i]) nth[k++] = min + i;

  return {
    min: min, max: max, count: count, isWork: isWork, idx: idx, nth: nth,
    perWeek: perWeek,

    isWorking: function (day) {
      if (day < this.min || day > this.max) {
        const wd = dayOfWeek(day);
        return wd !== 0 && wd !== 6;
      }
      return this.isWork[day - this.min] === 1;
    },
    /** First working day >= day. */
    next: function (day) {
      let d = Math.max(this.min, Math.min(day, this.max));
      const limit = this.max;
      const work = this.isWork;
      const base = this.min;
      while (d <= limit && work[d - base] === 0) d++;
      return d > limit ? limit : d;
    },
    /** Last working day <= day. */
    prev: function (day) {
      let d = Math.max(this.min, Math.min(day, this.max));
      const work = this.isWork;
      const base = this.min;
      while (d >= base && work[d - base] === 0) d--;
      return d < base ? base : d;
    },
    /** Ordinal among working days (day is snapped forward first). */
    ordinal: function (day) {
      const d = this.next(day);
      return this.idx[d - this.min];
    },
    /** k working days after `day` (k may be negative). */
    add: function (day, k) {
      const base = k >= 0 ? this.next(day) : this.prev(day);
      let o = this.idx[base - this.min] + k;
      if (o < 0) o = 0;
      if (o >= this.count) o = this.count - 1;
      return this.nth[o];
    },
    /** Working days from a to b inclusive of a, exclusive of b. */
    diff: function (a, b) {
      return this.ordinal(b) - this.ordinal(a);
    },
    /** Inclusive working-day span, i.e. the duration of [a, b]. */
    span: function (a, b) {
      if (b < a) return 0;
      return this.ordinal(b) - this.ordinal(a) + 1;
    }
  };
}

function calendarFor(doc, tasks) {
  const workDays = doc.calendar.workDays;
  const holidays = doc.calendar.holidays;
  let min = todayDay();
  let totalWork = 64;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const s = toDay(t.start);
    if (s !== null && s < min) min = s;
    const c = t.constraint.date ? toDay(t.constraint.date) : null;
    if (c !== null && c < min) min = c;
    totalWork += Math.max(1, t.duration);
  }
  const links = doc.links;
  for (let i = 0; i < links.length; i++) totalWork += Math.abs(links[i].lag) + 1;

  const perWeek = Math.max(1, workDays.length);
  // Round the horizon to coarse blocks so the cache survives normal editing.
  min = Math.floor((min - 400) / 512) * 512;
  let max = min + Math.ceil((totalWork * 7) / perWeek) + 800;
  max = Math.ceil(max / 512) * 512;
  if (max - min > 200000) max = min + 200000;

  let workMask = 0;
  for (let i = 0; i < workDays.length; i++) workMask |= 1 << (workDays[i] & 7);
  const holiN = holidays.length;
  const holiFirst = holiN ? holidays[0] : '';
  const holiLast = holiN ? holidays[holiN - 1] : '';

  // Identity plus a cheap content fingerprint so in-place holiday/weekday
  // mutation still misses the cache instead of serving stale dates.
  if (cachedCalendar &&
      cachedCalendar.min === min &&
      cachedCalendar.max === max &&
      cachedCalendar.workMask === workMask &&
      cachedCalendar.holiN === holiN &&
      cachedCalendar.holiFirst === holiFirst &&
      cachedCalendar.holiLast === holiLast) {
    return cachedCalendar.cal;
  }
  const cal = buildCalendar(workDays, holidays, min, max);
  cachedCalendar = {
    min: min, max: max, workMask: workMask,
    holiN: holiN, holiFirst: holiFirst, holiLast: holiLast, cal: cal
  };
  return cal;
}

// --- graph node layout ---------------------------------------------------
// FL_i = i (earliest-start floor), SR_i = n + i (start), FR_i = 2n + i (finish)

const K_PARENT = 0;   // FL_parent -> FL_child
const K_LINK = 1;     // pred event -> FL_succ
const K_FL_SR = 2;    // FL_i -> SR_i
const K_SR_FR = 3;    // SR_i -> FR_i
const K_ROLL_S = 4;   // SR_child -> SR_parent
const K_ROLL_F = 5;   // FR_child -> FR_parent

// --- schedule health ------------------------------------------------------

/** Bar states, in the order the colour palette is indexed. */
export const HEALTH = { none: 0, track: 1, risk: 2, late: 3, done: 4 };

/** Percentage points a task may lag behind the clock before it counts as late. */
const RISK_MARGIN = 10;

/**
 * Scratch buffers reused across compute() calls. Never returned to callers —
 * result typed arrays stay freshly allocated so tests (and any retained
 * schedule snapshots) cannot alias across runs.
 */
const LT_FS = 0;
const LT_SS = 1;
const LT_FF = 2;
const LT_SF = 3;

const SCRATCH = {
  n: 0,
  nodes: 0,
  links: 0,
  edges: 0,
  outDeg: null,
  indeg: null,
  linkFrom: null,
  linkTo: null,
  linkType: null,
  linkLag: null,
  linkSrc: null,
  linkUsed: null,
  hasPred: null,
  startDay: null,
  constrDay: null,
  kids: null,
  sumW: null,
  sumWP: null,
  sumPlain: null,
  offset: null,
  cursor: null,
  adjTo: null,
  adjKind: null,
  adjLink: null,
  floor: null,
  sVal: null,
  fVal: null,
  resolved: null,
  queue: null,
  order: null,
  outCount: null,
  outOff: null,
  outCursor: null,
  outLink: null,
  stack: [],
  wbsCounters: []
};

function scratchGrow(n, linkCount) {
  const nodes = 3 * n;
  const S = SCRATCH;
  if (!S.hasPred || S.n < n) {
    S.n = n;
    S.hasPred = new Uint8Array(n);
    S.startDay = new Int32Array(n);
    S.constrDay = new Int32Array(n);
    S.kids = new Int32Array(n);
    S.sumW = new Float64Array(n);
    S.sumWP = new Float64Array(n);
    S.sumPlain = new Float64Array(n);
    S.floor = new Int32Array(n);
    S.sVal = new Int32Array(n);
    S.fVal = new Int32Array(n);
    S.order = new Int32Array(n);
    S.outCount = new Int32Array(n + 1);
    S.outOff = new Int32Array(n + 1);
    S.outCursor = new Int32Array(n);
  }
  if (!S.outDeg || S.nodes < nodes) {
    S.nodes = nodes;
    S.outDeg = new Int32Array(nodes + 1);
    S.indeg = new Int32Array(nodes);
    S.offset = new Int32Array(nodes + 1);
    S.cursor = new Int32Array(nodes);
    S.resolved = new Uint8Array(nodes);
    S.queue = new Int32Array(nodes);
  }
  if (!S.linkUsed || S.links < linkCount) {
    S.links = linkCount;
    S.linkFrom = new Int32Array(linkCount);
    S.linkTo = new Int32Array(linkCount);
    S.linkType = new Int8Array(linkCount);
    S.linkLag = new Int32Array(linkCount);
    S.linkSrc = new Int32Array(linkCount);
    S.linkUsed = new Uint8Array(linkCount);
  }
}

function scratchEdges(edgeCount) {
  const S = SCRATCH;
  if (S.edges < edgeCount) {
    const grow = Math.max(edgeCount, S.edges ? S.edges * 2 : edgeCount);
    S.edges = grow;
    S.adjTo = new Int32Array(grow);
    S.adjKind = new Int32Array(grow);
    S.adjLink = new Int32Array(grow);
  }
}

function scratchOutLinks(count) {
  const S = SCRATCH;
  if (!S.outLink || S.outLink.length < count) {
    S.outLink = new Int32Array(Math.max(count, S.outLink ? S.outLink.length * 2 : count));
  }
}

/**
 * Computes the whole derived schedule.
 * `today` defaults to the real date and exists so the health rule can be tested.
 * Returns typed arrays indexed by row plus display strings and problems.
 */
export function compute(doc, today) {
  const now = today === undefined ? todayDay() : today;
  const tasks = doc.tasks;
  const links = doc.links;
  const n = tasks.length;
  const L = links.length;
  const cal = calendarFor(doc, tasks);

  const parent = new Int32Array(n);
  const summary = new Uint8Array(n);
  const start = new Int32Array(n);
  const finish = new Int32Array(n);
  const lateStart = new Int32Array(n);
  const lateFinish = new Int32Array(n);
  const slack = new Int32Array(n);
  const critical = new Uint8Array(n);
  const pct = new Float32Array(n);
  const span = new Int32Array(n);
  const wbs = new Array(n);
  const pred = new Array(n);
  const problems = [];
  const cycleIds = new Set();

  scratchGrow(n, L);
  const S = SCRATCH;
  const stack = S.stack;
  const wbsCounters = S.wbsCounters;
  stack.length = 0;
  wbsCounters.length = 0;

  const startDay = S.startDay;
  const constrDay = S.constrDay;
  const idOf = new Map();

  // Outline structure + pre-parsed day numbers.
  for (let i = 0; i < n; i++) {
    const t = tasks[i];
    idOf.set(t.id, i);
    const level = t.level;
    stack.length = level;
    parent[i] = level > 0 ? stack[level - 1] : -1;
    stack[level] = i;
    wbsCounters.length = level + 1;
    wbsCounters[level] = (wbsCounters[level] || 0) + 1;
    let code = '' + wbsCounters[0];
    for (let k = 1; k <= level; k++) code += '.' + wbsCounters[k];
    wbs[i] = code;
    pred[i] = '';
    if (parent[i] >= 0) summary[parent[i]] = 1;

    const sd = toDay(t.start);
    startDay[i] = sd === null ? NEG : sd;
    const cd = t.constraint.date ? toDay(t.constraint.date) : null;
    constrDay[i] = cd === null ? NEG : cd;
  }

  // --- resolve links once (row indices + type codes; no Map in hot loops) ---
  const nodes = 3 * n;
  const outDeg = S.outDeg;
  const indeg = S.indeg;
  outDeg.fill(0, 0, nodes + 1);
  indeg.fill(0, 0, nodes);

  const linkFrom = S.linkFrom;
  const linkTo = S.linkTo;
  const linkType = S.linkType;
  const linkLag = S.linkLag;
  const linkSrc = S.linkSrc;
  const linkUsed = S.linkUsed;
  const hasPred = S.hasPred;
  linkUsed.fill(0, 0, L);
  hasPred.fill(0, 0, n);

  for (let l = 0; l < L; l++) {
    const from = idOf.get(links[l].from);
    const to = idOf.get(links[l].to);
    if (from === undefined || to === undefined) {
      linkFrom[l] = -1;
      linkTo[l] = -1;
      continue;
    }
    linkFrom[l] = from;
    linkTo[l] = to;
    const type = links[l].type;
    const code = type === 'SS' ? LT_SS : type === 'FF' ? LT_FF : type === 'SF' ? LT_SF : LT_FS;
    linkType[l] = code;
    linkLag[l] = links[l].lag | 0;
    // Display text matches formatPredecessors (every resolvable inbound link).
    let s = '' + links[l].from;
    if (type !== 'FS') s += type;
    if (linkLag[l]) s += (linkLag[l] > 0 ? '+' : '-') + Math.abs(linkLag[l]) + 'd';
    pred[to] = pred[to] ? pred[to] + ', ' + s : s;
    if (summary[to] && (code === LT_FF || code === LT_SF)) {
      problems.push({
        id: links[l].to,
        text: type + ' link into summary task ' + links[l].to + ' is ignored (summary dates roll up from children)'
      });
      continue;
    }
    linkSrc[l] = (code === LT_FS || code === LT_FF ? 2 * n : n) + from;
    linkUsed[l] = 1;
    hasPred[to] = 1;
  }

  // --- CSR edge list: count then fill (no callback closure) ---
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p >= 0) {
      outDeg[p]++;
      outDeg[n + i]++;
      outDeg[2 * n + i]++;
    }
    if (!summary[i]) {
      outDeg[i]++;
      outDeg[n + i]++;
    }
  }
  for (let l = 0; l < L; l++) {
    if (linkUsed[l]) outDeg[linkSrc[l]]++;
  }

  const offset = S.offset;
  let edgeCount = 0;
  for (let i = 0; i < nodes; i++) {
    offset[i] = edgeCount;
    edgeCount += outDeg[i];
  }
  offset[nodes] = edgeCount;
  scratchEdges(edgeCount);

  const cursor = S.cursor;
  for (let i = 0; i < nodes; i++) cursor[i] = offset[i];
  const adjTo = S.adjTo;
  const adjKind = S.adjKind;
  const adjLink = S.adjLink;

  function emit(from, to, kind, link) {
    const at = cursor[from]++;
    adjTo[at] = to;
    adjKind[at] = kind;
    adjLink[at] = link;
    indeg[to]++;
  }

  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p >= 0) emit(p, i, K_PARENT, 0);
    if (!summary[i]) {
      emit(i, n + i, K_FL_SR, 0);
      emit(n + i, 2 * n + i, K_SR_FR, 0);
    }
    if (p >= 0) {
      emit(n + i, n + p, K_ROLL_S, 0);
      emit(2 * n + i, 2 * n + p, K_ROLL_F, 0);
    }
  }
  for (let l = 0; l < L; l++) {
    if (linkUsed[l]) emit(linkSrc[l], linkTo[l], K_LINK, l);
  }

  // --- forward pass (Kahn) ---
  const floor = S.floor;
  const sVal = S.sVal;
  const fVal = S.fVal;
  floor.fill(NEG, 0, n);
  sVal.fill(POS, 0, n);
  fVal.fill(NEG, 0, n);
  const resolved = S.resolved;
  resolved.fill(0, 0, nodes);
  const queue = S.queue;
  const order = S.order;
  let head = 0;
  let tail = 0;
  let orderLen = 0;
  for (let i = 0; i < nodes; i++) if (indeg[i] === 0) queue[tail++] = i;

  while (head < tail) {
    const node = queue[head++];
    resolved[node] = 1;
    const row = node % n;
    const kind = (node - row) / n;

    if (kind === 1) {
      if (summary[row]) {
        if (sVal[row] === POS) sVal[row] = cal.next(anchorDay(startDay[row], cal));
      } else {
        sVal[row] = leafStart(tasks[row], startDay[row], constrDay[row], floor[row], hasPred[row] === 1, cal, problems);
      }
    } else if (kind === 2) {
      if (summary[row]) {
        if (fVal[row] === NEG) fVal[row] = sVal[row];
      } else {
        const t = tasks[row];
        fVal[row] = t.duration <= 0 ? sVal[row] : cal.add(sVal[row], t.duration - 1);
        if (t.constraint.type === 'FNLT' && constrDay[row] !== NEG && fVal[row] > constrDay[row]) {
          problems.push({ id: t.id, text: 'Task ' + t.id + ' finishes after its "no later than" date' });
        }
      }
      order[orderLen++] = row;
    }

    const e0 = offset[node];
    const e1 = e0 + outDeg[node];
    for (let e = e0; e < e1; e++) {
      const to = adjTo[e];
      const k = adjKind[e];
      if (k === K_PARENT) {
        if (floor[to] < floor[node]) floor[to] = floor[node];
      } else if (k === K_LINK) {
        const li = adjLink[e];
        const req = requiredStart(linkType[li], linkLag[li], linkFrom[li], to, sVal, fVal, tasks, summary, cal);
        if (req > floor[to]) floor[to] = req;
      } else if (k === K_ROLL_S) {
        const child = node - n;
        const par = to - n;
        if (sVal[child] < sVal[par]) sVal[par] = sVal[child];
      } else if (k === K_ROLL_F) {
        const child = node - 2 * n;
        const par = to - 2 * n;
        if (fVal[child] > fVal[par]) fVal[par] = fVal[child];
      }
      if (--indeg[to] === 0) queue[tail++] = to;
    }
  }

  // --- cycles: schedule the stragglers from their own anchors ---
  if (tail < nodes) {
    for (let i = 0; i < n; i++) {
      if (resolved[2 * n + i]) continue;
      cycleIds.add(tasks[i].id);
      if (!summary[i]) {
        sVal[i] = cal.next(anchorDay(startDay[i], cal));
        fVal[i] = tasks[i].duration <= 0 ? sVal[i] : cal.add(sVal[i], tasks[i].duration - 1);
      }
      order[orderLen++] = i;
    }
    if (cycleIds.size) {
      problems.push({
        id: 0,
        text: 'Circular dependency involving task' + (cycleIds.size > 1 ? 's ' : ' ') +
          Array.from(cycleIds).slice(0, 8).join(', ')
      });
    }
  }

  // --- roll summaries up in O(n) via parent[] (children always follow parents) ---
  const kids = S.kids;
  const sumW = S.sumW;
  const sumWP = S.sumWP;
  const sumPlain = S.sumPlain;
  kids.fill(0, 0, n);
  sumW.fill(0, 0, n);
  sumWP.fill(0, 0, n);
  sumPlain.fill(0, 0, n);
  for (let i = 0; i < n; i++) {
    if (!summary[i]) pct[i] = tasks[i].pct;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (summary[i]) {
      if (kids[i]) {
        pct[i] = sumW[i] > 0 ? sumWP[i] / sumW[i] : sumPlain[i] / kids[i];
      } else {
        pct[i] = tasks[i].pct;
      }
    }
    const p = parent[i];
    if (p < 0) continue;
    if (kids[p] === 0) {
      sVal[p] = sVal[i];
      fVal[p] = fVal[i];
    } else {
      if (sVal[i] < sVal[p]) sVal[p] = sVal[i];
      if (fVal[i] > fVal[p]) fVal[p] = fVal[i];
    }
    kids[p]++;
    const w = Math.max(1, cal.span(sVal[i], fVal[i]));
    sumWP[p] += w * pct[i];
    sumW[p] += w;
    sumPlain[p] += pct[i];
  }

  // --- backward pass for slack / critical path ---
  let projectFinish = NEG;
  let projectStart = POS;
  for (let i = 0; i < n; i++) {
    if (fVal[i] > projectFinish) projectFinish = fVal[i];
    if (sVal[i] < projectStart) projectStart = sVal[i];
  }
  if (projectStart === POS) projectStart = now;
  if (projectFinish === NEG) projectFinish = projectStart;

  const outCount = S.outCount;
  outCount.fill(0, 0, n + 1);
  for (let l = 0; l < L; l++) {
    if (linkUsed[l]) outCount[linkFrom[l]]++;
  }
  const outOff = S.outOff;
  let outAcc = 0;
  for (let i = 0; i < n; i++) {
    outOff[i] = outAcc;
    outAcc += outCount[i];
  }
  outOff[n] = outAcc;
  scratchOutLinks(outAcc);
  const outCursor = S.outCursor;
  for (let i = 0; i < n; i++) outCursor[i] = outOff[i];
  const outLink = S.outLink;
  for (let l = 0; l < L; l++) {
    if (!linkUsed[l]) continue;
    outLink[outCursor[linkFrom[l]]++] = l;
  }

  for (let i = 0; i < n; i++) {
    lateFinish[i] = POS;
    lateStart[i] = POS;
  }
  for (let k = orderLen - 1; k >= 0; k--) {
    const i = order[k];
    let lf = POS;
    let ls = POS;
    const e0 = outOff[i];
    const e1 = e0 + outCount[i];
    for (let e = e0; e < e1; e++) {
      const li = outLink[e];
      const to = linkTo[li];
      const lagged = linkLag[li];
      const code = linkType[li];
      if (code === LT_FS) {
        const bump = !summary[i] && tasks[i].duration <= 0 ? 0 : 1;
        const v = cal.add(lateStart[to] === POS ? projectFinish : lateStart[to], -(bump + lagged));
        if (v < lf) lf = v;
      } else if (code === LT_FF) {
        const v = cal.add(lateFinish[to] === POS ? projectFinish : lateFinish[to], -lagged);
        if (v < lf) lf = v;
      } else if (code === LT_SS) {
        const v = cal.add(lateStart[to] === POS ? projectFinish : lateStart[to], -lagged);
        if (v < ls) ls = v;
      } else {
        const v = cal.add(lateFinish[to] === POS ? projectFinish : lateFinish[to], -lagged);
        if (v < ls) ls = v;
      }
    }
    const par = parent[i];
    if (par >= 0 && lateFinish[par] !== POS && lateFinish[par] < lf) lf = lateFinish[par];
    if (ls !== POS) {
      const dur = Math.max(1, summary[i] ? cal.span(sVal[i], fVal[i]) : Math.max(1, tasks[i].duration));
      const v = cal.add(ls, dur - 1);
      if (v < lf) lf = v;
    }
    if (lf === POS) lf = projectFinish;
    lateFinish[i] = lf;
    const dur = summary[i] ? Math.max(1, cal.span(sVal[i], fVal[i])) : Math.max(1, tasks[i].duration);
    lateStart[i] = cal.add(lf, -(dur - 1));
    slack[i] = cal.ordinal(lf) - cal.ordinal(fVal[i]);
    critical[i] = slack[i] <= 0 ? 1 : 0;
  }
  // Summary rows are critical when any child is.
  for (let i = n - 1; i >= 0; i--) {
    if (parent[i] >= 0 && critical[i]) critical[parent[i]] = 1;
  }

  for (let i = 0; i < n; i++) {
    start[i] = sVal[i];
    finish[i] = fVal[i];
    span[i] = summary[i] || tasks[i].duration > 0 ? cal.span(sVal[i], fVal[i]) : 0;
  }

  // -1 marks "no predecessor or parent floor", i.e. the stored date rules.
  const earliest = new Int32Array(n);
  for (let i = 0; i < n; i++) earliest[i] = floor[i] === NEG ? -1 : floor[i];

  // --- health: progress compared with the working time already spent ---
  // 0% is fine on a task's first day and alarming on its last, so the yardstick
  // is the share of the task's working days that today has consumed.
  const health = new Uint8Array(n);
  const expected = new Float32Array(n);
  const nowOrdinal = cal.ordinal(now);
  for (let i = 0; i < n; i++) {
    const total = Math.max(1, span[i]);
    let exp;
    if (now > finish[i]) {
      exp = 100;
    } else {
      let elapsed = nowOrdinal - cal.ordinal(start[i]);
      if (elapsed < 0) elapsed = 0;
      else if (elapsed > total) elapsed = total;
      exp = (elapsed * 100) / total;
    }
    expected[i] = exp;
    if (pct[i] >= 100) health[i] = HEALTH.done;
    else if (exp <= 0) health[i] = HEALTH.none;
    else {
      const deficit = exp - pct[i];
      health[i] = deficit > RISK_MARGIN ? HEALTH.late : deficit > 0 ? HEALTH.risk : HEALTH.track;
    }
  }

  return {
    cal: cal,
    parent: parent,
    summary: summary,
    earliest: earliest,
    start: start,
    finish: finish,
    lateStart: lateStart,
    lateFinish: lateFinish,
    slack: slack,
    critical: critical,
    pct: pct,
    health: health,
    expected: expected,
    span: span,
    wbs: wbs,
    pred: pred,
    projectStart: projectStart,
    projectFinish: projectFinish,
    problems: problems,
    cycleIds: cycleIds,
    rowOf: idOf
  };
}

function anchorDay(day, cal) {
  return day === NEG ? cal.min + 400 : day;
}

function leafStart(task, startD, constrD, floorValue, hasPred, cal, problems) {
  const anchor = anchorDay(startD, cal);
  if (task.manual) return anchor;
  // Predecessors drive the date; without them the stored date is the anchor,
  // raised by any floor inherited from a scheduled parent summary.
  let day;
  if (floorValue === NEG) day = anchor;
  else if (hasPred) day = floorValue;
  else day = Math.max(anchor, floorValue);
  if (task.constraint.type === 'MSO' && constrD !== NEG) {
    if (floorValue !== NEG && constrD < floorValue) {
      problems.push({ id: task.id, text: 'Task ' + task.id + ' must start on a date earlier than its predecessors allow' });
    }
    return cal.next(constrD);
  }
  if (task.constraint.type === 'SNET' && constrD !== NEG && constrD > day) day = constrD;
  return cal.next(day);
}

/** Earliest start the link imposes on its successor row. */
function requiredStart(type, lag, from, toRow, sVal, fVal, tasks, summary, cal) {
  if (type === LT_FS) {
    // A milestone's finish is the start of its day, so its successor may start
    // on that same day; a real task's successor starts the day after.
    const bump = !summary[from] && tasks[from].duration <= 0 ? 0 : 1;
    return cal.add(fVal[from], bump + lag);
  }
  if (type === LT_SS) return cal.add(sVal[from], lag);
  const dur = Math.max(1, tasks[toRow].duration);
  const reqFinish = type === LT_FF ? cal.add(fVal[from], lag) : cal.add(sVal[from], lag);
  return cal.add(reqFinish, -(dur - 1));
}

// --- predecessor text ("12FS+2d") ---------------------------------------

export function formatPredecessors(model, id) {
  const links = model.predecessorsOf(id);
  if (!links.length) return '';
  const parts = new Array(links.length);
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    let s = '' + l.from;
    if (l.type !== 'FS') s += l.type;
    if (l.lag) s += (l.lag > 0 ? '+' : '-') + Math.abs(l.lag) + 'd';
    parts[i] = s;
  }
  return parts.join(', ');
}

export function parsePredecessors(text) {
  const out = [];
  const parts = String(text || '').split(/[;,]/);
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].trim();
    if (!s) continue;
    const m = /^(\d+)\s*(FS|SS|FF|SF)?\s*([+-]\s*\d+)?\s*d?$/i.exec(s);
    if (!m) return null;
    out.push({
      from: +m[1],
      type: m[2] ? m[2].toUpperCase() : 'FS',
      lag: m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0
    });
  }
  return out;
}
