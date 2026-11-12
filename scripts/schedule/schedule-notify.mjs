#!/usr/bin/env node
// 일정 알림을 메신저 글로 보낸다. 한 번 돌고 끝나는 실행기다. cron 이나 정기 일정 장부가 몇 분마다 부른다.
// - 개인 일정: 당일 아침(morning)과 시작 N분 전(beforeMinutes). 종일 일정은 아침 알림만.
// - 마일스톤: 기한 날 아침. 대시보드 /board-schedule 투영을 읽는다.
// 같은 알림은 상태 파일 영수증(메신저 글 id)으로 한 번만 보낸다. 보내기 직전에 "보내는 중"을 먼저 적어서,
// 보낸 뒤 영수증을 못 적고 죽어도 다음 실행이 다시 보내지 않는다(두 번보다 한 번 빠지는 쪽을 고른다).
// 설정 예: config/schedule-notify.example.json, 안내: docs/guides/schedule-messenger.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPersonalSchedule } from '../../packages/core/src/personal-schedule.ts';
import { scheduleDetailHref } from '../../packages/core/src/schedule-link.ts';
import { createClient } from '../messenger/msg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/;
const RECEIPT_KEEP_DAYS = 14;

// "YYYY-MM-DD[ HH:mm]" 벽시계 값을 분 단위 수로. 시간대는 비교에 쓰지 않으므로 UTC 로 센다.
export function wallMinutes(value) {
  const m = WALL_RE.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) / 60000;
}

export function formatWall(minutes) {
  const iso = new Date(minutes * 60000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** 지금 시각을 설정 시간대(없으면 이 기계 시간대)의 "YYYY-MM-DD HH:mm" 로. */
export function wallNow(now = new Date(), timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function clock(value) {
  return /^\d{2}:\d{2}$/.test(value ?? '') ? value : null;
}

/**
 * 지금 보낼 알림 목록. 알림 시각 T 가 [T, T+grace) 안에 들 때만 보낸다(오래 멈췄다 깨어나도 지난 알림을 쏟지 않음).
 * 시작 전 알림은 시작 시각이 지나면 보내지 않는다.
 */
export function dueNotices({ now, personal = [], milestones = [], morning = '08:30', beforeMinutes = [10], graceMinutes = 30 }) {
  const nowMin = wallMinutes(now);
  if (nowMin === null) throw new Error(`잘못된 지금 시각: ${now}`);
  const morningClock = clock(morning);
  if (!morningClock) throw new Error(`morning 은 HH:mm 이어야 합니다: ${morning}`);
  const inWindow = (t, limit = Infinity) => t !== null && t <= nowMin && nowMin < Math.min(t + graceMinutes, limit);
  const out = [];
  for (const { user, items } of personal) {
    for (const item of items) {
      const start = wallMinutes(item.start);
      if (start === null) continue;
      const date = item.start.slice(0, 10);
      const morningAt = wallMinutes(`${date} ${morningClock}`);
      // 아침 알림 시각이 이미 시작 뒤면(이른 아침 일정) 아침 알림은 건너뛰고 시작 전 알림에 맡긴다.
      if ((item.allDay || morningAt < start) && inWindow(morningAt)) {
        out.push({ key: `personal:${user}:${item.id}:${item.start}:morning`, kind: 'personal', trigger: 'morning', user, item, date });
      }
      if (item.allDay) continue;
      for (const minutes of beforeMinutes) {
        if (!Number.isInteger(minutes) || minutes <= 0) continue;
        if (inWindow(start - minutes, start)) {
          out.push({ key: `personal:${user}:${item.id}:${item.start}:before${minutes}`, kind: 'personal', trigger: 'before', minutes, user, item, date });
        }
      }
    }
  }
  for (const ms of milestones) {
    if (!ms?.dueDate || (ms.total > 0 && ms.completed >= ms.total)) continue;
    if (inWindow(wallMinutes(`${ms.dueDate} ${morningClock}`))) {
      out.push({ key: `milestone:${ms.id}:${ms.dueDate}:morning`, kind: 'milestone', trigger: 'morning', milestone: ms, date: ms.dueDate });
    }
  }
  return out;
}

function inline(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1').trim();
}

function timeRange(item) {
  if (item.allDay) return item.end && item.end !== item.start ? `종일 (~${item.end})` : '종일';
  const end = item.end?.slice(0, 10) === item.start.slice(0, 10) ? item.end.slice(11) : item.end;
  return `${item.start.slice(11)}~${end}`;
}

// 링크 모양에 맞지 않는 id(작업보드가 준 마일스톤 id 등)는 일정 화면 첫 화면으로 보낸다.
function detailLink(target, dashboardUrl) {
  try { return scheduleDetailHref(target, dashboardUrl); }
  catch { return `${dashboardUrl.replace(/\/+$/, '')}/schedule`; }
}

/** 알림 글 본문. 일정 화면 상세로 가는 링크를 붙인다. */
export function noticeBody(notice, { dashboardUrl = '', mention = '' } = {}) {
  const lead = mention ? `${mention} ` : '';
  if (notice.kind === 'milestone') {
    const ms = notice.milestone;
    const link = detailLink({ layer: 'milestone', id: String(ms.id), date: notice.date }, dashboardUrl);
    const progress = ms.total > 0 ? ` (${ms.completed}/${ms.total})` : '';
    return `${lead}오늘 기한 마일스톤: **${inline(ms.name)}**${progress}\n[일정에서 보기](${link})`;
  }
  const { item } = notice;
  const link = detailLink({ layer: 'personal', id: item.id, date: notice.date }, dashboardUrl);
  const head = notice.trigger === 'morning' ? '오늘 일정' : `${notice.minutes}분 뒤 시작`;
  return `${lead}${head}: **${inline(item.title)}** · ${timeRange(item)}\n[일정에서 보기](${link})`;
}

export function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.receipts && typeof parsed.receipts === 'object') return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`상태 파일을 읽지 못했습니다(${file}): ${error.message}`);
  }
  return { version: 1, receipts: {} };
}

export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pruneReceipts(state, now) {
  const limit = Date.parse(now) - RECEIPT_KEEP_DAYS * 86400000;
  for (const [key, receipt] of Object.entries(state.receipts)) {
    const at = Date.parse(receipt.sentAt ?? receipt.startedAt ?? '');
    if (Number.isFinite(at) && at < limit) delete state.receipts[key];
  }
}

// 동시에 두 번 돌면 같은 알림을 두 번 보낼 수 있으니 잠금 파일 하나로 막는다. 죽은 프로세스의 잠금은 걷는다.
export function acquireLock(file) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lock); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8').trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive) return null;
      fs.unlinkSync(lock);
    }
  }
  return null;
}

/**
 * 한 번 돌기. send(channel, body) 는 메신저에 글을 올리고 { id } 를 돌려준다.
 * 돌려주는 값: [{ key, status: 'sent'|'skipped'|'unknown'|'failed'|'dry-run', messageId?, error? }]
 */
export async function runOnce({ config, nowDate = new Date(), send, loadPersonal, loadMilestones, stateFile, dryRun = false, log = () => {} }) {
  const now = wallNow(nowDate, config.timeZone);
  const users = Array.isArray(config.personal) ? config.personal : [];
  const personal = [];
  for (const entry of users) {
    try { personal.push({ user: entry.user, items: (await loadPersonal(entry.user)).items }); }
    catch (error) { log(`개인 일정을 읽지 못함(${entry.user}): ${error.message}`); }
  }
  let milestones = [];
  if (config.milestones?.channel) {
    try { milestones = await loadMilestones(); }
    catch (error) { log(`마일스톤을 읽지 못함: ${error.message}`); }
  }
  const notices = dueNotices({ now, personal, milestones, morning: config.morning, beforeMinutes: config.beforeMinutes, graceMinutes: config.graceMinutes });
  const state = readState(stateFile);
  const results = [];
  for (const notice of notices) {
    const receipt = state.receipts[notice.key];
    if (receipt?.messageId) { results.push({ key: notice.key, status: 'skipped', messageId: receipt.messageId }); continue; }
    if (receipt?.pending) { results.push({ key: notice.key, status: 'unknown' }); continue; }
    const target = notice.kind === 'milestone' ? config.milestones : users.find((u) => u.user === notice.user);
    const body = noticeBody(notice, { dashboardUrl: config.dashboardUrl || '', mention: target?.mention || '' });
    if (dryRun) { results.push({ key: notice.key, status: 'dry-run', channel: target.channel, body }); continue; }
    state.receipts[notice.key] = { pending: true, channel: target.channel, startedAt: nowDate.toISOString() };
    writeState(stateFile, state);
    try {
      const message = await send(target.channel, body);
      state.receipts[notice.key] = { messageId: String(message.id), channel: target.channel, sentAt: nowDate.toISOString() };
      results.push({ key: notice.key, status: 'sent', messageId: String(message.id) });
    } catch (error) {
      // 서버가 거절했다고 분명히 답한 경우(HTTP 4xx·5xx 응답)만 다음 실행에 다시 보낸다. 연결이 끊긴 경우는 올라갔을 수 있다.
      if (/메신저 요청 실패 \(\d{3}\)|채널을 찾지 못했습니다/.test(error.message)) delete state.receipts[notice.key];
      results.push({ key: notice.key, status: 'failed', error: error.message });
    }
    writeState(stateFile, state);
  }
  if (!dryRun) { pruneReceipts(state, nowDate.toISOString()); writeState(stateFile, state); }
  return results;
}

export function messengerSender(client) {
  let channels;
  return async (value, body) => {
    channels ??= await client.channels();
    const ch = channels.find((c) => c.id === value || c.name === value);
    if (!ch) throw new Error('채널을 찾지 못했습니다');
    const response = await client.request(`/channels/${encodeURIComponent(ch.id)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
    });
    return response.json();
  };
}

function resolvePath(value, base) {
  return value ? path.resolve(base, value) : null;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const configFile = option('--config') ?? env.NAIA_SCHEDULE_NOTIFY_CONFIG;
  if (!configFile) throw new Error('사용: schedule-notify.mjs --config <설정.json> [--dry-run] [--now <ISO 시각>]');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const base = path.dirname(path.resolve(configFile));
  const dryRun = args.includes('--dry-run');
  const nowDate = option('--now') ? new Date(option('--now')) : new Date();
  if (Number.isNaN(nowDate.getTime())) throw new Error('--now 값이 시각이 아닙니다');
  const personalDir = resolvePath(config.personalDir, base) ?? env.NAIA_PERSONAL_SCHEDULE_DIR?.trim() ?? path.join(ROOT, 'packages/dashboard/data/schedule/personal');
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(os.homedir(), '.local/state');
  const stateFile = resolvePath(config.stateFile, base) ?? path.join(stateHome, 'naia-adk/schedule-notify.json');
  const loadMilestones = async () => {
    const response = await fetch(config.milestones.source, { redirect: 'error', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.milestones) ? data.milestones : [];
  };
  let send = async () => { throw new Error('dry-run'); };
  if (!dryRun) {
    const tokenFile = resolvePath(config.messenger?.tokenFile, base);
    const token = env.NAIA_MESSENGER_TOKEN || (tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
    send = messengerSender(createClient({ url: env.NAIA_MESSENGER_URL || config.messenger?.url, token }));
  }
  const release = dryRun ? () => {} : acquireLock(stateFile);
  if (!release) throw new Error('다른 schedule-notify 실행이 잠금을 쥐고 있습니다');
  try {
    const results = await runOnce({
      config, nowDate, send, stateFile, dryRun, log: (line) => console.error(line),
      loadPersonal: async (user) => readPersonalSchedule(user, personalDir), loadMilestones,
    });
    for (const result of results) console.log(JSON.stringify(result));
    if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
