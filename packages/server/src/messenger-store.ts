import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { messengerRoleIds } from './messenger-roles.js'

export interface MessengerAuthor { id: string; kind: 'human' | 'agent' }
export interface MessengerMessage {
  id: string; channel_id: string; author_id: string; author_kind: 'human' | 'agent';
  /** A person's latest display name; null for agents and for people the gate has not named. */
  author_name: string | null;
  body: string; reply_to_id: string | null; thread_root_id: string | null;
  created_at: number; edited_at: number | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  attachments: Record<string, unknown>[];
  approval: { plan_code: string; step_code: string; status: string } | null;
}
function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let previousTime = -1;
let previousRandom = 0n;
function ulid(now: number): string {
  const time = Math.max(Math.floor(now), previousTime);
  previousRandom = time === previousTime ? previousRandom + 1n : BigInt(`0x${randomBytes(10).toString('hex')}`);
  previousTime = time;
  let value = (BigInt(time) << 80n) | previousRandom;
  let result = '';
  for (let i = 0; i < 26; i++) { result = alphabet[Number(value & 31n)] + result; value >>= 5n; }
  return result;
}
// The approval document must live on this dashboard: NAIA_DASHBOARD_PUBLIC_URL when set, otherwise any https host.
// A set value that is not an https origin accepts no approval form (fail closed); approvalDocWarning names it.
export function approvalDocOrigin(env: NodeJS.ProcessEnv = process.env): { ok: true; origin: string | null } | { ok: false } {
  const raw = (env.NAIA_DASHBOARD_PUBLIC_URL ?? '').trim();
  if (!raw) return { ok: true, origin: null };
  const origin = raw.replace(/\/+$/, '');
  return /^https:\/\/[^\s/?#@]+$/.test(origin) ? { ok: true, origin } : { ok: false };
}
export function approvalDocWarning(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return approvalDocOrigin(env).ok ? undefined : 'NAIA_DASHBOARD_PUBLIC_URL is not an https origin (https://host[:port]); approval forms are refused until it is fixed';
}
// Only the first "3. 문서:" line counts, the same line the dashboard card links to.
export function approvalDocPattern(env: NodeJS.ProcessEnv = process.env): RegExp {
  const pin = approvalDocOrigin(env);
  if (!pin.ok) return /(?!)/;
  const base = pin.origin ? pin.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'https:\\/\\/[^\\s/]+';
  return new RegExp(`^3\\.\\s*문서:\\s*${base}\\/d\\/[^\\s]+`);
}
export function approvalDocLine(body: string): string | null {
  return body.match(/3\.\s*문서:[^\r\n]*/)?.[0] ?? null;
}
export function isApprovalForm(body: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const docLine = approvalDocLine(body);
  return /1\.\s*제목:\s*\[[^\]\r\n]+\]\s*\S/.test(body)
    && /2\.\s*요약:/.test(body)
    && docLine !== null && approvalDocPattern(env).test(docLine);
}
// Same channel and document rule as scripts/messenger/msg.mjs validateApproval: approval forms live only in this channel.
export const APPROVAL_CHANNEL = '업무-요청';
export const MAX_LIST_LIMIT = 100;
// The database holds every message and DM: its folder is 0700 and its files 0600 whatever the umask.
// SQLite gives -wal and -shm the mode of the main file. An existing folder stays as it is, with a warning.
function prepareDbFiles(path: string): string | undefined {
  const dir = dirname(path);
  let warning: string | undefined;
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const mode = statSync(dir).mode & 0o777;
    if (mode & 0o077) warning = `Messenger DB folder ${dir} is mode ${mode.toString(8)}, not 700`;
  }
  const file = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(file, 0o600); } finally { closeSync(file); }
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try { chmodSync(sidecar, 0o600); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  }
  return warning;
}
export class MessengerStore {
  readonly db: DatabaseSync;
  readonly permissionWarning?: string;
  constructor(path: string, readonly now: () => number = Date.now) {
    if (path !== ':memory:') this.permissionWarning = prepareDbFiles(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('channel','dm')),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_members(channel_id TEXT NOT NULL REFERENCES channels(id),member_id TEXT NOT NULL,member_kind TEXT NOT NULL CHECK(member_kind IN ('human','agent')),PRIMARY KEY(channel_id,member_id,member_kind));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),author_id TEXT NOT NULL,author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),body TEXT NOT NULL CHECK(length(body)<=64000),reply_to_id TEXT REFERENCES messages(id),thread_root_id TEXT REFERENCES messages(id),created_at INTEGER NOT NULL,edited_at INTEGER);
      CREATE INDEX IF NOT EXISTS messenger_messages_channel ON messages(channel_id,id);
      CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL REFERENCES messages(id),author_id TEXT NOT NULL,author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),emoji TEXT NOT NULL,PRIMARY KEY(message_id,author_id,author_kind,emoji));
      CREATE TABLE IF NOT EXISTS read_cursors(channel_id TEXT NOT NULL REFERENCES channels(id),reader_id TEXT NOT NULL,reader_kind TEXT NOT NULL CHECK(reader_kind IN ('human','agent')),last_message_id TEXT NOT NULL REFERENCES messages(id),updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,reader_id,reader_kind));
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT REFERENCES messages(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(message_id TEXT PRIMARY KEY REFERENCES messages(id),plan_code TEXT NOT NULL,step_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),decided_by TEXT,decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS watch_state(message_id TEXT NOT NULL REFERENCES messages(id),target_id TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'none',updated_at INTEGER NOT NULL,PRIMARY KEY(message_id,target_id));
      CREATE TABLE IF NOT EXISTS human_names(id TEXT PRIMARY KEY,name TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messenger_events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    this.migrateMemberKind();
    this.migrateKindColumn('reactions','author_kind',`CREATE TABLE reactions(message_id TEXT NOT NULL REFERENCES messages(id),author_id TEXT NOT NULL,author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),emoji TEXT NOT NULL,PRIMARY KEY(message_id,author_id,author_kind,emoji))`,'message_id,author_id,emoji');
    this.migrateKindColumn('read_cursors','reader_kind',`CREATE TABLE read_cursors(channel_id TEXT NOT NULL REFERENCES channels(id),reader_id TEXT NOT NULL,reader_kind TEXT NOT NULL CHECK(reader_kind IN ('human','agent')),last_message_id TEXT NOT NULL REFERENCES messages(id),updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,reader_id,reader_kind))`,'channel_id,reader_id,last_message_id,updated_at');
    for (const name of ['업무-요청', '사내-인프라', '자유']) {
      this.db.prepare('INSERT OR IGNORE INTO channels VALUES (?,?,?,?)').run(name, name, 'channel', now());
    }
  }
  // Earlier databases keyed members by name only; a DM's agent member is the role after the last colon.
  private migrateMemberKind() {
    const columns = this.db.prepare('PRAGMA table_info(channel_members)').all();
    if (columns.some(column => column.name === 'member_kind')) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT channel_id,member_id FROM channel_members').all();
      this.db.exec(`DROP TABLE channel_members;
        CREATE TABLE channel_members(channel_id TEXT NOT NULL REFERENCES channels(id),member_id TEXT NOT NULL,member_kind TEXT NOT NULL CHECK(member_kind IN ('human','agent')),PRIMARY KEY(channel_id,member_id,member_kind));`);
      const insert = this.db.prepare('INSERT OR IGNORE INTO channel_members VALUES (?,?,?)');
      for (const row of rows) {
        const channelId = String(row.channel_id), memberId = String(row.member_id);
        insert.run(channelId, memberId, channelId.slice(channelId.lastIndexOf(':') + 1) === memberId && messengerRoleIds().includes(memberId) ? 'agent' : 'human');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  // Earlier reactions and read cursors were keyed by name only; the dashboard wrote nearly all of them, so they become human.
  private migrateKindColumn(table: string, kindColumn: string, create: string, columns: string) {
    if (this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === kindColumn)) return;
    // Both tables keep the kind right after the id column.
    const values = columns.split(',');
    const target = [...values.slice(0, 2), kindColumn, ...values.slice(2)].join(',');
    const source = [...values.slice(0, 2), "'human'", ...values.slice(2)].join(',');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_kindless; ${create}; INSERT INTO ${table}(${target}) SELECT ${source} FROM ${table}_kindless; DROP TABLE ${table}_kindless;`);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  canAccess(channelId: string, reader: MessengerAuthor): boolean {
    return Boolean(this.db.prepare("SELECT id FROM channels WHERE id=? AND (kind='channel' OR EXISTS(SELECT 1 FROM channel_members WHERE channel_id=channels.id AND member_id=? AND member_kind=?))").get(channelId,reader.id,reader.kind));
  }
  channels(reader: MessengerAuthor) {
    const readerId = reader.id;
    if (reader.kind === 'human') {
      for (const role of messengerRoleIds()) {
        const id = `dm:${encodeURIComponent(readerId)}:${role}`;
        this.db.prepare('INSERT OR IGNORE INTO channels VALUES (?,?,?,?)').run(id,`${readerId} · ${role}`,'dm',this.now());
        this.db.prepare('INSERT OR IGNORE INTO channel_members VALUES (?,?,?)').run(id,readerId,'human');
        this.db.prepare('INSERT OR IGNORE INTO channel_members VALUES (?,?,?)').run(id,role,'agent');
      }
    }
    return this.db.prepare(`SELECT c.id,c.name,c.kind,(SELECT count(*) FROM messages m WHERE m.channel_id=c.id AND NOT (m.author_id=? AND m.author_kind=?) AND m.id>COALESCE((SELECT last_message_id FROM read_cursors WHERE channel_id=c.id AND reader_id=? AND reader_kind=?),'')) AS unread FROM channels c WHERE c.kind='channel' OR EXISTS(SELECT 1 FROM channel_members WHERE channel_id=c.id AND member_id=? AND member_kind=?) ORDER BY c.created_at,c.rowid`).all(readerId, reader.kind, readerId, reader.kind, readerId, reader.kind);
  }
  message(id: string, reader: MessengerAuthor): MessengerMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) return undefined;
    const reactions = this.db.prepare('SELECT emoji,count(*) AS count,max(author_id=? AND author_kind=?) AS mine FROM reactions WHERE message_id=? GROUP BY emoji ORDER BY emoji').all(reader.id,reader.kind,id).map(r => ({emoji: String(r.emoji),count: Number(r.count),mine: Boolean(r.mine)}));
    const attachments = this.db.prepare('SELECT id,message_id,name,mime,size,sha256 FROM attachments WHERE message_id=?').all(id);
    const approval = this.db.prepare('SELECT plan_code,step_code,status FROM approvals WHERE message_id=?').get(id) ?? null;
    const named = row.author_kind === 'human' ? this.db.prepare('SELECT name FROM human_names WHERE id=?').get(String(row.author_id)) : undefined;
    return { ...row, author_name: named ? String(named.name) : null, reactions, attachments, approval } as unknown as MessengerMessage;
  }
  rememberHumanName(id: string, name: string) {
    this.db.prepare('INSERT INTO human_names VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at WHERE name<>excluded.name').run(id,name,this.now());
  }
  messages(channelId: string, reader: MessengerAuthor, before?: string, limit = 50): MessengerMessage[] {
    const rows = this.db.prepare('SELECT id FROM messages WHERE channel_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT ?').all(channelId,before ?? null,before ?? null,Math.max(1,Math.min(MAX_LIST_LIMIT,Math.trunc(limit) || 50)));
    return rows.reverse().map(row => this.message(String(row.id),reader)!);
  }
  createMessage(channelId: string, author: MessengerAuthor, body: string, replyTo?: string): MessengerMessage {
    if (typeof body !== 'string' || !body.trim() || [...body].length > 64000) fail('Invalid message body');
    if (!this.db.prepare('SELECT id FROM channels WHERE id=?').get(channelId)) fail('Channel not found',404);
    const parent = replyTo ? this.message(replyTo,author) : undefined;
    if (replyTo && (!parent || parent.channel_id !== channelId)) fail('Invalid reply target');
    const id = ulid(this.now());
    this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,NULL)').run(id,channelId,author.id,author.kind,body,replyTo ?? null,parent ? parent.thread_root_id ?? parent.id : null,this.now());
    const codes = body.match(/\b(PLAN-[A-Z0-9]{6})\s+(STEP-[A-Z0-9]{6})\b/);
    if (codes) {
      let target = channelId === APPROVAL_CHANNEL && isApprovalForm(body) ? id : undefined;
      if (!target && channelId === APPROVAL_CHANNEL) {
        const previous = this.db.prepare('SELECT id,body,author_id,author_kind FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT 1').get(channelId,id);
        if (previous && previous.author_id === author.id && previous.author_kind === author.kind && isApprovalForm(String(previous.body))) target = String(previous.id);
      }
      if (target) this.db.prepare('INSERT OR IGNORE INTO approvals(message_id,plan_code,step_code) VALUES (?,?,?)').run(target,codes[1],codes[2]);
    }
    return this.message(id,author)!;
  }
  react(messageId: string, author: MessengerAuthor, emoji: string, remove = false) {
    if (typeof emoji !== 'string' || !emoji.trim() || Buffer.byteLength(emoji) > 32) fail('Invalid emoji');
    if (!this.message(messageId,author)) fail('Message not found',404);
    this.db.prepare(remove ? 'DELETE FROM reactions WHERE message_id=? AND author_id=? AND author_kind=? AND emoji=?' : 'INSERT OR IGNORE INTO reactions(message_id,author_id,author_kind,emoji) VALUES (?,?,?,?)').run(messageId,author.id,author.kind,emoji);
    return this.message(messageId,author)!;
  }
  markRead(channelId: string, reader: MessengerAuthor, lastId: string) {
    if (this.message(lastId,reader)?.channel_id !== channelId) fail('Invalid read cursor');
    this.db.prepare(`INSERT INTO read_cursors(channel_id,reader_id,reader_kind,last_message_id,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(channel_id,reader_id,reader_kind) DO UPDATE SET last_message_id=MAX(read_cursors.last_message_id,excluded.last_message_id),updated_at=excluded.updated_at`).run(channelId,reader.id,reader.kind,lastId,this.now());
  }
  decideApproval(id: string, author: MessengerAuthor, decision: 'approve' | 'reject') {
    if (author.kind !== 'human') fail('Human identity required',403);
    if (decision !== 'approve' && decision !== 'reject') fail('Invalid decision');
    const message = this.message(id,author);
    if (!message?.approval || message.channel_id !== APPROVAL_CHANNEL || !isApprovalForm(message.body)) fail('Approval form required');
    if (message.approval.status !== 'pending') fail('Approval already decided',409);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE approvals SET status=?,decided_by=?,decided_at=? WHERE message_id=? AND status='pending'").run(decision === 'approve' ? 'approved' : 'rejected',author.id,this.now(),id);
      if (!changed.changes) fail('Approval already decided',409);
      const codeMessage = decision === 'approve' ? this.createMessage(message.channel_id,author,`${message.approval.plan_code} ${message.approval.step_code}`) : undefined;
      this.db.exec('COMMIT');
      return {message: this.message(id,author)!, codeMessage};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addEvent(type: string, data: unknown) {
    const result = this.db.prepare('INSERT INTO messenger_events(type,data,created_at) VALUES (?,?,?)').run(type,JSON.stringify(data),this.now());
    return {id: Number(result.lastInsertRowid),type,data};
  }
  lastEventId(): number {
    return Number(this.db.prepare('SELECT COALESCE(max(id),0) AS id FROM messenger_events').get()?.id ?? 0);
  }
  eventsAfter(id: number) {
    return this.db.prepare('SELECT id,type,data FROM messenger_events WHERE id>? ORDER BY id').all(id).map(row => ({id:Number(row.id),type:String(row.type),data:JSON.parse(String(row.data)) as unknown}));
  }
}
