import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { collectRoleCards, parseIsoTime, readWorkLedgerMeta } from './stalled-cards-ledger.mjs';

export { collectRoleCards, readWorkLedgerMeta };

const execFileAsync = promisify(execFile);

const singleLine = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

async function optionalStat(filePath) {
  try { return (await stat(filePath)).mtimeMs; }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
}

async function gitOutput(cwd, args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 65536 });
  return stdout.trim();
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolve linked result path latest commit timestamp at or before `now`.
 */
async function resultCommitAt(resultPath, workspace, now) {
  const probeDir = await optionalStat(resultPath).then(ms => (ms !== null ? resultPath : null))
    .catch(() => null);
  let startDir = dirname(resultPath);
  if (probeDir !== null) {
    try { if ((await stat(resultPath)).isDirectory()) startDir = resultPath; } catch { /* ignore */ }
  }
  const candidates = [...new Set([startDir, workspace].filter(Boolean))];
  for (const dir of candidates) {
    let repoRoot;
    try { repoRoot = await gitOutput(dir, ['rev-parse', '--show-toplevel']); }
    catch { continue; }
    if (!inside(repoRoot, resultPath)) continue;
    const rel = relative(repoRoot, resultPath) || '.';
    try {
      const isoBefore = new Date(now).toISOString();
      const raw = await gitOutput(repoRoot, ['log', '-1', `--before=${isoBefore}`, '--format=%cI', '--', rel]);
      const at = parseIsoTime(raw);
      if (Number.isFinite(at) && at <= now) return at;
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve staleMinutes, repeatMinutes, and escalateAfterCount thresholds from config.
 */
export function resolveCardThresholds(config) {
  const staleMinutes = config.staleMinutes ?? (config.staleHours !== undefined ? config.staleHours * 60 : 90);
  const repeatMinutes = config.repeatMinutes ?? 30;
  const escalateAfterCount = config.escalateAfterCount ?? 3;
  return {
    staleMinutes,
    staleMs: staleMinutes * 60000,
    repeatMinutes,
    repeatMs: repeatMinutes * 60000,
    escalateAfterCount,
  };
}

/**
 * Evaluate per-card progress evidence (excluding plain Discord replies) and stall state.
 */
export async function evaluateCardStall({ card, role, record, now, staleMs }) {
  const prevStatuses = record.cardStatuses ?? {};
  const prior = prevStatuses[card.cardKey];
  const nextEvidence = [...card.ledgerEvidence];

  if (card.isOpen) {
    if (prior && prior.status !== card.status && Number.isFinite(now)) {
      // Transitioning from human-wait or another state into open counts as transition evidence.
      record.cardTransitions ??= {};
      record.cardTransitions[card.cardKey] = now;
    }
    const recordedTransition = record.cardTransitions?.[card.cardKey];
    if (Number.isFinite(recordedTransition) && recordedTransition <= now) {
      nextEvidence.push({ source: '장부 상태 전이', at: recordedTransition });
    }
    for (const resPath of card.resultPaths) {
      const mtimeAt = await optionalStat(resPath);
      if (Number.isFinite(mtimeAt) && mtimeAt <= now) {
        nextEvidence.push({ source: '결과 경로 mtime', at: mtimeAt });
      }
      const commitAt = await resultCommitAt(resPath, role.workspace, now);
      if (Number.isFinite(commitAt) && commitAt <= now) {
        nextEvidence.push({ source: '결과 경로 커밋', at: commitAt });
      }
    }
  }

  const latest = nextEvidence.length
    ? nextEvidence.reduce((best, cur) => (cur.at > best.at ? cur : best))
    : null;
  const fallbackFirst = record.cardFirstSeen?.[card.cardKey] ?? now;
  const effectiveAt = latest ? latest.at : fallbackFirst;
  const stalledMs = Math.max(0, now - effectiveAt);
  const stalled = card.isOpen && stalledMs >= staleMs;

  return {
    ...card,
    evidenceSources: nextEvidence,
    lastEvidenceAt: latest ? latest.at : null,
    lastEvidenceSource: latest ? latest.source : '관찰 시작(증거 없음)',
    effectiveAt,
    stalledMs,
    stalled,
  };
}

function buildWakeFilename({ stamp, cardId, roleId, cardKey, disambiguate = false }) {
  const safeId = cardId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'card';
  const safeRole = roleId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'role';
  const route = `-route-${safeRole}.md`;
  const keyTag = disambiguate || safeId !== cardId
    ? `-${createHash('sha256').update(cardKey).digest('hex').slice(0, 8)}`
    : '';
  const candidate = `${stamp}-stalled-${safeId}${keyTag}${route}`;
  if (Buffer.byteLength(candidate) <= 255) return candidate;
  const hash = createHash('sha256').update(JSON.stringify([cardKey, roleId, stamp])).digest('hex');
  const maxBody = Math.max(16, 255 - Buffer.byteLength(route));
  return `${stamp}-stalled-${hash}`.slice(0, maxBody) + route;
}

function formatStallDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return hours > 0 ? `${totalMin}분 (${hours}시간 ${mins}분)` : `${totalMin}분`;
}

/**
 * Format wake markdown body for a stalled card, escalating to humanChannel once wakeCount reaches escalateAfterCount.
 */
export function formatStalledCardWake({ roleId, card, wakeCount, escalateAfterCount }) {
  const evidenceText = card.lastEvidenceAt !== null
    ? `${card.lastEvidenceSource} (${new Date(card.lastEvidenceAt).toISOString()})`
    : '없음';
  const lines = [
    `[장부] 멈춘 카드: ${singleLine(card.title)}`,
    `역할: ${singleLine(roleId)}`,
    `카드 id: ${singleLine(card.id)}`,
    `멈춘 시간: ${formatStallDuration(card.stalledMs)}`,
    `마지막 증거: ${evidenceText}`,
    `기한: ${card.due ? singleLine(card.due) : '없음'}`,
    `결과 경로: ${card.resultPaths.length ? card.resultPaths.join(', ') : '없음'}`,
    `반복 횟수: ${wakeCount}회`,
  ];
  if (wakeCount >= escalateAfterCount) {
    const channel = card.humanChannel ? singleLine(card.humanChannel) : '미설정(장부 사람 채널 확인 필요)';
    lines.push(`보고 대상(사람 채널): ${channel}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reconcile per-card episode state and emit deduplicated repeat/escalated wake files into role.wakeDir.
 */
export async function syncCardWakes({ role, cardResults, ledgerKnown, now, dry, thresholds }) {
  const { record } = role;
  record.cardStalls ??= {};
  record.cardStatuses ??= {};
  record.cardTransitions ??= {};
  record.cardFirstSeen ??= {};

  const wakes = [];
  const errors = [];
  let previews = 0;

  if (!ledgerKnown) {
    return { wakes, previews, errors };
  }

  const seenKeys = new Set();
  const usedFiles = new Set();
  for (const card of cardResults) {
    seenKeys.add(card.cardKey);

    if (!card.isOpen) {
      if (card.isHumanWait || card.isClosed) {
        record.cardStatuses[card.cardKey] = { status: card.status, at: now };
        delete record.cardStalls[card.cardKey];
        delete record.cardTransitions[card.cardKey];
        delete record.cardFirstSeen[card.cardKey];
      } else {
        if (!errors.includes('work ledger unavailable')) errors.push('work ledger unavailable');
      }
      continue;
    }

    record.cardStatuses[card.cardKey] = { status: card.status, at: now };

    if (card.lastEvidenceAt === null) {
      record.cardFirstSeen[card.cardKey] ??= now;
    } else {
      delete record.cardFirstSeen[card.cardKey];
    }

    const existing = record.cardStalls[card.cardKey];
    // New progress resets or closes the prior episode cleanly.
    if (!card.stalled || (existing && card.effectiveAt > existing.evidenceAt)) {
      delete record.cardStalls[card.cardKey];
      if (!card.stalled) continue;
    }

    if (!card.wakeDir) {
      if (!errors.includes('wake dir unavailable')) errors.push('wake dir unavailable');
      continue;
    }

    const episode = record.cardStalls[card.cardKey] ??= {
      cardId: card.id,
      episodeAt: now,
      evidenceAt: card.effectiveAt,
      wakeCount: 0,
      lastWakeAt: null,
    };

    if (episode.lastWakeAt !== null && now - episode.lastWakeAt < thresholds.repeatMs) {
      continue;
    }

    const nextCount = episode.wakeCount + 1;
    const escalated = nextCount >= thresholds.escalateAfterCount;

    if (dry) {
      previews++;
      continue;
    }

    await mkdir(card.wakeDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now).toISOString().replace(/\D/g, '');
    let file = join(card.wakeDir, buildWakeFilename({ stamp, cardId: card.id, roleId: role.role, cardKey: card.cardKey }));
    if (usedFiles.has(file)) {
      file = join(card.wakeDir, buildWakeFilename({ stamp, cardId: card.id, roleId: role.role, cardKey: card.cardKey, disambiguate: true }));
    }
    usedFiles.add(file);
    const body = formatStalledCardWake({
      roleId: role.role,
      card,
      wakeCount: nextCount,
      escalateAfterCount: thresholds.escalateAfterCount,
    });

    let created = true;
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(body); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      created = false;
    }

    if (created) {
      previews++;
      episode.wakeCount = nextCount;
      episode.lastWakeAt = now;
      wakes.push({
        role: role.role,
        cardId: card.id,
        title: card.title,
        wakeCount: nextCount,
        escalated,
        humanChannel: card.humanChannel,
        file,
      });
    }
  }

  for (const key of Object.keys(record.cardStalls)) {
    if (!seenKeys.has(key)) delete record.cardStalls[key];
  }
  for (const key of Object.keys(record.cardStatuses)) {
    if (!seenKeys.has(key)) {
      delete record.cardStatuses[key];
      delete record.cardTransitions[key];
      delete record.cardFirstSeen[key];
    }
  }

  return { wakes, previews, errors };
}
