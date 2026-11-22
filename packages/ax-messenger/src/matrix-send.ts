// Matrix 방 글 보내기·인사 표지 확인. 인사와 답이 같은 sendText 길을 쓰며,
// 보내기 한 번마다 유한 기한(AbortController)을 건다. 기한을 넘기거나
// 연결이 끊기면 그 보내기는 "결과 모름"이다. 호출부(봇)는 인사 줄을
// reserved로 두고(sent로 두지 않고, 차지도 풀지 않는다), 다음 재시도는
// 방 표지 확인 뒤에 보낸다.
import { AX_GREETING_SEND_TIMEOUT_MS } from "./ai-ledger.js"

// 보내기 기한의 단일 출처는 ai-ledger.ts다(차지 임대와 함께 둬 관계를
// 시작 때 단정한다). 여기서는 같은 값을 이름만 빌려 쓴다.
export const AX_MATRIX_SEND_TIMEOUT_MS = AX_GREETING_SEND_TIMEOUT_MS

// 인사 본문에 함께 싣는 숨은 표지 칸. 화면에는 보이지 않으며, 장치가
// 달라도(고정 txnId의 장치 범위 밖) 방 흐름 대조로 중복을 막는다.
export const AX_GREETING_MARKER_KEY = "io.nextain.greeting"
export const AX_GREETING_HISTORY_LIMIT = 50

// 인증 거부(토큰 무효) 판정. Matrix는 인증 거부를 401로 돌려주며
// 본문의 errcode는 보통 아래 값이다. 401이면 코드와 무관하게 인증이
// 끊긴 것으로 보고, 다시 로그인하는 길(일반 오류의 1초 재시도와 다른
// 길)로 간다. 토큰·원문은 기록하지 않는다.
export const AX_MATRIX_AUTH_ERRCODES = ["M_MISSING_TOKEN", "M_UNKNOWN_TOKEN"] as const

export function isMatrixAuthFailure(status: unknown, _errcode?: unknown): boolean {
  return typeof status === "number" && status === 401
}

export class AxMatrixAuthError extends Error {
  readonly status: number
  readonly errcode: string | null
  constructor(status: number, errcode?: unknown) {
    super(`Matrix 인증이 끊겼습니다(${status}).`)
    this.name = "AxMatrixAuthError"
    this.status = status
    this.errcode = typeof errcode === "string" ? errcode : null
  }
}

export function greetingMarkerFor(orgId: string, roomId: string): string {
  const org = (orgId ?? "").trim()
  const room = (roomId ?? "").trim()
  if (!org || !room) throw new Error("기관·방을 확인해 주세요.")
  return `${org}:${room}`
}

function cleanTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("보내기 기한을 확인해 주세요.")
  }
  return value
}

// JSON PUT 한 번을 기한 안에 보낸다. 기한을 넘기면 AbortController로
// 끊고 오류를 던진다(결과 모름). 서버가 그 말을 받았는지는 모른다.
export async function putJsonWithDeadline(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const limit = cleanTimeoutMs(timeoutMs)
  const target = (url ?? "").trim()
  if (!target) throw new Error("Matrix 주소를 확인해 주세요.")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)
  try {
    return await fetchImpl(target, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Matrix 보내기 기한(${limit}ms)을 넘겼습니다.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export type AxGreetingHistoryDeps = {
  homeserverUrl: string
  accessToken: string
  roomId: string
  userId: string
  orgId: string
  // 옛 방(표지 없는 8회차 인사) 대조용 본문. 없으면 표지로만 본다.
  greetingBody?: string
  limit?: number
  // 흐름 조회 기한. 차지 뒤 표지 확인·보내기가 임대(60초) 안에 끝나게
  // 하려고 보내기와 같은 10초를 둔다. 넘기면 던진다(결과 모름).
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

// 방의 최근 글(뒤에서 앞으로, 상한 50)에서 봇이 남긴 표지 글이 있는지
// 본다. 있으면 true(보내지 않고 sent로 둔다). 흐름 읽기가 실패하면
// 던진다(실패를 "없음"으로 두지 않는다. 중복보다 빠짐을 막으려는 게
// 아니라, 모르는 채로 보내 중복을 만들지 않으려는 것이다).
export async function hasPostedGreeting(deps: AxGreetingHistoryDeps): Promise<boolean> {
  const base = (deps.homeserverUrl ?? "").trim().replace(/\/+$/, "")
  const roomId = (deps.roomId ?? "").trim()
  const userId = (deps.userId ?? "").trim()
  if (!base || !roomId || !userId || !deps.accessToken) {
    throw new Error("Matrix 방 흐름 조회를 확인해 주세요.")
  }
  const marker = greetingMarkerFor(deps.orgId, roomId)
  const limit = typeof deps.limit === "number" && Number.isInteger(deps.limit) && deps.limit > 0
    ? deps.limit
    : AX_GREETING_HISTORY_LIMIT
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeout = cleanTimeoutMs(deps.timeoutMs ?? AX_MATRIX_SEND_TIMEOUT_MS)
  const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${deps.accessToken}` },
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`방 흐름 읽기 기한(${timeout}ms)을 넘겼습니다.`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    // 401은 인증 끊김이다. 일반 흐름 읽기 실패와 길을 나누려고 따로
    // 던진다(호출부는 저장한 토큰을 버리고 다시 로그인한다).
    if (isMatrixAuthFailure(response.status)) {
      let errcode: unknown = null
      try {
        errcode = ((await response.json()) as { errcode?: unknown } | null)?.errcode ?? null
      } catch {
        // 본문이 없어도 401이면 인증 끊김이다.
      }
      throw new AxMatrixAuthError(response.status, errcode)
    }
    throw new Error(`방 흐름을 읽지 못했습니다(${response.status}).`)
  }
  const body = (await response.json()) as { chunk?: unknown }
  const chunk = Array.isArray(body?.chunk) ? (body.chunk as Record<string, unknown>[]) : []
  const wantBody = typeof deps.greetingBody === "string" && deps.greetingBody ? deps.greetingBody : null
  return chunk.some((event) => {
    if (!event || typeof event !== "object" || event["sender"] !== userId) return false
    const content = event["content"]
    if (!content || typeof content !== "object") return false
    const stamped = (content as Record<string, unknown>)[AX_GREETING_MARKER_KEY]
    if (typeof stamped === "string" && stamped === marker) return true
    if (wantBody && (content as Record<string, unknown>)["body"] === wantBody) return true
    return false
  })
}
