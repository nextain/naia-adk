#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { updateTokens } from './issue-agent-token.mjs';
export const defaultChannels = ['업무-요청','사내-인프라','자유'];
export async function setup({root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), env = process.env, roles = [], output = console.log} = {}) {
  for (const role of roles) if (!role || !/^[\p{L}\p{N}_-]+$/u.test(role)) throw new Error('역할 이름이 잘못됐습니다');
  const directory = resolve(root,'data-company/messenger'); mkdirSync(directory,{recursive:true});
  const dbFile = env.NAIA_MESSENGER_DB || resolve(directory,'messenger.db'); mkdirSync(dirname(dbFile),{recursive:true});
  let Database;
  try { Database = createRequire(import.meta.url)('better-sqlite3'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; Database = (await import('node:sqlite')).DatabaseSync; }
  const db = new Database(dbFile);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('channel','dm')),created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_members(channel_id TEXT NOT NULL REFERENCES channels(id),member_id TEXT NOT NULL,member_kind TEXT NOT NULL CHECK(member_kind IN ('human','agent')),PRIMARY KEY(channel_id,member_id,member_kind));
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),author_id TEXT NOT NULL,author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),body TEXT NOT NULL CHECK(length(body)<=64000),reply_to_id TEXT REFERENCES messages(id),thread_root_id TEXT REFERENCES messages(id),created_at INTEGER NOT NULL,edited_at INTEGER);
      CREATE INDEX IF NOT EXISTS messenger_messages_channel ON messages(channel_id,id);
      CREATE TABLE IF NOT EXISTS reactions(message_id TEXT NOT NULL REFERENCES messages(id),author_id TEXT NOT NULL,author_kind TEXT NOT NULL CHECK(author_kind IN ('human','agent')),emoji TEXT NOT NULL,PRIMARY KEY(message_id,author_id,author_kind,emoji));
      CREATE TABLE IF NOT EXISTS read_cursors(channel_id TEXT NOT NULL REFERENCES channels(id),reader_id TEXT NOT NULL,reader_kind TEXT NOT NULL CHECK(reader_kind IN ('human','agent')),last_message_id TEXT NOT NULL REFERENCES messages(id),updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,reader_id,reader_kind));
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,message_id TEXT REFERENCES messages(id),name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(message_id TEXT PRIMARY KEY REFERENCES messages(id),plan_code TEXT NOT NULL,step_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),decided_by TEXT,decided_at INTEGER);
      CREATE TABLE IF NOT EXISTS watch_state(message_id TEXT NOT NULL REFERENCES messages(id),target_id TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'none',updated_at INTEGER NOT NULL,PRIMARY KEY(message_id,target_id));
      CREATE TABLE IF NOT EXISTS messenger_events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    const insert = db.prepare('INSERT INTO channels(id,name,kind,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM channels WHERE name=? AND kind=?)');
    for (const name of defaultChannels) insert.run(name,name,'channel',Date.now(),name,'channel');
  } finally { db.close(); }
  const tokenFile = env.NAIA_MESSENGER_AGENT_TOKENS_FILE || resolve(directory,'agent-tokens.json');
  mkdirSync(dirname(tokenFile),{recursive:true});
  for (const role of [...new Set(roles)]) {
    const tokens = existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile,'utf8')) : {};
    if (!Object.values(tokens).includes(role)) output(`${role}: ${updateTokens(tokenFile,'issue',role)}`);
  }
  if (!existsSync(tokenFile)) writeFileSync(tokenFile,'{}\n',{mode:0o600});
  output(`서버 설정: NAIA_MESSENGER_DB=${dbFile} NAIA_MESSENGER_AGENT_TOKENS_FILE=${tokenFile}`);
  output(`${(env.NAIA_MESSENGER_DASHBOARD_URL || env.NAIA_MESSENGER_URL || 'http://localhost:3142').replace(/\/$/,'')}/messages 를 여세요`);
  return {dbFile,tokenFile};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const roles = [];
  try { while (args.length) { if (args.shift() !== '--role' || !args[0]) throw new Error('setup.mjs --role <역할> [--role <다른역할>]'); roles.push(args.shift()); } if (!roles.length) throw new Error('역할을 하나 이상 --role로 지정하세요'); await setup({roles}); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
