import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Values contain only normalized evidence; callers supply the clock and file reader.
export const defaultEvidencePaths = ['priority', 'role-doc'];
const ok = value => ({ value, unknown: false, reason: null });
const missing = reason => ({ value: null, unknown: true, reason });
const time = value => { const n = Date.parse(value); if (!Number.isFinite(n)) throw Error('invalid timestamp'); return n; };
const before = (at, now) => time(at) <= now;
function collect(input, key, fn) {
  try {
    if (input.errors?.[key]) throw Error(input.errors[key]);
    return ok(fn());
  } catch (error) { return missing(`${key}: ${error.message}`); }
}
const array = value => { if (!Array.isArray(value)) throw Error('missing or invalid array'); return value; };

export function collectS1(input, now) {
  return collect(input, 'reviews', () => array(input.reviews.plans).map(p => ({
    plan: p.plan, files: array(p.files).filter(f => before(f.mtime, now)).map(f => ({ name: f.name, at: f.mtime, verdict: f.verdict, failCriteria: f.fail_criteria }))
  })));
}
export function collectS2(input, now) {
  return collect(input, 'reviews', () => array(input.reviews.plans).map(p => ({ plan: p.plan, results: array(p.files).filter(f => before(f.mtime, now)).map(f => ({ at: f.mtime, verdict: f.verdict, blocking: array(f.fail_criteria).length })) })));
}
export function collectS3(input, now, { evidencePaths = defaultEvidencePaths, priorityTarget = 'priority' } = {}) {
  return collect(input, 'session', () => {
    if (input.errors?.ledger || !input.ledger) throw Error(input.errors?.ledger ?? 'ledger unavailable');
    const start = time(input.session.period.from);
    // A ledger touch by itself is not proof that the priority advanced.
    const edits = array(input.session.edits).filter(e => (array(e.tags).some(t => evidencePaths.includes(t)) || evidencePaths.some(p => e.file === p || e.file?.startsWith(`${p}/`))) && before(e.at, now)).map(e => time(e.at));
    array(input.ledger.rows);
    edits.sort((a,b) => a-b);
    const points = [start, ...edits.filter(t => t >= start), now].sort((a,b) => a-b);
    const gaps = points.slice(1).map((end,i) => ({ from: points[i], to: end, hours: (end-points[i])/3600000 }));
    return { lastAt: edits.at(-1) ?? start, idleHours: (now-(edits.at(-1) ?? start))/3600000, gaps };
  });
}
export function collectS4(input, now) {
  return collect(input, 'session', () => ({ hours: array(input.session.hourly_tool_calls).filter(h => time(`${h.hour}:00:00Z`)+3600000 <= now).map(h => ({ at: `${h.hour}:00:00Z`, total: h.total })) }));
}
export function collectS5(input, now) {
  return collect(input, 'session', () => {
    if (input.errors?.gates || !input.gates) throw Error(input.errors?.gates ?? 'gate commits unavailable');
    return { edits: array(input.session.edits).filter(e => array(e.tags).includes('gate') && before(e.at, now)).map(e => ({ at: e.at, file: e.file })), commits: array(input.gates.commits).filter(e => before(e.at, now)) };
  });
}
export function collectS6(input, now) {
  return collect(input, 'reviews', () => array(input.reviews.plans).flatMap(p => array(p.files).filter(f => before(f.mtime, now) && /FAIL|NOT[- ]READY/i.test(f.verdict)).map(f => ({ plan: p.plan, at: f.mtime }))));
}
export function collectS7(input, now) {
  return collect(input, 'wake', () => {
    if (!input.wake.seen_marker) throw Error('missing consumption marker');
    const files = array(input.wake.files).filter(f => before(f.name_at, now) && (!f.consumed_at || time(f.consumed_at) > now));
    const oldest = files.length ? Math.min(...files.map(f => time(f.name_at))) : null;
    return { count: files.length, oldestAt: oldest, oldestHours: oldest === null ? 0 : (now-oldest)/3600000 };
  });
}
export function collectS8(input) {
  return collect(input, 'ledger', () => {
    if (input.errors?.monitors) throw Error(input.errors.monitors);
    return { rows: array(input.ledger.rows), monitors: input.monitors ?? null };
  });
}
export function collectS10(input, now) { return collect(input, 'session', () => array(input.session.text_markers).filter(m => before(m.at, now)).map(({ at, marker }) => ({ at, marker }))); }
export function collectSignals(input, { now, evidencePaths, priorityTarget } = {}) {
  if (!Number.isFinite(now)) throw Error('finite clock required');
  return { S1: collectS1(input, now), S2: collectS2(input, now), S3: collectS3(input, now, { evidencePaths, priorityTarget }), S4: collectS4(input, now), S5: collectS5(input, now), S6: collectS6(input, now), S7: collectS7(input, now), S8: collectS8(input), S10: collectS10(input, now) };
}
export async function readInputs(paths, { read = readFile } = {}) {
  const result = { errors: {} };
  await Promise.all(['reviews', 'session', 'gates', 'wake', 'ledger'].map(async key => {
    try { if (!paths[key]) throw Error('path missing'); result[key] = JSON.parse(await read(paths[key], 'utf8')); }
    catch (error) { result.errors[key] = error.message; }
  }));
  if (paths.monitors) {
    try {
      result.monitors = Object.fromEntries(await Promise.all(Object.entries(paths.monitors).map(async ([name, path]) => [name, JSON.parse(await read(path, 'utf8'))])));
    } catch (error) { result.errors.monitors = error.message; }
  }
  return result;
}
export async function readFixture(dir, options = {}) {
  const files = { reviews: 'reviews.json', session: 'session-log.json', gates: 'gate-git.json', wake: 'wake.json', ledger: 'ledger.json' };
  return readInputs(Object.fromEntries(Object.entries(files).map(([key, file]) => [key, join(dir, file)])), options);
}
