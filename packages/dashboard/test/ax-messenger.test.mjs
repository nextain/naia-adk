import assert from 'node:assert/strict'
import { PassThrough, Readable } from 'node:stream'
import { test } from 'node:test'
import { AxMessengerError, invalidInput } from '@naia-adk/ax-messenger'
import { authorizeMessenger, createAxMessengerHandler } from '../ax-messenger-gateway.mjs'

const config = { features: { messenger: { enabled: true, backend: 'matrix', homeserverUrl: 'https://matrix.example.invalid', roles: { reader: ['read'], writer: ['read', 'write'], admin: ['read', 'write', 'manage'] }, accounts: { reader: { roles: ['reader'], matrixUserId: '@reader:example.invalid' }, writer: { roles: ['writer'], matrixUserId: '@writer:example.invalid' }, admin: { roles: ['admin'], matrixUserId: '@admin:example.invalid' } } } } }

test('계정 역할의 읽기 쓰기 관리 권한은 명시된 것만 허용한다', () => {
  for (const [account, allowed] of [['reader', ['read']], ['writer', ['read', 'write']], ['admin', ['read', 'write', 'manage']], ['missing', []], ['toString', []]]) {
    for (const action of ['read', 'write', 'manage']) assert.equal(authorizeMessenger(config, account, action), allowed.includes(action), `${account} ${action}`)
  }
  assert.equal(authorizeMessenger(config, 'admin', 'unknown'), false)
  assert.equal(authorizeMessenger({ features: { messenger: { ...config.features.messenger, enabled: false } } }, 'admin', 'read'), false)
})

async function call(handler, account, method, url, data) {
  const req = Readable.from(data === undefined ? [] : [Buffer.from(JSON.stringify(data))])
  Object.assign(req, { method, url, headers: { host: 'localhost:3142', origin: 'http://localhost:3142' } })
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body = '') { this.body = String(body) } }
  await handler(req, res, account)
  return { status: res.statusCode, body: res.body && JSON.parse(res.body) }
}

test('경로는 계정, 설정, 읽기·쓰기·관리 권한을 서버에서 검사한다', async () => {
  let sent = 0, logins = 0
  const mockClient = { session: { userId: '@reader:example.invalid' }, start: async () => {}, stop() {}, listRooms: () => [{ roomId: '!room:example.invalid' }], getMessages: () => [], sendText: async () => { sent++ } }
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => { logins++; return mockClient } })
  assert.equal((await call(handler, null, 'GET', '/api/ax-messenger/rooms')).status, 401)
  assert.equal((await call(handler, 'missing', 'GET', '/api/ax-messenger/rooms')).status, 403)
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/send', { roomId: '!room:example.invalid', body: 'hello' })).status, 403)
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/admin', {})).status, 403)
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/admin/users', {})).status, 403)
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@reader:example.invalid', password: 'test' })).status, 200)
  assert.equal((await call(handler, 'reader', 'GET', '/api/ax-messenger/rooms')).status, 200)
  assert.equal((await call(handler, 'writer', 'GET', '/api/ax-messenger/rooms')).status, 401)
  assert.equal(sent, 0)
  assert.equal(logins, 1)
  const off = createAxMessengerHandler({ readConfig: () => ({ features: { messenger: { enabled: false } } }), login: async () => { throw Error('unexpected') } })
  assert.equal((await call(off, 'reader', 'GET', '/api/ax-messenger/rooms')).status, 404)
})

test('다른 Matrix 계정으로 로그인하거나 원점이 다른 쓰기는 거절한다', async () => {
  let loginCount = 0, stopped = 0
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => { loginCount++; return { session: { userId: '@other:example.invalid' }, stop() { stopped++ } } } })
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@other:example.invalid', password: 'test' })).status, 403)
  assert.equal(loginCount, 0)
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@reader:example.invalid', password: 'test' })).status, 403)
  assert.equal(stopped, 1)
})

test('설정 변경으로 서버 주소나 권한이 바뀌면 열린 세션을 더 이상 쓰지 않는다', async () => {
  let current = structuredClone(config), stopped = 0
  const client = { session: { userId: '@reader:example.invalid' }, start: async () => {}, stop() { stopped++ }, listRooms: () => [] }
  const handler = createAxMessengerHandler({ readConfig: () => current, login: async () => client })
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@reader:example.invalid', password: 'test' })).status, 200)
  current.features.messenger.homeserverUrl = 'https://other.example.invalid'
  assert.equal((await call(handler, 'reader', 'GET', '/api/ax-messenger/rooms')).status, 401)
  assert.equal(stopped, 1)
})

test('다른 원점에서 온 로그인은 Matrix에 전달하지 않는다', async () => {
  let logins = 0
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => { logins++; throw Error('unexpected') } })
  const req = Readable.from([Buffer.from(JSON.stringify({ user: '@reader:example.invalid', password: 'test' }))])
  Object.assign(req, { method: 'POST', url: '/api/ax-messenger/login', headers: { host: 'localhost:3142', origin: 'https://attacker.invalid' } })
  const res = { setHeader() {}, end() {} }
  await handler(req, res, 'reader')
  assert.equal(res.statusCode, 403)
  assert.equal(logins, 0)
})

test('쓰기 권한과 가입된 방에서만 전송하고 Matrix 거절을 그대로 오류로 표시한다', async () => {
  const calls = []
  const client = { session: { userId: '@writer:example.invalid' }, start: async () => {}, stop() {}, listRooms: () => [{ roomId: '!joined:example.invalid' }], sendText: async (...args) => { calls.push(args); if (args[1] === 'denied') throw { kind: 'forbidden' } } }
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => client })
  assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/login', { user: '@writer:example.invalid', password: 'test' })).status, 200)
  assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/send', { roomId: '!other:example.invalid', body: 'hello' })).status, 403)
  assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/send', { roomId: '!joined:example.invalid', body: 'hello' })).status, 200)
  const failure = await call(handler, 'writer', 'POST', '/api/ax-messenger/send', { roomId: '!joined:example.invalid', body: 'denied' })
  assert.equal(failure.status, 403)
  assert.match(failure.body.error, /권한/)
  assert.equal(calls.length, 2)
})

test('서버 종료 시 열려 있는 Matrix 연결을 정지한다', async () => {
  let stopped = 0
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => ({ session: { userId: '@reader:example.invalid' }, start: async () => {}, stop() { stopped++ } }) })
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@reader:example.invalid', password: 'test' })).status, 200)
  handler.close()
  assert.equal(stopped, 1)
})

test('로그아웃 뒤 늦게 끝난 로그인은 세션을 되살리지 않는다', async () => {
  let resolveLogin, stopped = 0
  const client = { session: { userId: '@reader:example.invalid' }, start: async () => {}, stop() { stopped++ }, listRooms: () => [] }
  const handler = createAxMessengerHandler({ readConfig: () => config, login: () => new Promise(resolve => { resolveLogin = resolve }) })
  const pending = call(handler, 'reader', 'POST', '/api/ax-messenger/login', { user: '@reader:example.invalid', password: 'test' })
  while (!resolveLogin) await new Promise(resolve => setImmediate(resolve))
  assert.equal((await call(handler, 'reader', 'POST', '/api/ax-messenger/logout', {})).status, 200)
  resolveLogin(client)
  assert.equal((await pending).status, 403)
  assert.equal(stopped, 1)
  assert.equal((await call(handler, 'reader', 'GET', '/api/ax-messenger/rooms')).status, 401)
})


test('본문 수신 중 권한 회수나 로그아웃이 일어나면 전송을 막는다', async () => {
  for (const revoke of ['permission', 'logout']) {
    let current = structuredClone(config), sent = 0
    const client = { session: { userId: '@writer:example.invalid' }, start: async () => {}, stop() {}, listRooms: () => [{ roomId: '!joined:example.invalid' }], sendText: async () => { sent++ } }
    const handler = createAxMessengerHandler({ readConfig: () => current, login: async () => client })
    assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/login', { user: '@writer:example.invalid', password: 'test' })).status, 200)
    const req = new PassThrough()
    Object.assign(req, { method: 'POST', url: '/api/ax-messenger/send', headers: { host: 'localhost:3142', origin: 'http://localhost:3142' } })
    const res = { setHeader() {}, end() {} }
    const sending = handler(req, res, 'writer')
    req.write('{')
    await new Promise(resolve => setImmediate(resolve))
    if (revoke === 'permission') current.features.messenger.roles.writer = ['read']
    else assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/logout', {})).status, 200)
    req.end('"roomId":"!joined:example.invalid","body":"hello"}')
    await sending
    assert.ok([401, 403].includes(res.statusCode), `${revoke}: ${res.statusCode}`)
    assert.equal(sent, 0)
    handler.close()
  }
})

test('공개 주소와 단일 머리글 검사를 적용해 요청 출처를 판정한다', async () => {
  const client = { session: { userId: '@reader:example.invalid' }, start: async () => {}, stop() {}, listRooms: () => [] }
  const handler = createAxMessengerHandler({
    readConfig: () => config,
    login: async () => client,
    env: { NAIA_DASHBOARD_PUBLIC_URL: 'https://public.example.com/' },
  })
  try {
    const post = async (headers, rawHeaders) => {
      const req = Readable.from([Buffer.from(JSON.stringify({ user: '@reader:example.invalid', password: 'test' }))])
      Object.assign(req, { method: 'POST', url: '/api/ax-messenger/login', headers, ...(rawHeaders ? { rawHeaders } : {}) })
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body = '') { this.body = String(body) } }
      await handler(req, res, 'reader')
      return res.statusCode
    }
    assert.equal(await post({ host: '127.0.0.1:3142', origin: 'https://public.example.com' }), 200)
    assert.equal(await post({ host: '127.0.0.1:3142', origin: 'https://other.example.com' }), 403)
    assert.equal(await post({ host: '127.0.0.1:3142', origin: 'http://127.0.0.1:3142' }, ['Host', '127.0.0.1:3142', 'Origin', 'http://127.0.0.1:3142', 'Origin', 'http://127.0.0.1:3142']), 403)
    assert.equal(await post({ host: '127.0.0.1:3142', origin: 'https://127.0.0.1:3142', 'x-forwarded-proto': 'https' }, ['host', '127.0.0.1:3142', 'origin', 'https://127.0.0.1:3142', 'x-forwarded-proto', 'https', 'x-forwarded-proto', 'https']), 403)
  } finally { handler.close() }
})

test('메신저 오류 종류와 내부 예외를 적절한 HTTP 상태로 구분해 돌려준다', async () => {
  let nextError
  const client = {
    session: { userId: '@writer:example.invalid' },
    start: async () => {},
    stop() {},
    listRooms: () => [{ roomId: '!joined:example.invalid' }],
    sendText: async () => { throw nextError },
  }
  const handler = createAxMessengerHandler({ readConfig: () => config, login: async () => client })
  try {
    assert.equal((await call(handler, 'writer', 'POST', '/api/ax-messenger/login', { user: '@writer:example.invalid', password: 'test' })).status, 200)
    const cases = [
      [invalidInput('메시지를 입력해 주세요.'), 400],
      [new AxMessengerError({ kind: 'rate-limited', userMessage: '요청이 많아 잠시 막혔습니다.', detail: 'rate', status: 429 }), 429],
      [new AxMessengerError({ kind: 'too-large', userMessage: '파일이 큽니다.', detail: 'large' }), 413],
      [new AxMessengerError({ kind: 'duplicate', userMessage: '이미 처리됨', detail: 'dup' }), 409],
      [new AxMessengerError({ kind: 'network', userMessage: '네트워크 오류', detail: 'net' }), 502],
      [new TypeError('unexpected gateway bug'), 500],
    ]
    for (const [err, expectedStatus] of cases) {
      nextError = err
      const res = await call(handler, 'writer', 'POST', '/api/ax-messenger/send', { roomId: '!joined:example.invalid', body: 'hello' })
      assert.equal(res.status, expectedStatus, `expected ${expectedStatus} for ${err.kind ?? err.name}, got ${res.status}`)
    }
    const emptyRes = await call(handler, 'writer', 'POST', '/api/ax-messenger/send', { roomId: '!joined:example.invalid', body: '   ' })
    assert.equal(emptyRes.status, 400)
  } finally { handler.close() }
})
