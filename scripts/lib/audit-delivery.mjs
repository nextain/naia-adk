import { createHash } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fixedTemplate } from './audit-judge.mjs';

async function writeWakeFile(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`, file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(content); await file.close(); await rename(tmp, path); }
  catch (error) { await file.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw error; }
}

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const safeName = value => typeof value === 'string' && /^[\p{L}\p{N}_.-]+$/u.test(value) && value !== '.' && value !== '..';
const clean = value => String(value ?? '').normalize('NFKC').replace(/[|\r\n\u0085\u2028\u2029]/gu, ' ').replace(/<@[^>]*>|@(?:everyone|here|\S+)/giu, '').trim();
const isId = value => typeof value === 'string' && /^\d+$/.test(value);
function localTime(now, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { day: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) };
}
export function reportChannel(config, now) {
  const { hour } = localTime(now, config.timezone ?? 'UTC');
  const { start = 0, end = 9 } = config.night ?? {};
  if (![start, end].every(n => Number.isInteger(n) && n >= 0 && n <= 23) || start === end) throw Error('invalid night window');
  return (start < end ? hour >= start && hour < end : hour >= start || hour < end) ? config.channels.night : config.channels.day;
}
export function validateDelivery(config, role, now, hashes) {
  if (config.hold === true) throw Error('HOLD output is outside permitted audit paths');
  if ((config.senderBotId !== undefined && !isId(config.senderBotId)) || !safeName(role?.id) || !Array.isArray(role.botIds) || !role.botIds.length || !role.botIds.every(isId) || !isId(config.ownerId) || (role.leaderId && !isId(role.leaderId))) throw Error('invalid audit recipients');
  if (![config.channels?.internal, config.channels?.day, config.channels?.night].every(isId)) throw Error('invalid audit channels');
  if (!Number.isFinite(now) || !Number.isInteger(config.dailyCap ?? 6) || (config.dailyCap ?? 6) < 1 || !hashes.every(h => typeof h === 'string' && /^[0-9a-f]{8,64}$/i.test(h))) throw Error('invalid audit delivery settings');
  if (typeof role.wakeDir !== 'string' || !role.wakeDir || typeof config.workspace !== 'string' || !config.workspace) throw Error('missing audit paths');
  reportChannel(config, now);
}

export function deliveryKey(role, event) { return `${role.id}:${event.code}:${event.target ?? ''}:${event.episodeAt ?? event.at}:${event.stage}`; }

// `save` persists an intent before a network send: an uncertain send is never replayed.
export async function deliverAudit({ role, events = [], config, state, reportPath, configHash, promptHash, now = Date.now(), sender, channelMessages = [], save = async () => {} }) {
  validateDelivery(config, role, now, [configHash, promptHash]);
  if (typeof reportPath !== 'string' || !reportPath || /[|\r\n@<>]/.test(reportPath)) throw Error('invalid report path');
  if (!Array.isArray(channelMessages)) throw Error('invalid channel read');
  const dry = config.dry === true || typeof sender !== 'function';
  const next = structuredClone(state ?? { days: {}, episodes: {} });
  if (!next.days || !next.episodes || typeof next.days !== 'object' || typeof next.episodes !== 'object') throw Error('invalid delivery state');
  const { day } = localTime(now, config.timezone ?? 'UTC');
  const dayKey = `${role.id}:${day}`, daily = next.days[dayKey] ??= { count: 0, capReported: false };
  if (!Number.isInteger(daily.count) || daily.count < 0 || typeof daily.capReported !== 'boolean') throw Error('invalid daily state');
  const hashLine = `prompt=${promptHash.slice(0, 8)} config=${configHash.slice(0, 8)}`;
  const deliveries = [], report = [], capSkipped = new Set();
  const ownIds = new Set(Object.values(next.episodes).map(e => e?.id).filter(Boolean));
  const count = channelMessages.filter(m => typeof m?.content === 'string' && /^\[감사(?: 보고)?\]/u.test(m.content.trimStart()) && !ownIds.has(String(m.id ?? '')) && !(config.senderBotId && m.author?.id === config.senderBotId)).length;
  report.push(`같은 채널 다른 감사 글 ${count}건`);
  if (Object.entries(next.episodes).some(([key, value]) => (key.startsWith(`${role.id}:`) || key.startsWith(`cap:${role.id}:`)) && ['intent', 'uncertain'].includes(value?.status))) report.push('발신 결과 불확실: 수동 확인 필요');
  async function post(item, key) {
    deliveries.push({ ...item, dry });
    if (dry) { next.episodes[key] = { status: 'confirmed', at: now, id: 'dry' }; report.push(`발신 예정: ${item.channelId}\n${item.content}`); return; }
    next.episodes[key] = { status: 'intent', at: now }; await save(next);
    try {
      const receipt = await sender({ ...item, nonce: digest(key) });
      if (!receipt?.id) throw Error('missing receipt');
      next.episodes[key] = { status: 'confirmed', at: now, id: String(receipt.id) };
    } catch { next.episodes[key] = { status: 'uncertain', at: now }; report.push('발신 결과 불확실: 수동 확인 필요'); }
    await save(next);
  }
  async function capReport() {
    if (daily.count < (config.dailyCap ?? 6) || daily.capReported) return;
    daily.capReported = true;
    const key = `cap:${dayKey}`, mentions = [...new Set([config.ownerId, ...(role.leaderId ? [role.leaderId] : [])])];
    const content = `[감사 보고] ${role.id} 발신 상한 도달 ${mentions.map(id => `<@${id}>`).join(' ')} ${hashLine}`;
    await post({ channelId: reportChannel(config, now), content, mentions, stage: 'cap' }, key);
  }
  await capReport();
  for (const event of events) {
    if (event.stage === 'recovered') { report.push(`회복: ${role.id} ${clean(event.code)}`); continue; }
    if (!['warn', 'report'].includes(event.stage) || !safeName(event.code)) continue;
    const key = deliveryKey(role, event);
    if (next.episodes[key]) continue;
    if (daily.count >= (config.dailyCap ?? 6)) { capSkipped.add(key); continue; }
    const output = event.output?.code === event.code ? event.output : fixedTemplate(event.code);
    const facts = Array.isArray(output.facts) ? output.facts.slice(0, 3).map(clean).filter(Boolean) : [];
    const mentions = event.stage === 'warn' ? [...new Set(role.botIds)] : [...new Set([config.ownerId, ...(role.leaderId ? [role.leaderId] : [])])];
    const title = event.stage === 'warn' ? '[감사]' : '[감사 보고]';
    const action = event.stage === 'warn' ? clean(output.ask) || '관련 근거를 확인하고 필요한 조치를 정해 주세요.' : '진행을 멈출지 또는 방식을 바꿀지 결정해 주세요.';
    const content = [`${title} ${role.id} ${event.code} ${clean(output.headline)}`.trimEnd(), ...facts, action, ...(event.stage === 'warn' ? [`보고서: ${reportPath}`] : []), mentions.map(id => `<@${id}>`).join(' '), hashLine].filter(Boolean).join('\n');
    const channelId = event.stage === 'warn' ? config.channels.internal : reportChannel(config, now);
    daily.count++;
    if (event.stage === 'warn' && !dry) {
      // Persist intent before publishing either part of a warning.
      next.episodes[key] = { status: 'intent', at: now }; await save(next);
      try {
        const wakeId = (1000000000000000000n + BigInt(`0x${digest(key)}`) % 9000000000000000000n).toString();
        await writeWakeFile(join(role.wakeDir, `${digest(key)}-audit.md`), `# Discord wake\n\nRole: ${role.id}\nChannel: ${channelId}\nAuthor: session-audit\nMessage ID: ${wakeId}\n\n${content}\n`);
      } catch { next.episodes[key] = { status: 'uncertain', at: now }; report.push('깨움 파일 쓰기 실패: 수동 확인 필요'); await save(next); await capReport(); continue; }
    }
    await post({ channelId, content, mentions, stage: event.stage }, key);
    await capReport();
  }
  if (capSkipped.size) report.push(`상한으로 보류 ${capSkipped.size}건`);
  return { state: dry ? structuredClone(state ?? { days: {}, episodes: {} }) : next, ...(dry ? { projectedState: next } : {}), report: report.join('\n'), deliveries, dry };
}
