import {
  GATE_ACCOUNT_HEADER,
  GATE_SECRET_HEADER,
  inspectSingleHeaderOnReq,
  isTrustedIdentityPeer,
  readGateSecret,
  verifyGateSecretValue,
} from "./gate-secret.mjs"

// API 는 대시보드가 붙인 이 표시가 있을 때만 메신저의 사람 신원을 믿는다.
export const MESSENGER_GATE_MARK_HEADER = "x-naia-gate-verified"

const MESSENGER_API_PATH = "/api/portal/messenger"
const DISPLAY_HEADER = "x-ax-user"
// 로그인 게이트의 계정 이름 원형과 같다.
const ACCOUNT_KEY_RE = /^[a-z][a-z0-9-]{1,31}$/
const verifiedAccounts = new WeakMap()

function isMessengerApiPath(url) {
  if (typeof url !== "string") return false
  const pathname = url.split("?")[0]
  return pathname === MESSENGER_API_PATH || pathname.startsWith(`${MESSENGER_API_PATH}/`)
}

/**
 * 로그인 게이트가 넘긴 요청인지 확인한다(닫힌 쪽 기본값).
 * 비밀이 없거나, 믿는 출처가 아니거나, 비밀·계정 머리글이 맞지 않으면 사람 신원은 없다.
 * 게이트 비밀 머리글을 지우는 가드보다 먼저 불러야 한다.
 */
export function verifyMessengerGate(req, env = process.env) {
  verifiedAccounts.delete(req)
  if (!isMessengerApiPath(req?.url)) return false
  const gateSecret = readGateSecret(env)
  if (!gateSecret) return false
  if (!isTrustedIdentityPeer(req.socket?.remoteAddress, env)) return false
  const secret = inspectSingleHeaderOnReq(req, GATE_SECRET_HEADER)
  if (!secret.present || !secret.valid || !verifyGateSecretValue(secret.value, gateSecret)) return false
  const account = inspectSingleHeaderOnReq(req, GATE_ACCOUNT_HEADER)
  if (!account.present || !account.valid || !ACCOUNT_KEY_RE.test(account.value ?? "")) return false
  // 표시 이름은 게이트가 덮어쓴 한 개만 받는다. 두 개 오면(브라우저 값이 남은 경우) 넘기지 않는다.
  const display = inspectSingleHeaderOnReq(req, DISPLAY_HEADER)
  verifiedAccounts.set(req, { account: account.value, display: display.present && display.valid ? display.value : null })
  return true
}

/** verifyMessengerGate 가 이 요청의 게이트 비밀·계정을 확인했는지. */
export function isMessengerGateVerified(req) {
  return verifiedAccounts.has(req)
}

/**
 * API 로 넘길 머리글을 메신저 길에 맞게 고친다. 다른 길은 건드리지 않는다.
 * 확인된 요청만 계정·표시 이름과 표시를 넘기고, 나머지는 사람 신원 머리글을 모두 지운다.
 * 표시 이름은 확인 때 읽은 값으로 다시 쓴다(앞단 게이트가 x-ax-user 를 덮어쓴다는 규약에 기댄다).
 */
export function applyMessengerIdentity(outHeaders, req, env = process.env) {
  if (!isMessengerApiPath(req?.url)) return
  const verified = verifiedAccounts.get(req)
  const noteHeader = typeof env?.NAIA_NOTE_USER_HEADER === "string" ? env.NAIA_NOTE_USER_HEADER.trim().toLowerCase() : ""
  for (const key of Object.keys(outHeaders)) {
    const lower = key.toLowerCase()
    if (lower === GATE_ACCOUNT_HEADER || lower === DISPLAY_HEADER || (!verified && lower === noteHeader)) {
      delete outHeaders[key]
    }
  }
  if (verified) {
    outHeaders[GATE_ACCOUNT_HEADER] = verified.account
    if (verified.display) outHeaders[DISPLAY_HEADER] = verified.display
    outHeaders[MESSENGER_GATE_MARK_HEADER] = "1"
  }
}
