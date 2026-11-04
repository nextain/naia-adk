import { readFile, lstat, open, rename, unlink } from 'node:fs/promises';

const object = x => x && typeof x === 'object' && !Array.isArray(x);
const required = (x, label) => { if (typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x)) throw Error(`invalid ${label}`); return x; };
const timestamp = (x, now, nullable = false) => {
  if (nullable && x === null) return null;
  if (typeof x !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) || !Number.isFinite(Date.parse(x))) throw Error('invalid timestamp');
  const wall = new Date(Date.parse(x.slice(0, 19) + 'Z'));
  if (wall.toISOString().slice(0, 19) !== x.slice(0, 19)) throw Error('invalid calendar date');
  return Date.parse(x);
};
function scalar(raw) {
  const s = raw.trim();
  if (!s) throw Error('empty scalar');
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s[0] === '"') { const v = JSON.parse(s); if (typeof v !== 'string') throw Error('invalid scalar'); return v; }
  if (s[0] === "'") { if (!/^'(?:[^']|'')*'$/.test(s)) throw Error('invalid quoted scalar'); return s.slice(1, -1).replace(/''/g, "'"); }
  if (/^[\[\]{}&*!>|%@`]/.test(s) || /\s+#|:\s/.test(s)) throw Error('unsupported YAML scalar');
  if (s === 'null' || s === '~') return null;
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}
export function parseLedgerYaml(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text, (key, value) => { if (key === '__proto__') throw Error('unsafe mapping key'); return value; });
  const lines = text.split(/\r?\n/).filter(s => s.trim() && !s.trimStart().startsWith('#')).map(s => {
    if (/\t/.test(s)) throw Error('tabs unsupported');
    const indent = s.length - s.trimStart().length;
    if (indent % 2) throw Error('two-space indentation required');
    return { indent, text: s.trim() };
  });
  let i = 0;
  function block(level) {
    const sequence = lines[i]?.text.startsWith('- '), out = sequence ? [] : {};
    function field(target, raw, childLevel) {
      const match = /^([a-zA-Z_][a-zA-Z0-9_-]*):(?:\s+(.*))?$/.exec(raw);
      if (!match || match[1] === '__proto__' || Object.hasOwn(target, match[1])) throw Error('invalid or duplicate mapping key');
      const [, key, value] = match;
      if (value !== undefined) target[key] = scalar(value);
      else { if (!lines[i] || lines[i].indent !== childLevel) throw Error('missing nested value'); target[key] = block(childLevel); }
    }
    while (i < lines.length && lines[i].indent === level) {
      const line = lines[i++].text;
      if (sequence) {
        if (!line.startsWith('- ')) throw Error('mixed YAML block');
        const row = {}; field(row, line.slice(2), level + 4);
        while (i < lines.length && lines[i].indent === level + 2) field(row, lines[i++].text, level + 4);
        out.push(row);
      } else { if (line.startsWith('- ')) throw Error('mixed YAML block'); field(out, line, level + 2); }
    }
    if (i < lines.length && lines[i].indent > level) throw Error('invalid indentation');
    return out;
  }
  if (!lines.length || lines[0].indent) throw Error('invalid document');
  const result = block(0); if (i !== lines.length) throw Error('invalid document'); return result;
}
function rows(doc, key) {
  if (!object(doc) || doc.version !== 1 || !Array.isArray(doc[key])) throw Error('invalid ledger');
  const ids = new Set();
  for (const row of doc[key]) {
    if (!object(row)) throw Error('invalid row');
    for (const k of ['id', 'role', 'task', 'status']) required(row[k], k);
    if (ids.has(row.id)) throw Error('duplicate id'); ids.add(row.id);
  }
  return doc[key];
}
export function validateWorkLedger(doc, now = Date.now()) {
  if (!Number.isFinite(now)) throw Error('invalid clock');
  for (const row of rows(doc, 'work')) {
    if (!['진행 중', '대기', '막힘', '끝'].includes(row.status)) throw Error('invalid work status');
    const requested = timestamp(row.requested_at, now), updated = timestamp(row.updated_at, now);
    timestamp(row.due_at, now, true);
    if (requested > now || updated > now || updated < requested) throw Error('invalid work chronology');
    required(row.evidence, 'evidence');
    if (row.result !== null) required(row.result, 'result');
    if (row.status === '끝' && row.result === null) throw Error('completion result required');
  }
  return doc.work;
}
export function validateScheduleLedger(doc, now = Date.now()) {
  if (!Number.isFinite(now)) throw Error('invalid clock');
  rows(doc, 'schedules'); required(doc.timezone, 'timezone');
  new Intl.DateTimeFormat('en', { timeZone: doc.timezone }).format(now);
  for (const row of doc.schedules) {
    if (!['있음', '부분', '새로', '사람', '제안'].includes(row.status)) throw Error('invalid schedule status');
    required(row.cadence, 'cadence');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time)) throw Error('invalid schedule time');
    if (row.status === '있음' && !/^(daily|weekly:(MON|TUE|WED|THU|FRI|SAT|SUN))$/.test(row.cadence)) throw Error('unsupported cadence');
    if (!Number.isFinite(row.graceMinutes ?? 15) || (row.graceMinutes ?? 15) < 0) throw Error('invalid grace');
    if (!object(row.mechanism) || !['wake', 'timer', 'manual'].includes(row.mechanism.kind)) throw Error('invalid mechanism');
    required(row.mechanism.target, 'target');
    if (!Object.hasOwn(row, 'approval') || !object(row.last_result)) throw Error('missing schedule evidence');
    const at = timestamp(row.last_result.at, now, true);
    if (at > now) throw Error('future result');
    required(row.last_result.outcome, 'outcome');
    if (!Object.hasOwn(row.last_result, 'evidence')) throw Error('missing result evidence');
  }
  return doc;
}
export const readWorkLedger = async (path, now = Date.now()) => validateWorkLedger(parseLedgerYaml(await readFile(path, 'utf8')), now);
export const readScheduleLedger = async (path, now = Date.now()) => validateScheduleLedger(parseLedgerYaml(await readFile(path, 'utf8')), now);
const formatters = new Map();
function parts(at, zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  const p = Object.fromEntries(formatters.get(zone).formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return p;
}
export function scheduleStatus(doc, roleId, now = Date.now()) {
  validateScheduleLedger(doc, now);
  const p = parts(now, doc.timezone), localDate = Date.UTC(p.year, p.month - 1, p.day);
  return doc.schedules.filter(r => r.role === roleId && r.status === '있음').map(row => {
    const [hour, minute] = row.time.split(':').map(Number); let dueAt = null;
    // Search UTC minutes around recent local dates: this handles DST gaps and repeated hours explicitly.
    for (let days = 0; days <= 15 && dueAt === null; days++) {
      const date = new Date(localDate - days * 86400000);
      if (row.cadence.startsWith('weekly:') && ['SUN','MON','TUE','WED','THU','FRI','SAT'][date.getUTCDay()] !== row.cadence.slice(7)) continue;
      const target = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
      const matches = [];
      for (let candidate = target - 15 * 3600000; candidate <= target + 15 * 3600000; candidate += 60000) {
        if (candidate > now) continue;
        const q = parts(candidate, doc.timezone);
        if (q.year === date.getUTCFullYear() && q.month === date.getUTCMonth() + 1 && q.day === date.getUTCDate() && q.hour === hour && q.minute === minute) matches.push(candidate);
      }
      if (matches.length) dueAt = Math.max(...matches);
    }
    if (dueAt === null) throw Error('no due occurrence');
    const at = row.last_result.at === null ? null : Date.parse(row.last_result.at);
    const status = at !== null && at >= dueAt && row.last_result.outcome !== 'not-run' ? 'recorded' : now <= dueAt + (row.graceMinutes ?? 15) * 60000 ? 'pending' : 'missed';
    return { id: row.id, dueAt, status, occurrence: `${row.id}/${dueAt}` };
  });
}
export function serializeLedgerYaml(value) {
  function render(v, indent) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(v)) {
      if (!v.length) return `${pad}[]`;
      return v.map(row => {
        if (!object(row)) throw Error('mapping sequence required');
        const lines = render(row, indent + 2).split('\n');
        lines[0] = `${pad}- ${lines[0].slice(indent + 2)}`;
        return lines.join('\n');
      }).join('\n');
    }
    return Object.entries(v).map(([key, child]) => {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) throw Error('unsupported key');
      return child !== null && typeof child === 'object' ? Object.keys(child).length === 0 ? `${pad}${key}: ${Array.isArray(child) ? '[]' : '{}'}` : `${pad}${key}:\n${render(child, indent + 2)}` : `${pad}${key}: ${JSON.stringify(child)}`;
    }).join('\n');
  }
  return `${render(value, 0)}\n`;
}
export async function recordSchedule(path, id, outcome, { now = Date.now() } = {}) {
  required(id, 'id'); required(outcome, 'outcome');
  if (outcome === 'not-run') throw Error('execution result required');
  if (!Number.isFinite(now)) throw Error('invalid clock');
  const lockPath = `${path}.lock`, tmp = `${path}.${process.pid}.tmp`;
  const lock = await open(lockPath, 'wx', 0o600); let temporary = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: now }));
    const meta = await lstat(path); if (meta.isSymbolicLink() || !meta.isFile()) throw Error('regular ledger file required; symlinks are not replaced');
    const doc = await readScheduleLedger(path, now), row = doc.schedules.find(r => r.id === id);
    if (!row) throw Error('unknown schedule id');
    row.last_result = { ...row.last_result, at: new Date(now).toISOString(), outcome };
    const handle = await open(tmp, 'wx', meta.mode & 0o777); temporary = true;
    try { await handle.writeFile(serializeLedgerYaml(doc)); } finally { await handle.close(); }
    await rename(tmp, path); temporary = false;
    return row.last_result;
  } finally { if (temporary) await unlink(tmp); await lock.close(); await unlink(lockPath); }
}
