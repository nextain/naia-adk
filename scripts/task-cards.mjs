#!/usr/bin/env node
// Task cards: one file per piece of work, per role, checked on a schedule so nothing is dropped.
// Cards are never deleted: a deferral keeps its reason and revisit date, a finished card keeps its result.
// Card events and check results can be posted to Discord or the Naia messenger through scripts/notify.mjs.
// Guide: docs/guides/task-cards.md.
//
// Usage:
//   node scripts/task-cards.mjs [--root <repo>] [--config <file>] [--now <ISO>] <command> ...
//   new --role <role> --title <title> --source <origin> --next <next action> [--due <YYYY-MM-DD[THH:MM]>]
//       [--progress <path>] [--calendar yes|no]
//   move <id> [--next <text>] [--status doing|waiting] [--due ...] [--calendar yes|no] [--progress ...]
//   defer <id> --reason <why> --revisit <YYYY-MM-DD>
//   done <id> --result <result link>
//   ack --role <role> --ref <message or event id> --reason <why no card>
//   list --role <role>
//   check [--role <role>] [--since-hours 72] [--stale-hours 24] [--json] [--notify]
//   board
//   tick --role <role> --session <id> [--every-min 60]
//
// Contract:
// - Errors print `[error] ...` to stderr and exit 2. tick never fails (it runs from a hook): any error is silent, exit 0.
// - check exits 0 even with problems; with --notify it exits 3 when the alert could not be sent.
// - A card command whose alert fails still keeps the card change and exits 0 with a `[warn]` line.
// - The ledger (ledger.jsonl) is append-only.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createNotifier, validateNotify, notifyKind, recipientOk } from './notify.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_CONFIG = 'config/task-cards.json';

const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const EVENTS = ['new', 'move', 'defer', 'done'];
const KIND_LABEL = {
  overdue: 'overdue',
  stale: 'stale',
  revisit: 'revisit date passed',
  'missing-field': 'missing field',
  vanished: 'vanished card',
  'unlinked-inbox': 'leader request without card',
  'no-calendar': 'not on calendar',
  repeat: 'keeps slipping',
};
const CHECK_ORDER = Object.keys(KIND_LABEL);
const CARD_KEYS = ['id', 'title', 'owner', 'status', 'source', 'received', 'due', 'next', 'moved', 'calendar', 'progress', 'defer_reason', 'revisit', 'defer_count', 'result'];
const MAX_CHECK_LINES = 15;

export function fail(message) {
  throw new Error(message);
}

// ── configuration ─────────────────────────────────────────────

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const relPath = value => typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');

// Every field is optional; an absent file means defaults and no alerts.
export function loadConfig(root, file) {
  const explicit = Boolean(file);
  const full = path.resolve(root, file || DEFAULT_CONFIG);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (err) {
    if (!explicit && err.code === 'ENOENT') return normalizeConfig({});
    fail(`cannot read config: ${full}`);
  }
  let raw;
  try { raw = JSON.parse(text); } catch { fail(`config is not JSON: ${full}`); }
  return normalizeConfig(raw);
}

export function normalizeConfig(raw) {
  if (!object(raw)) fail('config must be an object');
  const c = { cardsDir: 'docs/team/cards', staleHours: 24, sinceHours: 72, requireCalendar: false, inbox: null, alerts: null, notify: undefined, ...raw };
  if (!relPath(c.cardsDir)) fail('cardsDir must be a relative path inside the repository');
  for (const key of ['staleHours', 'sinceHours']) if (!(Number.isFinite(c[key]) && c[key] > 0)) fail(`${key} must be a positive number`);
  if (typeof c.requireCalendar !== 'boolean') fail('requireCalendar must be true or false');
  if (c.inbox !== null) {
    if (!object(c.inbox) || !relPath(c.inbox.dir) || !Array.isArray(c.inbox.leaderIds) || c.inbox.leaderIds.some(id => !/^[\p{L}\p{N}_-]+$/u.test(String(id)))) fail('inbox needs dir (relative) and leaderIds');
  }
  validateNotify(c.notify);
  if (c.alerts !== null) {
    const a = c.alerts;
    if (!object(a)) fail('alerts must be an object');
    a.events ??= ['new', 'defer', 'done'];
    if (!Array.isArray(a.events) || a.events.some(e => !EVENTS.includes(e))) fail(`alerts.events must be a list of ${EVENTS.join('/')}`);
    if (a.linkBase !== undefined && !/^https?:\/\/[^\s?#]+$/.test(a.linkBase)) fail('alerts.linkBase must be an http(s) URL without query or fragment');
    if (a.owners !== undefined && (!object(a.owners) || Object.entries(a.owners).some(([role, who]) => !ROLE_RE.test(role) || !recipientOk(c.notify, who)))) fail('alerts.owners must map role to a recipient');
    if (notifyKind(c.notify) === 'discord') {
      if (!/^\d+$/.test(a.channelId ?? '')) fail('alerts.channelId (Discord channel ID) required for Discord alerts');
      if (a.tokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(a.tokenEnv)) fail('invalid alerts.tokenEnv');
    }
  }
  return c;
}

// ── parsing ─────────────────────────────────────────────

function parseCli(argv) {
  const global = { root: DEFAULT_ROOT, now: null, config: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = arg.match(/^--(root|now|config)(?:=(.*))?$/);
    if (m && m[2] !== undefined) { global[m[1]] = m[2]; continue; }
    if (m && i + 1 < argv.length) { global[m[1]] = argv[++i]; continue; }
    rest.push(arg);
  }
  return { global, rest };
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq >= 0) { flags[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) flags[key] = args[++i];
    else flags[key] = 'yes';
  }
  return { flags, positional };
}

export function checkRole(role) {
  if (!ROLE_RE.test(role || '')) fail(`invalid role: ${role}`);
  return role;
}

export function checkId(id) {
  const base = String(id || '').replace(/\.md$/, '');
  if (!base || base.length > 160 || base.startsWith('.') || base.includes('..') || /[\\/]/.test(base)) fail(`card id leaves the cards folder: ${id}`);
  return base;
}

function nowMs(value) {
  if (!value) return Date.now();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail(`invalid --now: ${value}`);
  return ms;
}

const nowIso = ms => new Date(ms).toISOString();
const datePrefix = ms => nowIso(ms).slice(0, 10).replaceAll('-', '');

// File-name part from the title. Letters of any script survive; spaces become hyphens.
export function slugify(title) {
  const slug = String(title || '').trim().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'card';
}

// A bare date means the end of that day (UTC); with a time, that time (UTC).
export function dueMs(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!DUE_RE.test(text)) fail(`invalid date (YYYY-MM-DD or YYYY-MM-DDTHH:MM): ${value}`);
  const ms = text.length === 10 ? Date.parse(`${text}T23:59:59Z`) : Date.parse(`${text}:00Z`);
  if (!Number.isFinite(ms)) fail(`invalid date: ${value}`);
  return ms;
}

export function parseCard(text) {
  const match = String(text).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) fail('card has no front matter');
  const card = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) card[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  card.defer_count = Number.parseInt(card.defer_count || '0', 10) || 0;
  card.body = match[2];
  return card;
}

export function serializeCard(card) {
  const lines = ['---'];
  for (const key of CARD_KEYS) {
    let value = card[key] ?? '';
    if (key === 'defer_count') value = String(Number.parseInt(value, 10) || 0);
    lines.push(`${key}: ${String(value).replace(/\n/g, ' ')}`);
  }
  lines.push('---', card.body || '');
  return lines.join('\n');
}

// ── storage ─────────────────────────────────────────────

export const cardsRoot = (root, config) => path.join(root, config.cardsDir);
export const cardsDir = (root, config, role) => path.join(cardsRoot(root, config), role);
export const cardFile = (root, config, role, id) => path.join(cardsDir(root, config, role), `${id}.md`);
export const ledgerFile = (root, config) => path.join(cardsRoot(root, config), 'ledger.jsonl');
export const boardFile = (root, config) => path.join(cardsRoot(root, config), 'index.md');
export const tickFile = (root, session) => path.join(root, '.agents', 'work', 'task-cards', `tick-${session}.json`);

// Finds a card by id across role folders; two hits stop the command.
export function findCard(root, config, id) {
  const base = checkId(id);
  let entries = [];
  try { entries = fs.readdirSync(cardsRoot(root, config), { withFileTypes: true }); } catch {}
  const hits = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ROLE_RE.test(entry.name)) continue;
    const file = path.join(cardsRoot(root, config), entry.name, `${base}.md`);
    if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) hits.push({ role: entry.name, file });
  }
  if (hits.length === 0) fail(`no such card: ${base}`);
  if (hits.length > 1) fail(`card id is not unique (${hits.map(h => `${h.role}/${base}`).join(', ')})`);
  return { ...hits[0], id: base };
}

export function loadCard(file) {
  return { ...parseCard(fs.readFileSync(file, 'utf8')), file };
}

// All cards including finished ones. A broken file stops the run rather than being skipped silently.
export function loadRoleCards(root, config, role) {
  checkRole(role);
  let names = [];
  try { names = fs.readdirSync(cardsDir(root, config, role)); } catch { return []; }
  const cards = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    try { checkId(id); } catch { continue; }
    cards.push({ role, id, ...loadCard(path.join(cardsDir(root, config, role), name)) });
  }
  return cards;
}

export function discoverRoles(root, config) {
  const roles = new Set();
  const dirs = [cardsRoot(root, config), ...(config.inbox ? [path.join(root, config.inbox.dir)] : [])];
  for (const dir of dirs) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory() && ROLE_RE.test(entry.name)) roles.add(entry.name);
  }
  return [...roles].sort();
}

export function appendLedger(root, config, entry) {
  const file = ledgerFile(root, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readLedger(root, config) {
  let text = '';
  try { text = fs.readFileSync(ledgerFile(root, config), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function compareDue(a, b) {
  const am = dueMs(a.due), bm = dueMs(b.due);
  if (am === null && bm === null) return byId(a, b);
  if (am === null) return 1;
  if (bm === null) return -1;
  return am - bm || byId(a, b);
}

export function listLines(cards) {
  return cards
    .filter(c => c.status !== 'done')
    .sort(compareDue)
    .map(c => `- [${c.status}] ${c.id} | due: ${c.due || 'none'} | next: ${c.next || 'none'} | moved: ${c.moved || 'none'}`);
}

// ── check ─────────────────────────────────────────────

// Card ↔ inbox links are message IDs and event IDs only. Channel IDs are not links: a channel URL in a card's
// source would otherwise link every request in that channel.
const EVT_RE = /\bevt-[0-9a-f]{4,}\b/g;
const MSGID_RE = /\b\d{17,20}\b/g;

// Inbox files use "- From: name (id)" and "- Message: <id>" header lines (the Korean labels
// "보낸 사람" and "원문 글" written by older wake scripts are read too).
const FROM_RE = /^-\s*(?:From|보낸 사람)\s*:.*\(([^)]+)\)\s*$/m;
const MESSAGE_LINE = /^-\s*(?:Message|원문 글)\s*:/;

export function inboxSender(text) {
  return String(text || '').match(FROM_RE)?.[1] ?? null;
}

function inboxLinkRefs(text, name) {
  const refs = new Set();
  for (const m of String(text || '').matchAll(EVT_RE)) refs.add(m[0]);
  for (const m of String(name || '').matchAll(EVT_RE)) refs.add(m[0]);
  for (const line of String(text || '').split('\n')) {
    if (!MESSAGE_LINE.test(line)) continue;
    for (const m of line.matchAll(MSGID_RE)) refs.add(m[0]);
  }
  return [...refs];
}

function sourceLinkRefs(source) {
  const refs = new Set();
  for (const m of String(source || '').matchAll(EVT_RE)) refs.add(m[0]);
  for (const m of String(source || '').matchAll(MSGID_RE)) refs.add(m[0]);
  return refs;
}

// Unread inbox files plus the ones the wake moved to read/: being read is not the same as having a card.
function inboxFiles(dir) {
  const seen = new Set();
  const out = [];
  for (const sub of ['', 'read']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)).filter(n => n.endsWith('.md')).sort(); } catch { continue; }
    for (const name of names) if (!seen.has(name)) { seen.add(name); out.push(path.join(dir, sub, name)); }
  }
  return out;
}

// Returns [{ kind, role, id, reason }] sorted by CHECK_ORDER, role, id.
export function runCheck(root, config, roles, { now = Date.now(), sinceHours = config.sinceHours, staleHours = config.staleHours } = {}) {
  const problems = [];
  const ledger = readLedger(root, config);
  const acksByRole = new Map();
  for (const entry of ledger) {
    if (entry.cmd !== 'ack' || !entry.role) continue;
    if (!acksByRole.has(entry.role)) acksByRole.set(entry.role, new Set());
    for (const key of [entry.ref, entry.id]) if (key) acksByRole.get(entry.role).add(String(key));
  }
  const seen = new Set();
  for (const entry of ledger) {
    if (!EVENTS.includes(entry.cmd) || !entry.role || !entry.id) continue;
    let id;
    try { id = checkId(entry.id); } catch { continue; }
    const key = `${entry.role}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.statSync(cardFile(root, config, entry.role, id), { throwIfNoEntry: false })?.isFile()) {
      problems.push({ kind: 'vanished', role: entry.role, id, reason: `in the ledger (${entry.cmd}) but the file is gone` });
    }
  }
  for (const role of roles) {
    const cards = loadRoleCards(root, config, role);
    for (const card of cards) {
      const open = card.status !== 'done';
      const due = dueMs(card.due || '');
      if (open && due !== null && due < now) problems.push({ kind: 'overdue', role, id: card.id, reason: `due ${card.due} has passed` });
      if (card.status === 'doing') {
        const moved = Date.parse(card.moved || '');
        if (!Number.isFinite(moved)) problems.push({ kind: 'missing-field', role, id: card.id, reason: 'moved is empty' });
        else if (now - moved > staleHours * 3600_000) problems.push({ kind: 'stale', role, id: card.id, reason: `no movement since ${card.moved}` });
      }
      if (card.status === 'deferred' && card.revisit) {
        const revisit = dueMs(card.revisit);
        if (revisit !== null && revisit < now) problems.push({ kind: 'revisit', role, id: card.id, reason: `revisit date ${card.revisit} has passed (reason: ${card.defer_reason || 'none'})` });
      }
      if (card.status === 'done' && !card.result) problems.push({ kind: 'missing-field', role, id: card.id, reason: 'done without a result' });
      if (card.status === 'deferred' && (!card.defer_reason || !card.revisit)) problems.push({ kind: 'missing-field', role, id: card.id, reason: 'deferred without reason or revisit date' });
      if (config.requireCalendar && open && card.due && card.calendar !== 'yes') problems.push({ kind: 'no-calendar', role, id: card.id, reason: `due ${card.due} but not on the calendar` });
      if (open && (card.defer_count >= 2 || (due !== null && now - due > 48 * 3600_000))) {
        const why = card.defer_count >= 2 ? `deferred ${card.defer_count} times` : `more than two days past due ${card.due}`;
        problems.push({ kind: 'repeat', role, id: card.id, reason: `${why}: add or hand over to another role` });
      }
    }
    if (!config.inbox) continue;
    const leaders = new Set(config.inbox.leaderIds.map(String));
    const acks = acksByRole.get(role) || new Set();
    for (const file of inboxFiles(path.join(root, config.inbox.dir, role))) {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile() || now - stat.mtimeMs > sinceHours * 3600_000) continue;
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!leaders.has(inboxSender(text))) continue;
      const name = path.basename(file);
      const refs = inboxLinkRefs(text, name);
      const linked = refs.some(ref => cards.some(c => sourceLinkRefs(c.source).has(ref)) || acks.has(ref));
      if (!linked) problems.push({ kind: 'unlinked-inbox', role, id: name.replace(/\.md$/, ''), reason: `leader request (${refs[0] || 'no link'}) has no card or ack` });
    }
  }
  const rank = new Map(CHECK_ORDER.map((k, i) => [k, i]));
  problems.sort((a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99) || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0) || byId(a, b));
  return problems;
}

export function formatProblems(problems) {
  if (problems.length === 0) return ['nothing missed'];
  return problems.map(p => `[${KIND_LABEL[p.kind] || p.kind}] ${p.role}/${p.id}: ${p.reason}`);
}

// ── alerts ─────────────────────────────────────────────

export function cardLink(config, role, id) {
  const rel = `${config.cardsDir}/${role}/${id}.md`.replace(/\\/g, '/');
  return config.alerts?.linkBase ? `${config.alerts.linkBase.replace(/\/$/, '')}/${rel.split('/').map(encodeURIComponent).join('/')}` : rel;
}

const mention = (config, role) => (config.alerts?.owners?.[role] ? `<@${config.alerts.owners[role]}> ` : '');
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// One short line per card event; the link opens the card file.
export function eventMessage(config, cmd, role, card) {
  const head = `[task card] ${mention(config, role)}${role}/${card.id}`;
  const link = cardLink(config, role, card.id);
  if (cmd === 'new') return `${head} new: ${oneLine(card.title)} | due ${card.due || 'none'} | next: ${oneLine(card.next)} | ${link}`;
  if (cmd === 'move') return `${head} ${card.status} | due ${card.due || 'none'} | next: ${oneLine(card.next)} | ${link}`;
  if (cmd === 'defer') return `${head} deferred (${card.defer_count}x): ${oneLine(card.defer_reason)} | revisit ${card.revisit} | ${link}`;
  return `${head} done: ${oneLine(card.title)} | result: ${oneLine(card.result)}`;
}

export function checkMessage(config, problems) {
  const roles = [...new Set(problems.map(p => p.role))];
  const lines = formatProblems(problems);
  const shown = lines.slice(0, MAX_CHECK_LINES);
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more`);
  return [`[task card check] ${roles.map(r => mention(config, r).trim()).filter(Boolean).join(' ')} ${problems.length} problem(s)`.replace(/\s+/g, ' '), ...shown.map(l => `- ${l}`)].join('\n');
}

// Recipients a messenger post should treat as people (not roles sharing the same ID).
const people = config => (notifyKind(config.notify) === 'messenger' ? Object.values(config.alerts?.owners ?? {}) : []);

export function makeNotifier(config, { env = process.env, fetchImpl } = {}) {
  if (!config.alerts) return null;
  const token = notifyKind(config.notify) === 'discord' ? env[config.alerts.tokenEnv ?? 'DISCORD_BOT_TOKEN'] : undefined;
  return createNotifier(config.notify, { token, env, ...(fetchImpl ? { fetchImpl } : {}) });
}

async function sendAlert(config, notifier, stage, content) {
  const mentions = notifyKind(config.notify) === 'discord' ? Object.values(config.alerts.owners ?? {}).filter(id => content.includes(`<@${id}>`)) : [];
  return notifier.send({ stage, channelId: config.alerts.channelId, content, mentions, people: people(config) });
}

// Card change is already on disk; an alert failure only warns.
async function alertEvent(ctx, cmd, role, card) {
  const { config, notifier } = ctx;
  if (!notifier || !config.alerts.events.includes(cmd)) return '';
  try {
    await sendAlert(config, notifier, 'event', eventMessage(config, cmd, role, card));
    return '';
  } catch (err) {
    return `[warn] alert not sent (${err.uncertain ? 'may have been delivered' : 'not delivered'}): ${err.message}`;
  }
}

// ── commands ─────────────────────────────────────────────

function need(flags, key) {
  const value = flags[key];
  if (value === undefined || String(value).trim() === '') fail(`--${key} is required`);
  return String(value);
}

function checkCalendar(value) {
  if (value === undefined) return null;
  if (value !== 'yes' && value !== 'no') fail('--calendar is yes or no');
  return value;
}

const cardId = (flags, positional) => checkId(positional[0] || flags.id || fail('card id is required'));

async function cmdNew(ctx, flags) {
  const { root, config, ms } = ctx;
  const role = checkRole(flags.role || fail('--role is required'));
  const title = need(flags, 'title'), source = need(flags, 'source'), next = need(flags, 'next');
  const due = flags.due === undefined ? '' : String(flags.due);
  if (due) dueMs(due);
  const calendar = checkCalendar(flags.calendar) || 'no';
  const stamp = nowIso(ms);
  const dir = cardsDir(root, config, role);
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugify(title);
  let id = `${datePrefix(ms)}-${slug}`;
  for (let n = 2; fs.existsSync(path.join(dir, `${id}.md`)); n++) id = checkId(`${datePrefix(ms)}-${slug}-${n}`);
  const card = { id, title, owner: role, status: 'doing', source, received: stamp, due, next, moved: stamp, calendar, progress: flags.progress ? String(flags.progress) : '', defer_reason: '', revisit: '', defer_count: '0', result: '' };
  fs.writeFileSync(path.join(dir, `${id}.md`), serializeCard(card));
  appendLedger(root, config, { at: stamp, cmd: 'new', role, id, changes: { status: 'doing', due, next, calendar } });
  return [`created ${role}/${id}`, await alertEvent(ctx, 'new', role, card)];
}

async function cmdMove(ctx, flags, positional) {
  const { root, config, ms } = ctx;
  const found = findCard(root, config, cardId(flags, positional));
  const card = loadCard(found.file);
  const changes = {};
  if (flags.status !== undefined) {
    if (flags.status !== 'doing' && flags.status !== 'waiting') fail('move --status is doing or waiting');
    changes.status = card.status = flags.status;
  }
  if (flags.next !== undefined) changes.next = card.next = String(flags.next);
  if (flags.due !== undefined) { dueMs(String(flags.due)); changes.due = card.due = String(flags.due); }
  if (flags.calendar !== undefined) changes.calendar = card.calendar = checkCalendar(flags.calendar);
  if (flags.progress !== undefined) changes.progress = card.progress = String(flags.progress);
  changes.moved = card.moved = nowIso(ms);
  fs.writeFileSync(found.file, serializeCard(card));
  appendLedger(root, config, { at: card.moved, cmd: 'move', role: found.role, id: found.id, changes });
  return [`moved ${found.role}/${found.id}`, await alertEvent(ctx, 'move', found.role, { ...card, id: found.id })];
}

async function cmdDefer(ctx, flags, positional) {
  const { root, config, ms } = ctx;
  const id = cardId(flags, positional);
  // Both reason and revisit date are required; stop before touching the card or the ledger.
  const reason = String(flags.reason ?? '').trim(), revisit = String(flags.revisit ?? '').trim();
  if (!reason || !revisit) fail('defer needs --reason and --revisit');
  dueMs(revisit);
  const found = findCard(root, config, id);
  const card = loadCard(found.file);
  Object.assign(card, { defer_reason: reason, revisit, status: 'deferred', defer_count: (Number.parseInt(card.defer_count, 10) || 0) + 1, moved: nowIso(ms) });
  fs.writeFileSync(found.file, serializeCard(card));
  appendLedger(root, config, { at: card.moved, cmd: 'defer', role: found.role, id: found.id, changes: { status: 'deferred', defer_reason: reason, revisit, defer_count: card.defer_count, moved: card.moved } });
  return [`deferred ${found.role}/${found.id} (revisit ${revisit})`, await alertEvent(ctx, 'defer', found.role, { ...card, id: found.id })];
}

async function cmdDone(ctx, flags, positional) {
  const { root, config, ms } = ctx;
  const id = cardId(flags, positional);
  const result = need(flags, 'result');
  const found = findCard(root, config, id);
  const card = loadCard(found.file);
  Object.assign(card, { status: 'done', result, moved: nowIso(ms) });
  fs.writeFileSync(found.file, serializeCard(card));
  appendLedger(root, config, { at: card.moved, cmd: 'done', role: found.role, id: found.id, changes: { status: 'done', result, moved: card.moved } });
  const warn = await alertEvent(ctx, 'done', found.role, { ...card, id: found.id });
  const rest = listLines(loadRoleCards(root, config, found.role));
  const checks = formatProblems(runCheck(root, config, [found.role], { now: ms }));
  return [`done ${found.role}/${found.id}`, 'next (by due date):', ...(rest.length ? rest : ['(no cards left)']), 'check:', ...checks, warn];
}

function cmdAck(ctx, flags) {
  const role = checkRole(flags.role || fail('--role is required'));
  const ref = need(flags, 'ref'), reason = need(flags, 'reason');
  appendLedger(ctx.root, ctx.config, { at: nowIso(ctx.ms), cmd: 'ack', role, id: ref, ref, reason });
  return [`recorded ${role} request ${ref} as not a card`];
}

function cmdList(ctx, flags) {
  const lines = listLines(loadRoleCards(ctx.root, ctx.config, checkRole(flags.role || fail('--role is required'))));
  if (lines.length === 0) console.error('[info] no cards left');
  return lines;
}

async function cmdCheck(ctx, flags) {
  const { root, config, ms } = ctx;
  const roles = flags.role ? [checkRole(flags.role)] : discoverRoles(root, config);
  const sinceHours = flags['since-hours'] === undefined ? config.sinceHours : Number(flags['since-hours']);
  const staleHours = flags['stale-hours'] === undefined ? config.staleHours : Number(flags['stale-hours']);
  if (!Number.isFinite(sinceHours) || !Number.isFinite(staleHours)) fail('--since-hours and --stale-hours are numbers');
  const problems = runCheck(root, config, roles, { now: ms, sinceHours, staleHours });
  const out = flags.json !== undefined ? [JSON.stringify(problems, null, 2)] : formatProblems(problems);
  if (flags.notify === undefined || problems.length === 0) return out;
  if (!ctx.notifier) fail('check --notify needs an alerts block in the config');
  try {
    await sendAlert(config, ctx.notifier, 'check', checkMessage(config, problems));
  } catch (err) {
    console.error(`[error] check alert not sent (${err.uncertain ? 'may have been delivered' : 'not delivered'}): ${err.message}`);
    ctx.exitCode = 3;
  }
  return out;
}

function cmdBoard(ctx) {
  const { root, config, ms } = ctx;
  const roles = discoverRoles(root, config);
  const lines = ['# Task cards', '', `Updated: ${nowIso(ms)}`, ''];
  const problems = runCheck(root, config, roles, { now: ms });
  const marks = new Map();
  for (const p of problems) {
    if (!['overdue', 'stale', 'revisit'].includes(p.kind)) continue;
    const key = `${p.role}/${p.id}`;
    if (!marks.has(key)) marks.set(key, []);
    if (!marks.get(key).includes(KIND_LABEL[p.kind])) marks.get(key).push(KIND_LABEL[p.kind]);
  }
  const cell = v => String(v || 'none').replace(/\|/g, '｜').replace(/\n/g, ' ');
  const weekAgo = ms - 7 * 24 * 3600_000;
  for (const role of roles) {
    lines.push(`## ${role}`, '', '| Status | Card | Due | Next | Moved |', '|---|---|---|---|---|');
    for (const card of loadRoleCards(root, config, role).sort(compareDue)) {
      if (card.status === 'done' && !(Date.parse(card.moved || '') >= weekAgo)) continue;
      const tag = marks.get(`${role}/${card.id}`);
      lines.push(`| ${tag ? `${card.status} [${tag.join(', ')}]` : card.status} | ${cell(card.title)} (${cell(card.id)}) | ${cell(card.due)} | ${cell(card.next)} | ${cell(card.moved)} |`);
    }
    lines.push('');
  }
  lines.push('## Missed or slipping', '', ...formatProblems(problems), '');
  const file = boardFile(root, config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n').replace(/\n+$/, '')}\n`);
  return [`wrote ${path.relative(root, file)}`];
}

function cmdTick(ctx, flags) {
  // Runs from a session hook: swallow every error so the session is never blocked.
  try {
    const { root, config, ms } = ctx;
    const role = String(flags.role || ''), session = String(flags.session || '');
    if (!ROLE_RE.test(role) || !/^[A-Za-z0-9._-]{1,128}$/.test(session) || session === '.' || session === '..') return [];
    const everyMin = flags['every-min'] === undefined ? 60 : Number(flags['every-min']);
    if (!Number.isFinite(everyMin) || everyMin <= 0) return [];
    const file = tickFile(root, session);
    let last = NaN;
    try { last = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).last); } catch {}
    if (Number.isFinite(last) && ms - last < everyMin * 60_000) return [];
    const list = listLines(loadRoleCards(root, config, role)).slice(0, 8);
    const checks = formatProblems(runCheck(root, config, [role], { now: ms })).slice(0, 6);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ last: nowIso(ms) })}\n`);
    return ['[task cards hourly check]', ...list, ...checks];
  } catch {
    return [];
  }
}

// ── entry ─────────────────────────────────────────────

// Returns { out, exitCode }. deps.env / deps.fetchImpl are for tests.
export async function main(argv, deps = {}) {
  const { global, rest } = parseCli(argv);
  const root = path.resolve(global.root);
  const [cmd, ...args] = rest;
  if (!cmd) fail('command required (new/move/defer/done/ack/list/check/board/tick)');
  const { flags, positional } = parseFlags(args);
  const ms = nowMs(global.now);
  if (cmd === 'tick') {
    let config;
    try { config = loadConfig(root, global.config); } catch { return { out: '', exitCode: 0 }; }
    return { out: cmdTick({ root, config, ms }, flags).join('\n'), exitCode: 0 };
  }
  const config = loadConfig(root, global.config);
  const ctx = { root, config, ms, exitCode: 0, notifier: ['new', 'move', 'defer', 'done', 'check'].includes(cmd) ? makeNotifier(config, deps) : null };
  const handlers = { new: cmdNew, move: cmdMove, defer: cmdDefer, done: cmdDone, ack: cmdAck, list: cmdList, check: cmdCheck, board: cmdBoard };
  if (!handlers[cmd]) fail(`unknown command: ${cmd}`);
  const lines = await handlers[cmd](ctx, flags, positional);
  return { out: lines.filter(Boolean).join('\n'), exitCode: ctx.exitCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { out, exitCode } = await main(process.argv.slice(2));
    if (out) process.stdout.write(`${out}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    console.error(`[error] ${err.message}`);
    process.exit(2);
  }
}
