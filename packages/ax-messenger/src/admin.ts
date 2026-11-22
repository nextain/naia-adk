import { randomBytes } from "node:crypto"
import { createClient, Preset } from "matrix-js-sdk"
import { AxMessengerError, invalidInput, isAxMessengerError, sanitizeForLog, toAxError } from "./errors.js"
import type { AxSession } from "./types.js"

// 관리 길. 뒤쪽 서버에서만 부른다. 화면 묶음은 이 출입구를 가져가지 않는다.
// 임시 비밀번호는 반환값에 한 번만 담고 어디에도 저장하지 않는다(D105 64번).

export type AxAdminDeps = {
  createClient?: typeof createClient
  fetchImpl?: typeof fetch
}

export type AxProvisionPendingStep = "login" | "display-name"

export type AxProvisionResult = {
  userId: string
  // 한 번만 전달. 저장 금지.
  password: string
  displayName: string
  // 등록 뒤에 못 끝낸 단계. 비어 있으면 완전 성공이다.
  pending: AxProvisionPendingStep[]
  // pending이 비어 있지 않을 때 사용자용 안내 문구. 한 번만 전달.
  notice?: string
}

function baseUrlOf(homeserverUrl: string): string {
  const baseUrl = (homeserverUrl ?? "").trim().replace(/\/$/, "")
  if (!baseUrl) throw invalidInput("서버 주소를 확인해 주세요.")
  return baseUrl
}

function checkLocalpart(localpart: string): string {
  const value = (localpart ?? "").trim().toLowerCase()
  if (!/^[a-z0-9._=-]{1,32}$/.test(value)) {
    throw invalidInput("아이디는 영문 소문자·숫자와 . _ = - 조합 1~32자로 입력해 주세요.")
  }
  return value
}

function checkDisplayName(displayName: string): string {
  const value = (displayName ?? "").trim()
  if (!value || value.length > 80) throw invalidInput("이름은 1~80자로 입력해 주세요.")
  return value
}

// toAxError는 일반 객체의 message를 detail에 넣지 않으므로(Error만 읽는다),
// 단계·계정 표시가 필요한 곳은 상태·errcode를 단 Error로 넘긴다. 비밀값은 담지 않는다.
function stageError(message: string, status: unknown, errcode: unknown): Error {
  return Object.assign(new Error(message), { httpStatus: status, errcode })
}

// 이미 있는 아이디. kind는 invalid-input 그대로 두되 errcode를 남겨 409 대응에 쓴다.
function alreadyInUse(status?: number): AxMessengerError {
  return new AxMessengerError({
    kind: "invalid-input",
    userMessage: "이미 사용 중인 아이디입니다.",
    detail: `status=${status ?? "?"} errcode=M_USER_IN_USE register`,
    status,
    errcode: "M_USER_IN_USE",
  })
}

// FE-ax1-02-07 계정 발급. 뒤쪽 서버 전용.
export async function provisionAccount(input: {
  homeserverUrl: string
  registrationToken: string
  localpart: string
  displayName: string
  deps?: AxAdminDeps
}): Promise<AxProvisionResult> {
  const baseUrl = baseUrlOf(input.homeserverUrl)
  const localpart = checkLocalpart(input.localpart)
  const displayName = checkDisplayName(input.displayName)
  if (!input.registrationToken) throw invalidInput("등록 설정을 확인할 수 없습니다.")
  const fetchImpl = input.deps?.fetchImpl ?? fetch
  const password = randomBytes(18).toString("base64url")

  async function postRegister(body: Record<string, unknown>) {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}/_matrix/client/v3/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch (error) {
      throw toAxError(error, "계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
    }
    let result: Record<string, unknown> = {}
    try { result = await response.json() as Record<string, unknown> } catch { /* 빈 본문은 아래에서 처리 */ }
    return { response, result }
  }

  try {
    const first = await postRegister({
      username: localpart,
      password,
      inhibit_login: true,
      initial_device_display_name: "넥스테인 AX",
    })
    let userId = typeof first.result["user_id"] === "string" ? first.result["user_id"] as string : ""
    if (!userId) {
      const session = first.result["session"]
      if (typeof session !== "string" || !session) {
        if (first.result["errcode"] === "M_USER_IN_USE") throw alreadyInUse(first.response.status)
        throw toAxError(
          stageError(`provision register challenge localpart=${localpart}`, first.response.status, first.result["errcode"]),
          "계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
        )
      }
      const second = await postRegister({
        username: localpart,
        password,
        inhibit_login: true,
        initial_device_display_name: "넥스테인 AX",
        auth: { type: "m.login.registration_token", token: input.registrationToken, session },
      })
      if (typeof second.result["user_id"] !== "string" || !second.response.ok) {
        if (second.result["errcode"] === "M_USER_IN_USE") throw alreadyInUse(second.response.status)
        throw toAxError(
          stageError(`provision register localpart=${localpart}`, second.response.status, second.result["errcode"]),
          "계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
        )
      }
      userId = second.result["user_id"] as string
    }

    // 표시 이름은 새로 로그인해 붙이고 바로 끊는다. 임시 비밀번호는 저장하지 않는다.
    // 등록은 끝난 뒤 로그인·표시 이름 실패는 던지지 않고 부분 성공으로 돌려준다.
    // 계정은 만들어진 상태이므로 아이디·임시 비밀번호·못 끝낸 단계·안내 문구를 한 번 돌려준다.
    // 되돌리기(비활성화)는 관리 권한이 필요하므로 하지 않는다. 비밀값은 오류·기록에 넣지 않는다.
    // 로그아웃 실패는 발급 성공을 막지 않고 detail 기록만 남긴다.
    let accessToken: string
    let authedUserId: string
    try {
      const login = await fetchImpl(`${baseUrl}/_matrix/client/v3/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user: localpart }, password }),
      })
      let loginBody: Record<string, unknown> = {}
      try { loginBody = await login.json() as Record<string, unknown> } catch { /* 빈 본문은 아래에서 처리 */ }
      const token = loginBody["access_token"]
      if (!login.ok || typeof token !== "string" || !token) {
        throw toAxError(
          stageError(`provision login user_id=${userId}`, login.status, loginBody["errcode"]),
          "계정을 만들었으나 로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
        )
      }
      accessToken = token
      authedUserId = typeof loginBody["user_id"] === "string" && loginBody["user_id"] ? loginBody["user_id"] : userId
    } catch (error) {
      // 발급 뒤처리의 로그인 실패는 인증 실패이므로 forbidden을 auth로 되돌린다.
      let axError: AxMessengerError
      if (isAxMessengerError(error)) {
        axError = error.kind === "forbidden"
          ? new AxMessengerError({
            kind: "auth",
            userMessage: error.userMessage,
            detail: error.detail,
            status: error.status,
            errcode: error.errcode,
          })
          : error
      } else {
        const converted = toAxError(error, "계정을 만들었으나 로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
        axError = converted.kind === "forbidden"
          ? new AxMessengerError({
            kind: "auth",
            userMessage: converted.userMessage,
            detail: converted.detail,
            status: converted.status,
            errcode: converted.errcode,
          })
          : converted
      }
      console.warn(`ax-provision: partial pending=login user_id=${userId} ${axError.detail}`)
      return { userId, password, displayName, pending: ["login" as const], notice: axError.userMessage }
    }

    // 표시 이름 실패 때도 아래 로그아웃 정리는 건너뛰지 않는다. 토큰이 있으면
    // 성공·실패와 상관없이 정리하고, 마지막에 결과를 한 번만 돌려준다.
    let pending: AxProvisionPendingStep[] = []
    let notice: string | undefined
    try {
      const displayNameResponse = await fetchImpl(
        `${baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(authedUserId)}/displayname`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ displayname: displayName }),
        },
      )
      if (!displayNameResponse.ok) {
        let errcode: unknown
        try { errcode = (await displayNameResponse.json() as Record<string, unknown>)["errcode"] } catch { /* 빈 본문 무시 */ }
        throw toAxError(
          stageError(`provision displayname user_id=${authedUserId}`, displayNameResponse.status, errcode),
          "계정은 만들었으나 이름을 설정하지 못했습니다. 다시 로그인해 이름을 설정해 주세요.",
        )
      }
    } catch (error) {
      const axError = isAxMessengerError(error)
        ? error
        : toAxError(error, "계정은 만들었으나 이름을 설정하지 못했습니다. 다시 로그인해 이름을 설정해 주세요.")
      console.warn(`ax-provision: partial pending=display-name user_id=${authedUserId} ${axError.detail}`)
      pending = ["display-name"]
      notice = axError.userMessage
    }

    if (accessToken) {
      try {
        const logout = await fetchImpl(`${baseUrl}/_matrix/client/v3/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
        })
        if (!logout.ok) {
          let errcode: unknown
          try { errcode = (await logout.json() as Record<string, unknown>)["errcode"] } catch { /* 빈 본문 무시 */ }
          console.warn(
            `ax-provision: logout status=${logout.status} errcode=${typeof errcode === "string" ? errcode : "?"} user_id=${authedUserId}`,
          )
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "알 수 없는 오류"
        console.warn(sanitizeForLog(`ax-provision: logout failed user_id=${authedUserId} ${reason}`, 300))
      }
    }
    if (pending.length > 0) {
      return { userId, password, displayName, pending, notice: notice as string }
    }
    return { userId, password, displayName, pending: [] }
  } catch (error) {
    if (isAxMessengerError(error)) throw error
    throw toAxError(error, "계정을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  }
}

function adminClient(session: AxSession, deps?: AxAdminDeps) {
  const baseUrl = baseUrlOf(session.homeserverUrl)
  if (!session.userId || !session.accessToken) throw invalidInput("관리 연결 정보를 확인해 주세요.")
  const makeClient = deps?.createClient ?? createClient
  return makeClient({
    baseUrl,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
  })
}

// FE-ax1-02-07 뼈대 세우기 방 만들기. 뒤쪽 서버 전용.
export async function createRoom(
  session: AxSession,
  name: string,
  invitees: string[] = [],
  deps?: AxAdminDeps,
): Promise<string> {
  const roomName = (name ?? "").trim()
  if (!roomName) throw invalidInput("대화방 이름을 입력해 주세요.")
  // 통합 시험 종료를 막는 남은 연결을 없애려고 일회성 관리 연결도 바로 끊는다.
  const matrix = adminClient(session, deps)
  try {
    const result = await matrix.createRoom({
      name: roomName,
      invite: invitees,
      preset: Preset.PrivateChat,
      initial_state: [
        { type: "m.room.history_visibility", state_key: "", content: { history_visibility: "shared" } },
      ],
    })
    return result.room_id
  } catch (error) {
    if (isAxMessengerError(error)) throw error
    throw toAxError(error, "대화방을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  } finally {
    try { (matrix as unknown as { stopClient?: () => void }).stopClient?.() } catch { /* 정리만 */ }
  }
}

// FE-ax1-02-07 초대. 뒤쪽 서버 전용.
export async function invite(session: AxSession, roomId: string, userId: string, deps?: AxAdminDeps): Promise<void> {
  if (!roomId || !userId?.trim()) throw invalidInput("초대할 방과 아이디를 확인해 주세요.")
  const matrix = adminClient(session, deps)
  try {
    await matrix.invite(roomId, userId.trim())
  } catch (error) {
    if (isAxMessengerError(error)) throw error
    throw toAxError(error, "초대하지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  } finally {
    try { (matrix as unknown as { stopClient?: () => void }).stopClient?.() } catch { /* 정리만 */ }
  }
}

// FE-ax1-02-07 표시 이름. 뒤쪽 서버 전용.
export async function setDisplayName(session: AxSession, displayName: string, deps?: AxAdminDeps): Promise<void> {
  const value = checkDisplayName(displayName)
  const matrix = adminClient(session, deps)
  try {
    await matrix.setDisplayName(value)
  } catch (error) {
    if (isAxMessengerError(error)) throw error
    throw toAxError(error, "이름을 바꾸지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  } finally {
    try { (matrix as unknown as { stopClient?: () => void }).stopClient?.() } catch { /* 정리만 */ }
  }
}

export type AxUsageKind = "message" | "file" | "ai-call"

// 제공자 응답의 사용량(모델 사용량). FE-ax1-04-04.
export type AxAiUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AxUsageEntry = {
  kind: AxUsageKind
  // 기관별 집계를 위한 기관 표지. ai-call에는 필수다.
  orgId?: string
  // 제공자를 부르는 지점의 호출 표지(QC-07 대조용).
  callId?: string
  userId?: string
  roomId?: string
  bytes?: number
  // 셀 수 있는 입력 크기(문자 수 또는 토큰 수, 계산기는 AI 길 설정).
  inputSize?: number
  // ai-call의 모델 사용량.
  usage?: AxAiUsage
  // 호출에 쓴 제공자 표지. 시험 표시 호출은 "fake"로 남아 1단계 판정에서
  // 걸러 낼 수 있다.
  provider?: string
  // 응답 출력이 상한을 넘겨 실패 처리된 호출에만 true다.
  outputOverflow?: boolean
  at: number
}

function checkUsageNumbers(usage: AxAiUsage | undefined): AxAiUsage | undefined {
  if (usage === undefined) return undefined
  const out: AxAiUsage = {}
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const value = usage[key]
    if (value === undefined) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw invalidInput("사용량을 확인해 주세요.")
    }
    out[key] = value
  }
  return out
}

// FE-ax1-02-07 사용량 모으기. 메시지 수·파일 용량 자리에 FE-ax1-04-04
// 기관별 AI 호출 사용량을 더한다. 아는 칸만 골라 담아 비밀값·대화 본문이
// 들어갈 자리가 없다. 거부된 AI 호출은 AI 길이 부르지 않으므로 쌓이지 않는다.
export function createUsageCollector() {
  const entries: AxUsageEntry[] = []
  return {
    entries,
    record(input: Omit<AxUsageEntry, "at"> & { at?: number }): AxUsageEntry {
      if (!input || !["message", "file", "ai-call"].includes(input.kind)) {
        throw invalidInput("사용량 종류를 확인해 주세요.")
      }
      if (input.bytes !== undefined && (!Number.isFinite(input.bytes) || input.bytes < 0)) {
        throw invalidInput("사용량을 확인해 주세요.")
      }
      if (input.kind === "ai-call" && !(input.orgId ?? "").trim()) {
        throw invalidInput("기관을 확인해 주세요.")
      }
      if (input.inputSize !== undefined && (!Number.isFinite(input.inputSize) || input.inputSize < 0)) {
        throw invalidInput("사용량을 확인해 주세요.")
      }
      if (input.callId !== undefined && !input.callId.trim()) {
        throw invalidInput("호출 표지를 확인해 주세요.")
      }
      const entry: AxUsageEntry = {
        kind: input.kind,
        at: input.at ?? Date.now(),
      }
      if (input.orgId) entry.orgId = input.orgId
      if (input.callId) entry.callId = input.callId
      if (input.userId) entry.userId = input.userId
      if (input.roomId) entry.roomId = input.roomId
      if (input.bytes !== undefined) entry.bytes = input.bytes
      if (input.inputSize !== undefined) entry.inputSize = input.inputSize
      if (input.provider) entry.provider = input.provider
      if (input.outputOverflow === true) entry.outputOverflow = true
      const usage = checkUsageNumbers(input.usage)
      if (usage !== undefined) entry.usage = usage
      entries.push(entry)
      return entry
    },
  }
}
