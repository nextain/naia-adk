#!/usr/bin/env node
// 메신저 깨움 옮기기: 포털 API(운영에서는 API 전용 계정)가 대기 폴더에 남긴 깨움을 역할 깨움 폴더로 옮긴다.
// 깨움 폴더: roles.json 의 wakeDir 먼저, 없으면 NAIA_MESSENGER_ROOT_WAKE_ROLE 역할은 wake/, 다른 역할은 wake/<역할>/.
// 옮긴 뒤 대기 파일을 지우고, 옮긴 이름을 상태 파일에 적어 같은 깨움을 두 번 옮기지 않는다.
// 옮기지 못하면 대기 파일을 그대로 두고 다음 차례에 다시 한다. cron 1분(flock -n 으로 감싼다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 서버(packages/server/src/messenger-roles.ts)와 같은 NAIA_MESSENGER_ROLES 규칙으로, 서버가 깨움을 쓰는 역할만 옮긴다.
const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
// 항목이 모두 틀리면 경고 한 줄을 내고 기본값(naia)으로 돌아간다(서버와 같음).
export function messengerRoleIds(env = process.env, warn = console.error) {
 const raw = String(env.NAIA_MESSENGER_ROLES ?? '').trim();
 if (!raw) return ['naia'];
 const out = [];
 for (const part of raw.split(',')) { const id = part.split(':')[0].trim(); if (ROLE_ID_RE.test(id) && !out.includes(id)) out.push(id); }
 if (out.length) return out;
 warn('NAIA_MESSENGER_ROLES 에 맞는 역할 이름이 없어 기본값 naia 로 옮깁니다');
 return ['naia'];
}
const NAME_RE = /^\d{17}-[A-Za-z0-9_-]{1,128}-route-[a-z][a-z0-9_-]{0,63}\.json$/;
const MAX_SPOOL_BYTES = 256 * 1024;
const STATE_KEEP_MS = 30 * 24 * 3600_000;

function insideRoot(root, rel) {
 if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
 const abs = path.resolve(root, rel), base = path.resolve(root);
 return abs.startsWith(base + path.sep) ? abs : null;
}

export function wakeDirFor(root, role, env = process.env) {
 try {
  const parsed = JSON.parse(fs.readFileSync(path.join(root, '.agents/work/l4/roles.json'), 'utf8'));
  for (const raw of Array.isArray(parsed?.roles) ? parsed.roles : []) {
   if (raw?.id !== role) continue;
   const configured = insideRoot(root, raw.wakeDir);
   if (configured) return configured;
  }
 } catch {}
 const base = path.join(root, '.agents/work/l4/wake');
 return role === String(env.NAIA_MESSENGER_ROOT_WAKE_ROLE ?? '').trim() ? base : path.join(base, role);
}

const notRegular = () => Object.assign(new Error('not a regular file'), { code: 'ENOTREG' });

// 대기 폴더를 직접 읽거나(같은 사용자·시험), sudo -n 으로 읽고 지운다(운영: 대기 폴더는 API 서비스 계정 0700).
// 읽기는 링크를 따라가지 않는다: 직접 읽기는 O_NOFOLLOW, sudo 는 find -P 가 보통 파일일 때만 cat 한다.
export function spoolIo(sudo) {
 if (!sudo) return {
  list: (dir) => fs.readdirSync(dir),
  read: (file) => {
   let fd;
   try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
   catch (error) { if (error?.code === 'ELOOP') throw notRegular(); throw error; }
   try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw notRegular();
    if (stat.size > MAX_SPOOL_BYTES) throw Object.assign(new Error('too large'), { code: 'ETOOBIG' });
    return fs.readFileSync(fd, 'utf8');
   } finally { fs.closeSync(fd); }
  },
  remove: (file) => fs.unlinkSync(file),
 };
 const run = (args) => execFileSync(sudo, ['-n', ...args], { encoding: 'utf8', maxBuffer: MAX_SPOOL_BYTES * 4, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
 return {
  list: (dir) => run(['find', dir, '-maxdepth', '1', '-type', 'f', '-name', '*.json']).split('\n').filter(Boolean).map((p) => path.basename(p)),
  read: (file) => {
   const out = run(['find', '-P', file, '-maxdepth', '0', '-type', 'f', '-size', `-${MAX_SPOOL_BYTES + 1}c`, '-exec', 'cat', '--', '{}', ';']);
   if (!out) throw notRegular();
   return out;
  },
  remove: (file) => run(['rm', '-f', '--', file]),
 };
}

// 상태 파일: { moved: {이름: 옮긴 시각}, ignored: {이름: 처음 본 시각} }. 옛 형식(이름: 시각)은 moved 로 읽는다.
function readState(file) {
 let parsed;
 try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { moved: {}, ignored: {} }; }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { moved: {}, ignored: {} };
 const map = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
 if ('moved' in parsed || 'ignored' in parsed) return { moved: map(parsed.moved), ignored: map(parsed.ignored) };
 return { moved: map(parsed), ignored: {} };
}

function writeState(file, state) {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const temp = `${file}.tmp-${process.pid}`;
 fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 });
 fs.renameSync(temp, file);
}

// 새 파일만 만든다. 이미 있으면 덮어쓰지 않고 false.
function writeNew(file, content) {
 fs.mkdirSync(path.dirname(file), { recursive: true });
 const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
 fs.writeFileSync(temp, content, { mode: 0o600, flag: 'wx' });
 try { fs.linkSync(temp, file); return true; }
 catch (error) { if (error?.code === 'EEXIST') return false; throw error; }
 finally { try { fs.unlinkSync(temp); } catch {} }
}

// 오류 종류만 남긴다(파일 내용·명령 출력은 싣지 않는다). sudo 명령 실패는 종료 코드로.
const why = (error) => error?.code || (Number.isInteger(error?.status) ? `exit ${error.status}` : error?.name || 'Error');

export function moveWakes({ spool, root, state = path.join(os.homedir(), '.cache/messenger-wake-move/moved.json'), sudo = null, io = {}, log = () => {}, now = Date.now } = {}) {
 const ops = { ...spoolIo(sudo), ...io };
 const moved = [], kept = [];
 let names;
 try { names = ops.list(spool).filter((name) => NAME_RE.test(name)).sort(); }
 catch (error) { if (error?.code === 'ENOENT') return { moved, kept }; throw error; }
 const { moved: ledger, ignored } = readState(state);
 for (const [name, at] of Object.entries(ledger)) if (!(Number(at) > now() - STATE_KEEP_MS)) delete ledger[name];
 // 무시 목록은 대기 폴더에 아직 남은 파일만 기억한다.
 for (const name of Object.keys(ignored)) if (!names.includes(name)) delete ignored[name];
 const save = () => writeState(state, { moved: ledger, ignored });
 // 형식이 틀린 파일은 한 번만 일지에 남기고 무시 목록에 넣는다(지우지 않는다). 오류 문구에 파일 내용을 싣지 않는다.
 const ignore = (name, why) => { log(`형식 아님 ${name}: ${why} (무시 목록에 넣음)`); ignored[name] = now(); kept.push(name); };
 const roleIds = messengerRoleIds(process.env, log);
 for (const name of names) {
  const spoolFile = path.join(spool, name);
  if (ignored[name]) { kept.push(name); continue; }
  if (!ledger[name]) {
   let text;
   try { text = ops.read(spoolFile); }
   catch (error) {
    if (error?.code === 'ENOTREG' || error?.code === 'ETOOBIG') ignore(name, error.code);
    else { log(`읽기 실패 ${name}: ${why(error)}`); kept.push(name); }
    continue;
   }
   let record;
   try { record = JSON.parse(text); } catch { ignore(name, 'JSON 아님'); continue; }
   const role = record?.role;
   if (record?.v !== 1 || typeof role !== 'string' || !roleIds.includes(role) || !name.endsWith(`-route-${role}.json`)
    || record.file !== name.replace(/\.json$/, '.md') || typeof record.body !== 'string') { ignore(name, '필드'); continue; }
   const target = path.join(wakeDirFor(root, role), record.file);
   try { if (!writeNew(target, record.body)) log(`이미 있음 ${target}`); }
   catch (error) { log(`옮기기 실패 ${name}: ${error?.code || error?.message}`); kept.push(name); continue; }
   ledger[name] = now();
   save();
   moved.push(target);
  }
  try { ops.remove(spoolFile); } catch (error) { log(`대기 파일 지우기 실패 ${name}: ${why(error)}`); }
 }
 save();
 return { moved, kept };
}

function parseArgs(argv) {
 const options = {};
 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--sudo') options.sudo = process.env.MESSENGER_WAKE_MOVE_SUDO || 'sudo';
  else if (['--spool', '--root', '--state'].includes(arg) && argv[i + 1]) options[arg.slice(2)] = argv[++i];
  else throw new Error(`알 수 없는 인자: ${arg}`);
 }
 if (!options.spool || !options.root) throw new Error('사용: wake-move.mjs --spool <대기 폴더> --root <ADK 뿌리> [--state <상태 파일>] [--sudo]');
 return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const options = parseArgs(process.argv.slice(2));
  const stamp = () => new Date().toISOString();
  const { moved, kept } = moveWakes({ ...options, log: (line) => console.error(`${stamp()} ${line}`) });
  for (const file of moved) console.log(`${stamp()} 옮김 ${file}`);
  if (kept.length) console.error(`${stamp()} 남김 ${kept.length}건`);
 } catch (error) {
  console.error(`${new Date().toISOString()} ${error.message}`);
  process.exit(1);
 }
}
