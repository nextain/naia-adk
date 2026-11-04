/** Group-owned sensors. Adapters are trusted, locally installed code. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RECOVERY_ACTIONS = ['restart_sensor', 'enable_wait', 'clear_input'];
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const opaqueId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const fail = message => { throw new Error(message); };
export function localPath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => ['..', 'keys', '.keys'].includes(p))) fail('Unsafe group-relative path');
  const base = fs.realpathSync(root);
  let probe = path.resolve(base, relative);
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const actual = fs.realpathSync(probe);
  if (actual !== base && !actual.startsWith(base + path.sep)) fail('Path escapes group root');
  return path.resolve(base, relative);
}
export function validateSensorConfig(c, roles = []) {
  if (!c || typeof c.enabled !== 'boolean') fail('enabled must be boolean');
  if (!id(c.authority?.instance_id)) fail('authority.instance_id required');
  if (!id(c.state_directory)) fail('state_directory must be a directory label');
  const knownRole = role => id(role) && (!roles.length || roles.includes(role));
  const seen = new Set();
  for (const route of c.messenger?.routes ?? []) {
    if (!id(route.id) || seen.has(route.id) || !id(route.server_ref) || !knownRole(route.role)) fail('Invalid or duplicate messenger route');
    seen.add(route.id);
  }
  for (const source of c.mail?.sources ?? []) {
    if (!id(source.id) || seen.has(source.id) || !['mailbox', 'group'].includes(source.kind) || !id(source.resource_ref) || !knownRole(source.role)) fail('Invalid or duplicate mail source');
    seen.add(source.id);
  }
  if (c.mail && c.mail.metadata_only !== true) fail('Mail requires metadata_only: true');
  if (c.mail && (!Array.isArray(c.mail.agent_sender_refs) || !c.mail.agent_sender_refs.every(id))) fail('agent_sender_refs must be labels');
  if (c.messenger && (!Number.isFinite(c.messenger.unanswered_seconds) || c.messenger.unanswered_seconds < 1 || c.messenger.unanswered_seconds > 7200)) fail('Invalid unanswered_seconds');
  const sessionIds = new Set();
  for (const s of c.sessions ?? []) {
    if (!id(s.id) || sessionIds.has(s.id) || !id(s.expected_account_ref) || typeof s.workspace !== 'string' || !Array.isArray(s.recovery_actions) || !s.recovery_actions.every(a => RECOVERY_ACTIONS.includes(a))) fail('Invalid session');
    sessionIds.add(s.id);
  }
  return c;
}
export function loadGroup(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'adk.json'), 'utf8'));
  if (manifest.kind !== 'group') fail('Expected kind=group');
  const file = manifest.group_config?.operations?.sensors_file;
  if (!file) fail('group_config.operations.sensors_file required');
  const config = validateSensorConfig(JSON.parse(fs.readFileSync(localPath(root, file), 'utf8')), manifest.group_config.agents.map(a => a.role));
  for (const s of config.sessions ?? []) localPath(root, s.workspace);
  return config;
}
function atomicJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function identity(parts) { return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function checkAuthority(config, instance) {
  if (!config.enabled) fail('Group sensors disabled');
  if (instance !== config.authority.instance_id) fail('Only the configured sensor authority may act');
}
async function exclusive(root, config, instance, task) {
  checkAuthority(config, instance);
  const directory = localPath(root, config.state_directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = localPath(root, `${config.state_directory}/authority.lock`);
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ instance, pid: process.pid }));
    return await task(directory);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
/** Adapter reads headers only; wake must deduplicate the stable requestId durably. */
export async function pollGroup(root, config, instance, adapter, now = Date.now()) {
  validateSensorConfig(config);
  if (!config.enabled) return { disabled: true, delivered: 0 };
  return exclusive(root, config, instance, async directory => {
    const file = localPath(root, `${config.state_directory}/state.json`);
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, seen: {}, pending: {} };
    if (state.version !== 1 || !state.seen || !state.pending) fail('Invalid sensor state; operator review required');
    // Local outbox stores routing metadata; adapters never return mail bodies.
    const admit = (key, role, kind, at, metadata = {}) => {
      if (!state.seen[key]) state.pending[key] ??= { role, kind, at, metadata };
    };
    for (const route of config.messenger?.routes ?? []) {
      const messages = await adapter.readMessages({ route, since: now - 7200000, limit: 1000 });
      if (!Array.isArray(messages) || messages.length > 1000) fail('Bounded message batch required');
      const replies = messages.filter(m => m.team_bot === true && Number.isFinite(m.at) && m.at <= now);
      for (const message of messages) {
        if (!opaqueId(message.id) || !Number.isFinite(message.at) || message.at > now || now - message.at > 7200000) continue;
        if (message.team_bot === true || (message.human !== true && message.bot_mentioned !== true)) continue;
        if (replies.some(r => r.at > message.at)) continue;
        if (now - message.at < config.messenger.unanswered_seconds * 1000) continue;
        admit(identity(['messenger', route.server_ref, route.id, message.id]), route.role, 'messenger', message.at, { source_ref: route.server_ref, route_id: route.id, message_id: message.id });
      }
      // A response cancels failed-delivery retries for this route as well.
      for (const message of messages) if (replies.some(r => r.at > message.at)) delete state.pending[identity(['messenger', route.server_ref, route.id, message.id])];
    }
    for (const source of config.mail?.sources ?? []) {
      const headers = await adapter.readMailHeaders({ source, fields: ['id', 'sender_ref', 'subject', 'received_at'], limit: 1000 });
      if (!Array.isArray(headers) || headers.length > 1000) fail('Bounded mail header batch required');
      for (const header of headers) {
        if (!opaqueId(header.id) || !id(header.sender_ref) || typeof header.subject !== 'string' || !Number.isFinite(header.received_at) || header.received_at > now || now - header.received_at > 7200000) continue;
        if (config.mail.agent_sender_refs.includes(header.sender_ref)) continue;
        admit(identity(['mail', source.kind, source.resource_ref, header.id]), source.role, 'mail', header.received_at, { source_ref: source.resource_ref, source_kind: source.kind, message_id: header.id, sender_ref: header.sender_ref, subject: header.subject.slice(0, 256) });
      }
    }
    for (const [key, entry] of Object.entries(state.pending)) if (now - entry.at > 7200000) delete state.pending[key];
    // Durable outbox before effects. Restart retries with the same idempotency key.
    atomicJson(file, state);
    let delivered = 0;
    for (const [key, entry] of Object.entries(state.pending)) {
      await adapter.wake({ requestId: key, role: entry.role, kind: entry.kind, ...entry.metadata, access: 'read-only' });
      state.seen[key] = now;
      delete state.pending[key];
      atomicJson(file, state);
      delivered++;
    }
    for (const [key, at] of Object.entries(state.seen)) if (now - at > 86400000) delete state.seen[key];
    state.last_poll_at = now;
    atomicJson(file, state);
    return { delivered };
  });
}
/** Read-only adapter contract: snapshot booleans/refs, never screen or transcript text. */
export async function diagnoseGroup(root, config, adapter, now = Date.now()) {
  validateSensorConfig(config);
  const stateFile = localPath(root, `${config.state_directory}/state.json`);
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const sessions = [];
  for (const session of config.sessions ?? []) {
    const workspace = localPath(root, session.workspace);
    const status = await adapter.readSessionStatus({ sessionId: session.id, workspace });
    sessions.push({ id: session.id, checks: {
      workspace_matches: status.workspace === workspace,
      account_matches: status.account_ref === session.expected_account_ref,
      sensor_fresh: Number.isFinite(status.sensor_at) && status.sensor_at <= now && now - status.sensor_at <= 120000,
      input_clear: status.input_pending === false,
      wait_enabled: status.wait_enabled === true,
      session_alive: status.alive === true,
    } });
  }
  return { enabled: config.enabled, authority: config.authority.instance_id,
    sensor_fresh: Number.isFinite(state?.last_poll_at) && now >= state.last_poll_at && now - state.last_poll_at <= 120000,
    sessions };
}
export async function recoverGroup(root, config, instance, adapter, sessionId, action, apply = false) {
  validateSensorConfig(config);
  const session = config.sessions?.find(s => s.id === sessionId);
  if (!session || !RECOVERY_ACTIONS.includes(action) || !session.recovery_actions.includes(action)) fail('Recovery action outside allowlist');
  checkAuthority(config, instance);
  const before = await diagnoseGroup(root, config, adapter);
  const checks = before.sessions.find(s => s.id === sessionId).checks;
  if (!checks.workspace_matches || !checks.account_matches) fail('Workspace/account mismatch requires owner review');
  if (!apply) return { planned: action, session: sessionId, before };
  return exclusive(root, config, instance, async () => {
    // Recheck immediately under the same authority lock before a bounded effect.
    const fresh = await diagnoseGroup(root, config, adapter);
    const current = fresh.sessions.find(s => s.id === sessionId).checks;
    if (!current.workspace_matches || !current.account_matches) fail('Recovery identity changed');
    await adapter.recover({ sessionId, workspace: localPath(root, session.workspace), action });
    return { applied: action, after: await diagnoseGroup(root, config, adapter) };
  });
}
