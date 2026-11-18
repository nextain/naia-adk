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
const TEST_TMP_ROOT = path.resolve(__dirname, "../../.tmp-test/identity-guard")
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
      host: "127.0.0.1:3142",
      origin: "http://127.0.0.1:3142",
      [GATE_SECRET_HEADER]: secret,
      [GATE_ACCOUNT_HEADER]: "writer-one",
      ...headers,
    }, rawHeaders)
    req.method = "POST"
    req.url = "/api/portal/publish/example/approve"
    req.socket.localAddress = "127.0.0.1"
    return req
  }

  it("게시 계정은 관문 검증 뒤 scope:key로 새로 만들고 원본 계정·관문 머리글은 API에 보내지 않는다", () => {
    const { secret, env } = publishFixture()
    const req = publishRequest(secret, {
      "x-naia-actor-id": "test-gate:owner-one",
      "x-naia-actor-verified": "1",
    })
    stripUntrustedIdentityHeaders(req, env)
    assert.equal(req.headers["x-naia-actor-id"], undefined)
    assert.equal(req.headers["x-naia-actor-verified"], undefined)
    const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)
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

  it("3142 직접 접근·비밀 없는 호환·빠진 계정·표시명·누락 범위·비신뢰 소켓에서는 게시 계정을 만들지 않는다", () => {
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
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, config)
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
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)
      assert.equal(out["x-naia-actor-id"], undefined, String(account))
      assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
    }
    for (const raw of [
      [GATE_ACCOUNT_HEADER, "writer-one", "X-Ax-Account-Key", "writer-one"],
      [GATE_ACCOUNT_HEADER, "owner-one"],
    ]) {
      const req = publishRequest(secret, {}, [GATE_SECRET_HEADER, secret, ...raw])
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)["x-naia-actor-id"], undefined)
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
            "x-ax-user": "luke",
            "x-note-author": "user-a",
          })
          req.url = url
          stripUntrustedIdentityHeaders(req, config)
          assert.equal(req.headers["x-ax-user"], "luke")
          assert.equal(req.headers["x-note-author"], "user-a")
          assert.equal(isGateVerifiedHeaders(req.headers, config), true)
          assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
          assert.equal(req.rawHeaders.includes(GATE_ACCOUNT_HEADER), false)
          assert.equal(req.rawHeaders.includes("user-a"), true)
          const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, config)
          assert.equal(out["x-note-author"], "user-a")
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
      const req = publishRequest(secret, { "x-ax-user": "luke", "x-note-author": "user-a" })
      req.url = url
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(req.headers["x-ax-user"], "luke")
      assert.equal(req.headers["x-note-author"], "user-a")
      assert.equal(isGateVerifiedHeaders(req.headers, env), true)
      assert.equal(req.headers[GATE_ACCOUNT_HEADER], undefined)
      const out = buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)
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
        "x-ax-user": "luke",
        "x-note-author": "user-a",
      })
      req.url = "/schedule-personal"
      const res = { statusCode: 200, setHeader() {}, end() {} }
      let reachedNext = false
      const handler = createRequestHandler((forwarded, response) => {
        reachedNext = true
        assert.equal(forwarded.headers["x-ax-user"], "luke")
        assert.equal(forwarded.headers["x-note-author"], "user-a")
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
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)["x-naia-actor-id"], undefined)
    stripUntrustedIdentityHeaders(req, env)
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)["x-naia-actor-id"], "test-gate:writer-one")
    // 기기 해제·쿠키 만료 뒤 관문이 신원을 보내지 않는 다음 요청을 재현한다.
    const revoked = publishRequest(undefined, {
      [GATE_ACCOUNT_HEADER]: undefined,
      "x-naia-actor-id": "test-gate:writer-one",
      "x-naia-actor-verified": "1",
      [GATE_VERIFIED_HEADER]: req.headers[GATE_VERIFIED_HEADER],
    })
    stripUntrustedIdentityHeaders(revoked, env)
    assert.equal(buildProxyHeaders(revoked, revoked.socket, "api-proxy-secret", 3141, env)["x-naia-actor-id"], undefined)
  })

  it("게시 쓰기는 같은 출처의 단일 Host·Origin에만 확인표시를 만든다", () => {
    const { secret, env } = publishFixture()
    const cases = [
      { origin: "https://outside.example" },
      { origin: undefined },
      { origin: ["http://127.0.0.1:3142"] },
      { Origin: "http://127.0.0.1:3142" },
    ]
    for (const headers of cases) {
      const req = publishRequest(secret, headers)
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)["x-naia-origin-ok"], undefined)
    }
    const req = publishRequest(secret, {}, ["Host", "127.0.0.1:3142", "Origin", "http://127.0.0.1:3142", "Origin", "http://127.0.0.1:3142"])
    assert.equal(buildProxyHeaders(req, req.socket, "api-proxy-secret", 3141, env)["x-naia-origin-ok"], undefined)
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
          host: "127.0.0.1:3142",
          "x-naia-gate-secret": secret,
          "x-naia-user": "luke",
          "x-note-author": "user-a",
        },
        [
          "Host",
          "127.0.0.1:3142",
          "X-Naia-Gate-Secret",
          secret,
          "X-Naia-User",
          "luke",
          "X-Note-Author",
          "user-a",
        ],
      )
      stripUntrustedIdentityHeaders(req, env)
      assert.equal(req.headers["x-naia-user"], "luke")
      assert.equal(req.headers["x-note-author"], "user-a")
      assert.equal(req.headers["x-naia-gate-secret"], undefined)
      assert.equal(isGateVerifiedHeaders(req.headers, env), true)
      assert.deepEqual(req.rawHeaders, [
        "Host",
        "127.0.0.1:3142",
        "X-Naia-User",
        "luke",
        "X-Note-Author",
        "user-a",
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
      { label: "비밀 머리글 없음", headers: { "x-ax-user": "luke", "x-note-author": "user-a" } },
      {
        label: "틀린 비밀(같은 길이)",
        headers: { "x-naia-gate-secret": wrongSameLen, "x-ax-user": "luke", "x-note-author": "user-a" },
      },
      {
        label: "틀린 비밀(다른 길이)",
        headers: { "x-naia-gate-secret": wrongDiffLen, "x-ax-user": "luke", "x-note-author": "user-a" },
      },
      {
        label: "비밀 머리글 배열(중복)",
        headers: { "x-naia-gate-secret": [secret, secret], "x-ax-user": "luke", "x-note-author": "user-a" },
      },
      {
        label: "비밀 머리글 쉼표 결합(중복)",
        headers: { "x-naia-gate-secret": `${secret}, ${secret}`, "x-ax-user": "luke", "x-note-author": "user-a" },
      },
      {
        label: "사용자 머리글 쉼표 결합(중복)",
        headers: { "x-naia-gate-secret": secret, "x-ax-user": "luke, admin", "x-note-author": "user-a" },
      },
      {
        label: "사용자 머리글 배열(중복)",
        headers: { "x-naia-gate-secret": secret, "x-ax-user": ["luke", "admin"], "x-note-author": "user-a" },
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
      { "x-naia-gate-secret": secret, "x-ax-user": "luke" },
      ["X-Naia-Gate-Secret", secret, "X-Naia-Gate-Secret", secret, "X-Ax-User", "luke"],
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

    const priv192 = [192, 168, 1, 15].join(".")
    const priv10 = [10, 0, 0, 42].join(".")
    const priv172 = [172, 16, 0, 5].join(".")
    for (const ip of [
      "100.64.0.24",
      "::ffff:100.64.0.9",
      priv192,
      priv10,
      priv172,
      "203.0.113.7",
      "fd7a:115c:a1e0::1",
      "",
    ]) {
      assert.equal(isLoopbackIp(ip), false, `${ip} must not be loopback`)
      assert.equal(isTrustedIdentityPeer(ip, env), false)

      const req = makeFakeReq(
        ip,
        {
          host: "100.64.0.24:3142",
          "x-naia-gate-secret": secret,
          "x-naia-schedule-user": "luke",
          "X-Naia-Note-User": "user-b",
          "user-agent": "Mozilla/5.0",
        },
        [
          "Host",
          "100.64.0.24:3142",
          "X-Naia-Gate-Secret",
          secret,
          "X-Naia-Schedule-User",
          "luke",
          "X-Naia-Note-User",
          "user-b",
          "User-Agent",
          "Mozilla/5.0",
        ],
      )
      stripUntrustedIdentityHeaders(req, env)

      assert.equal(req.headers["x-naia-gate-secret"], undefined)
      assert.equal(req.headers["x-naia-schedule-user"], undefined)
      assert.equal(req.headers["X-Naia-Note-User"], undefined)
      assert.equal(isGateVerifiedHeaders(req.headers, env), false)
      assert.equal(req.headers["host"], "100.64.0.24:3142")
      assert.equal(req.headers["user-agent"], "Mozilla/5.0")
      assert.deepEqual(req.rawHeaders, ["Host", "100.64.0.24:3142", "User-Agent", "Mozilla/5.0"])
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
        host: "127.0.0.1:3142",
        "x-naia-gate-secret": "test-unconfigured-secret-should-still-strip",
        "x-schedule-only": "person-a",
        "x-note-author": "user-a",
      },
      [
        "Host",
        "127.0.0.1:3142",
        "X-Naia-Gate-Secret",
        "test-unconfigured-secret-should-still-strip",
        "X-Schedule-Only",
        "person-a",
        "X-Note-Author",
        "user-a",
      ],
    )
    stripUntrustedIdentityHeaders(loopReq, env)
    assert.equal(loopReq.headers["x-naia-gate-secret"], undefined)
    assert.equal(loopReq.headers["x-schedule-only"], undefined)
    assert.equal(loopReq.headers["x-note-author"], "user-a")
    assert.equal(isGateVerifiedHeaders(loopReq.headers, env), false)
    assert.deepEqual(loopReq.rawHeaders, ["Host", "127.0.0.1:3142", "X-Note-Author", "user-a"])

    // 비루프백(테일넷 등): NAIA_NOTE_USER_HEADER 도 제거
    const tailReq = makeFakeReq("100.64.0.24", {
      "x-schedule-only": "luke",
      "x-note-author": "user-a",
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
        "x-ax-user": "luke",
        [GATE_VERIFIED_HEADER]: realToken,
      },
      ["X-Ax-User", "luke", "X-Naia-Gate-Verified", realToken],
    )
    stripUntrustedIdentityHeaders(spoofReq, env)
    assert.equal(spoofReq.headers["x-ax-user"], undefined)
    assert.equal(spoofReq.headers[GATE_VERIFIED_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(spoofReq.headers, env), false)
    assert.deepEqual(spoofReq.rawHeaders, [])
  })

  it("NAIA_SCHEDULE_USER_HEADER 와 NAIA_NOTE_USER_HEADER 설정이 모두 비어 있으면 일반 머리글은 유지하되 x-naia-gate-secret 는 항상 지운다", () => {
    const req = makeFakeReq(
      "100.64.0.24",
      {
        host: "100.64.0.24:3142",
        "x-naia-gate-secret": "must-always-be-stripped",
        "x-custom": "keep",
      },
      ["Host", "100.64.0.24:3142", "X-Naia-Gate-Secret", "must-always-be-stripped", "X-Custom", "keep"],
    )
    stripUntrustedIdentityHeaders(req, {})
    assert.equal(req.headers["x-naia-gate-secret"], undefined)
    assert.equal(req.headers["x-custom"], "keep")
    assert.deepEqual(req.rawHeaders, ["Host", "100.64.0.24:3142", "X-Custom", "keep"])
  })

  it("NAIA_IDENTITY_TRUSTED_PROXIES(쉼표 구분 IP 목록)에 지정된 프록시 IP는 비밀이 맞을 때 믿고 그 밖의 IP는 지운다", () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const trustedPriv = [192, 168, 10, 20].join(".")
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_SCHEDULE_USER_HEADER: "x-ax-user",
      NAIA_IDENTITY_TRUSTED_PROXIES: ` 100.64.0.10 , ::ffff:${trustedPriv}, fd00::99 `,
    }
    const trustedSet = parseTrustedProxyIps(env)
    assert.equal(trustedSet.has("100.64.0.10"), true)
    assert.equal(trustedSet.has(trustedPriv), true)
    assert.equal(trustedSet.has("fd00::99"), true)
    assert.equal(normalizeRemoteIp(`::ffff:${trustedPriv}`), trustedPriv)

    // 믿는 프록시 IP + 맞는 비밀 -> 유지
    const trustedReq = makeFakeReq("::ffff:100.64.0.10", {
      [GATE_SECRET_HEADER]: secret,
      "x-ax-user": "luke",
    })
    stripUntrustedIdentityHeaders(trustedReq, env)
    assert.equal(trustedReq.headers["x-ax-user"], "luke")
    assert.equal(trustedReq.headers[GATE_SECRET_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(trustedReq.headers, env), true)

    // 목록에 없는 다른 테일넷 IP + 맞는 비밀 -> 제거
    const untrustedReq = makeFakeReq("100.64.0.11", {
      [GATE_SECRET_HEADER]: secret,
      "x-ax-user": "luke",
    })
    stripUntrustedIdentityHeaders(untrustedReq, env)
    assert.equal(untrustedReq.headers["x-ax-user"], undefined)
    assert.equal(untrustedReq.headers[GATE_SECRET_HEADER], undefined)
    assert.equal(isGateVerifiedHeaders(untrustedReq.headers, env), false)
  })

  it("대시보드 → API(3141) 프록시(buildProxyHeaders 및 proxyToApi)에 x-naia-gate-secret 와 x-naia-gate-verified 가 넘어가지 않는다", async () => {
    const dir = makeTempDir()
    const secret = "gate-secret-" + crypto.randomBytes(24).toString("hex")
    const secretFile = writeSecretFile(dir, "gate.key", secret, 0o600)
    const env = {
      NAIA_GATE_SECRET_FILE: secretFile,
      NAIA_NOTE_USER_HEADER: "x-ax-user",
    }

    const fakeSocket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" }
    const req = makeFakeReq("127.0.0.1", {
      host: "127.0.0.1:3142",
      "x-naia-gate-secret": secret,
      "x-ax-user": encodeURIComponent("테스트 사용자"),
    })
    req.socket = fakeSocket
    req.pipe = (dest) => {
      dest.end()
      return dest
    }

    // 1) buildProxyHeaders 에 직접 넣어도 x-naia-gate-secret 가 제거됨
    const directOut = buildProxyHeaders(req, fakeSocket, "proxy-sec-3141", 3141)
    assert.equal(directOut["x-naia-gate-secret"], undefined)
    assert.equal(directOut["x-naia-gate-verified"], undefined)
    assert.equal(directOut["x-ax-user"], encodeURIComponent("테스트 사용자"))
    assert.equal(directOut["x-naia-proxy-secret"], "proxy-sec-3141")

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
      proxyToApi(req, clientRes, "/api/portal/notes?source=adk", apiPort, "proxy-sec-3141", fakeSocket)
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
      assert.equal(apiReceivedHeaders["x-ax-user"], encodeURIComponent("테스트 사용자"))
      assert.equal(apiReceivedHeaders["x-naia-proxy-secret"], "proxy-sec-3141")
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
                "x-ax-user": "luke",
                "x-note-user": "user-a",
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
        assert.equal(captured[0].headers["x-ax-user"], "luke")
        assert.equal(captured[0].headers["x-note-user"], "user-a")
        assert.equal(captured[0].headers[GATE_ACCOUNT_HEADER], undefined)
        assert.equal(captured[0].headers["x-naia-gate-secret"], undefined)
        assert.equal(
          captured[0].rawHeaders.some((h) => h.toLowerCase() === "x-naia-gate-secret" || h === secret),
          false,
        )
      } finally {
        await new Promise((resolve) => server.close(resolve))
      }

      // 2) 테일넷 원격 주소(100.64.0.24)로 직접 들어온 요청(비밀이 맞아도) -> 머리 제거 확인
      const tailnetReq = makeFakeReq(
        "100.64.0.24",
        {
          host: "100.64.0.24:3142",
          "x-naia-gate-secret": secret,
          "x-ax-user": "luke",
          "x-note-user": "user-a",
        },
        ["Host", "100.64.0.24:3142", "X-Naia-Gate-Secret", secret, "X-Ax-User", "luke", "X-Note-User", "user-a"],
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

describe("922ebd3a 기본 게이트·일정 신원 검증 보존", () => {
  it("gate verification removes spoofed headers and rejects duplicate secrets and untrusted peers", () => {
    const dir = makeTempDir()
    const secretFile = writeSecretFile(dir, "gate-key", "a".repeat(48))
    const secret = "a".repeat(48)
    const env = { NAIA_GATE_SECRET_FILE: secretFile, NAIA_SCHEDULE_USER_HEADER: "x-user" }
    const reqObj = (headers, remote = "127.0.0.1", rawHeaders = []) => ({ headers, rawHeaders, socket: { remoteAddress: remote } })
    const ok = reqObj({ "x-user": "person-a", "x-naia-gate-secret": secret, "x-naia-gate-verified": "forged" })
    stripUntrustedIdentityHeaders(ok, env)
    assert.equal(ok.headers["x-user"], "person-a")
    assert.equal(ok.headers["x-naia-gate-secret"], undefined)
    assert.equal(isGateVerifiedHeaders(ok.headers, env), true)
    const forged = reqObj({ "x-user": "person-a", "x-naia-gate-verified": ok.headers["x-naia-gate-verified"] })
    stripUntrustedIdentityHeaders(forged, env)
    assert.equal(forged.headers["x-user"], undefined)
    assert.equal(isGateVerifiedHeaders(forged.headers, env), false)
    const remote = reqObj({ "x-user": "person-a", "x-naia-gate-secret": secret }, "192.0.2.10")
    stripUntrustedIdentityHeaders(remote, env)
    assert.equal(remote.headers["x-user"], undefined)
    const duplicate = reqObj({ "x-user": "person-a", "x-naia-gate-secret": secret }, "127.0.0.1", ["X-Naia-Gate-Secret", secret, "X-Naia-Gate-Secret", secret])
    stripUntrustedIdentityHeaders(duplicate, env)
    assert.equal(duplicate.headers["x-user"], undefined)
    fs.chmodSync(secretFile, 0o644)
    const wrongMode = reqObj({ "x-user": "person-a", "x-naia-gate-secret": secret })
    stripUntrustedIdentityHeaders(wrongMode, env)
    assert.equal(isGateVerifiedHeaders(wrongMode.headers, env), false)
  })

  it("schedule requests use the handler's gate environment and reject forged identity", () => {
    const dir = makeTempDir()
    const secretFile = writeSecretFile(dir, "gate-key", "b".repeat(48))
    const secret = "b".repeat(48)
    const env = { NAIA_GATE_SECRET_FILE: secretFile, NAIA_SCHEDULE_USER_HEADER: "x-user" }
    let seen
    const handler = createRequestHandler((req) => { seen = req.headers }, {}, env)
    const response = { setHeader() {} }
    const good = { headers: { host: "127.0.0.1:3142", "x-user": "person-a", "x-naia-gate-secret": secret }, rawHeaders: [], socket: { remoteAddress: "127.0.0.1" }, url: "/schedule" }
    handler(good, response)
    assert.equal(seen["x-user"], "person-a")
    assert.equal(seen["x-naia-gate-secret"], undefined)
    assert.equal(isGateVerifiedHeaders(seen, env), true)
    const forged = { headers: { host: "127.0.0.1:3142", "x-user": "other", "x-naia-gate-verified": "forged" }, rawHeaders: [], socket: { remoteAddress: "127.0.0.1" }, url: "/schedule" }
    handler(forged, response)
    assert.equal(seen["x-user"], undefined)
    assert.equal(isGateVerifiedHeaders(seen, env), false)
  })
})
