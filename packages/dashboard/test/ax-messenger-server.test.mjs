import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createRequestHandler } from '../server.mjs'

const config = { features: { messenger: { enabled: true, backend: 'matrix', homeserverUrl: 'https://matrix.example.invalid', roles: { reader: ['read'] }, accounts: { reader: { roles: ['reader'], matrixUserId: '@reader:example.invalid' }, denied: { roles: [] } } } } }

test('대시보드 경로와 API가 검증된 게이트 계정과 권한을 요구한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-common-gate-'))
  const secretFile = path.join(dir, 'gate-test')
  const configFile = path.join(dir, 'instance.json')
  const secret = 'synthetic-'.padEnd(64, 'x')
  fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  fs.writeFileSync(configFile, JSON.stringify(config))
  const handler = createRequestHandler((_req, res) => { res.statusCode = 200; res.end('screen') }, {}, { NAIA_GATE_SECRET_FILE: secretFile, NAIA_INSTANCE_CONFIG: configFile })
  const call = async (url, headers = {}) => {
    const req = { url, method: 'GET', headers: { host: 'localhost:3142', ...headers }, socket: { remoteAddress: '127.0.0.1' } }
    const res = { setHeader() {}, end(body) { this.body = body } }
    await handler(req, res)
    return res
  }
  try {
    const gate = { 'x-naia-gate-secret': secret, 'x-ax-account-key': 'reader' }
    assert.equal((await call('/ax/messenger', { 'x-ax-account-key': 'reader' })).statusCode, 401)
    assert.equal((await call('/ax/messenger', { ...gate, 'x-ax-account-key': 'denied' })).statusCode, 403)
    assert.equal((await call('/ax/messenger', gate)).statusCode, 200)
    assert.equal((await call('/api/ax-messenger/rooms', { 'x-ax-account-key': 'reader' })).statusCode, 401)
    assert.equal((await call('/api/ax-messenger/rooms', { ...gate, 'x-ax-account-key': 'denied' })).statusCode, 403)
    assert.equal((await call('/api/ax-messenger/rooms', gate)).statusCode, 401)
    fs.writeFileSync(configFile, JSON.stringify({ features: { messenger: { enabled: false } } }))
    assert.equal((await call('/ax/messenger', gate)).statusCode, 404)
    assert.equal((await call('/api/ax-messenger/status')).statusCode, 404)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('게이트가 확인한 공개 원점 POST 요청은 내부 Host 뒤에서도 허용하고 위조된 원점은 거절한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-common-origin-'))
  const secretFile = path.join(dir, 'gate-test')
  const configFile = path.join(dir, 'instance.json')
  const secret = 'synthetic-'.padEnd(64, 'x')
  fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  fs.writeFileSync(configFile, JSON.stringify(config))
  const handler = createRequestHandler((_req, res) => { res.statusCode = 200; res.end('screen') }, {}, {
    NAIA_GATE_SECRET_FILE: secretFile,
    NAIA_INSTANCE_CONFIG: configFile,
    NAIA_DASHBOARD_PUBLIC_URL: 'https://dashboard.example.com/',
  })
  const postLogout = async (headers) => {
    const req = { url: '/api/ax-messenger/logout', method: 'POST', headers: { host: '127.0.0.1:3142', ...headers }, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() {} }
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, end(body) { this.body = body } }
    await handler(req, res)
    return res
  }
  try {
    const gate = { 'x-naia-gate-secret': secret, 'x-ax-account-key': 'reader' }
    assert.equal((await postLogout({ ...gate, origin: 'https://dashboard.example.com' })).statusCode, 200)
    assert.equal((await postLogout({ ...gate, origin: 'https://evil.example.com' })).statusCode, 403)
    assert.equal((await postLogout({ 'x-ax-account-key': 'reader', origin: 'https://dashboard.example.com' })).statusCode, 401)
  } finally { handler.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
