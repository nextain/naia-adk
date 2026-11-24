import fs from 'node:fs'
import { isAllowedMessengerOrigin } from './messenger-gate.mjs'

// Instance-owned configuration; missing or malformed configuration never enables Matrix.
export function readMessengerConfig(env = process.env) {
  const file = env.NAIA_INSTANCE_CONFIG
  if (!file) return {}
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function messengerConfig(config) {
  const value = config?.features?.messenger
  return value && typeof value === 'object' && value.enabled === true && value.backend === 'matrix' ? value : null
}

export function authorizeMessenger(config, account, action) {
  const feature = messengerConfig(config)
  if (!feature || !['read', 'write', 'manage'].includes(action) || typeof account !== 'string') return false
  const accounts = feature.accounts
  if (!accounts || typeof accounts !== 'object' || !Object.hasOwn(accounts, account)) return false
  const roles = feature.roles
  const assigned = accounts[account]?.roles
  return Boolean(roles && typeof roles === 'object' && Array.isArray(assigned) && assigned.some(role =>
    typeof role === 'string' && Object.hasOwn(roles, role) && Array.isArray(roles[role]) && roles[role].includes(action)))
}

const ERROR_BY_STATUS = {
  400: '요청을 확인해 주세요.',
  401: 'Matrix 인증에 실패했습니다.',
  403: 'Matrix 접근 권한이 없습니다.',
  409: '이미 처리된 요청입니다.',
  413: '요청이 너무 큽니다.',
  429: '요청이 많아 잠시 막혔습니다. 잠시 뒤 다시 시도해 주세요.',
  500: '메신저 요청을 처리하지 못했습니다.',
  502: 'Matrix 연결에 실패했습니다.',
}

const AX_KIND_STATUS = {
  'invalid-input': 400,
  auth: 401,
  forbidden: 403,
  duplicate: 409,
  'too-large': 413,
  'rate-limited': 429,
  network: 502,
  server: 502,
  unknown: 502,
}

/** Machine-readable error code for a gateway failure (mirrors ax.err.* keys). */
export function codeFromGatewayError(error) {
  if (error?.errcode === 'M_USER_IN_USE' || error?.kind === 'duplicate') {
    return 'user-in-use'
  }
  if (typeof error?.kind === 'string' && error.kind) {
    return error.kind
  }
  if (error?.errcode === 'M_FORBIDDEN' || error?.status === 403) {
    return 'no-permission'
  }
  if (error?.status === 401) {
    return 'login-required'
  }
  if (error?.status === 400) {
    return 'bad-request'
  }
  if (error?.status === 413) {
    return 'too-large'
  }
  return 'server'
}

function statusFromGatewayError(error) {
  if (error?.errcode === 'M_USER_IN_USE' || error?.kind === 'duplicate') {
    return 409
  }
  if (typeof error?.kind === 'string' && Object.hasOwn(AX_KIND_STATUS, error.kind)) {
    return AX_KIND_STATUS[error.kind]
  }
  // Legacy string fallback (kept last): older providers only surface a Korean message.
  if (typeof error?.userMessage === 'string' && error.userMessage.includes('이미 사용 중')) {
    return 409
  }
  if (error?.status === 400 || error?.status === 413) return error.status
  return 500
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32768) throw Object.assign(new Error('Request too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Invalid request'), { status: 400 }) }
}

const ERROR_CODE_BY_MESSAGE = {
  '메신저 서버가 종료되었습니다.': 'service-stopped',
  '메신저 설정을 읽지 못했습니다.': 'config-error',
  '메신저가 꺼져 있습니다.': 'messenger-off',
  '로그인이 필요합니다.': 'login-required',
  '메신저 접근 권한이 없습니다.': 'no-permission',
  '요청 출처를 확인해 주세요.': 'origin-not-allowed',
  '요청을 확인해 주세요.': 'bad-request',
  '연결할 계정을 확인해 주세요.': 'account-mismatch',
  '메신저 접근 권한이 변경되었습니다.': 'permission-changed',
  '관리 기능은 연결되지 않았습니다.': 'admin-disabled',
  'Matrix 로그인이 필요합니다.': 'login-required',
  '대화방 접근 권한이 없습니다.': 'room-denied',
  '메시지를 입력해 주세요.': 'message-required',
  '요청한 경로가 없습니다.': 'route-not-found',
  '요청을 처리하지 못했습니다.': 'server',
  '전송에 실패했습니다.': 'server',
  '연결에 실패했습니다.': 'matrix-conn',
  'Matrix 인증에 실패했습니다.': 'matrix-auth',
  'Matrix 접근 권한이 없습니다.': 'no-permission',
  '이미 처리된 요청입니다.': 'duplicate',
  '요청이 너무 큽니다.': 'too-large',
  '요청이 많아 잠시 막혔습니다. 잠시 뒤 다시 시도해 주세요.': 'rate-limited',
  '메신저 요청을 처리하지 못했습니다.': 'server',
  'Matrix 연결에 실패했습니다.': 'matrix-conn',
}

function respond(res, status, data) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  // Every JSON error carries a stable machine-readable `code` so the dashboard
  // can localize it (`ax.err.*`) instead of showing raw Korean banners.
  if (data && typeof data === 'object' && typeof data.error === 'string' && !data.code) {
    data = { ...data, code: ERROR_CODE_BY_MESSAGE[data.error] ?? codeFromGatewayError({ status }) ?? 'server' }
  }
  res.end(JSON.stringify(data))
}

export function createAxMessengerHandler({
  readConfig = () => readMessengerConfig(),
  login = async (...args) => (await import('@naia-adk/ax-messenger')).AxMessengerClient.login(...args),
  env = process.env,
  trustProxyOrigin = () => true,
} = {}) {
  const sessions = new Map()
  const generations = new Map()
  let epoch = 0
  const invalidate = account => { const next = (generations.get(account) ?? 0) + 1; generations.set(account, next); return next }
  let closed = false
  const handle = async function handle(req, res, account) {
    if (closed) return respond(res, 503, { error: '메신저 서버가 종료되었습니다.' })
    let config
    try { config = readConfig() } catch { return respond(res, 503, { error: '메신저 설정을 읽지 못했습니다.' }) }
    const feature = messengerConfig(config)
    if (!feature) {
      epoch++
      for (const session of sessions.values()) session.client.stop()
      sessions.clear()
      return respond(res, 404, { error: '메신저가 꺼져 있습니다.' })
    }
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice('/api/ax-messenger'.length)
    if (route === '/status' && req.method === 'GET') return respond(res, 200, { enabled: true })
    if (!account) return respond(res, 401, { error: '로그인이 필요합니다.' })
    const action = (route === '/admin' || route.startsWith('/admin/')) ? 'manage' : route === '/send' ? 'write' : 'read'
    if (!authorizeMessenger(config, account, action)) {
      if (!authorizeMessenger(config, account, 'read')) { invalidate(account); sessions.get(account)?.client.stop(); sessions.delete(account) }
      return respond(res, 403, { error: '메신저 접근 권한이 없습니다.' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedMessengerOrigin(req, env, { allowProxyOrigin: Boolean(trustProxyOrigin(req)) })) {
      return respond(res, 403, { error: '요청 출처를 확인해 주세요.' })
    }
    try {
      if (route === '/login' && req.method === 'POST') {
        const body = await readJson(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: '요청을 확인해 주세요.' })
        const expected = feature.accounts[account]?.matrixUserId
        if (typeof expected !== 'string' || body.user !== expected || typeof body.password !== 'string' || !body.password) return respond(res, 403, { error: '연결할 계정을 확인해 주세요.' })
        const generation = invalidate(account)
        const loginEpoch = epoch
        const client = await login(feature.homeserverUrl, body.user, body.password)
        if (client.session.userId !== expected) { client.stop(); return respond(res, 403, { error: '연결할 계정을 확인해 주세요.' }) }
        try { await client.start() } catch (error) { client.stop(); throw error }
        let current
        try { current = readConfig() } catch (error) { client.stop(); throw error }
        const currentFeature = messengerConfig(current)
        if (closed || epoch !== loginEpoch || generations.get(account) !== generation || !currentFeature || !authorizeMessenger(current, account, 'read') || currentFeature.homeserverUrl !== feature.homeserverUrl || currentFeature.accounts[account]?.matrixUserId !== expected) { client.stop(); return respond(res, 403, { error: '메신저 접근 권한이 변경되었습니다.' }) }
        sessions.get(account)?.client.stop()
        sessions.set(account, { client, userId: expected, homeserverUrl: feature.homeserverUrl })
        return respond(res, 200, { ok: true })
      }
      if (route === '/logout' && req.method === 'POST') {
        invalidate(account)
        sessions.get(account)?.client.stop(); sessions.delete(account)
        return respond(res, 200, { ok: true })
      }
      if (route === '/admin' || route.startsWith('/admin/')) return respond(res, 404, { error: '관리 기능은 연결되지 않았습니다.' })
      const session = sessions.get(account)
      if (!session || (session.userId !== feature.accounts[account]?.matrixUserId || session.homeserverUrl !== feature.homeserverUrl)) {
        if (session) { session.client.stop(); sessions.delete(account) }
        return respond(res, 401, { error: 'Matrix 로그인이 필요합니다.' })
      }
      const client = session.client
      if (route === '/rooms' && req.method === 'GET') return respond(res, 200, { rooms: client.listRooms() })
      if (route === '/messages' && req.method === 'GET') {
        const roomId = url.searchParams.get('roomId')
        if (!roomId || !client.listRooms().some(room => room.roomId === roomId)) return respond(res, 403, { error: '대화방 접근 권한이 없습니다.' })
        return respond(res, 200, { messages: client.getMessages(roomId) })
      }
      if (route === '/send' && req.method === 'POST') {
        const body = await readJson(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: '요청을 확인해 주세요.' })
        let current
        try { current = readConfig() } catch { return respond(res, 503, { error: '메신저 설정을 읽지 못했습니다.' }) }
        const currentFeature = messengerConfig(current)
        if (!currentFeature) return respond(res, 404, { error: '메신저가 꺼져 있습니다.' })
        if (!authorizeMessenger(current, account, 'write')) return respond(res, 403, { error: '메신저 접근 권한이 없습니다.' })
        if (sessions.get(account) !== session || session.userId !== currentFeature.accounts[account]?.matrixUserId || session.homeserverUrl !== currentFeature.homeserverUrl) return respond(res, 401, { error: 'Matrix 로그인이 필요합니다.' })
        if (typeof body.roomId !== 'string' || !client.listRooms().some(room => room.roomId === body.roomId)) return respond(res, 403, { error: '대화방 접근 권한이 없습니다.' })
        if (typeof body.body !== 'string' || !body.body.trim()) return respond(res, 400, { error: '메시지를 입력해 주세요.' })
        if (body.options !== undefined && (!body.options || typeof body.options !== 'object' || Array.isArray(body.options))) return respond(res, 400, { error: '요청을 확인해 주세요.' })
        await client.sendText(body.roomId, body.body, body.options)
        return respond(res, 200, { ok: true })
      }
      return respond(res, 404, { error: '요청한 경로가 없습니다.' })
    } catch (error) {
      const status = statusFromGatewayError(error)
      const message = error?.name === 'AxMessengerError' && typeof error.userMessage === 'string' && error.userMessage
        ? error.userMessage
        : ERROR_BY_STATUS[status]
      return respond(res, status, { error: message, code: codeFromGatewayError(error) })
    }
  }
  handle.close = () => {
    closed = true
    for (const session of sessions.values()) session.client.stop()
    sessions.clear()
  }
  return handle
}
