import fs from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:net';

function waitFor(socket, type) {
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      clearTimeout(timeout);
      socket.removeEventListener(type, ok);
      socket.removeEventListener('error', fail);
      socket.removeEventListener('close', fail);
      fn(value);
    };
    const ok = event => finish(resolve, event);
    const fail = () => finish(reject, new Error('active_transport_unavailable'));
    const timeout = setTimeout(fail, 3000);
    socket.addEventListener(type, ok);
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
  });
}

// An already-running, authenticated loopback app server is required. This client
// never starts, resumes, interrupts, or switches a thread, and never uses a TTY.
async function requestRoleTurn(profile, expectedTurnId, text, threadOnly = false) {
  let socket, sentSteer = false;
  try {
    const config = profile.active_mentions?.app_server;
    if (config?.socket_path) {
      const file = config.socket_path;
      if (config.url || config.token_file || !path.isAbsolute(file) || path.resolve(file) !== file ||
          await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('active_transport_unavailable');
      // Codex publishes an owner-only alias to its short Unix socket pathname.
      const target = await fs.realpath(file);
      const link = await fs.lstat(file), aliasParent = await fs.stat(path.dirname(file));
      const socketStat = await fs.lstat(target), parent = await fs.stat(path.dirname(target));
      if (!socketStat.isSocket() || (!link.isSocket() && !link.isSymbolicLink()) || link.uid !== socketStat.uid ||
          aliasParent.uid !== socketStat.uid || parent.uid !== socketStat.uid || ((aliasParent.mode | parent.mode) & 0o022) ||
          ((parent.mode & 0o007) && (socketStat.mode & 0o007))) throw new Error('active_socket_unprotected');
      const { WebSocket: UnixWebSocket } = await import('ws');
      socket = new UnixWebSocket('ws://localhost/', { createConnection: () => connect({ path: target }),
        followRedirects: false, handshakeTimeout: 3000, maxPayload: 1024 * 1024 });
    } else {
      const endpoint = new URL(config?.url);
      if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !path.isAbsolute(config.token_file ?? '')) throw new Error('active_transport_unavailable');
      const file = config.token_file;
      if (await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw new Error('active_transport_unavailable');
      const token = (await fs.readFile(file, 'utf8')).trim();
      if (!token || /\s/.test(token)) throw new Error('active_transport_unavailable');
      socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
    }
    await waitFor(socket, 'open');
    let id = 0;
    const request = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const finish = (fn, value) => {
        clearTimeout(timer);
        socket.removeEventListener('message', receive);
        socket.removeEventListener('close', failed);
        socket.removeEventListener('error', failed);
        fn(value);
      };
      const failed = () => finish(reject, new Error('active_transport_unconfirmed'));
      const receive = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.id !== requestId || message.method) return;
        if (message.error) return finish(reject, new Error('active_request_rejected'));
        finish(resolve, message.result);
      };
      const timer = setTimeout(failed, 3000);
      socket.addEventListener('message', receive);
      socket.addEventListener('close', failed);
      socket.addEventListener('error', failed);
      if (method === 'turn/steer') sentSteer = true;
      try { socket.send(JSON.stringify({ id: requestId, method, params })); } catch { failed(); }
    });
    await request('initialize', { clientInfo: { name: 'naia_role_receiver', title: 'Role receiver', version: '1' } });
    socket.send(JSON.stringify({ method: 'initialized' }));
    const { thread_id, cwd, native_path } = profile.session;
    const { thread } = await request('thread/read', { threadId: thread_id, includeTurns: false });
    if (thread?.id !== thread_id || thread.cwd !== cwd || thread.path !== native_path) throw new Error('active_turn_changed');
    if (threadOnly) {
      if (!['idle', 'active'].includes(thread.status?.type)) throw new Error('active_turn_changed');
      return { id: thread.id, cwd: thread.cwd, path: thread.path, status: { type: thread.status.type } };
    }
    if (thread.status?.type !== 'active') throw new Error('active_turn_changed');
    const { data: turns } = await request('thread/turns/list', { threadId: thread_id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    const current = turns?.[0];
    if (current?.status !== 'inProgress' || !current.id || (expectedTurnId && current.id !== expectedTurnId)) throw new Error('active_turn_changed');
    if (text === undefined) return current.id;
    if (!expectedTurnId) throw new Error('active_turn_changed');
    const response = await request('turn/steer', {
      threadId: thread_id, expectedTurnId, input: [{ type: 'text', text, text_elements: [] }],
    });
    if (response?.turnId !== expectedTurnId) throw new Error('active_transport_unconfirmed');
    return { method: 'turn/steer', turn_id: response.turnId };
  } catch (error) {
    throw Object.assign(error, { notSubmitted: !sentSteer });
  } finally { socket?.close(); }
}

export async function steerActiveTurn(profile, expectedTurnId, text) {
  return requestRoleTurn(profile, expectedTurnId, text);
}

export async function probeRoleThread(profile) {
  return requestRoleTurn(profile, null, undefined, true);
}
