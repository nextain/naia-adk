import { evaluateTrust, isLoopbackIp } from "./security.js"

const ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{1,31}$/
const GATEWAY_SCOPE_RE = /^[a-z][a-z0-9._-]{0,63}$/
const IDENTITY_HEADERS = [
  "x-naia-proxy-secret",
  "x-naia-peer",
  "x-naia-local",
  "x-naia-origin-ok",
  "x-naia-actor-id",
  "x-naia-actor-verified",
] as const

type IdentityEnv = Record<string, string | undefined>
type HeaderBag = Record<string, string | string[] | undefined>

export interface PublishIdentityRequest {
  headers: HeaderBag
  raw?: { rawHeaders?: readonly string[]; socket?: { remoteAddress?: string } }
  socket?: { remoteAddress?: string }
  server?: unknown
}

export class PublishIdentityError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = "PublishIdentityError"
  }
}

/** 배열, 합쳐진 값, 원본 중복, 파싱 전후 불일치는 신원 경계에서 거절한다. */
function singleHeader(request: PublishIdentityRequest, name: string): string | undefined {
  const keys = Object.keys(request.headers).filter((key) => key.toLowerCase() === name)
  const value = keys.length === 1 ? request.headers[keys[0]!] : undefined
  let rawCount = 0
  let rawValue: string | undefined
  const raw = request.raw?.rawHeaders ?? []
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === name) {
      rawCount++
      rawValue = raw[i + 1]
    }
  }
  if (keys.length > 1 || rawCount > 1 || Array.isArray(value) ||
      (value !== undefined && (typeof value !== "string" || value.includes(","))) ||
      (rawCount === 1 && (rawValue !== value || typeof rawValue !== "string"))) {
    throw new PublishIdentityError(401, "publish_identity_invalid", "게시 계정 정보를 확인할 수 없습니다.")
  }
  return value
}

function gatewayScope(env: IdentityEnv): string {
  const scope = env.PUBLISH_GATEWAY_SCOPE
  if (typeof scope !== "string" || !GATEWAY_SCOPE_RE.test(scope)) {
    throw new PublishIdentityError(503, "publish_identity_unavailable", "게시 계정 확인 설정이 준비되지 않았습니다.")
  }
  return scope
}

function isActorId(actorId: string, scope: string): boolean {
  return actorId.startsWith(`${scope}:`) && ACCOUNT_KEY_RE.test(actorId.slice(scope.length + 1))
}

/**
 * 대시보드가 매 요청 새로 만든 계정만 인정한다.
 * 관문 표시명·요청 본문·기존 메모의 비밀 없는 호환 동작은 사용하지 않는다.
 */
export function requirePublishIdentity(
  request: PublishIdentityRequest,
  env: IdentityEnv = process.env,
  write = false,
): string {
  const scope = gatewayScope(env)
  const secret = (request.server as { proxySecret?: unknown } | undefined)?.proxySecret
  if (typeof secret !== "string" || !secret) {
    throw new PublishIdentityError(503, "publish_identity_unavailable", "게시 계정 확인 설정이 준비되지 않았습니다.")
  }
  const headers: HeaderBag = {}
  for (const name of IDENTITY_HEADERS) headers[name] = singleHeader(request, name)
  const trust = evaluateTrust(headers, secret)
  if (!trust.secretValid) {
    throw new PublishIdentityError(401, "publish_identity_required", "로그인한 계정으로 다시 요청해 주세요.")
  }
  const socketPeer = request.raw?.socket?.remoteAddress ?? request.socket?.remoteAddress ?? ""
  if (!isLoopbackIp(socketPeer) || !trust.trusted) {
    throw new PublishIdentityError(403, "publish_proxy_forbidden", "허용된 대시보드에서 요청해 주세요.")
  }
  const actor = headers["x-naia-actor-id"]
  if (headers["x-naia-actor-verified"] !== "1" || typeof actor !== "string" || !actor) {
    throw new PublishIdentityError(401, "publish_identity_required", "로그인한 계정으로 다시 요청해 주세요.")
  }
  if (!isActorId(actor, scope)) {
    throw new PublishIdentityError(401, "publish_identity_invalid", "게시 계정 정보를 확인할 수 없습니다.")
  }
  if (write && !trust.originOk) {
    throw new PublishIdentityError(403, "publish_origin_forbidden", "같은 대시보드 화면에서 다시 요청해 주세요.")
  }
  return actor
}

function approverIds(env: IdentityEnv): Set<string> | null {
  const scope = env.PUBLISH_GATEWAY_SCOPE
  const raw = env.PUBLISH_APPROVER_IDS
  if (typeof scope !== "string" || !GATEWAY_SCOPE_RE.test(scope) || typeof raw !== "string" || !raw) return null
  const ids = raw.split(",").map((id) => id.trim())
  if (ids.length === 0 || ids.some((id) => !isActorId(id, scope))) return null
  return new Set(ids)
}

export function canApprove(actorId: string, env: IdentityEnv = process.env): boolean {
  return env.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED === "1" && approverIds(env)?.has(actorId) === true
}

export function requireApprover(actorId: string, env: IdentityEnv = process.env): void {
  if (env.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED !== "1") {
    throw new PublishIdentityError(403, "publish_gateway_unconfirmed", "관문의 계정 덮어쓰기 확인이 필요합니다.")
  }
  const ids = approverIds(env)
  if (!ids) {
    throw new PublishIdentityError(503, "publish_approver_unavailable", "게시 승인 담당자 설정이 준비되지 않았습니다.")
  }
  if (!ids.has(actorId)) {
    throw new PublishIdentityError(403, "publish_approver_required", "게시 승인 담당자만 승인할 수 있습니다.")
  }
}
