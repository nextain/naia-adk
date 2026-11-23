#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deliverInput, payloadHash, verifyInput, resolveAgentProcess, validateBinding, screenState } from './lib/role-session-input.mjs';
import { createHash } from 'node:crypto';
import { resolveRoleRegistration } from './lib/role-session-registration-host.mjs';

const entry = fileURLToPath(import.meta.url);

export async function nativeSnapshot(session, hash, query = {}) {
  const result = { thread_id: null, cwd: null, state: 'unknown', ack: null };
  let file;
  try {
    const processStat = await fs.readFile(`/proc/${session.pid}/stat`, 'utf8');
    result.process_start = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ')[19];
    result.process_cwd = await fs.readlink(`/proc/${session.pid}/cwd`);
    if ((await fs.lstat(session.native_path)).isSymbolicLink()) throw Object.assign(new Error(), { code: 'native_symlink' });
    file = await fs.open(session.native_path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) throw Object.assign(new Error(), { code: 'native_not_file' });
    result.file_id = `${stat.dev}:${stat.ino}`;
    result.byte_size = stat.size;
    if (query.file_id && query.file_id !== result.file_id) throw Object.assign(new Error(), { code: 'native_rotated' });
    const limit = 512 * 1024;
    const end = query.end_offset ?? stat.size;
    if (!Number.isSafeInteger(end) || end < 0 || end > stat.size) throw Object.assign(new Error(), { code: 'native_truncated' });
    const prefix = Buffer.alloc(Math.min(64 * 1024, stat.size));
    const headerRead = await file.read(prefix, 0, prefix.length, 0);
    const newline = prefix.subarray(0, headerRead.bytesRead).indexOf(10);
    if (newline < 0) throw Object.assign(new Error(), { code: 'native_header_incomplete' });
    const header = JSON.parse(prefix.subarray(0, newline).toString('utf8'));
    if (header.type !== 'session_meta') throw Object.assign(new Error(), { code: 'native_header_invalid' });
    result.thread_id = header.payload?.id;
    result.cwd = header.payload?.cwd;
    const offset = query.cursor?.offset ?? Math.max(0, stat.size - limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > end) throw Object.assign(new Error(), { code: 'native_truncated' });
    let partial = false;
    if (offset) {
      const previous = Buffer.alloc(1);
      await file.read(previous, 0, 1, offset - 1);
      partial = previous[0] !== 10;
    }
    const bytes = Buffer.alloc(Math.min(limit, end - offset));
    const read = await file.read(bytes, 0, bytes.length, offset);
    result.bytes_read = headerRead.bytesRead + read.bytesRead;
    const data = bytes.subarray(0, read.bytesRead);
    const lastNewline = data.lastIndexOf(10);
    if (lastNewline < 0) {
      // A user record may be appended in several writes. Re-read the same
      // incomplete line next time; advancing would permanently lose its ACK.
      result.next_cursor = { offset };
      if (data.length === limit) result.error = 'native_record_too_large';
      return result;
    }
    result.next_cursor = { offset: offset + lastNewline + 1 };
    let position = 0;
    for (const raw of data.subarray(0, lastNewline + 1).toString('utf8').split('\n')) {
      const itemOffset = offset + position;
      position += Buffer.byteLength(raw) + 1;
      if (partial) { partial = false; continue; }
      let item;
      try { item = JSON.parse(raw); } catch { continue; }
      const value = item.payload;
      if (item.type === 'event_msg') {
        if (value?.type === 'task_started') result.state = 'active';
        if (['task_complete', 'turn_aborted', 'task_failed'].includes(value?.type)) result.state = 'idle';
      }
      if (item.type === 'response_item' && value?.role === 'user') {
        const text = typeof value.content === 'string' ? value.content : (value.content ?? [])
          .filter(part => ['input_text', 'text'].includes(part.type)).map(part => part.text ?? '').join('\n');
        if (payloadHash(text) === hash) result.ack = { thread_id: result.thread_id, offset: itemOffset,
          at: item.timestamp ?? null, payload_sha256: hash };
      }
    }
  } catch (error) { result.error = error.code ?? 'native_read_failed'; }
  finally { await file?.close(); }
  return result;
}

function processList(run) {
  return run('ps', ['-ww', '-eo', 'pid=,ppid=,args=']).split('\n')
    .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(match => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }));
}

function transportFailure(error) {
  // Retain only the API's bounded machine code, never its message or payload.
  for (const raw of [error.stdout, error.stderr]) {
    if (!raw || Buffer.byteLength(raw) > 64 * 1024) continue;
    try {
      const code = JSON.parse(String(raw)).error?.code;
      if (/^[a-z][a-z0-9_]{0,63}$/.test(code ?? '')) {
        error.transportCode = code;
        // Both errors return before the single byte-buffer enqueue in Herdr
        // 0.8.0 handle_pane_send_input. Other errors remain uncertain.
        error.beforeInput = ['pane_not_found', 'invalid_key'].includes(code);
        break;
      }
    } catch { /* no structured error: preserve uncertainty */ }
  }
  return error;
}

export function hostDependencies({ paneBin = 'herdr', run = (bin, args, options = {}) => execFileSync(bin, args, {
  encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, ...options,
}) } = {}) {
  return {
    transportApi: 'herdr.pane.send_input',
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    async inspect(profile) {
      try {
        const answer = JSON.parse(run(paneBin, ['pane', 'process-info', '--pane', profile.pane_id]));
        const foreground = answer.result?.process_info?.foreground_processes ?? [];
        const screen = run(paneBin, ['pane', 'read', profile.pane_id, '--source', 'visible', '--format', 'ansi', '--lines', '100']);
        return { foreground, screen, processes: processList(run) };
      } catch { return { foreground: [], processes: [], screen: null }; }
    },
    async native(session, hash, agent, query = {}) {
      if (!session) return { error: 'session_unbound' };
      const prefix = session.read_prefix ?? [];
      if (!Array.isArray(prefix) || prefix.some(part => typeof part !== 'string' || !part)) return { error: 'invalid_read_prefix' };
      if (!prefix.length) return nativeSnapshot(session, hash, query);
      try {
        const [bin, ...args] = [...prefix, process.execPath, entry, 'native-snapshot'];
        return JSON.parse(run(bin, args, { input: JSON.stringify({ session, hash, query }), timeout: 10_000 }));
      } catch (error) { return { error: error.code ?? 'native_read_failed' }; }
    },
    async submit(profile, text) {
      // Existing-session identity was checked independently of Herdr's agent
      // registration. One literal argument becomes one pane.send_input RPC:
      // live bracketed paste plus encoded Enter, with no shell interpretation.
      try { run(paneBin, ['pane', 'run', profile.pane_id, text], { timeout: 7000 }); }
      catch (error) { throw transportFailure(error); }
    },
  };
}

export async function main(argv = process.argv.slice(2), dependencies, env = process.env) {
  if (argv[0] === 'native-snapshot') {
    // Child stdin may be a socket or another uid's pipe. Read the inherited fd
    // rather than reopening /dev/stdin, which can fail with ENXIO/EACCES.
    const request = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(await nativeSnapshot(request.session, request.hash, request.query)) + '\n');
    return 0;
  }
  const value = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
  const configFile = value('--config'), role = value('--role') ?? env.ADK_WAKE_ROLE, file = value('--file');
  const verify = argv[0] === 'verify';
  const probe = argv[0] === 'probe';
  if (!configFile || !role || (!verify && !probe && !file)) throw new Error('required: --config FILE --role ROLE --file FILE');
  const registry = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const profile = registry.roles?.[role];
  if (!profile) throw new Error('role is not configured');
  const stateDir = registry.state_dir;
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('state_dir must be absolute');
  const resolved = { ...profile, pane_id: profile.pane_id ?? profile.find?.pane_id };
  if (!resolved.pane_id) throw new Error('role pane is not configured');
  if ((env.ADK_WAKE_ROLE && env.ADK_WAKE_ROLE !== role) || (env.ADK_WAKE_PANE && env.ADK_WAKE_PANE !== resolved.pane_id)) throw new Error('dispatcher binding differs');
  let deps = dependencies ?? hostDependencies({ paneBin: registry.pane?.bin });
  if (resolved.registration) {
    const registration = await (deps.registration ?? resolveRoleRegistration)(role, resolved);
    if (registration.code === 0) resolved.session = { ...resolved.session, ...registration.session };
    else {
      const reason = /^[a-z_]{1,64}$/.test(registration.reason ?? '') ? registration.reason : 'registration_unavailable';
      resolved.session = { ...resolved.session, pid: null, process_start: null, registration_error: reason };
      deps = { ...deps, native: async () => ({ error: reason }) };
    }
  }
  if (probe) {
    const inspected = await deps.inspect(resolved), agent = resolveAgentProcess(inspected.foreground, inspected.processes);
    const native = agent ? await deps.native(resolved.session, '') : {};
    const invalid = agent ? validateBinding(resolved.session, agent, native) : 'unknown_agent';
    const screen = screenState(inspected.screen);
    const reason = invalid ?? (native.state === 'active' || screen === 'busy' ? 'screen_busy' : native.state !== 'idle' ? 'native_state_unknown' : screen === 'idle' ? 'ready' : screen);
    const code = reason === 'ready' ? 0 : 75;
    process.stdout.write(JSON.stringify({ role, pane: resolved.pane_id, session: resolved.session?.thread_id, actual_pid: agent?.pid, reason, native_error: native.error ?? null, screen_state: screen, native_state: native.state, code }) + '\n');
    return code;
  }
  const key = env.ADK_WAKE_ATTEMPT ?? value('--key') ?? (file && path.resolve(file));
  if (!key) throw new Error('attempt key is required');
  const bytes = verify ? null : await fs.readFile(file);
  const transportSha256 = env.ADK_WAKE_PAYLOAD_SHA256 ?? (bytes && createHash('sha256').update(bytes).digest('hex'));
  const result = verify ? await verifyInput({ role, key, transportSha256, profile: resolved, stateDir }, deps)
    : await deliverInput({ role, key, transportSha256, canonicalAttempt: Boolean(env.ADK_WAKE_ATTEMPT), text: bytes.toString('utf8'),
      sourceSha256: value('--source-sha256'), sourceMessageId: value('--source-message-id'), profile: resolved, stateDir,
    }, deps);
  process.stdout.write(JSON.stringify({ role, ...result }) + '\n');
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(JSON.stringify({ reason: error.code ?? 'receiver_error' }) + '\n'); process.exitCode = 1;
  });
}
