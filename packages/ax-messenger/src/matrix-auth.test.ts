import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  AX_AUTH_DUPLICATE_BOT_MESSAGE,
  AX_AUTH_RELOGIN_COUNT_MAX,
  AX_AUTH_RELOGIN_COUNT_MIN,
  AX_AUTH_RELOGIN_MAX_COUNT,
  AX_AUTH_RELOGIN_WINDOW_MAX_MS,
  AX_AUTH_RELOGIN_WINDOW_MIN_MS,
  AX_AUTH_RELOGIN_WINDOW_MS,
  AX_AUTH_START_PROBE_MESSAGE,
  AX_AUTH_STATE_MISMATCH_MESSAGE,
  AX_AUTH_TEST_VARS_PROVIDER_MESSAGE,
  AX_BOT_TOKEN_FILE_MODE,
  AX_RELOGIN_HISTORY_CORRUPT_MESSAGE,
  AX_RELOGIN_HISTORY_FILE,
  AxAuthReloginTracker,
  appendReloginStamp,
  checkDataDirMode,
  checkDataDirReady,
  checkSavedToken,
  fetchWithAuthRecovery,
  hasAuthTestVars,
  isAuthExhaustedError,
  isAuthTestMode,
  loadReloginStamps,
  noteReloginOrThrow,
  performStartAuth,
  probeSavedToken,
  readBotTokenFile,
  resolveAuthReloginPolicy,
  writeBotTokenFileAtomic,
} from "./matrix-auth.js"

// 인증 회복 반복 상한: 창 10분·3회. 계약 문서와 운영 기본값에 같은 값을 적는다.
test("인증 회복 상수는 창 10분·3회이다", () => {
  assert.equal(AX_AUTH_RELOGIN_WINDOW_MS, 600_000)
  assert.equal(AX_AUTH_RELOGIN_MAX_COUNT, 3)
})

test("인증 회복 정책은 시험 모드가 아니면 시험 변수를 무시하고 기본값을 쓴다", () => {
  const defaults = { windowMs: AX_AUTH_RELOGIN_WINDOW_MS, maxCount: AX_AUTH_RELOGIN_MAX_COUNT }
  assert.deepEqual(resolveAuthReloginPolicy({}), defaults)
  // 범위 안 값도 시험 모드가 아니면 무시한다.
  assert.deepEqual(
    resolveAuthReloginPolicy({ AX_AUTH_RELOGIN_WINDOW_MS: "60000", AX_AUTH_RELOGIN_MAX_COUNT: "2" }),
    defaults,
  )
  // 검수 재현: 큰 값도 시험 모드가 아니면 무시한다(상한을 풀 수 없다).
  assert.deepEqual(
    resolveAuthReloginPolicy({
      AX_AUTH_RELOGIN_WINDOW_MS: "9007199254740991",
      AX_AUTH_RELOGIN_MAX_COUNT: "9007199254740991",
    }),
    defaults,
  )
  // 범위 밖 값도 시험 모드가 아니면 오류가 아니라 무시+기본값이다.
  assert.deepEqual(
    resolveAuthReloginPolicy({ AX_AUTH_RELOGIN_WINDOW_MS: "999", AX_AUTH_RELOGIN_MAX_COUNT: "4" }),
    defaults,
  )
  // 시험 모드가 아니면 제공자가 실제(openai-compatible)여도 무시+기본값이다.
  // 실제 제공자와 시험 변수의 조합은 시험 모드 안에서만 시작 오류로 막는다.
  assert.deepEqual(
    resolveAuthReloginPolicy({
      AX_AI_PROVIDER: "openai-compatible",
      AX_AUTH_RELOGIN_WINDOW_MS: "60000",
      AX_AUTH_RELOGIN_MAX_COUNT: "2",
    }),
    defaults,
  )
  assert.equal(isAuthTestMode({}), false)
  assert.equal(isAuthTestMode({ AX_AI_TEST_MODE: "1" }), true)
  assert.equal(isAuthTestMode({ AX_AI_TEST_MODE: "0" }), false)
  assert.equal(hasAuthTestVars({}), false)
  assert.equal(hasAuthTestVars({ AX_AUTH_RELOGIN_MAX_COUNT: "2" }), true)
  assert.equal(hasAuthTestVars({ AX_AUTH_RELOGIN_WINDOW_MS: "   " }), false)
})

test("시험 모드+가짜 제공자에서는 범위 안 값만 받고 범위 밖은 시작 오류다", () => {
  const testMode = { AX_AI_TEST_MODE: "1", AX_AI_PROVIDER: "fake" }
  assert.deepEqual(resolveAuthReloginPolicy(testMode), {
    windowMs: AX_AUTH_RELOGIN_WINDOW_MS,
    maxCount: AX_AUTH_RELOGIN_MAX_COUNT,
  })
  assert.deepEqual(
    resolveAuthReloginPolicy({ ...testMode, AX_AUTH_RELOGIN_WINDOW_MS: "60000", AX_AUTH_RELOGIN_MAX_COUNT: "2" }),
    { windowMs: 60_000, maxCount: 2 },
  )
  assert.equal(AX_AUTH_RELOGIN_COUNT_MIN, 1)
  assert.equal(AX_AUTH_RELOGIN_COUNT_MAX, 3)
  assert.equal(AX_AUTH_RELOGIN_WINDOW_MIN_MS, 1_000)
  assert.equal(AX_AUTH_RELOGIN_WINDOW_MAX_MS, 600_000)
  assert.deepEqual(
    resolveAuthReloginPolicy({ ...testMode, AX_AUTH_RELOGIN_WINDOW_MS: "1000", AX_AUTH_RELOGIN_MAX_COUNT: "1" }),
    { windowMs: 1_000, maxCount: 1 },
  )
  for (const bad of [
    { AX_AUTH_RELOGIN_WINDOW_MS: "999" },
    { AX_AUTH_RELOGIN_WINDOW_MS: "600001" },
    { AX_AUTH_RELOGIN_WINDOW_MS: "0" },
    { AX_AUTH_RELOGIN_WINDOW_MS: "잠시" },
    { AX_AUTH_RELOGIN_MAX_COUNT: "0" },
    { AX_AUTH_RELOGIN_MAX_COUNT: "4" },
    { AX_AUTH_RELOGIN_MAX_COUNT: "-1" },
    { AX_AUTH_RELOGIN_MAX_COUNT: "2.5" },
  ]) {
    assert.throws(
      () => resolveAuthReloginPolicy({ ...testMode, ...bad }),
      /인증 회복 시험 설정/,
      `범위 밖 시험 값은 시작 오류여야 한다: ${JSON.stringify(bad)}`,
    )
  }
})

test("시험 모드라도 제공자가 가짜가 아니면 시험 변수는 시작 오류다", () => {
  const vars = { AX_AUTH_RELOGIN_WINDOW_MS: "60000", AX_AUTH_RELOGIN_MAX_COUNT: "2" }
  // openai-compatible+시험 모드+변수 → 시작 오류(무시하지 않는다).
  assert.throws(
    () => resolveAuthReloginPolicy({ AX_AI_TEST_MODE: "1", AX_AI_PROVIDER: "openai-compatible", ...vars }),
    new RegExp(AX_AUTH_TEST_VARS_PROVIDER_MESSAGE.slice(0, 20)),
    "실제 제공자와 시험 변수의 조합은 시작 오류여야 한다",
  )
  // 제공자 이름이 없거나 비어도 시험 변수는 받지 않는다(닫힘 실패).
  assert.throws(
    () => resolveAuthReloginPolicy({ AX_AI_TEST_MODE: "1", ...vars }),
    new RegExp(AX_AUTH_TEST_VARS_PROVIDER_MESSAGE.slice(0, 20)),
    "제공자 없이 시험 변수는 받지 않아야 한다",
  )
  assert.throws(
    () => resolveAuthReloginPolicy({ AX_AI_TEST_MODE: "1", AX_AI_PROVIDER: "  ", ...vars }),
    new RegExp(AX_AUTH_TEST_VARS_PROVIDER_MESSAGE.slice(0, 20)),
    "빈 제공자 이름으로 시험 변수는 받지 않아야 한다",
  )
  // 시험 모드+가짜 제공자+변수 → 받는다.
  assert.deepEqual(
    resolveAuthReloginPolicy({ AX_AI_TEST_MODE: "1", AX_AI_PROVIDER: "fake", ...vars }),
    { windowMs: 60_000, maxCount: 2 },
  )
})

test("창 안 3회까지는 이어 가고 4회째는 고정 오류로 끝난다", () => {
  const tracker = new AxAuthReloginTracker(600_000, 3)
  const now = 1_700_000_000_000
  noteReloginOrThrow(tracker, now)
  noteReloginOrThrow(tracker, now + 1_000)
  noteReloginOrThrow(tracker, now + 2_000)
  assert.equal(tracker.count(now + 2_000), 3)
  assert.throws(
    () => noteReloginOrThrow(tracker, now + 3_000),
    (error: unknown) =>
      error instanceof Error && error.message === AX_AUTH_DUPLICATE_BOT_MESSAGE,
    "4회째는 고정 문구로 던져야 한다",
  )
})

test("창이 지나면 횟수가 비워진다", () => {
  const tracker = new AxAuthReloginTracker(600_000, 3)
  const now = 1_700_000_000_000
  tracker.note(now)
  tracker.note(now + 1_000)
  assert.equal(tracker.count(now + 600_000 + 2_000), 0)
  noteReloginOrThrow(tracker, now + 600_000 + 2_000)
  assert.equal(tracker.count(now + 600_000 + 2_000), 1)
})

test("고정 오류 판정은 문구로만 가린다", () => {
  assert.equal(
    AX_AUTH_DUPLICATE_BOT_MESSAGE,
    "같은 기관 봇이 다른 곳에서 돌고 있을 수 있어 넥스테인 AI 봇을 끝냅니다.",
  )
  assert.equal(isAuthExhaustedError(new Error(AX_AUTH_DUPLICATE_BOT_MESSAGE)), true)
  assert.equal(isAuthExhaustedError(new Error("방에 말을 남기지 못했습니다(500).")), false)
  assert.equal(isAuthExhaustedError(null), false)
})

// 가짜 Matrix 응답으로 401 → 다시 로그인 1회 → 새 토큰으로 이어 간다.
test("401이면 다시 로그인 1회 뒤 새 토큰으로 이어 간다", async () => {
  const seenNew: boolean[] = []
  let relogins = 0
  const fakeFetch = (async (_url: unknown, init: unknown) => {
    const headers = (init as { headers?: Record<string, string> })?.headers ?? {}
    if (relogins === 0) {
      assert.equal(headers.authorization?.includes("old-token"), true)
      return { ok: false, status: 401, json: async () => ({ errcode: "M_UNKNOWN_TOKEN" }) }
    }
    seenNew.push(headers.authorization?.includes("new-token") === true)
    return { ok: true, status: 200, json: async () => ({}) }
  }) as unknown as typeof fetch
  const tracker = new AxAuthReloginTracker(600_000, 3)
  const response = await fetchWithAuthRecovery({
    url: "http://127.0.0.1:9/_matrix/client/v3/sync",
    init: { headers: { "content-type": "application/json" } },
    fetchImpl: fakeFetch,
    getToken: () => "old-token",
    relogin: async () => {
      relogins += 1
      return "new-token"
    },
    tracker,
    now: () => 1_700_000_000_000,
  })
  assert.equal(response.status, 200)
  assert.equal(relogins, 1)
  assert.deepEqual(seenNew, [true])
  assert.equal(tracker.count(1_700_000_000_000), 1)
})

test("일반 오류는 다시 로그인하지 않고 그대로 돌려준다", async () => {
  let relogins = 0
  const failing = (async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as unknown as typeof fetch
  const tracker = new AxAuthReloginTracker(600_000, 3)
  const response = await fetchWithAuthRecovery({
    url: "http://127.0.0.1:9/_matrix/client/v3/sync",
    init: {},
    fetchImpl: failing,
    getToken: () => "kept-token",
    relogin: async () => {
      relogins += 1
      return "unused-token"
    },
    tracker,
  })
  assert.equal(response.status, 500)
  assert.equal(relogins, 0)
  assert.equal(tracker.count(Date.now()), 0)
})

test("창 안 횟수를 넘기면 다시 로그인하지 않고 고정 오류로 던진다", async () => {
  let relogins = 0
  const authFail = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({ errcode: "M_UNKNOWN_TOKEN" }),
  })) as unknown as typeof fetch
  const tracker = new AxAuthReloginTracker(600_000, 3)
  const now = 1_700_000_000_000
  tracker.note(now)
  tracker.note(now + 1)
  tracker.note(now + 2)
  await assert.rejects(
    fetchWithAuthRecovery({
      url: "http://127.0.0.1:9/_matrix/client/v3/sync",
      init: {},
      fetchImpl: authFail,
      getToken: () => "old-token",
      relogin: async () => {
        relogins += 1
        return "unused-token"
      },
      tracker,
      now: () => now + 3,
    }),
    (error: unknown) =>
      error instanceof Error && error.message === AX_AUTH_DUPLICATE_BOT_MESSAGE,
  )
  assert.equal(relogins, 0)
})

// 횟수 초과 경로는 실제 자식 프로세스로 끝냄을 본다(종료 코드·고정 문구).
test("횟수 초과면 자식 프로세스가 0이 아닌 코드·고정 문구로 끝난다", () => {
  const moduleUrl = new URL("./matrix-auth.ts", import.meta.url).href
  const script = [
    `import { AxAuthReloginTracker, noteReloginOrThrow } from ${JSON.stringify(moduleUrl)};`,
    "const tracker = new AxAuthReloginTracker(600000, 3);",
    "const now = Date.now();",
    "tracker.note(now); tracker.note(now); tracker.note(now);",
    "noteReloginOrThrow(tracker, now);",
  ].join("\n")
  const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.dirname(new URL(".", import.meta.url).pathname),
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.notEqual(result.status, 0, "0이 아닌 코드로 끝나야 한다")
  assert.ok(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(AX_AUTH_DUPLICATE_BOT_MESSAGE),
    "고정 문구가 기록되어야 한다",
  )
})

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ax-auth-"))
}

test("토큰 파일은 임시 파일에 0600으로 쓰고 이름 바꾸기로 둔다", async () => {
  const dir = freshDir()
  const file = path.join(dir, "nextain-ai-token.json")
  await writeBotTokenFileAtomic(file, '{"deviceId":"d"}\n')
  assert.equal(readFileSync(file, "utf8"), '{"deviceId":"d"}\n')
  assert.equal(lstatSync(file).mode & 0o777, AX_BOT_TOKEN_FILE_MODE)
})

test("0644로 둔 토큰 파일은 시작 때 0600으로 고치고 읽는다", async () => {
  const dir = freshDir()
  const file = path.join(dir, "nextain-ai-token.json")
  const body = JSON.stringify({ deviceId: "d", userId: "@bot:x", accessToken: "t" })
  writeFileSync(file, `${body}\n`)
  chmodSync(file, 0o644)
  assert.equal(lstatSync(file).mode & 0o777, 0o644)
  const record = await readBotTokenFile(file)
  assert.deepEqual(record, { deviceId: "d", userId: "@bot:x", accessToken: "t" })
  assert.equal(lstatSync(file).mode & 0o777, 0o600)
})

test("심볼릭 링크 토큰 파일은 시작 거부한다", async () => {
  const dir = freshDir()
  const target = path.join(dir, "real.json")
  writeFileSync(target, "{}\n")
  const link = path.join(dir, "nextain-ai-token.json")
  symlinkSync(target, link)
  await assert.rejects(readBotTokenFile(link), /심볼릭 링크/)
})

test("소유자가 다르면 시작 거부한다", async () => {
  const dir = freshDir()
  const file = path.join(dir, "nextain-ai-token.json")
  writeFileSync(file, "{}\n", { mode: 0o600 })
  await assert.rejects(readBotTokenFile(file, { expectedUid: 424242 }), /소유자/)
})

test("없는 토큰 파일은 null(새로 로그인), 깨진 파일도 null이다", async () => {
  const dir = freshDir()
  assert.equal(await readBotTokenFile(path.join(dir, "nextain-ai-token.json")), null)
  const broken = path.join(dir, "broken.json")
  writeFileSync(broken, "깨진 내용\n", { mode: 0o600 })
  assert.equal(await readBotTokenFile(broken), null)
  const shapeless = path.join(dir, "shapeless.json")
  writeFileSync(shapeless, '{"deviceId":"d"}\n', { mode: 0o600 })
  assert.equal(await readBotTokenFile(shapeless), null)
})

test("데이터 폴더 권한은 세계 쓰기 거부·함께 쓰기 주의·정상 셋으로 가른다", async () => {
  assert.equal(checkDataDirMode(0o700), "ok")
  assert.equal(checkDataDirMode(0o750), "ok")
  assert.equal(checkDataDirMode(0o770), "group-writable")
  assert.equal(checkDataDirMode(0o707), "world-writable")
  assert.equal(checkDataDirMode(0o777), "world-writable")
  const dir = freshDir()
  assert.equal(await checkDataDirReady(dir), "ok")
  assert.equal(await checkDataDirReady(path.join(dir, "없음")), "ok")
})

test("다시 로그인 기록은 없으면 비고 쌓이면 창 안만 남는다", async () => {
  const dir = freshDir()
  const file = path.join(dir, AX_RELOGIN_HISTORY_FILE)
  const now = 1_700_000_000_000
  assert.deepEqual(await loadReloginStamps(file, 600_000, now), [])
  await appendReloginStamp(file, now - 700_000, 600_000)
  await appendReloginStamp(file, now - 1_000, 600_000)
  assert.equal(lstatSync(file).mode & 0o777, AX_BOT_TOKEN_FILE_MODE)
  const stamps = await loadReloginStamps(file, 600_000, now)
  assert.deepEqual(stamps, [now - 1_000])
})

test("깨진 다시 로그인 기록은 비운 것으로 보지 않고 시작 오류다", async () => {
  const dir = freshDir()
  const file = path.join(dir, AX_RELOGIN_HISTORY_FILE)
  writeFileSync(file, "깨진 내용\n", { mode: 0o600 })
  await assert.rejects(loadReloginStamps(file, 600_000), new RegExp(AX_RELOGIN_HISTORY_CORRUPT_MESSAGE))
  await assert.rejects(appendReloginStamp(file, Date.now(), 600_000), new RegExp(AX_RELOGIN_HISTORY_CORRUPT_MESSAGE))
  const shapeless = path.join(dir, "shapeless.json")
  writeFileSync(shapeless, '{"stamps":[1]}\n', { mode: 0o600 })
  await assert.rejects(loadReloginStamps(shapeless, 600_000), new RegExp(AX_RELOGIN_HISTORY_CORRUPT_MESSAGE))
})

test("다시 로그인 기록 파일도 심볼릭 링크·소유자 불일치를 거부한다", async () => {
  const dir = freshDir()
  const target = path.join(dir, "real.json")
  writeFileSync(target, "[]\n")
  const link = path.join(dir, AX_RELOGIN_HISTORY_FILE)
  symlinkSync(target, link)
  await assert.rejects(loadReloginStamps(link, 600_000), /심볼릭 링크/)
  const owned = path.join(dir, "owned.json")
  writeFileSync(owned, "[]\n", { mode: 0o600 })
  await assert.rejects(loadReloginStamps(owned, 600_000, Date.now(), { expectedUid: 424242 }), /소유자/)
})

test("시작 토큰 확인은 401일 때만 무효로 본다", async () => {
  const ok = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response
  const fetch401 = (async () => ok({ errcode: "M_UNKNOWN_TOKEN" }, 401)) as unknown as typeof fetch
  const fetch500 = (async () => ok({}, 500)) as unknown as typeof fetch
  const fetchDown = (async () => { throw new Error("연결 끊김") }) as unknown as typeof fetch
  const fetchGood = (async () => ok({ user_id: "@bot:x" })) as unknown as typeof fetch
  const fetchOther = (async () => ok({ user_id: "@남:x" })) as unknown as typeof fetch
  assert.equal(await checkSavedToken(fetch401, "http://127.0.0.1:9/whoami", "t", "@bot:x"), "invalid")
  assert.equal(await checkSavedToken(fetch500, "http://127.0.0.1:9/whoami", "t", "@bot:x"), "unknown")
  assert.equal(await checkSavedToken(fetchDown, "http://127.0.0.1:9/whoami", "t", "@bot:x"), "unknown")
  assert.equal(await checkSavedToken(fetchGood, "http://127.0.0.1:9/whoami", "t", "@bot:x"), "valid")
  assert.equal(await checkSavedToken(fetchOther, "http://127.0.0.1:9/whoami", "t", "@bot:x"), "invalid")
})

test("모름이면 물러나며 다시 묻고 상한을 넘기면 모름으로 끝난다", async () => {
  let calls = 0
  const sleeps: number[] = []
  const flaky = (async () => {
    calls += 1
    if (calls < 3) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ user_id: "@bot:x" }) }
  }) as unknown as typeof fetch
  const verdict = await probeSavedToken({
    fetchImpl: flaky,
    whoamiUrl: "http://127.0.0.1:9/whoami",
    token: "t",
    expectedUserId: "@bot:x",
    attempts: 5,
    baseDelayMs: 10,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(verdict, "valid")
  assert.deepEqual(sleeps, [10, 20])
  const down = (async () => {
    throw new Error("연결 끊김")
  }) as unknown as typeof fetch
  const verdictDown = await probeSavedToken({
    fetchImpl: down,
    whoamiUrl: "http://127.0.0.1:9/whoami",
    token: "t",
    expectedUserId: "@bot:x",
    attempts: 3,
    baseDelayMs: 5,
    sleep: async () => {},
  })
  assert.equal(verdictDown, "unknown")
})

function startAuthHarness(dir: string, fetchImpl: typeof fetch) {
  const tokenPath = path.join(dir, "nextain-ai-token.json")
  const historyPath = path.join(dir, AX_RELOGIN_HISTORY_FILE)
  let logins = 0
  const kinds: string[] = []
  return {
    tokenPath,
    historyPath,
    get logins() { return logins },
    get kinds() { return kinds },
    deps: {
      tokenPath,
      historyPath,
      deviceId: "d",
      expectedUserId: "@bot:x",
      whoamiUrl: "http://127.0.0.1:9/whoami",
      policy: { windowMs: 600_000, maxCount: 3 },
      fetchImpl,
      login: async (kind: "fresh" | "relogin") => {
        logins += 1
        kinds.push(kind)
        return { userId: "@bot:x", accessToken: `new-${logins}` }
      },
      sleep: async () => {},
    },
  }
}

function writeSavedToken(dir: string, accessToken: string): void {
  writeFileSync(
    path.join(dir, "nextain-ai-token.json"),
    `${JSON.stringify({ deviceId: "d", userId: "@bot:x", accessToken })}\n`,
    { mode: 0o600 },
  )
}

test("시작 5xx·연결 끊김은 로그인 0회·토큰 파일 그대로로 끝난다", async () => {
  const fetch500 = (async () => ({
    ok: false, status: 500, json: async () => ({}),
  })) as unknown as typeof fetch
  for (const fetchImpl of [
    fetch500,
    (async () => { throw new Error("연결 끊김") }) as unknown as typeof fetch,
  ]) {
    const dir = freshDir()
    // 기록 파일이 있어야 토큰 확인 길로 간다(없으면 어긋남 오류가 먼저 난다).
    writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), "[]\n", { mode: 0o600 })
    writeSavedToken(dir, "kept")
    const harness = startAuthHarness(dir, fetchImpl)
    await assert.rejects(
      performStartAuth({ ...harness.deps, probeAttempts: 2 }),
      new RegExp(AX_AUTH_START_PROBE_MESSAGE),
    )
    assert.equal(harness.logins, 0)
    assert.equal(readFileSync(harness.tokenPath, "utf8").includes('"accessToken":"kept"'), true)
    assert.equal(lstatSync(harness.tokenPath).mode & 0o777, 0o600)
  }
})

test("시작 401은 다시 로그인 1회로 기록에 남는다", async () => {
  const dir = freshDir()
  // 기록 파일이 있어야 다시 로그인 길로 간다(없으면 어긋남 오류가 먼저 난다).
  writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), "[]\n", { mode: 0o600 })
  writeSavedToken(dir, "stale")
  const fetch401 = (async () => ({
    ok: false, status: 401, json: async () => ({ errcode: "M_UNKNOWN_TOKEN" }),
  })) as unknown as typeof fetch
  const harness = startAuthHarness(dir, fetch401)
  const result = await performStartAuth(harness.deps)
  assert.equal(result.status, "relogin")
  assert.deepEqual(harness.kinds, ["relogin"])
  assert.equal(result.accessToken, "new-1")
  assert.equal(readFileSync(harness.tokenPath, "utf8").includes('"accessToken":"new-1"'), true)
  const stamps = await loadReloginStamps(harness.historyPath, 600_000)
  assert.equal(stamps.length, 1)
  assert.equal(result.tracker.count(Date.now()), 1)
})

test("둘 다 없으면 처음 로그인 직전에 빈 기록 파일을 만들고 횟수 0이다", async () => {
  const dir = freshDir()
  const fetchUnused = (async () => {
    throw new Error("불러서는 안 된다")
  }) as unknown as typeof fetch
  const harness = startAuthHarness(dir, fetchUnused)
  const result = await performStartAuth(harness.deps)
  assert.equal(result.status, "fresh")
  assert.deepEqual(harness.kinds, ["fresh"])
  assert.equal(result.tracker.count(Date.now()), 0)
  assert.equal(lstatSync(harness.tokenPath).mode & 0o777, 0o600)
  // 처음 로그인 직전에 빈 목록(초기화 표지)으로 기록 파일을 만든다.
  assert.equal(lstatSync(harness.historyPath).mode & 0o777, 0o600)
  assert.deepEqual(await loadReloginStamps(harness.historyPath, 600_000), [])
})

test("기록 없이 토큰만 있으면 어긋난 상태로 시작 오류다", async () => {
  const fetchUnused = (async () => {
    throw new Error("불러서는 안 된다")
  }) as unknown as typeof fetch
  for (const tokenBody of [
    JSON.stringify({ deviceId: "d", userId: "@bot:x", accessToken: "stale" }),
    "깨진 내용",
  ]) {
    const dir = freshDir()
    writeFileSync(path.join(dir, "nextain-ai-token.json"), `${tokenBody}\n`, { mode: 0o600 })
    const harness = startAuthHarness(dir, fetchUnused)
    await assert.rejects(
      performStartAuth(harness.deps),
      new RegExp(AX_AUTH_STATE_MISMATCH_MESSAGE.slice(0, 20)),
    )
    assert.equal(harness.logins, 0, "어긋난 상태에서는 로그인하지 않아야 한다")
  }
})

test("기록이 있으면 토큰이 없어도·깨져도 로그인 전에 기록하고 상한에 넣는다", async () => {
  const fetchUnused = (async () => {
    throw new Error("불러서는 안 된다")
  }) as unknown as typeof fetch
  // 토큰 파일 없음.
  {
    const dir = freshDir()
    writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), "[]\n", { mode: 0o600 })
    const harness = startAuthHarness(dir, fetchUnused)
    const result = await performStartAuth(harness.deps)
    assert.equal(result.status, "relogin", "기록이 있으면 처음 로그인이 아니다")
    assert.deepEqual(harness.kinds, ["relogin"])
    assert.equal(result.tracker.count(Date.now()), 1)
    assert.equal((await loadReloginStamps(harness.historyPath, 600_000)).length, 1)
  }
  // 토큰 파일 깨짐.
  {
    const dir = freshDir()
    writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), "[]\n", { mode: 0o600 })
    writeFileSync(path.join(dir, "nextain-ai-token.json"), "깨진 내용\n", { mode: 0o600 })
    const harness = startAuthHarness(dir, fetchUnused)
    const result = await performStartAuth(harness.deps)
    assert.equal(result.status, "relogin")
    assert.deepEqual(harness.kinds, ["relogin"])
    assert.equal((await loadReloginStamps(harness.historyPath, 600_000)).length, 1)
  }
})

test("창 안 기록이 찬 채로 시작 401이면 로그인 없이 고정 오류다", async () => {
  const dir = freshDir()
  writeSavedToken(dir, "stale")
  const now = 1_700_000_000_000
  await appendReloginStamp(path.join(dir, AX_RELOGIN_HISTORY_FILE), now - 1_000, 600_000)
  await appendReloginStamp(path.join(dir, AX_RELOGIN_HISTORY_FILE), now - 2_000, 600_000)
  await appendReloginStamp(path.join(dir, AX_RELOGIN_HISTORY_FILE), now - 3_000, 600_000)
  const fetch401 = (async () => ({
    ok: false, status: 401, json: async () => ({ errcode: "M_UNKNOWN_TOKEN" }),
  })) as unknown as typeof fetch
  const harness = startAuthHarness(dir, fetch401)
  await assert.rejects(
    performStartAuth({ ...harness.deps, now: () => now }),
    (error: unknown) => error instanceof Error && error.message === AX_AUTH_DUPLICATE_BOT_MESSAGE,
  )
  assert.equal(harness.logins, 0)
  assert.equal(readFileSync(harness.tokenPath, "utf8").includes('"accessToken":"stale"'), true)
})

// 상한을 넘게 실제 자식 프로세스를 거듭 띄운다. 매번 시작 401이 나면 정해진
// 횟수 뒤 시작 단계에서 고정 오류로 끝난다(재시작해도 상한이 이어진다).
// 기록 파일이 미리 있어야 다시 로그인 길로 간다(없으면 어긋남 오류가 난다).
test("재시작해도 상한이 이어져 정해진 횟수 뒤 시작 단계에서 고정 오류로 끝난다", () => {
  const dir = freshDir()
  writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), "[]\n", { mode: 0o600 })
  writeSavedToken(dir, "stale")
  const moduleUrl = new URL("./matrix-auth.ts", import.meta.url).href
  const script = [
    `import { performStartAuth, resolveAuthReloginPolicy } from ${JSON.stringify(moduleUrl)};`,
    `const dir = ${JSON.stringify(dir)};`,
    "const fetch401 = async () => ({ ok: false, status: 401, json: async () => ({ errcode: 'M_UNKNOWN_TOKEN' }) });",
    "const result = await performStartAuth({",
    "  tokenPath: dir + '/nextain-ai-token.json',",
    "  historyPath: dir + '/nextain-ai-relogins.json',",
    "  deviceId: 'd',",
    "  expectedUserId: '@bot:x',",
    "  whoamiUrl: 'http://127.0.0.1:9/whoami',",
    "  policy: resolveAuthReloginPolicy({ AX_AI_TEST_MODE: '1', AX_AI_PROVIDER: 'fake', AX_AUTH_RELOGIN_WINDOW_MS: '60000', AX_AUTH_RELOGIN_MAX_COUNT: '2' }),",
    "  fetchImpl: fetch401,",
    "  login: async () => ({ userId: '@bot:x', accessToken: 'new-' + process.pid + '-' + Date.now() }),",
    "  sleep: async () => {},",
    "});",
    "if (result.status !== 'relogin') throw new Error('다시 로그인이어야 한다');",
  ].join("\n")
  const codes: (number | null)[] = []
  for (let round = 0; round < 3; round++) {
    const result = spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: path.dirname(new URL(".", import.meta.url).pathname),
      encoding: "utf8",
      timeout: 60_000,
    })
    codes.push(result.status)
  }
  assert.deepEqual(codes, [0, 0, 1], "두 번은 다시 로그인하고 세 번째 시작은 고정 오류로 끝나야 한다")
  const last = spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.dirname(new URL(".", import.meta.url).pathname),
    encoding: "utf8",
    timeout: 60_000,
  })
  assert.notEqual(last.status, 0)
  assert.ok(
    `${last.stdout ?? ""}\n${last.stderr ?? ""}`.includes(AX_AUTH_DUPLICATE_BOT_MESSAGE),
    "고정 문구가 기록되어야 한다",
  )
})

// 다시 로그인 기록을 남긴 뒤 토큰 파일을 지우고 실제 자식 프로세스로 거듭
// 재시작한다. 기록이 있으면 토큰이 없어도 로그인 전에 기록해 상한에 넣으므로,
// 상한 뒤에는 로그인 없이 고정 오류로 끝나고 토큰 파일이 그대로 없어야 한다.
test("기록 뒤 토큰을 지운 재시작도 상한에 넣어 로그인 없이 고정 오류로 끝난다", () => {
  const dir = freshDir()
  const now = Date.now()
  writeFileSync(path.join(dir, AX_RELOGIN_HISTORY_FILE), `${JSON.stringify([now - 1_000])}\n`, {
    mode: 0o600,
  })
  const tokenPath = path.join(dir, "nextain-ai-token.json")
  // 토큰 파일은 처음부터 없다(기록 뒤 지운 것과 같다).
  assert.equal(lstatSync(tokenPath, { throwIfNoEntry: false }), undefined)
  const moduleUrl = new URL("./matrix-auth.ts", import.meta.url).href
  const script = [
    `import { performStartAuth, resolveAuthReloginPolicy } from ${JSON.stringify(moduleUrl)};`,
    `const dir = ${JSON.stringify(dir)};`,
    "const fetch401 = async () => ({ ok: false, status: 401, json: async () => ({ errcode: 'M_UNKNOWN_TOKEN' }) });",
    "const result = await performStartAuth({",
    "  tokenPath: dir + '/nextain-ai-token.json',",
    "  historyPath: dir + '/nextain-ai-relogins.json',",
    "  deviceId: 'd',",
    "  expectedUserId: '@bot:x',",
    "  whoamiUrl: 'http://127.0.0.1:9/whoami',",
    "  policy: resolveAuthReloginPolicy({ AX_AI_TEST_MODE: '1', AX_AI_PROVIDER: 'fake', AX_AUTH_RELOGIN_WINDOW_MS: '60000', AX_AUTH_RELOGIN_MAX_COUNT: '2' }),",
    "  fetchImpl: fetch401,",
    "  login: async () => ({ userId: '@bot:x', accessToken: 'new-' + process.pid + '-' + Date.now() }),",
    "  sleep: async () => {},",
    "});",
    "if (result.status !== 'relogin') throw new Error('다시 로그인이어야 한다');",
  ].join("\n")
  const runChild = () =>
    spawnSync("node", ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: path.dirname(new URL(".", import.meta.url).pathname),
      encoding: "utf8",
      timeout: 60_000,
    })
  // 기록 1개에서 시작해 상한 2회: 첫 재시작은 기록(2회째) 뒤 로그인한다.
  const first = runChild()
  assert.equal(first.status, 0, "첫 재시작은 다시 로그인해야 한다")
  // 둘째부터는 상한 초과라 로그인 없이 고정 오류다. 토큰 파일은 그대로 둔다.
  const tokenAfterFirst = readFileSync(tokenPath, "utf8")
  for (let round = 0; round < 2; round++) {
    const result = runChild()
    assert.notEqual(result.status, 0, "상한 뒤 재시작은 0이 아닌 코드로 끝나야 한다")
    assert.ok(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.includes(AX_AUTH_DUPLICATE_BOT_MESSAGE),
      "고정 문구가 기록되어야 한다",
    )
    assert.equal(
      readFileSync(tokenPath, "utf8"),
      tokenAfterFirst,
      "상한 초과 재시작은 로그인하지 않아 토큰 파일이 그대로여야 한다",
    )
  }
})
