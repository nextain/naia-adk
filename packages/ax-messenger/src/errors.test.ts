import assert from "node:assert/strict"
import test from "node:test"
import { AxMessengerError, httpStatusOfAxError, invalidInput, sanitizeForLog, toAxError, userMessageOf } from "./errors.js"

const SAFE_RE = /M_[A-Z_]+|synapse|continuwuity|matrix|127\.0\.0\.1|localhost/i

test("429·빈도 초과는 rate-limited 갈래로 사용자 문구를 돌려준다", () => {
  const error = toAxError({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED", message: "too many" }, "대체 문구")
  assert.ok(error instanceof AxMessengerError)
  assert.equal(error.kind, "rate-limited")
  assert.equal(error.userMessage, "요청이 많아 잠시 막혔습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.match(error.detail, /M_LIMIT_EXCEEDED/)
})

test("413·크기 초과는 too-large 갈래로 사용자 문구를 돌려준다", () => {
  const error = toAxError({ httpStatus: 413, errcode: "M_TOO_LARGE", message: "too big" }, "대체 문구")
  assert.equal(error.kind, "too-large")
  assert.equal(error.userMessage, "파일이 커서 올리지 못했습니다. 더 작은 파일로 시도해 주세요.")
})

test("403·M_FORBIDDEN은 forbidden 갈래로 호출 맥락의 문구를 돌려준다", () => {
  const error = toAxError({ httpStatus: 403, errcode: "M_FORBIDDEN", message: "forbidden" }, "대화방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.equal(error.kind, "forbidden")
  assert.equal(error.userMessage, "대화방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
})

test("401·토큰 없음은 auth 갈래다(로그인 실패 문구 유지)", () => {
  for (const cause of [
    { httpStatus: 401, errcode: "M_UNKNOWN_TOKEN", message: "bad" },
    { errcode: "M_UNKNOWN_TOKEN", message: "bad" },
    { errcode: "M_MISSING_TOKEN", message: "bad" },
  ]) {
    const error = toAxError(cause, "아이디나 비밀번호를 확인해 주세요.")
    assert.equal(error.kind, "auth")
    assert.equal(error.userMessage, "아이디나 비밀번호를 확인해 주세요.")
  }
})

test("연결 끊김은 network 갈래다", () => {
  const cause = Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" })
  const error = toAxError(cause, "대체 문구")
  assert.equal(error.kind, "network")
  assert.equal(error.userMessage, "연결하지 못했습니다. 네트워크를 확인해 주세요.")
})

test("이미 층 오류면 그대로 돌려준다", () => {
  const original = toAxError({ httpStatus: 500, message: "x" }, "지금 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.equal(toAxError(original, "다른 문구"), original)
})

test("사용자 문구에 내부 이름·원문이 새지 않는다", () => {
  const cases = [
    toAxError({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED", message: "limit" }, "대체"),
    toAxError({ httpStatus: 413, errcode: "M_TOO_LARGE", message: "large" }, "대체"),
    toAxError({ httpStatus: 401, errcode: "M_UNKNOWN_TOKEN", message: "no" }, "아이디나 비밀번호를 확인해 주세요."),
    toAxError({ httpStatus: 403, errcode: "M_FORBIDDEN", message: "no" }, "대체"),
    toAxError(Object.assign(new Error("fetch failed")), "대체"),
  ]
  for (const error of cases) assert.doesNotMatch(error.userMessage, SAFE_RE)
})

test("userMessageOf는 화면용 문구만 돌려준다", () => {
  const error = toAxError({ httpStatus: 500, errcode: "M_UNKNOWN", message: "matrix synapse down" }, "지금 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.equal(userMessageOf(error, "대체"), "지금 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  assert.equal(userMessageOf(new Error("날것"), "대체 문구"), "대체 문구")
})

test("httpStatusOfAxError는 kind별 HTTP 상태를 돌려준다", () => {
  const cases: Array<[AxMessengerError, number]> = [
    [invalidInput("아이디는 영문 소문자·숫자와 . _ = - 조합 1~32자로 입력해 주세요."), 400],
    [toAxError({ httpStatus: 401, errcode: "M_UNKNOWN_TOKEN", message: "no" }, "문구"), 401],
    [toAxError({ httpStatus: 403, errcode: "M_FORBIDDEN", message: "no" }, "문구"), 403],
    [toAxError({ httpStatus: 429, errcode: "M_LIMIT_EXCEEDED", message: "many" }, "대체"), 429],
    [toAxError({ httpStatus: 413, errcode: "M_TOO_LARGE", message: "big" }, "대체"), 413],
    [toAxError(Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }), "대체"), 502],
    [toAxError({ httpStatus: 500, errcode: "M_UNKNOWN", message: "x" }, "대체"), 502],
    [toAxError(new Error("날것"), "대체"), 502],
    [
      new AxMessengerError({
        kind: "invalid-input",
        userMessage: "이미 사용 중인 아이디입니다.",
        detail: "status=400 errcode=M_USER_IN_USE register",
        status: 400,
        errcode: "M_USER_IN_USE",
      }),
      409,
    ],
  ]
  for (const [error, status] of cases) assert.equal(httpStatusOfAxError(error), status)
})

test("sanitizeForLog은 비밀값 모양을 가리고 길이를 자른다", () => {
  const raw = 'login failed access_token=tok-secret-1 Bearer abcdef "password": "hunter2" syt_xyz123 ?access_token=tok2 registration_token=reg-secret'
  const cleaned = sanitizeForLog(raw)
  assert.doesNotMatch(cleaned, /tok-secret-1|tok2|reg-secret|hunter2|abcdef|syt_xyz123/i)
  assert.doesNotMatch(cleaned, /access_token|password|registration_token|Bearer|syt_/i)
  assert.ok(cleaned.length <= 500)
  assert.equal(sanitizeForLog("a".repeat(600)).length, 500)
})

test("toAxError detail은 비밀값 섞인 원문을 남기지 않는다", () => {
  const secret = 'register challenge access_token=tok-secret-1 Bearer abcdef "password": "hunter2" syt_xyz123'
  const error = toAxError(Object.assign(new Error(secret), { httpStatus: 500 }), "대체 문구")
  assert.doesNotMatch(error.detail, /tok-secret-1|hunter2|abcdef|syt_xyz123/i)
  assert.doesNotMatch(error.detail, /access_token|password|Bearer|syt_/i)
  assert.match(error.detail, /status=500/)
})
