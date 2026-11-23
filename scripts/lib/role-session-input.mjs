import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from '../role-wake.mjs';
import { verifiedActiveMention } from './active-mention.mjs';

export const payloadHash = text => createHash('sha256').update(text).digest('hex');
const tools = new Set(['codex', 'muse', 'claude', 'agy', 'opencode']);
const wrappers = new Set(['sudo', 'env', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'setsid', 'script', 'stdbuf', 'timeout', 'nice']);
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const prompt = /^[ \t]*([❯›➜»>])(?:[ \t]+(.*)|$)/;
const placeholder = /^(?:type a message|ask anything|ask codex to do anything|\/usage shows this|메시지를 입력하세요)?$/i;
const footer = /^(?:[─━═]{3,}|GPT[- ]\d|muse[- ·]|claude[- ·]|gemini[- ·]|\[default\]|tab\s+to\s+queue|\?\s+for\s+shortcuts|\d+%\s+context)/i;
const active = /^[ \t]*(?:#[ \t]*)?(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒✶✳✢✻✽✼◈◇•][ \t]+[^\n]*\(\s*\d+(?:\.\d+)?\s*[smh]\b|(?:thinking|working|running|double\s+checking)(?:[.…]|\s*\()|(?:esc|escape)\s+to\s+(?:cancel|interr\w*))/im;

export function screenState(screen) {
  if (typeof screen !== 'string' || !screen.trim()) return 'unknown';
  const lines = screen.replace(ansi, '').replaceAll('\r', '').split('\n');
  let index = -1, match;
  for (let i = 0; i < lines.length; i++) {
    const candidate = prompt.exec(lines[i]);
    if (candidate) { index = i; match = candidate; }
  }
  if (index < 0) return 'unknown';
  if (active.test(lines.slice(Math.max(0, index - 12), index).join('\n'))) return 'busy';
  const parts = [match[2] ?? ''];
  for (const line of lines.slice(index + 1)) {
    if (footer.test(line.trim())) break;
    parts.push(line.trim());
  }
  return placeholder.test(parts.join(' ').trim().replace(/\s+/g, ' ')) ? 'idle' : 'draft';
}

function program(process) {
  const tokens = process.argv ?? String(process.cmdline ?? process.args ?? '').split(/\s+/);
  const first = path.basename(tokens[0] ?? '').replace(/^-/, '');
  return { first, name: ['node', 'nodejs'].includes(first) ? path.basename(tokens[1] ?? '').replace(/\.m?js$/, '') : first };
}

export function resolveAgentProcess(foreground, processes) {
  const queue = [...foreground], seen = new Set();
  while (queue.length) {
    const item = queue.shift(), executable = program(item);
    const tool = [...tools].find(tool => executable.name === tool || executable.name.startsWith(tool + '-bin'));
    if (tool) return { ...item, tool };
    if (!wrappers.has(executable.first) || !Number.isInteger(item.pid) || seen.has(item.pid)) continue;
    seen.add(item.pid);
    queue.push(...processes.filter(child => child.ppid === item.pid));
  }
  return null;
}

export function validateBinding(session, agent, native) {
  if (native?.error) return native.error === 'session_unbound' ? 'session_unbound' : 'native_unreadable';
  if (session?.kind !== 'codex-jsonl' || agent?.tool !== 'codex') return 'unsupported';
  if (!session.thread_id || !session.native_path || !session.cwd || !session.process_start || !Number.isInteger(session.pid)) return 'session_unbound';
  if (agent.pid !== session.pid || native.process_start !== session.process_start) return 'process_mismatch';
  if (native.thread_id !== session.thread_id) return 'thread_mismatch';
  if (path.resolve(native.cwd ?? '') !== path.resolve(session.cwd) || path.resolve(native.process_cwd ?? '') !== path.resolve(session.cwd)) return 'cwd_mismatch';
  return null;
}

async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

export function attemptFile(stateDir, role, key) {
  if (!/^[a-zA-Z0-9_-]+$/.test(role)) throw new Error('invalid role');
  return path.join(stateDir, 'role-input', `${role}-${payloadHash(key)}.json`);
}

async function readAttempt(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function lockRole(stateDir, role) {
  if (!/^[a-zA-Z0-9_-]+$/.test(role)) throw new Error('invalid role');
  return acquireLock({ stateDir: path.join(stateDir, 'role-input', role) });
}

export async function deliverInput({ role, key, text, sourceMessageId = null, sourceSha256 = null,
  transportSha256 = null, canonicalAttempt = false, activeMention = null, profile, stateDir, ackTimeoutMs = 5000, pollMs = 200 }, deps) {
  const release = await lockRole(stateDir, role);
  if (!release) return { code: 75, reason: 'receiver_locked' };
  try {
    const file = attemptFile(stateDir, role, key);
    const before = await readAttempt(file);
    const fixedPayload = ['submitting', 'submitted_unconfirmed', 'accepted'].includes(before?.status);
    const terminalNotSubmitted = before?.canonical_attempt === true && before.status === 'not_submitted';
    const immutable = fixedPayload || terminalNotSubmitted;
    const hash = immutable ? before.payload_hash : payloadHash(text);
    const record = { ...before, role, source_key: key, source_message_id: immutable ? before.source_message_id : sourceMessageId,
      status: immutable ? before.status : 'not_submitted',
      canonical_attempt: before?.canonical_attempt ?? canonicalAttempt,
      pane_id: immutable ? before.pane_id : profile.pane_id,
      thread_id: immutable ? before.thread_id : profile.session?.thread_id ?? null,
      source_sha256: immutable ? before.source_sha256 : sourceSha256 ?? before?.source_sha256 ?? null,
      transport_sha256: immutable ? before.transport_sha256 : transportSha256 ?? before?.transport_sha256 ?? null,
      payload_hash: hash,
      first_at: before?.first_at ?? new Date(deps.now()).toISOString() };
    const finish = async (code, reason, extra = {}) => {
      Object.assign(record, extra, { reason, last_at: new Date(deps.now()).toISOString() });
      await atomic(file, record);
      return { schema_version: 1, code, role, source_key: key, source_sha256: record.source_sha256,
        payload_sha256: record.payload_hash, thread_id: record.thread_id ?? profile.session?.thread_id ?? null,
        status: code === 0 ? 'accepted' : code === 1 ? 'failed' : ['submitting', 'submitted_unconfirmed'].includes(record.status) ? 'uncertain' : 'deferred',
        reason, ...(record.active_transport && { active_transport: record.active_transport }), first_at: record.first_at, last_at: record.last_at,
        native_user_ack: record.native_evidence ?? null, attempt_path: file };
    };
    if (terminalNotSubmitted) return finish(75, 'attempt_terminal');
    if (fixedPayload && before.source_sha256 && sourceSha256 && before.source_sha256 !== sourceSha256) return finish(75, 'source_changed');
    if (fixedPayload && before.transport_sha256 && transportSha256 && before.transport_sha256 !== transportSha256) {
      record.transport_sha256 = before.transport_sha256;
      return finish(75, 'transport_payload_changed');
    }
    const inspected = await deps.inspect(profile);
    const agent = resolveAgentProcess(inspected.foreground, inspected.processes);
    if (!agent) return finish(75, 'unknown_agent');
    const readNative = async query => {
      try { return await deps.native(profile.session, hash, agent, query); }
      catch (error) { return { error: error.code ?? 'native_read_failed' }; }
    };
    const query = () => ({ ...(record.native_cursor && { cursor: record.native_cursor, file_id: record.native_file_id }),
      ...(record.active_turn_id && { expected_turn_id: record.active_turn_id }) });
    const native = await readNative(query());
    const invalid = validateBinding(profile.session, agent, native);
    if (invalid) return finish(75, invalid, { native_error: native.error ?? null });
    if (record.thread_id && record.thread_id !== native.thread_id) return finish(75, 'thread_mismatch');
    if (fixedPayload && record.native_file_id !== native.file_id) return finish(75, 'native_rotated');
    if (record.status === 'accepted') return finish(0, 'submitted_ack');
    const acknowledge = snapshot => snapshot.ack && snapshot.ack.offset >= record.native_after_offset &&
      snapshot.ack.thread_id === profile.session.thread_id && snapshot.ack.payload_sha256 === hash &&
      (!record.active_turn_id || snapshot.ack.turn_id === record.active_turn_id);
    if (fixedPayload && acknowledge(native)) return finish(0, 'submitted_ack', { status: 'accepted', native_evidence: native.ack });
    if (fixedPayload) {
      record.native_cursor = native.next_cursor ?? record.native_cursor;
      return finish(75, 'native_ack_pending');
    }
    let activeTurn = null;
    if (canonicalAttempt && verifiedActiveMention(activeMention, role, profile, key, text, transportSha256) && native.state !== 'idle' && typeof deps.steer === 'function') {
      activeTurn = native.turn_id ?? null;
      if (!activeTurn && deps.activeTurn) {
        try { activeTurn = await deps.activeTurn(profile); } catch { /* Long rollouts may lack a recent turn boundary. */ }
      }
    }
    const steering = Boolean(activeTurn);
    if (!steering) {
      if (native.state !== 'idle') return finish(75, native.state === 'active' ? 'screen_busy' : 'native_state_unknown');
      const screen = screenState(inspected.screen);
      if (screen !== 'idle') return finish(75, screen === 'busy' ? 'screen_busy' : screen);
    } else {
      record.active_turn_id = activeTurn;
      record.source_message_id = activeMention.message;
      record.gateway_wake_sha256 = activeMention.wake_sha256;
    }
    record.status = 'submitting';
    record.thread_id = native.thread_id;
    record.native_file_id = native.file_id;
    record.native_after_offset = native.byte_size;
    record.native_cursor = { offset: native.byte_size };
    if (steering) record.transport_api = 'codex.turn/steer';
    else if (deps.transportApi) record.transport_api = deps.transportApi;
    await finish(75, 'native_ack_pending');
    try {
      if (steering) {
        const receipt = await deps.steer(profile, record.active_turn_id, text);
        await finish(75, 'native_ack_pending', { status: 'submitted_unconfirmed', active_transport: receipt });
      } else {
        await deps.submit(profile, text);
      }
    } catch (error) {
      const evidence = { transport_error: error.transportCode ?? error.code ?? 'unconfirmed',
        ...(Number.isInteger(error.status) && { transport_exit_status: error.status }) };
      if (steering && error.notSubmitted === true) {
        return finish(75, 'active_not_submitted', { ...evidence, status: 'not_submitted' });
      }
      if (!steering && (error.code === 'ENOENT' || error.beforeInput === true)) {
        return finish(1, error.code === 'ENOENT' ? 'transport_unavailable' : 'transport_rejected',
          { ...evidence, status: 'not_submitted' });
      }
      return finish(75, 'native_ack_pending', { ...evidence, status: 'submitted_unconfirmed' });
    }
    const deadline = deps.now() + ackTimeoutMs;
    do {
      const after = await readNative(query());
      const invalidAfter = validateBinding(profile.session, agent, after);
      if (invalidAfter) return finish(75, invalidAfter, { status: 'submitted_unconfirmed' });
      if (after.file_id !== record.native_file_id) return finish(75, 'native_rotated', { status: 'submitted_unconfirmed' });
      if (acknowledge(after)) return finish(0, 'submitted_ack', { status: 'accepted', native_evidence: after.ack });
      record.native_cursor = after.next_cursor ?? record.native_cursor;
      if (deps.now() >= deadline) break;
      await finish(75, 'native_ack_pending');
      await deps.sleep(pollMs);
    } while (deps.now() <= deadline);
    return finish(75, 'native_ack_pending', { status: 'submitted_unconfirmed' });
  } finally { await release(); }
}

// Verification never injects input and never mutates attempt/native files. The
// dispatcher's attempt and raw payload digest identify the already-submitted
// transport; the saved actual-payload digest identifies the native user input.
export async function verifyInput({ role, key, transportSha256, profile, stateDir }, deps) {
  const projection = { status: 'unknown', attempt: key, sha256: transportSha256,
    role, pane: profile.pane_id, session: profile.session?.thread_id ?? null, receipt: null };
  const release = await lockRole(stateDir, role);
  if (!release) return { ...projection, reason: 'receiver_locked', code: 75 };
  try {
    const before = await readAttempt(attemptFile(stateDir, role, key));
    const rejected = () => ({ ...projection, status: 'rejected', reason: 'not_submitted', receipt: `not-submitted:${payloadHash(key)}`, code: 0 });
    if (!before) return { ...projection, reason: 'attempt_unrecorded', code: 75 };
    if (!transportSha256 || before.transport_sha256 !== transportSha256) return { ...projection, reason: 'transport_payload_changed', code: 75 };
    if (before.role !== role || before.source_key !== key || before.pane_id !== profile.pane_id || before.thread_id !== profile.session?.thread_id) {
      return { ...projection, reason: 'attempt_binding_mismatch', code: 75 };
    }
    if (before.status === 'not_submitted') return before.canonical_attempt === true ? rejected()
      : { ...projection, reason: 'legacy_nonterminal_attempt', code: 75 };
    if (!['submitting', 'submitted_unconfirmed', 'accepted'].includes(before.status)) return { ...projection, reason: 'attempt_phase_unknown', code: 75 };
    const inspected = await deps.inspect(profile);
    const agent = resolveAgentProcess(inspected.foreground, inspected.processes);
    if (!agent) return { ...projection, reason: 'unknown_agent', code: 75 };
    const turn = before.active_turn_id ? { expected_turn_id: before.active_turn_id } : {};
    let native = await deps.native(profile.session, before.payload_hash, agent,
      { cursor: before.native_cursor, file_id: before.native_file_id, ...turn });
    const check = snapshot => validateBinding(profile.session, agent, snapshot) ??
      (snapshot.file_id !== before.native_file_id ? 'native_rotated' : null);
    let invalid = check(native);
    if (invalid) return { ...projection, reason: invalid, code: 75 };
    // Verification has no writable cursor. Traverse only the bytes present at
    // this first snapshot's EOF, one bounded window at a time. New appends wait
    // for the next verification; a partial line never advances the cursor.
    const end = native.byte_size;
    while (before.status !== 'accepted' && !native.ack && native.next_cursor?.offset < end) {
      const offset = native.next_cursor.offset;
      const next = await deps.native(profile.session, before.payload_hash, agent,
        { cursor: { offset }, file_id: before.native_file_id, end_offset: end, ...turn });
      invalid = check(next);
      if (invalid) return { ...projection, reason: invalid, code: 75 };
      native = next;
      if (!native.ack && !(native.next_cursor?.offset > offset)) break;
    }
    const ack = before.status === 'accepted' ? before.native_evidence : native.ack;
    if (!ack || ack.offset < before.native_after_offset || ack.thread_id !== profile.session.thread_id || ack.payload_sha256 !== before.payload_hash ||
        (before.active_turn_id && ack.turn_id !== before.active_turn_id)) {
      return { ...projection, reason: before.active_transport ? 'steer_waiting_native' : 'native_ack_pending', code: 75 };
    }
    return { ...projection, status: 'accepted', code: 0, reason: 'submitted_ack',
      receipt: `codex-jsonl:${ack.thread_id}:${ack.offset}:${before.payload_hash}`, evidence: {
      source_sha256: before.source_sha256, payload_sha256: before.payload_hash,
      first_at: before.first_at, native_user_ack: ack, ...(before.active_turn_id && { gateway_wake_sha256: before.gateway_wake_sha256, active_turn_id: before.active_turn_id }),
    } };
  } finally { await release(); }
}
