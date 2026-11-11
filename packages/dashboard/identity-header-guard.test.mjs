import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  clearGateSecretCache,
  computeGateVerifiedToken,
  GATE_ACCOUNT_HEADER,
  GATE_SECRET_HEADER,
  GATE_VERIFIED_HEADER,
  isGateVerifiedHeaders,
  isLoopbackIp,
  isTrustedIdentityPeer,
  normalizeRemoteIp,
  parseTrustedProxyIps,
  readGateSecret,
  stripUntrustedIdentityHeaders,
  verifyGateSecretValue,
} from "./identity-header-guard.mjs"
import { buildProxyHeaders, createRequestHandler, proxyToApi } from "./server.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_TMP_ROOT = path.resolve(process.env.TMPDIR || "tmp", "identity-guard")
const createdDirs = []

function makeTempDir() {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true })
  const dir = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "run-"))
  createdDirs.push(dir)
  return dir
}

function writeSecretFile(dir, name, content, mode = 0o600) {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode })
  fs.chmodSync(filePath, mode)
  return filePath
}

afterEach(() => {
  clearGateSecretCache()
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

function makeFakeReq(remoteAddress, headers = {}, rawHeaders = null) {
  const hdrs = Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined))
  const raw =
    rawHeaders ??
    Object.entries(hdrs).flatMap(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
  return {
    method: "GET",
    url: "/schedule-personal",
    headers: hdrs,
    rawHeaders: raw,
    socket: { remoteAddress },
  }
}

describe("identity-header-guard 단위 및 server.mjs 연결 시험", () => {
  function publishFixture(extraEnv = {}) {
    const dir = makeTempDir()
    const secret = "publish-gate-" + crypto.randomBytes(24).toString("hex")
    const env = {
      NAIA_GATE_SECRET_FILE: writeSecretFile(dir, "gate.key", secret),
      PUBLISH_GATEWAY_SCOPE: "test-gate",
      PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "1",
      ...extraEnv,
    }
    return { secret, env }
  }

  function publishRequest(secret, headers = {}, rawHeaders = null, peer = "127.0.0.1") {
    const req = makeFakeReq(peer, {
      host: "127.0.0.1:42352",
      origin: "http://127.0.0.1:42352",
      [GATE_SECRET_HEADER]: secret,
      [GATE_ACCOUNT_HEADER]: "writer-one",
      ...headers,
    }, rawHeaders)
    req.method = "POST"
    req.url = "/api/portal/publish/example/approve"
    req.socket.localAddress = "127.0.0.1"
    return req
  }

  it("기존 사용자 머리글 이름과 게시 계정 이름이 같아도 기존 신원 동작과 게시 검증을 지킨다", () => {
    const { secret, env } = publishFixture()
    for (const setting of ["NAIA_NOTE_USER_HEADER", "NAIA_SCHEDULE_USER_HEADER"]) {
      const config = { ...env, [setting]: GATE_ACCOUNT_HEADER }
      for (const trusted of [true, false]) {
        const req = makeFakeReq(trusted ? "127.0.0.1" : "203.0.113.10", { [GATE_SECRET_HEADER]: secret, [GATE_ACCOUNT_HEADER]: "user-one" })
        req.url = "/api/portal/notes"
        stripUntrustedIdentityHeaders(req, config)
        assert.equal(req.headers[GATE_ACCOUNT_HEADER], trusted ? "user-one" : undefined)
        assert.equal(buildProxyHeaders(req, req.socket, "proxy-test", 42351, config)[GATE_ACCOUNT_HEADER], trusted ? "user-one" : undefined)
      }
      const req = publishRequest(secret)
      stripUntrustedIdentityHeaders(req, config)
      const proxy = buildProxyHeaders(req, req.socket, "proxy-test", 42351, config)
      assert.equal(proxy[GATE_ACCOUNT_HEADER], undefined)
      assert.equal(proxy["x-naia-actor-id"], "test-gate:writer-one")
      const untrusted = publishRequest(secret, {}, null, "203.0.113.10")
      stripUntrustedIdentityHeaders(untrusted, config)
      assert.equal(buildProxyHeaders(untrusted, untrusted.socket, "proxy-test", 42351, config)["x-naia-actor-id"], undefined)
      const noSecret = makeFakeReq("127.0.0.1", { [GATE_ACCOUNT_HEADER]: "user-one" })
      noSecret.url = "/api/portal/notes"
      stripUntrustedIdentityHeaders(noSecret, { ...config, NAIA_GATE_SECRET_FILE: undefined })
      assert.equal(noSecret.headers[GATE_ACCOUNT_HEADER], setting === "NAIA_NOTE_USER_HEADER" ? "user-one" : undefined)
    }
  })

  it("게시 계정은 관문 검증 뒤 scope:key로 새로 만들고 원본 계정·관문 머리글은 API에 보내지 않는다", () => {
    const { secret, env } = publishFixture()
    const req = publishRequest(secret, {
      "x-naia-actor-id": "test-gate:owner-one",
      "x-naia-actor-verified": "1",
    })
    stripUntrustedIdentityHeaders(req, env)
    assert.equal(req.headers["x-naia-actor-id"], undefined)
    assert.equal(req.headers["x-naia-actor-verified"], undefined)
    const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)
    assert.equal(out["x-naia-actor-id"], "test-gate:writer-one")
    assert.equal(out["x-naia-actor-verified"], "1")
    assert.equal(out["x-naia-origin-ok"], "1")
    assert.equal(out[GATE_ACCOUNT_HEADER], undefined)
    assert.equal(out[GATE_SECRET_HEADER], undefined)
    assert.equal(out[GATE_VERIFIED_HEADER], undefined)
  })

  it("게시 승인 경로는 확인 표시가 꺼져 있으면 프록시 전송 전에 403으로 닫힌다", () => {
    const { secret, env } = publishFixture()
    for (const flag of [undefined, "", "0", "true"]) {
      const req = publishRequest(secret, { [GATE_ACCOUNT_HEADER]: "owner-one", "x-naia-actor-id": "test-gate:owner-one", "x-naia-actor-verified": "1" })
      const res = { statusCode: 0, headers: {}, body: "", setHeader(key, value) { this.headers[key] = value }, end(value) { this.body = value } }
      const handle = createRequestHandler(() => assert.fail("승인 차단 뒤 화면 처리기로 넘어감"), {}, { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: flag })
      handle(req, res)
      assert.equal(res.statusCode, 403)
      assert.equal(JSON.parse(res.body).code, "publish_gateway_unconfirmed")
      assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
      assert.equal(res.headers["cache-control"], "no-store")
    }
  })

  it("42352 직접 접근·비밀 없는 호환·빠진 계정·표시명·누락 범위·비신뢰 소켓에서는 게시 계정을 만들지 않는다", () => {
    const { secret, env } = publishFixture()
    const cases = [
      { headers: { [GATE_SECRET_HEADER]: undefined } },
      { env: { ...env, NAIA_GATE_SECRET_FILE: undefined } },
      { headers: { [GATE_ACCOUNT_HEADER]: undefined, "x-ax-user": encodeURIComponent("대표님") } },
      { headers: { [GATE_ACCOUNT_HEADER]: encodeURIComponent("대표님") } },
      { env: { ...env, PUBLISH_GATEWAY_SCOPE: undefined } },
      { env: { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: undefined } },
      { env: { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "0" } },
      { env: { ...env, PUBLISH_GATEWAY_SCOPE: "test:gate" } },
      { peer: "203.0.113.10" },
    ]
    for (const example of cases) {
      const config = example.env ?? env
      const req = publishRequest(secret, example.headers, null, example.peer)
      stripUntrustedIdentityHeaders(req, config)
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, config)
      assert.equal(out["x-naia-actor-id"], undefined)
      assert.equal(out["x-naia-actor-verified"], undefined)
      assert.equal(out[GATE_ACCOUNT_HEADER], undefined)
    }
  })

  it("게시 계정은 배열·합친 값·원형 밖 문자·중복 원본·파싱 불일치를 거절한다", () => {
    const { secret, env } = publishFixture()
    for (const account of [["writer-one"], "writer-one, owner-one", "Writer-one", " writer-one", "writer-one ", "writer_one", "a", "a".repeat(33), "writer%2Done", "대표님"]) {
      const req = publishRequest(secret, { [GATE_ACCOUNT_HEADER]: account })
      stripUntrustedIdentityHeaders(req, env)
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)
      assert.equal(out["x-naia-actor-id"], undefined, String(account))
      assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
    }
    for (const raw of [
      [GATE_ACCOUNT_HEADER, "writer-one", "X-Ax-Account-Key", "writer-one"],
      [GATE_ACCOUNT_HEADER, "owner-one"],
    ]) {
      const req = publishRequest(secret, {}, [GATE_SECRET_HEADER, secret, ...raw])
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)["x-naia-actor-id"], undefined)
    }
  })

  it("잘못된 게시 계정은 정상 메모 작성자·개인 일정 신원을 지우지 않는다", () => {
    const { secret, env } = publishFixture({
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    })
    for (const flag of [undefined, "0", "1"]) {
      const config = { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: flag }
      for (const url of ["/api/portal/notes", "/schedule-personal", "/api/portal/publish/example/approve"]) {
        for (const account of ["INVALID", ["writer-one"], "writer-one, owner-one"]) {
          const req = publishRequest(secret, {
            [GATE_ACCOUNT_HEADER]: account,
            "x-ax-user": "user-two",
            "x-note-author": "user-one",
          })
          req.url = url
          stripUntrustedIdentityHeaders(req, config)
          assert.equal(req.headers["x-ax-user"], "user-two")
          assert.equal(req.headers["x-note-author"], "user-one")
          assert.equal(isGateVerifiedHeaders(req.headers, config), true)
          assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
          assert.equal(req.rawHeaders.includes(GATE_ACCOUNT_HEADER), false)
          assert.equal(req.rawHeaders.includes("user-one"), true)
          const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, config)
          assert.equal(out["x-note-author"], "user-one")
          assert.equal(out["x-naia-actor-id"], undefined)
          assert.equal(out["x-naia-actor-verified"], undefined)
        }
      }
    }
  })

  it("정상 게시 계정도 게시 경로 밖에서는 제거하고 기존 사용자 신원만 유지한다", () => {
    const { secret, env } = publishFixture({
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    })
    for (const url of ["/api/portal/notes?source=adk", "/schedule-personal", "/api/portal/publish-other/example/approve"]) {
      const req = publishRequest(secret, { "x-ax-user": "user-two", "x-note-author": "user-one" })
      req.url = url
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(req.headers["x-ax-user"], "user-two")
      assert.equal(req.headers["x-note-author"], "user-one")
      assert.equal(isGateVerifiedHeaders(req.headers, env), true)
      assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)
      assert.equal(out["x-naia-actor-id"], undefined)
      assert.equal(out["x-naia-actor-verified"], undefined)
    }
  })

  it("입구 처리기는 잘못된 게시 계정이 있어도 개인 일정의 검증 신원을 유지한다", () => {
    const { secret, env } = publishFixture({
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    })
    for (const flag of [undefined, "0", "1"]) {
      const config = { ...env, PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: flag }
      const req = publishRequest(secret, {
        [GATE_ACCOUNT_HEADER]: "INVALID",
        "x-ax-user": "user-two",
        "x-note-author": "user-one",
      })
      req.url = "/schedule-personal"
      const res = { statusCode: 200, setHeader() {}, end() {} }
      let reachedNext = false
      const handler = createRequestHandler((forwarded, response) => {
        reachedNext = true
        assert.equal(forwarded.headers["x-ax-user"], "user-two")
        assert.equal(forwarded.headers["x-note-author"], "user-one")
        assert.equal(isGateVerifiedHeaders(forwarded.headers, config), true)
        assert.equal(forwarded.headers[GATE_ACCOUNT_HEADER], undefined)
        response.end()
      }, {}, config)
      handler(req, res)
      assert.equal(reachedNext, true)
      assert.equal(res.statusCode, 200)
    }
  })

  it("꾸민 내부 검증표시와 이전 요청의 신원은 새 요청의 게시 권한이 되지 않는다", () => {
    const { secret, env } = publishFixture()
    const req = publishRequest(secret, { [GATE_VERIFIED_HEADER]: computeGateVerifiedToken(secret) })
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)["x-naia-actor-id"], undefined)
    stripUntrustedIdentityHeaders(req, env)
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)["x-naia-actor-id"], "test-gate:writer-one")
    // 기기 해제·쿠키 만료 뒤 관문이 신원을 보내지 않는 다음 요청을 재현한다.
    const revoked = publishRequest(undefined, {
      [GATE_ACCOUNT_HEADER]: undefined,
      "x-naia-actor-id": "test-gate:writer-one",
      "x-naia-actor-verified": "1",
      [GATE_VERIFIED_HEADER]: req.headers[GATE_VERIFIED_HEADER],
    })
    stripUntrustedIdentityHeaders(revoked, env)
    assert.equal(buildProxyHeaders(revoked, revoked.socket, "api-proxy-secret", 42351, env)["x-naia-actor-id"], undefined)
  })

  it("게시 쓰기는 같은 출처의 단일 Host·Origin에만 확인표시를 만든다", () => {
    const { secret, env } = publishFixture()
    const cases = [
      { origin: "https://outside.example" },
      { origin: undefined },
      { origin: ["http://127.0.0.1:42352"] },
      { Origin: "http://127.0.0.1:42352" },
    ]
    for (const headers of cases) {
      const req = publishRequest(secret, headers)
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)["x-naia-origin-ok"], undefined)
    }
    const req = publishRequest(secret, {}, ["Host", "127.0.0.1:42352", "Origin", "http://127.0.0.1:42352", "Origin", "http://127.0.0.1:42352"])
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 42351, env)["x-naia-origin-ok"], undefined)
  })

  it("NAIA_GATE_SECRET_FILE 읽기 규칙: 없거나·상대 경로·권한 600 아님(644 등)·32자 미만이면 비밀 없음(null) 상태가 된다", () => {
    const dir = makeTempDir()
    const validSecret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const validFile = writeSecretFile(dir, "valid.key", `  ${validSecret}\n`, 0o600)
    const mode644File = writeSecretFile(dir, "mode644.key", `${validSecret}\n`, 0o644)
    const mode640File = writeSecretFile(dir, "mode640.key", `${validSecret}\n`, 0o640)
    const shortFile = writeSecretFile(dir, "short.key", "short-secret-under-32-chars\n", 0o600)
    const missingFile = path.join(dir, "does-not-exist.key")

    assert.equal(readGateSecret({}), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: "" }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: "relative/path.key" }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: missingFile }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: mode644File }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: mode640File }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: shortFile }), null)
    assert.equal(readGateSecret({ NAIA_GATE_SECRET_FILE: validFile }), validSecret)
  })

  it("비밀이 설정되어 있을 때 루프백에서 맞는 x-naia-gate-secret 이 오면 사용자 머리글을 유지하고 비밀 머리글은 headers·rawHeaders 에서 지운다", () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "x-naia-user",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    }

    for (const ip of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1", "::FFFF:127.1.2.3"]) {
      assert.equal(isLoopbackIp(ip), true, `${ip} must be recognized as loopback`)
      assert.equal(isTrustedIdentityPeer(ip, env), true)

      const req = makeFakeReq(
        ip,
        {
          host: "127.0.0.1:42352",
          "x-naia-gate-secret": secret,
          "x-naia-user": "user-two",
          "x-note-author": "user-one",
        },
        [
          "Host",
          "127.0.0.1:42352",
          "X-Naia-Gate-Secret",
          secret,
          "X-Naia-User",
          "user-two",
          "X-Note-Author",
          "user-one",
        ],
      )
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(req.headers["x-naia-user"], "user-two")
      assert.equal(req.headers["x-note-author"], "user-one")
      assert.equal(req.headers["x-naia-gate-secret"], undefined)
      assert.equal(isGateVerifiedHeaders(req.headers, env), true)
      assert.deepEqual(req.rawHeaders, [
        "Host",
        "127.0.0.1:42352",
        "X-Naia-User",
        "user-two",
        "X-Note-Author",
        "user-one",
      ])
      assert.equal(req.rawHeaders.includes(secret), false)
    }
  })

  it("비밀이 설정되어 있을 때 비밀이 없거나·틀리거나(같은 길이/다른 길이)·여러 번 온 경우(배열/쉼표) 루프백이어도 사용자 머리글을 모두 지운다", () => {
    const dir = makeTempDir()
    const secret = "a".repeat(48)
    const wrongSameLen = "b".repeat(48)
    const wrongDiffLen = "c".repeat(33)
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    }

    assert.equal(verifyGateSecretValue(secret, secret), true)
    assert.equal(verifyGateSecretValue(wrongSameLen, secret), false)
    assert.equal(verifyGateSecretValue(wrongDiffLen, secret), false)

    const badCases = [
      { label: "비밀 머리글 없음", headers: { "x-ax-user": "user-two", "x-note-author": "user-one" } },
      {
        label: "틀린 비밀(같은 길이)",
        headers: { "x-naia-gate-secret": wrongSameLen, "x-ax-user": "user-two", "x-note-author": "user-one" },
      },
      {
        label: "틀린 비밀(다른 길이)",
        headers: { "x-naia-gate-secret": wrongDiffLen, "x-ax-user": "user-two", "x-note-author": "user-one" },
      },
      {
        label: "비밀 머리글 배열(중복)",
        headers: { "x-naia-gate-secret": [secret, secret], "x-ax-user": "user-two", "x-note-author": "user-one" },
      },
      {
        label: "비밀 머리글 쉼표 결합(중복)",
        headers: { "x-naia-gate-secret": `${secret}, ${secret}`, "x-ax-user": "user-two", "x-note-author": "user-one" },
      },
      {
        label: "사용자 머리글 쉼표 결합(중복)",
        headers: { "x-naia-gate-secret": secret, "x-ax-user": "user-two, admin", "x-note-author": "user-one" },
      },
      {
        label: "사용자 머리글 배열(중복)",
        headers: { "x-naia-gate-secret": secret, "x-ax-user": ["user-two", "admin"], "x-note-author": "user-one" },
      },
    ]

    for (const c of badCases) {
      const req = makeFakeReq("127.0.0.1", c.headers)
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(req.headers["x-naia-gate-secret"], undefined, `${c.label}: secret header must be stripped`)
      assert.equal(req.headers["x-ax-user"], undefined, `${c.label}: schedule user header must be stripped`)
      assert.equal(req.headers["x-note-author"], undefined, `${c.label}: note user header must be stripped`)
      assert.equal(isGateVerifiedHeaders(req.headers, env), false, `${c.label}: must not be gate verified`)
      assert.equal(
        req.rawHeaders.some((h) => h.toLowerCase() === "x-naia-gate-secret" || h.toLowerCase() === "x-ax-user"),
        false,
        `${c.label}: rawHeaders must not retain secret or user header`,
      )
    }

    // rawHeaders 에 비밀 머리글이 두 번 들어온 경우도 거부
    const dupRawReq = makeFakeReq(
      "127.0.0.1",
      { "x-naia-gate-secret": secret, "x-ax-user": "user-two" },
      ["X-Naia-Gate-Secret", secret, "X-Naia-Gate-Secret", secret, "X-Ax-User", "user-two"],
    )
    stripUntrustedIdentityHeaders(dupRawReq, env)
    assert.equal(dupRawReq.headers["x-ax-user"], undefined)
    assert.equal(isGateVerifiedHeaders(dupRawReq.headers, env), false)
  })

  it("테일넷(100.x)·사설 IP(192.168.x, 10.x, 172.16.x)·공인 IP에서 직접 온 요청은 비밀이 맞아도 신원 머리글과 비밀 머리글을 모두 지운다", () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "X-Naia-Schedule-User",
      NAIA_NOTE_USER_HEADER: "X-Naia-Note-User",
    }

    for (const ip of [
      "198.51.100.24",
      "::ffff:100.64.0.9",
      "192.168.1.15",
      "10.0.0.42",
      "172.16.0.5",
      "203.0.113.7",
      "fd7a:115c:a1e0::1",
      "",
    ]) {
      assert.equal(isLoopbackIp(ip), false, `${ip} must not be loopback`)
      assert.equal(isTrustedIdentityPeer(ip, env), false)

      const req = makeFakeReq(
        ip,
        {
          host: "198.51.100.24:42352",
          "x-naia-gate-secret": secret,
          "x-naia-schedule-user": "user-two",
          "X-Naia-Note-User": "jina",
          "user-agent": "Mozilla/5.0",
        },
        [
          "Host",
          "198.51.100.24:42352",
          "X-Naia-Gate-Secret",
          secret,
          "X-Naia-Schedule-User",
          "user-two",
          "X-Naia-Note-User",
          "jina",
          "User-Agent",
          "Mozilla/5.0",
        ],
      )
      stripUntrustedIdentityHeaders(req, env)

      assert.equal(req.headers["x-naia-gate-secret"], undefined)
      assert.equal(req.headers["x-naia-schedule-user"], undefined)
      assert.equal(req.headers["X-Naia-Note-User"], undefined)
      assert.equal(isGateVerifiedHeaders(req.headers, env), false)
      assert.equal(req.headers["host"], "198.51.100.24:42352")
      assert.equal(req.headers["user-agent"], "Mozilla/5.0")
      assert.deepEqual(req.rawHeaders, ["Host", "198.51.100.24:42352", "User-Agent", "Mozilla/5.0"])
    }
  })

  it("비밀이 설정되어 있지 않으면 메모 작성자 머리글(NAIA_NOTE_USER_HEADER)은 지금 동작 그대로(루프백 유지·외부 제거)이고 검증 표시는 붙지 않는다", () => {
    const env = {
      NAIA_SCHEDULE_USER_HEADER: "x-schedule-only",
      NAIA_NOTE_USER_HEADER: "x-note-author",
    }

    // 루프백: NAIA_NOTE_USER_HEADER 유지, NAIA_SCHEDULE_USER_HEADER 제거, x-naia-gate-secret 제거, 검증 표시 없음
    const loopReq = makeFakeReq(
      "127.0.0.1",
      {
        host: "127.0.0.1:42352",
        "x-naia-gate-secret": "unconfigured-secret-should-still-strip",
        "x-schedule-only": "user-two",
        "x-note-author": "user-one",
      },
      [
        "Host",
        "127.0.0.1:42352",
        "X-Naia-Gate-Secret",
        "unconfigured-secret-should-still-strip",
        "X-Schedule-Only",
        "user-two",
        "X-Note-Author",
        "user-one",
      ],
    )
    stripUntrustedIdentityHeaders(loopReq, env)
    assert.equal(loopReq.headers["x-naia-gate-secret"], undefined)
    assert.equal(loopReq.headers["x-schedule-only"], undefined)
    assert.equal(loopReq.headers["x-note-author"], "user-one")
    assert.equal(isGateVerifiedHeaders(loopReq.headers, env), false)
    assert.deepEqual(loopReq.rawHeaders, ["Host", "127.0.0.1:42352", "X-Note-Author", "user-one"])

    // 비루프백(테일넷 등): NAIA_NOTE_USER_HEADER 도 제거
    const tailReq = makeFakeReq("198.51.100.24", {
      "x-schedule-only": "user-two",
      "x-note-author": "user-one",
    })
    stripUntrustedIdentityHeaders(tailReq, env)
    assert.equal(tailReq.headers["x-schedule-only"], undefined)
    assert.equal(tailReq.headers["x-note-author"], undefined)
  })

  it("확인 표시 머리글(x-naia-gate-verified)을 바깥에서 꾸며 보내도 가드가 먼저 지워 무시한다", () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const realToken = computeGateVerifiedToken(secret)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
    }

    // 1) 비밀 없이 확인 표시 머리글(심지어 실제 토큰 값이라도)만 꾸며 보낸 경우 -> 지워지고 거부
    const spoofReq = makeFakeReq(
      "127.0.0.1",
      {
        "x-ax-user": "user-two",
        [GATE_VERIFIED_HEADER]: realToken,
      },
      ["X-Ax-User", "user-two", "X-Naia-Gate-Verified", realToken],
    )
    stripUntrustedIdentityHeaders(spoofReq, env)
    assert.equal(spoofReq.headers["x-ax-user"], undefined)
    assert.equal(spoofReq.headers[GATE_VERIFIED_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(spoofReq.headers, env), false)
    assert.deepEqual(spoofReq.rawHeaders, [])
  })

  it("NAIA_SCHEDULE_USER_HEADER 와 NAIA_NOTE_USER_HEADER 설정이 모두 비어 있으면 일반 머리글은 유지하되 x-naia-gate-secret 는 항상 지운다", () => {
    const req = makeFakeReq(
      "198.51.100.24",
      {
        host: "198.51.100.24:42352",
        "x-naia-gate-secret": "must-always-be-stripped",
        "x-custom": "keep",
      },
      ["Host", "198.51.100.24:42352", "X-Naia-Gate-Secret", "must-always-be-stripped", "X-Custom", "keep"],
    )
    stripUntrustedIdentityHeaders(req, {})
    assert.equal(req.headers["x-naia-gate-secret"], undefined)
    assert.equal(req.headers["x-custom"], "keep")
    assert.deepEqual(req.rawHeaders, ["Host", "198.51.100.24:42352", "X-Custom", "keep"])
  })

  it("NAIA_IDENTITY_TRUSTED_PROXIES(쉼표 구분 IP 목록)에 지정된 프록시 IP는 비밀이 맞을 때 믿고 그 밖의 IP는 지운다", () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_IDENTITY_TRUSTED_PROXIES: " 100.64.0.10 , ::ffff:192.168.10.20, fd00::99 ",
    }
    const trustedSet = parseTrustedProxyIps(env)
    assert.equal(trustedSet.has("100.64.0.10"), true)
    assert.equal(trustedSet.has("192.168.10.20"), true)
    assert.equal(trustedSet.has("fd00::99"), true)
    assert.equal(normalizeRemoteIp("::ffff:192.168.10.20"), "192.168.10.20")

    // 믿는 프록시 IP + 맞는 비밀 -> 유지
    const trustedReq = makeFakeReq("::ffff:100.64.0.10", {
      [GATE_SECRET_HEADER]: secret,
      "x-ax-user": "user-two",
    })
    stripUntrustedIdentityHeaders(trustedReq, env)
    assert.equal(trustedReq.headers["x-ax-user"], "user-two")
    assert.equal(trustedReq.headers[GATE_SECRET_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(trustedReq.headers, env), true)

    // 목록에 없는 다른 테일넷 IP + 맞는 비밀 -> 제거
    const untrustedReq = makeFakeReq("100.64.0.11", {
      [GATE_SECRET_HEADER]: secret,
      "x-ax-user": "user-two",
    })
    stripUntrustedIdentityHeaders(untrustedReq, env)
    assert.equal(untrustedReq.headers["x-ax-user"], undefined)
    assert.equal(untrustedReq.headers[GATE_SECRET_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(untrustedReq.headers, env), false)
  })

  it("대시보드 → API(42351) 프록시(buildProxyHeaders 및 proxyToApi)에 x-naia-gate-secret 와 x-naia-gate-verified 가 넘어가지 않는다", async () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_NOTE_USER_HEADER: "x-ax-user",
    }

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const req = makeFakeReq("127.0.0.1", {
      host: "127.0.0.1:42352",
      "x-naia-gate-secret": secret,
      "x-ax-user": encodeURIComponent("예시 사용자"),
    })
    req.socket = fakeSocket
    req.pipe = (dest) => {
      dest.end()
      return dest
    }

    // 1) buildProxyHeaders 에 직접 넣어도 x-naia-gate-secret 가 제거됨
    const directOut = buildProxyHeaders(req, fakeSocket, "proxy-sec-42351", 42351)
    assert.equal(directOut["x-naia-gate-secret"], undefined)
    assert.equal(directOut["x-naia-gate-verified"], undefined)
    assert.equal(directOut["x-ax-user"], encodeURIComponent("예시 사용자"))
    assert.equal(directOut["x-naia-proxy-secret"], "proxy-sec-42351")

    // 2) 가드 통과 후 proxyToApi 로 실제 가짜 API 서버에 보냈을 때도 x-naia-gate-secret 및 x-naia-gate-verified 가 넘어가지 않음
    stripUntrustedIdentityHeaders(req, env)
    assert.equal(isGateVerifiedHeaders(req.headers, env), true)

    let apiReceivedHeaders = null
    const dummyApi = http.createServer((apiReq, apiRes) => {
      apiReceivedHeaders = apiReq.headers
      apiRes.statusCode = 200
      apiRes.end("ok")
    })
    await new Promise((r) => dummyApi.listen(0, "127.0.0.1", r))
    const apiPort = dummyApi.address().port
    try {
      const clientRes = new http.ServerResponse(req)
      proxyToApi(req, clientRes, "/api/portal/notes?source=adk", apiPort, "proxy-sec-42351", fakeSocket)
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (apiReceivedHeaders) {
            clearInterval(timer)
            resolve()
          }
        }, 10)
      })
      assert.ok(apiReceivedHeaders)
      assert.equal(apiReceivedHeaders["x-naia-gate-secret"], undefined)
      assert.equal(apiReceivedHeaders["x-naia-gate-verified"], undefined)
      assert.equal(apiReceivedHeaders["x-ax-user"], encodeURIComponent("예시 사용자"))
      assert.equal(apiReceivedHeaders["x-naia-proxy-secret"], "proxy-sec-42351")
    } finally {
      await new Promise((r) => dummyApi.close(r))
    }
  })

  it("server.mjs createRequestHandler 연결: 실제 127.0.0.1 HTTP 서버 요청은 맞는 비밀일 때만 머리를 유지하고 비밀 머리글은 Next 처리기 전에 지워진다", async () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)

    const origSecretFile = process.env.NAIA_GATE_SECRET_FILE
    const origScheduleHeader = process.env.NAIA_SCHEDULE_USER_HEADER
    const origNoteHeader = process.env.NAIA_NOTE_USER_HEADER
    process.env.NAIA_GATE_SECRET_FILE = secretFile
    process.env.NAIA_SCHEDULE_USER_HEADER = "x-ax-user"
    process.env.NAIA_NOTE_USER_HEADER = "x-note-user"

    try {
      const captured = []
      const handler = createRequestHandler((req, res) => {
        captured.push({
          headers: { ...req.headers },
          rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
        })
        res.statusCode = 200
        res.end("ok")
      })

      // 1) 실제 127.0.0.1 HTTP 서버를 띄워 맞는 비밀 + 루프백 요청 확인
      const server = http.createServer(handler)
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
      const port = server.address().port
      try {
        const resStatus = await new Promise((resolve, reject) => {
          const req = http.request(
            {
              host: "127.0.0.1",
              port,
              path: "/schedule-personal",
              method: "GET",
              headers: {
                host: `127.0.0.1:${port}`,
                "x-naia-gate-secret": secret,
                "x-ax-user": "user-two",
                "x-note-user": "user-one",
                [GATE_ACCOUNT_HEADER]: "INVALID",
              },
            },
            (r) => {
              r.resume()
              r.on("end", () => resolve(r.statusCode))
            },
          )
          req.on("error", reject)
          req.end()
        })
        assert.equal(resStatus, 200)
        assert.equal(captured.length, 1)
        assert.equal(captured[0].headers["x-ax-user"], "user-two")
        assert.equal(captured[0].headers["x-note-user"], "user-one")
        assert.equal(captured[0].headers[GATE_ACCOUNT_HEADER], undefined)
        assert.equal(captured[0].headers["x-naia-gate-secret"], undefined)
        assert.equal(
          captured[0].rawHeaders.some((h) => h.toLowerCase() === "x-naia-gate-secret" || h === secret),
          false,
        )
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }

      // 2) 테일넷 원격 주소(198.51.100.24)로 직접 들어온 요청(비밀이 맞아도) -> 머리 제거 확인
      const tailnetReq = makeFakeReq(
        "198.51.100.24",
        {
          host: "198.51.100.24:42352",
          "x-naia-gate-secret": secret,
          "x-ax-user": "user-two",
          "x-note-user": "user-one",
        },
        ["Host", "198.51.100.24:42352", "X-Naia-Gate-Secret", secret, "X-Ax-User", "user-two", "X-Note-User", "user-one"],
      )
      const fakeRes = {
        statusCode: 200,
        headers: {},
        setHeader(k, v) {
          this.headers[k.toLowerCase()] = v
        },
        end() {},
      }
      handler(tailnetReq, fakeRes)
      assert.equal(captured.length, 2)
      assert.equal(captured[1].headers["x-naia-gate-secret"], undefined)
      assert.equal(captured[1].headers["x-ax-user"], undefined)
      assert.equal(captured[1].headers["x-note-user"], undefined)
      assert.equal(
        captured[1].rawHeaders.some(
          (h) =>
            h.toLowerCase() === "x-naia-gate-secret" ||
            h.toLowerCase() === "x-ax-user" ||
            h.toLowerCase() === "x-note-user",
        ),
        false,
      )
    } finally {
      if (origSecretFile === undefined) delete process.env.NAIA_GATE_SECRET_FILE
      else process.env.NAIA_GATE_SECRET_FILE = origSecretFile
      if (origScheduleHeader === undefined) delete process.env.NAIA_SCHEDULE_USER_HEADER
      else process.env.NAIA_SCHEDULE_USER_HEADER = origScheduleHeader
      if (origNoteHeader === undefined) delete process.env.NAIA_NOTE_USER_HEADER
      else process.env.NAIA_NOTE_USER_HEADER = origNoteHeader
    }
  })
})
