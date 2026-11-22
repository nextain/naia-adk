export type AxErrorKind =
  | "auth"
  | "forbidden"
  | "rate-limited"
  | "too-large"
  | "invalid-input"
  | "network"
  | "server"
  | "duplicate"
  | "unknown"

// 화면에는 userMessage만 보인다. detail은 서버 기록용이며 입력값(비밀번호·토큰)을 담지 않는다.
export class AxMessengerError extends Error {
  readonly kind: AxErrorKind
  readonly userMessage: string
  readonly detail: string
  readonly status?: number
  readonly errcode?: string

  constructor(options: {
    kind: AxErrorKind
    userMessage: string
    detail: string
    status?: number
    errcode?: string
  }) {
    super(options.userMessage)
    this.name = "AxMessengerError"
    this.kind = options.kind
    this.userMessage = options.userMessage
    this.detail = options.detail
    this.status = options.status
    this.errcode = options.errcode
  }
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  for (const key of ["httpStatus", "status", "statusCode"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  const response = record["response"]
  if (typeof response === "object" && response !== null) {
    const status = (response as Record<string, unknown>)["status"]
    if (typeof status === "number" && Number.isFinite(status)) return status
  }
  return undefined
}

function readErrcode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const record = error as Record<string, unknown>
  for (const key of ["errcode", "code"]) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
  const data = record["data"]
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>)["errcode"]
    if (typeof nested === "string" && nested) return nested
  }
  return undefined
}

function looksNetwork(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  const code = record["code"]
  if (typeof code === "string" && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET"].includes(code)) return true
  const name = record["name"]
  if (name === "ConnectionError" || name === "AbortError") return true
  const message = error instanceof Error ? error.message : ""
  return /fetch failed|Failed to fetch|network|load failed|connection refused/i.test(message)
}

// 기록용 비밀값 제거. 값뿐 아니라 키 이름까지 남기지 않는다(단언용 검사와 맞춤).
// URL 쿼리·JSON 본문·key=value·Bearer 헤더·Synapse 단기 토큰(syt_…)을 가린다.
export function sanitizeForLog(value: string, maxLength = 500): string {
  let out = value ?? ""
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "[가려짐]")
  out = out.replace(/\bsyt_[A-Za-z0-9\-_]+/g, "[가려짐]")
  out = out.replace(/"(?:access[_-]?token|accessToken|refresh[_-]?token|registration[_-]?token|registrationToken|password|passwd|pwd|token)"\s*:\s*"[^"]*"/gi, '"[가려짐]"')
  out = out.replace(/(?:access[_-]?token|accessToken|refresh[_-]?token|registration[_-]?token|registrationToken|password|passwd|pwd)\s*[:=]\s*['"]?[^\s&"'{};,]+['"]?/gi, "[가려짐]")
  out = out.replace(/\btoken\s*[:=]\s*['"]?[^\s&"'{};,]+['"]?/gi, "[가려짐]")
  return out.slice(0, maxLength)
}

// kind별 사용자 문구. 서버·모델·저장소 이름과 원문 오류를 담지 않는다.
export function toAxError(error: unknown, fallbackUserMessage: string): AxMessengerError {
  if (error instanceof AxMessengerError) return error
  const status = readStatus(error)
  const errcode = readErrcode(error)
  const raw = error instanceof Error ? error.message : String(error ?? "알 수 없는 오류")
  const detail = sanitizeForLog(`status=${status ?? "?"} errcode=${errcode ?? "?"} ${raw}`, 500)

  if (status === 429 || errcode === "M_LIMIT_EXCEEDED") {
    return new AxMessengerError({
      kind: "rate-limited",
      userMessage: "요청이 많아 잠시 막혔습니다. 잠시 뒤 다시 시도해 주세요.",
      detail, status, errcode,
    })
  }
  if (status === 413 || errcode === "M_TOO_LARGE") {
    return new AxMessengerError({
      kind: "too-large",
      userMessage: "파일이 커서 올리지 못했습니다. 더 작은 파일로 시도해 주세요.",
      detail, status, errcode,
    })
  }
  // 인증 실패(401·토큰 없음·계정 비활성)는 auth, 권한 부족(403·M_FORBIDDEN)은 forbidden.
  // 같은 M_FORBIDDEN이라도 로그인 맥락은 호출부(client 로그인·발급 로그인)에서 auth로 되돌린다.
  if (
    status === 401 ||
    (errcode !== undefined && ["M_UNKNOWN_TOKEN", "M_MISSING_TOKEN", "M_USER_DEACTIVATED"].includes(errcode))
  ) {
    return new AxMessengerError({ kind: "auth", userMessage: fallbackUserMessage, detail, status, errcode })
  }
  if (status === 403 || errcode === "M_FORBIDDEN") {
    return new AxMessengerError({ kind: "forbidden", userMessage: fallbackUserMessage, detail, status, errcode })
  }
  if (looksNetwork(error)) {
    return new AxMessengerError({
      kind: "network",
      userMessage: "연결하지 못했습니다. 네트워크를 확인해 주세요.",
      detail, status, errcode,
    })
  }
  if (status !== undefined && status >= 500) {
    return new AxMessengerError({ kind: "server", userMessage: fallbackUserMessage, detail, status, errcode })
  }
  return new AxMessengerError({ kind: "unknown", userMessage: fallbackUserMessage, detail, status, errcode })
}

export function invalidInput(userMessage: string, detail = userMessage): AxMessengerError {
  return new AxMessengerError({ kind: "invalid-input", userMessage, detail })
}

export function isAxMessengerError(error: unknown): error is AxMessengerError {
  return error instanceof AxMessengerError
}

// 화면용 안전 문구. detail은 기록에만 쓴다.
export function userMessageOf(error: unknown, fallback: string): string {
  if (error instanceof AxMessengerError) return error.userMessage
  return toAxError(error, fallback).userMessage
}

// 층 오류 kind → HTTP 상태. 이미 있는 아이디는 기존대로 409.
export function httpStatusOfAxError(error: AxMessengerError): number {
  if (error.errcode === "M_USER_IN_USE" || error.userMessage.includes("이미 사용 중")) return 409
  switch (error.kind) {
    case "invalid-input": return 400
    case "auth": return 401
    case "forbidden": return 403
    case "rate-limited": return 429
    case "too-large": return 413
    case "duplicate": return 409
    default: return 502
  }
}
