#!/usr/bin/env node
// Work ledger drive: an overdue ledger item starts its own worker from the
// instruction file registered with it. The lead is only notified.
// Design: docs/work/work-ledger-drive.md. Guide: docs/guides/work-ledger-drive.md.
import { mkdir, open, readFile, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CLOSED = ['done', 'dropped'];
const STATUSES = ['open', 'waiting_human', ...CLOSED];
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim() !== '' && !/[\r\n]/.test(x);
const count = (x, fallback, min = 0) => {
  if (x === undefined) return fallback;
  if (!Number.isFinite(x) || x < min) throw Error('invalid number in configuration');
  return x;
};

export function safeName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw Error('invalid role or item id');
  return value;
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}
export const ledgerDir = root => path.join(root, '.agents/work/ledger');
export const ledgerPath = (root, role) => path.join(ledgerDir(root), `${safeName(role)}.json`);

export function validateConfig(config) {
  if (!object(config) || config.version !== 1 || !Array.isArray(config.roles) || !config.roles.length) throw Error('invalid drive configuration');
  const roles = new Set();
  for (const r of config.roles) {
    safeName(r?.role);
    if (roles.has(r.role)) throw Error('duplicate role in configuration');
    roles.add(r.role);
  }
  const w = config.worker;
  if (!object(w) || !Array.isArray(w.command) || !w.command.length || !w.command.every(text)) throw Error('worker.command must be a non-empty argument list');
  if (w.models !== undefined && !(Array.isArray(w.models) && w.models.every(text))) throw Error('invalid worker.models');
  const d = config.disk ?? {}, n = config.notify ?? {}, o = config.owner_confirm;
  if (o !== undefined && !(object(o) && o.provider === 'discord' && text(o.token_env) && Array.isArray(o.owner_ids) && o.owner_ids.length && o.owner_ids.every(id => /^\d+$/.test(id))))
    throw Error('invalid owner_confirm');
  if (n.command !== undefined && !(Array.isArray(n.command) && n.command.length && n.command.every(text))) throw Error('invalid notify.command');
  return {
    roles: [...roles],
    worker: {
      command: w.command, models: w.models ?? null, cwd: w.cwd ?? null, preamble: w.preamble ?? null,
      maxParallel: count(w.max_parallel, 2, 1), maxAttempts: count(w.max_attempts, 3, 1),
      retryMin: count(w.retry_min, 30), maxRunMin: count(w.max_run_min, 240),
    },
    disk: { path: d.path ?? '/', minFreeGb: count(d.min_free_gb, 2) },
    notify: { wakeDir: n.wake_dir ?? null, command: n.command ?? null, repeatMin: count(n.repeat_min, 60) },
    owner: o ? { tokenEnv: o.token_env, ownerIds: o.owner_ids, apiBase: o.api_base ?? 'https://discord.com/api/v10' } : null,
  };
}

// Same per-item shape as the role ledger files; drive fields are additive so
// other readers of the file keep working.
export function validateLedger(ledger, role) {
  if (!object(ledger) || ledger.version !== 1 || ledger.role !== role || !Array.isArray(ledger.items) || !object(ledger.report)) throw Error('invalid ledger schema');
  const ids = new Set();
  for (const item of ledger.items) {
    safeName(item?.id);
    if (ids.has(item.id) || typeof item.title !== 'string' || !object(item.from) || typeof item.note !== 'string'
      || !validDate(item.due) || !STATUSES.includes(item.status)) throw Error(`invalid ledger item ${item.id}`);
    if (item.prompt !== undefined && !(text(item.prompt) && text(item.result_file) && text(item.model))) throw Error(`invalid drive fields on ${item.id}`);
    ids.add(item.id);
  }
  return ledger;
}
const driven = item => typeof item.prompt === 'string';
// A close counts only with its record: a result address, or a verified owner message.
export const closedProperly = item => CLOSED.includes(item.status) && object(item.closed)
  && ((item.closed.by === 'result' && item.status === 'done' && text(item.closed.result))
    || (item.closed.by === 'owner' && text(item.closed.msg_id) && text(item.closed.author)));

// Kernel lock shared with other writers of the same ledger file; released on crash.
export async function withLock(file, fn) {
  await mkdir(path.dirname(file), { recursive: true });
  const child = spawn('flock', ['--exclusive', '--timeout', '10', `${file}.lock`, process.execPath, '-e',
    "process.stdout.write('locked\\n'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolve() : reject(Error(`lock helper failed (${signal || code})`))));
  });
  finished.catch(() => {});
  await Promise.race([
    new Promise(resolve => child.stdout.once('data', resolve)),
    finished.then(() => { throw Error('lock ended before acquisition'); }),
  ]);
  try { return await fn(); } finally { child.stdin.end(); await finished.catch(() => {}); }
}
async function atomicWrite(file, body, mode = 0o600) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, body, { mode, flag: 'wx' }); await rename(tmp, file); }
  finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
export async function readLedger(root, role) {
  return validateLedger(JSON.parse(await readFile(ledgerPath(root, role), 'utf8')), role);
}
async function changeLedger(root, role, update, { create = false, dry = false } = {}) {
  const file = ledgerPath(root, role);
  return withLock(file, async () => {
    let ledger;
    try { ledger = await readLedger(root, role); } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      ledger = { version: 1, role, report: { every_min: 0, channel: '', last_msg_id: null, last_at: null }, items: [] };
    }
    const result = await update(ledger);
    validateLedger(ledger, role);
    if (!dry) await atomicWrite(file, `${JSON.stringify(ledger, null, 2)}\n`);
    return result;
  });
}

// Process identity = pid + kernel start time, so a reused pid is not mistaken for the worker.
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!existsSync('/proc/self/stat')) { try { process.kill(pid, 0); return 'unknown'; } catch { return null; } }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
}
export const workerAlive = run => object(run) && run.ended_at == null && processStart(run.pid) !== null && processStart(run.pid) === run.start;

async function fileHasContent(file) {
  try { const s = await stat(file); return s.isFile() && s.size > 0; } catch { return false; }
}
async function instructionProblem(file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return 'instruction path is not a regular file';
    if (!(await readFile(file, 'utf8')).trim()) return 'instruction file is empty';
    return null;
  } catch { return 'instruction file does not exist'; }
}
export async function freeGb(dir) {
  const s = await statfs(dir);
  return (Number(s.bavail) * Number(s.bsize)) / 2 ** 30;
}

const DEFAULT_PREAMBLE = 'Work ledger item {id} ({role}): {title}\nWrite the result to: {result_file}\nInstruction file: {prompt}\n';
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (all, key) => (Object.hasOwn(values, key) ? values[key] : all));

async function launch(root, cfg, role, item, now) {
  const attempt = (item.run?.attempts ?? 0) + 1;
  const dir = path.join(ledgerDir(root), 'runs', item.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(item.result_file), { recursive: true });
  const values = { id: item.id, role, title: item.title, model: item.model, prompt: item.prompt, result_file: item.result_file };
  const promptFile = path.join(dir, `${attempt}.prompt.md`), log = path.join(dir, `${attempt}.log`);
  await writeFile(promptFile, `${fill(cfg.worker.preamble ?? DEFAULT_PREAMBLE, values)}\n${await readFile(item.prompt, 'utf8')}`, { mode: 0o600 });
  const [command, ...args] = cfg.worker.command.map(part => fill(part, values));
  const input = await open(promptFile, 'r'), output = await open(log, 'a', 0o600);
  const run = { pid: null, start: null, started_at: new Date(now).toISOString(), ended_at: null, attempts: attempt, log, error: null };
  // The owner-confirmation token is for confirm only; a worker never receives it.
  const env = { ...process.env, LEDGER_ROLE: role, LEDGER_ITEM_ID: item.id, LEDGER_RESULT_FILE: item.result_file };
  if (cfg.owner) delete env[cfg.owner.tokenEnv];
  try {
    const child = spawn(command, args, {
      cwd: path.resolve(root, item.cwd ?? cfg.worker.cwd ?? '.'), detached: true, stdio: [input.fd, output.fd, output.fd], env,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    run.pid = child.pid; run.start = processStart(child.pid);
  } catch (error) {
    run.error = error.message; run.ended_at = run.started_at;
  } finally { await input.close(); await output.close(); }
  item.run = run;
  return run;
}

async function notify(root, cfg, role, alert, now) {
  const body = `# Work ledger drive\n\nRole: ${role}\nItem: ${alert.id}\nReason: ${alert.reason}\nTitle: ${alert.title}\n${alert.detail}\n`;
  if (cfg.notify.wakeDir) {
    const dir = path.resolve(root, cfg.notify.wakeDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
    await atomicWrite(path.join(dir, `${stamp}-ledger-drive-${alert.reason}-${alert.id}-route-${role}.md`), body);
  }
  if (cfg.notify.command) {
    const [command, ...args] = cfg.notify.command;
    await new Promise(resolve => {
      const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LEDGER_ROLE: role, LEDGER_ITEM_ID: alert.id, LEDGER_ALERT: alert.reason } });
      child.once('error', resolve); child.once('exit', resolve);
      child.stdin.on('error', () => {}); child.stdin.end(body);
    });
  }
}

// One pass over every role ledger. Starts workers; never closes an item.
export async function tick(root, config, { now = Date.now(), dry = false, freeGbImpl = freeGb } = {}) {
  const cfg = validateConfig(config);
  const out = { launched: [], alerts: [], errors: [] };
  let live = 0;
  for (const role of cfg.roles) {
    try { live += (await readLedger(root, role)).items.filter(i => !closedProperly(i) && workerAlive(i.run)).length; }
    catch (error) { if (error.code !== 'ENOENT') out.errors.push(`${role}: ${error.message}`); }
  }
  let free;
  const diskLow = async () => { free ??= await freeGbImpl(cfg.disk.path); return free < cfg.disk.minFreeGb; };
  for (const role of cfg.roles) {
    const pending = [];
    try {
      await changeLedger(root, role, async ledger => {
        const alert = (item, reason, detail, always = false) => {
          const last = Date.parse(item.alerts?.[reason] ?? '');
          if (!always && Number.isFinite(last) && now - last < cfg.notify.repeatMin * 60000) return;
          item.alerts = { ...item.alerts, [reason]: new Date(now).toISOString() };
          pending.push({ role, id: item.id, reason, title: item.title, detail });
        };
        const active = ledger.items.filter(i => !CLOSED.includes(i.status) || (driven(i) && !closedProperly(i)));
        for (const item of active.sort((a, b) => Date.parse(a.due) - Date.parse(b.due))) {
          const overdue = Date.parse(item.due) < now;
          if (!driven(item)) {
            if (overdue) alert(item, 'no-instruction', `Due: ${item.due}\nNo instruction file is registered, so no worker can be started. Run adopt with --prompt --result-file --model.`);
            continue;
          }
          if (CLOSED.includes(item.status)) {
            alert(item, 'reopened', `Closed as ${item.status} without a result address or an owner confirmation record. Reopened.`, true);
            item.status = 'open'; item.closed = null;
          }
          if (workerAlive(item.run)) {
            if (now - Date.parse(item.run.started_at) > cfg.worker.maxRunMin * 60000) alert(item, 'long-run', `Worker pid ${item.run.pid} has run since ${item.run.started_at}.\nLog: ${item.run.log}`);
            continue;
          }
          if (item.run && item.run.ended_at == null) item.run.ended_at = new Date(now).toISOString();
          if (await fileHasContent(item.result_file)) {
            alert(item, 'result-ready', `Result: ${item.result_file}\nReview it and close with: done ${item.id} --result <address>`);
            continue;
          }
          if (!overdue) continue;
          const attempts = item.run?.attempts ?? 0;
          if (attempts >= cfg.worker.maxAttempts) {
            alert(item, 'attempts-exhausted', `Started ${attempts} time(s) without a result.\nLast log: ${item.run.log}\nFix the instruction or environment, then run: start ${item.id}`);
            continue;
          }
          if (item.run && now - Date.parse(item.run.started_at) < cfg.worker.retryMin * 60000) continue;
          const problem = await instructionProblem(item.prompt);
          if (problem) { alert(item, 'instruction-missing', `${problem}: ${item.prompt}`); continue; }
          if (await diskLow()) { alert(item, 'disk-low', `Free space ${free.toFixed(2)} GB on ${cfg.disk.path} is below ${cfg.disk.minFreeGb} GB. No worker started.`); continue; }
          if (live >= cfg.worker.maxParallel) { alert(item, 'queued', `Due: ${item.due}\n${live} worker(s) running (limit ${cfg.worker.maxParallel}). Starts when one finishes.`); continue; }
          if (dry) { out.launched.push({ role, id: item.id, dry: true }); live++; continue; }
          const run = await launch(root, cfg, role, item, now);
          if (run.error) { alert(item, 'launch-failed', `Worker command failed to start: ${run.error}`, true); continue; }
          live++;
          out.launched.push({ role, id: item.id, pid: run.pid, attempt: run.attempts });
          alert(item, 'launched', `Due: ${item.due}\nModel: ${item.model}\nWorker pid: ${run.pid} (attempt ${run.attempts})\nInstruction: ${item.prompt}\nResult: ${item.result_file}\nLog: ${run.log}`, true);
        }
      }, { dry });
    } catch (error) {
      if (error.code !== 'ENOENT') out.errors.push(`${role}: ${error.message}`);
    }
    for (const alert of pending) {
      out.alerts.push({ role: alert.role, id: alert.id, reason: alert.reason });
      if (!dry) await notify(root, cfg, role, alert, now).catch(error => out.errors.push(`notify ${alert.id}: ${error.message}`));
    }
  }
  return out;
}

// Owner confirmation = a message written by a configured owner that names the
// item (first 8 characters of its id), directly or as a reply to a message that names it.
export async function verifyOwnerMessage(cfg, item, channel, msgId, { fetchImpl = fetch, env = process.env } = {}) {
  if (!cfg.owner) throw Error('owner_confirm is not configured');
  if (!/^\d+$/.test(channel ?? '') || !/^\d+$/.test(msgId ?? '')) throw Error('confirm requires numeric --channel and --msg-id');
  const token = env[cfg.owner.tokenEnv];
  if (!token) throw Error(`token environment variable ${cfg.owner.tokenEnv} is not set`);
  const get = async (c, m) => {
    const response = await fetchImpl(`${cfg.owner.apiBase}/channels/${c}/messages/${m}`, { headers: { Authorization: `Bot ${token}` } });
    if (!response.ok) throw Error(`message lookup failed (${response.status})`);
    return response.json();
  };
  const message = await get(channel, msgId);
  if (message?.id !== msgId || !cfg.owner.ownerIds.includes(message.author?.id)) throw Error('message was not written by a configured owner');
  const key = item.id.slice(0, 8);
  let named = typeof message.content === 'string' && message.content.includes(key);
  if (!named && message.message_reference?.message_id) {
    const parent = message.referenced_message ?? await get(message.message_reference.channel_id ?? channel, message.message_reference.message_id);
    named = typeof parent?.content === 'string' && parent.content.includes(key);
  }
  if (!named) throw Error(`owner message does not name item ${key} (in its text or in the message it replies to)`);
  return { channel, msg_id: msgId, author: message.author.id };
}

export function parseArgs(args) {
  const opts = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry') opts.dry = true;
    else if (args[i].startsWith('--')) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw Error(`missing ${args[i]} value`);
      opts[args[i].slice(2)] = args[++i];
    } else positional.push(args[i]);
  }
  return { opts, positional };
}

async function driveFields(root, cfg, ledger, o, { allowExistingResult }) {
  if (!o.prompt) throw Error('an instruction file is required: --prompt <path>');
  if (!o['result-file']) throw Error('a result file is required: --result-file <path>');
  if (!text(o.model)) throw Error('a worker model is required: --model <name>');
  if (cfg.worker.models && !cfg.worker.models.includes(o.model)) throw Error(`model ${o.model} is not in worker.models`);
  const prompt = path.resolve(root, o.prompt), resultFile = path.resolve(root, o['result-file']);
  const problem = await instructionProblem(prompt);
  if (problem) throw Error(`registration refused: ${problem}: ${prompt}`);
  if (resultFile === prompt) throw Error('result file must differ from the instruction file');
  if (!allowExistingResult && existsSync(resultFile)) throw Error(`result file already exists: ${resultFile}`);
  if (ledger.items.some(i => !closedProperly(i) && i.result_file === resultFile)) throw Error('result file is already used by another open item');
  return { prompt, result_file: resultFile, model: o.model, ...(o.cwd ? { cwd: o.cwd } : {}), registered_at: new Date().toISOString(), run: null, closed: null };
}

export async function main(args = process.argv.slice(2), { fetchImpl = fetch, env = process.env } = {}) {
  const { opts: o, positional: [command, positionalId] } = parseArgs(args);
  const root = path.resolve(o.root || process.cwd());
  const config = JSON.parse(await readFile(path.resolve(root, o.config || 'config/work-ledger-drive.json'), 'utf8'));
  const cfg = validateConfig(config);
  if (command === 'tick') return tick(root, config, { dry: o.dry === true });
  const role = safeName(o.role ?? (cfg.roles.length === 1 ? cfg.roles[0] : undefined));
  if (!cfg.roles.includes(role)) throw Error('role missing in configuration');
  if (command === 'drop') throw Error('drop is not available. Close with: done <id> --result <address>, or confirm <id> --channel <id> --msg-id <id> (owner confirmation).');
  if (command === 'list') {
    const ledger = await readLedger(root, role);
    return ledger.items.filter(i => !closedProperly(i) && !(CLOSED.includes(i.status) && !driven(i)))
      .map(i => `${i.id} [${i.status}] ${i.due} ${driven(i) ? (workerAlive(i.run) ? `worker:${i.run.pid}` : `runs:${i.run?.attempts ?? 0}`) : 'no-instruction'} ${i.title}`).join('\n') || '(no open items)';
  }
  const id = positionalId ?? o.id;
  const find = ledger => {
    const item = ledger.items.find(i => i.id === id);
    if (!item) throw Error('unknown item');
    return item;
  };
  const close = (item, status, closed) => {
    if (closedProperly(item)) throw Error('item is already closed');
    const at = new Date().toISOString();
    Object.assign(item, { status, closed: { ...closed, at }, checked_at: at });
    if (o.note) item.note = o.note;
    return `${item.id} ${status}`;
  };
  if (command === 'add') return changeLedger(root, role, async ledger => {
    if (!text(o.title) || !validDate(o.due) || !text(o.channel) || !text(o['msg-id'])) throw Error('add requires --title --due (UTC ISO) --channel --msg-id --prompt --result-file --model');
    const itemId = safeName(o.id || randomUUID());
    if (ledger.items.some(i => i.id === itemId)) throw Error('duplicate id');
    const fields = await driveFields(root, cfg, ledger, o, { allowExistingResult: false });
    ledger.items.push({ id: itemId, title: o.title, from: { channel: o.channel, msg_id: o['msg-id'], quote: o.quote || '' }, due: o.due, status: 'open', worker: null, checked_at: null, note: o.note || '', ...fields });
    return itemId;
  }, { create: true });
  if (command === 'adopt') return changeLedger(root, role, async ledger => {
    const item = find(ledger);
    if (driven(item)) throw Error('item already has an instruction file');
    if (CLOSED.includes(item.status)) throw Error('item is closed');
    Object.assign(item, await driveFields(root, cfg, ledger, o, { allowExistingResult: true }));
    return item.id;
  });
  if (command === 'start') {
    const now = Date.now();
    const started = await changeLedger(root, role, async ledger => {
      const item = find(ledger);
      if (!driven(item) || closedProperly(item)) throw Error('item is closed or has no instruction file');
      if (workerAlive(item.run)) throw Error(`worker already running (pid ${item.run.pid})`);
      const problem = await instructionProblem(item.prompt);
      if (problem) throw Error(`${problem}: ${item.prompt}`);
      const free = await freeGb(cfg.disk.path);
      if (free < cfg.disk.minFreeGb) throw Error(`free space ${free.toFixed(2)} GB is below ${cfg.disk.minFreeGb} GB`);
      const run = await launch(root, cfg, role, item, now);
      if (run.error) throw Error(`worker command failed to start: ${run.error}`);
      return { id: item.id, title: item.title, run };
    });
    return `${started.id} worker pid ${started.run.pid} (attempt ${started.run.attempts})`;
  }
  if (command === 'attach') return changeLedger(root, role, ledger => {
    const item = find(ledger), pid = Number(o.pid), start = processStart(pid);
    if (!driven(item) || closedProperly(item)) throw Error('item is closed or has no instruction file');
    if (start === null) throw Error('no running process with that pid');
    if (workerAlive(item.run)) throw Error(`worker already running (pid ${item.run.pid})`);
    item.run = { pid, start, started_at: new Date().toISOString(), ended_at: null, attempts: item.run?.attempts ?? 0, log: null, error: null };
    return `${item.id} attached pid ${pid}`;
  });
  if (command === 'done') return changeLedger(root, role, async ledger => {
    const item = find(ledger);
    if (!text(o.result)) throw Error('done requires --result <file path or URL>');
    let result = o.result;
    if (!/^https?:\/\/\S+$/.test(result)) {
      result = path.resolve(root, result);
      if (!(await fileHasContent(result))) throw Error(`result file is missing or empty: ${result}`);
    }
    return close(item, 'done', { by: 'result', result });
  });
  if (command === 'confirm') {
    const as = o.as ?? 'dropped';
    if (!CLOSED.includes(as)) throw Error('--as must be done or dropped');
    const record = await verifyOwnerMessage(cfg, find(await readLedger(root, role)), o.channel, o['msg-id'], { fetchImpl, env });
    return changeLedger(root, role, ledger => close(find(ledger), as, { by: 'owner', ...record }));
  }
  throw Error('commands: add adopt start attach done confirm list tick');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().then(value => console.log(typeof value === 'string' ? value : JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
