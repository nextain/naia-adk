import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const MAX_BUNDLE_BYTES = 20 * 1024;
const promptFile = new URL('../../prompts/session-audit.md', import.meta.url);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const chars = value => [...value].length;
const hash = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:[a-f0-9]{56})?$/i.test(value)) throw Error('invalid hash');
  return value.toLowerCase();
};
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
// Paths and identifiers cannot carry free-form session text into the model.
const identifier = value => {
  if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 1024) throw Error('identifier too large');
  return typeof value === 'string' && /^[\p{L}\p{N}._/\\:@+\-]+$/u.test(value) ? value : null;
};
const stamp = value => typeof value === 'number' ? numeric(value) : typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const list = value => {
  if (Array.isArray(value) && value.length > 5000) throw Error('too many signal items');
  return Array.isArray(value) ? value : [];
};
const compact = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
const entry = (value, shape) => compact(Object.fromEntries(Object.entries(shape).map(([key, fn]) => [key, fn(value?.[key])])));
const rows = (value, shape) => list(value).map(item => entry(item, shape));
const pathList = value => list(value).map(identifier).filter(Boolean);
const reviewFile = { name: identifier, at: stamp, verdict: identifier, failCriteria: value => Array.isArray(value) ? value.length : null };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const latest = (items, shape) => rows(items, shape).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).at(-1);
const specs = {
  S1: value => list(value).map(plan => compact({ plan: identifier(plan?.plan), count: Array.isArray(plan?.files) ? list(plan.files).length : count(plan?.count), latest: Array.isArray(plan?.files) ? latest(plan.files, reviewFile) : plan?.latest ? entry(plan.latest, reviewFile) : undefined })),
  S2: value => list(value).map(plan => compact({ plan: identifier(plan?.plan), count: Array.isArray(plan?.results) ? list(plan.results).length : count(plan?.count), latest: Array.isArray(plan?.results) ? latest(plan.results, { at: stamp, verdict: identifier, blocking: numeric }) : plan?.latest ? entry(plan.latest, { at: stamp, verdict: identifier, blocking: numeric }) : undefined })),
  S3: value => entry(value, { lastAt: stamp, idleHours: numeric, gaps: v => rows(v, { from: stamp, to: stamp, hours: numeric }) }),
  S4: value => entry(value, { hours: v => rows(v, { at: stamp, total: numeric }) }),
  S5: value => entry(value, {
    edits: v => rows(v, { at: stamp, file: identifier }),
    commits: v => rows(v, { at: stamp, files: pathList, pr: identifier, verified: v => typeof v === 'boolean' ? v : null, otherRoleReview: v => typeof v === 'boolean' ? v : null })
  }),
  S6: value => Array.isArray(value) ? { count: list(value).length, latest: latest(value, { plan: identifier, at: stamp }) } : entry(value, { count, latest: v => v ? entry(v, { plan: identifier, at: stamp }) : null }),
  S7: value => entry(value, { count: numeric, oldestAt: stamp, oldestHours: numeric }),
  S8: value => entry(value, { rows: v => rows(v, { target: identifier, status: identifier, updated_at: stamp, approvalWaiting: v => typeof v === 'boolean' ? v : null }) }),
  S10: value => Array.isArray(value) ? { count: list(value).length, latest: latest(value, { at: stamp }) } : entry(value, { count, latest: v => v ? entry(v, { at: stamp }) : null })
};
function priorityFields(value) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('invalid priority');
  const name = v => {
    if (typeof v !== 'string' || !v.trim() || chars(v) > 80 || /[\r\n\x00-\x1f]/.test(v)) throw Error('invalid priority item');
    return v;
  };
  const names = v => {
    if (!Array.isArray(v) || v.length > 5) throw Error('invalid priority items');
    return v.map(name);
  };
  return { title: name(value.title), items: names(value.items), originTitle: name(value.originTitle), originItems: names(value.originItems) };
}
function serialized(bundle) {
  const json = JSON.stringify(bundle);
  if (Buffer.byteLength(json, 'utf8') > MAX_BUNDLE_BYTES) throw Error('audit bundle exceeds 20KB');
  return json;
}

export function buildBundle({ signals = {}, firedCodes = [], configHash, promptHash, priority } = {}) {
  if (Buffer.byteLength(JSON.stringify({ signals, firedCodes, configHash, promptHash, priority }), 'utf8') > 256 * 1024) throw Error('audit input too large');
  if (!Array.isArray(firedCodes) || firedCodes.some(code => typeof code !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(code))) throw Error('invalid fired codes');
  const selected = {};
  for (const [id, select] of Object.entries(specs)) {
    const signal = signals[id];
    if (!signal || typeof signal !== 'object') continue;
    selected[id] = signal.unknown === false ? { unknown: false, value: select(signal.value) } : { unknown: true };
  }
  const bundle = compact({ signals: selected, firedCodes: [...firedCodes], configHash: hash(configHash), promptHash: hash(promptHash), priority: priorityFields(priority) });
  serialized(bundle);
  return bundle;
}

// Compare tokens, not substrings: a supplied 123 does not authorize 12.
const tokenPatterns = [
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+/giu,
  /<[@#][!&]?[\p{L}\p{N}_-]+>|@[\p{L}\p{N}_.-]+/gu,
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[\p{L}\p{N}._~%+@:/\\-]+|[\p{L}\p{N}._~%+-]+(?:[\\/][\p{L}\p{N}._~%+@-]+)+|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu,
  /\p{N}+(?:[.,]\p{N}+)*/gu
];
function tokens(text, pattern) { return [...text.matchAll(pattern)].map(match => match[0].replace(/[.,;:!?。]+$/u, '')); }
function strings(value) {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
export function validateOutput(output, bundle) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).sort().join(',') !== 'ask,code,facts,headline') return false;
  if (typeof output.code !== 'string' || ![...bundle.firedCodes, ...(bundle.priority ? ['priority-match', 'priority-mismatch'] : [])].includes(output.code)) return false;
  if (typeof output.headline !== 'string' || !output.headline.trim() || chars(output.headline) > 80 || /\[감사\]/.test(output.headline)) return false;
  if (!Array.isArray(output.facts) || output.facts.length > 3 || output.facts.some(f => typeof f !== 'string' || chars(f) > 120)) return false;
  if (typeof output.ask !== 'string' || !output.ask.trim() || chars(output.ask) > 120) return false;
  // Hash digits are integrity metadata, not evidence of numerical facts.
  const { configHash: _configHash, promptHash: _promptHash, ...evidence } = bundle;
  const sources = strings(evidence), content = [output.headline, ...output.facts, output.ask];
  return tokenPatterns.every(pattern => {
    const allowed = new Set(sources.flatMap(s => tokens(s, pattern)));
    return content.every(s => tokens(s, pattern).every(token => allowed.has(token)));
  });
}
export function fixedTemplate(code) {
  return { code, headline: '감사 신호를 확인했습니다', facts: [], ask: '관련 근거를 확인하고 필요한 조치를 정해 주세요.' };
}
export function formatText({ role, output, configHash, promptHash }) {
  if (typeof role !== 'string' || !/^[\p{L}\p{N}_.-]+$/u.test(role)) throw Error('invalid role');
  return [`[감사] ${role} ${output.code} ${output.headline}`, ...output.facts, output.ask, `prompt=${hash(promptHash).slice(0, 8)} config=${hash(configHash).slice(0, 8)}`].join('\n');
}

function run(executable, args, request, timeout) {
  return new Promise((resolve, reject) => {
    let finished = false, output = '', size = 0;
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    const timer = setTimeout(() => { child.kill(); finish(Error('runner timeout')); }, timeout);
    function finish(error, value) { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); }
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { child.kill(); finish(Error('runner output too large')); }
      else output += chunk.toString('utf8');
    });
    child.on('close', code => code === 0 ? finish(null, output) : finish(Error('runner failed')));
    child.stdin.end(request);
  });
}
export async function judge({ bundle, config = {}, prompt, executable, timeout = 60000 } = {}) {
  const runner = config.judge?.runner ?? 'codex';
  const fallback = () => fixedTemplate(bundle?.firedCodes?.[0] ?? 'priority-mismatch');
  if (runner === 'none') return { output: fallback(), failed: false, disabled: true, reason: 'none' };
  try {
    if (!['codex', 'agy'].includes(runner)) throw Error('invalid runner');
    // Rebuild even for direct callers: unrecognized fields never reach stdin.
    const safeBundle = buildBundle(bundle);
    const json = serialized(safeBundle);
    const instruction = prompt ?? await readFile(promptFile, 'utf8');
    if (sha256(instruction).slice(0, safeBundle.promptHash.length) !== safeBundle.promptHash) throw Error('prompt hash mismatch');
    const request = `${instruction}\n\n${json}\n`;
    if (Buffer.byteLength(request, 'utf8') > MAX_BUNDLE_BYTES) throw Error('audit request exceeds 20KB');
    const model = config.judge?.model ?? (runner === 'codex' ? 'gpt-6.1-terra' : 'carbon');
    const effort = config.judge?.effort ?? 'xhigh';
    if (!/^[a-zA-Z0-9._-]+$/.test(model) || !/^[a-zA-Z0-9._-]+$/.test(effort)) throw Error('invalid model configuration');
    const args = runner === 'codex' ? ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-m', model, '-c', `model_reasoning_effort=${effort}`, '-'] : ['--model', model];
    const raw = await run(executable ?? runner, args, request, timeout);
    const output = JSON.parse(raw);
    if (!validateOutput(output, safeBundle)) throw Error('invalid output contract');
    return { output, failed: false, reason: null };
  } catch (error) { return { output: fallback(), failed: true, reason: error.message }; }
}
