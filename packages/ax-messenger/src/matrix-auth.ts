// Matrix 인증 끊김 회복 + 봇 접속 토큰 파일 권한 강제. 뒤쪽 서버(봇) 전용이며
// 화면 묶음은 가져가지 않는다(공개 출입구에 두지 않는다).
//
// 전제: 1단계는 기관마다 서버 하나·봇 하나다. 같은 기관 봇이 두 곳에서
// 돌면 같은 고정 장치로 다시 로그인할 때마다 앞 접속 토큰이 끊긴다.
// 목표는 "둘 다 돌게 하기"가 아니라, 인증이 끊기면 정해진 길로 회복하고
// 회복이 반복되면 분명한 오류로 멈추는 것이다.
//
// 회복 길: Matrix 요청이 401을 받으면 저장한 토큰을 버리고 같은 고정
// device_id로 다시 로그인한 뒤 새 토큰을 저장하고 이어 간다. 일반 오류의
// 1초 재시도와 길을 나눈다. 다시 로그인이 창(10분) 안에 상한(3회)을 넘으면
// "같은 기관 봇이 다른 곳에서 돌고 있을 수 있음" 뜻의 고정 오류를 남기고
// 0이 아닌 코드로 끝낸다. 토큰·내부 원문은 기록하지 않는다.
//
// 토큰 파일 길: 읽기 전에 lstat으로 본다. 심볼릭 링크면 시작 거부,
// 소유자가 지금 사용자가 아니면 시작 거부, 모드가 0600이 아니면 chmod
// 0600으로 고치고 고치지 못하면 시작 거부다. 쓸 때는 임시 파일(0600)에
// 쓰고 rename으로 바꾼다.
import { randomBytes } from "node:crypto"
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { setTimeout as sleepMs } from "node:timers/promises"
import { isMatrixAuthFailure } from "./matrix-send.js"

// 다시 로그인이 이 창 안에 이 횟수를 넘으면 고정 오류로 끝난다.
// 기본값은 상수 그대로다. 환경 변수 손잡이는 명시적 시험 모드에서만 읽는다.
export const AX_AUTH_RELOGIN_WINDOW_MS = 600_000
export const AX_AUTH_RELOGIN_MAX_COUNT = 3
export const AX_AUTH_RELOGIN_WINDOW_MS_ENV = "AX_AUTH_RELOGIN_WINDOW_MS"
export const AX_AUTH_RELOGIN_MAX_COUNT_ENV = "AX_AUTH_RELOGIN_MAX_COUNT"

// 이 패키지에 이미 있는 시험 모드 표지를 그대로 쓴다. 가짜 제공자도 같은
// 표지(`AX_AI_TEST_MODE=1`)로만 기동한다. 시험 모드가 아니면 아래 시험 변수는
// 값이 있어도 무시하고 기본값을 쓰며 경고 한 줄을 남긴다.
export const AX_AUTH_TEST_MODE_ENV = "AX_AI_TEST_MODE"

// 시험 모드에서도 상한을 더 느슨하게 만들 수 없게 범위를 묶는다. 횟수는
// 기본값(3회)보다 크게 두지 못하고(1~3회), 창은 기본값(10분)보다 길게 두지
// 못한다(1초~600000ms). 창을 줄이면 옛 기록이 빨리 비워져 상한이 느슨해지므로
// 시험 모드에서만 허용한다. 범위 밖 값은 시작 오류다.
export const AX_AUTH_RELOGIN_COUNT_MIN = 1
export const AX_AUTH_RELOGIN_COUNT_MAX = AX_AUTH_RELOGIN_MAX_COUNT
export const AX_AUTH_RELOGIN_WINDOW_MIN_MS = 1_000
export const AX_AUTH_RELOGIN_WINDOW_MAX_MS = AX_AUTH_RELOGIN_WINDOW_MS

// 시험 모드가 아닐 때 시험 변수가 무시됐음을 알리는 경고 한 줄. 값(비밀 아님)은
// 담지 않고 기본값만 밝힌다.
export const AX_AUTH_ENV_IGNORED_WARNING =
  "nextain-ai: 시험 모드가 아니라 인증 회복 시험 변수를 무시하고 기본값(창 10분·3회)으로 돕니다."

// 고정 오류 문구. 같은 기관 봇이 다른 곳에서 돌고 있을 수 있다는 뜻이며,
// 토큰·내부 원문을 담지 않는다. 봇·계약 문서·시험이 같은 문구를 쓴다.
export const AX_AUTH_DUPLICATE_BOT_MESSAGE =
  "같은 기관 봇이 다른 곳에서 돌고 있을 수 있어 넥스테인 AI 봇을 끝냅니다."

// 토큰 파일 시작 거부 문구(토큰·원문을 담지 않는다).
export const AX_TOKEN_SYMLINK_MESSAGE = "넥스테인 AI의 접속 기록이 심볼릭 링크라 시작하지 않습니다."
export const AX_TOKEN_OWNER_MESSAGE = "넥스테인 AI의 접속 기록 소유자가 달라 시작하지 않습니다."
export const AX_TOKEN_MODE_MESSAGE = "넥스테인 AI의 접속 기록 권한을 고치지 못해 시작하지 않습니다."
export const AX_TOKEN_READ_MESSAGE = "넥스테인 AI의 접속 기록을 읽을 수 없습니다."
export const AX_DATADIR_WORLD_MESSAGE =
  "데이터 폴더가 다른 사용자에게 쓰기 열려 있어 넥스테인 AI 봇을 시작하지 않습니다."
export const AX_DATADIR_GROUP_WARNING = "nextain-ai: 데이터 폴더 함께 쓰기 주의"

// 토큰 파일 모드. 읽기·쓰기 모두 0600이다.
export const AX_BOT_TOKEN_FILE_MODE = 0o600

export type AxAuthReloginPolicy = {
  windowMs: number
  maxCount: number
}

export function isAuthTestMode(env: Record<string, string | undefined>): boolean {
  return (env[AX_AUTH_TEST_MODE_ENV] ?? "").trim() === "1"
}

// 시험 변수가 하나라도 값이 있으면 true다(시험 모드와 무관). 시험 모드가
// 아닐 때 true면 기본값을 쓰고 경고 한 줄을 남긴다.
export function hasAuthTestVars(env: Record<string, string | undefined>): boolean {
  const windowRaw = env[AX_AUTH_RELOGIN_WINDOW_MS_ENV] ?? ""
  const countRaw = env[AX_AUTH_RELOGIN_MAX_COUNT_ENV] ?? ""
  return windowRaw.trim() !== "" || countRaw.trim() !== ""
}

// 제공자 이름 환경 변수. ai.ts의 ENV_KEYS.provider와 같은 값이다. 시험 변수를
// 실제 제공자와 함께 쓰지 못하게 여기서도 읽는다(무거운 ai 모듈은 가져오지 않는다).
export const AX_AUTH_PROVIDER_ENV = "AX_AI_PROVIDER"
// 시험 변수를 쓸 수 있는 유일한 제공자. ai.ts의 AX_AI_PROVIDER_FAKE와 같은
// 값이다(위 까닭으로 값을 직접 적는다).
export const AX_AUTH_TEST_ONLY_PROVIDER = "fake"

// 시험 모드인데 제공자가 가짜가 아니면서 시험 변수가 있을 때의 시작 오류 문구.
// 변수값·열쇠 등 비밀은 담지 않는다.
export const AX_AUTH_TEST_VARS_PROVIDER_MESSAGE =
  "인증 회복 시험 변수는 가짜 제공자에서만 쓸 수 있어 시작하지 않습니다.(AX_AI_TEST_MODE=1·AX_AI_PROVIDER=fake)"

function parseTestInt(raw: string, envName: string, min: number, max: number): number {
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`인증 회복 시험 설정을 확인해 주세요.(${envName}는 ${min}~${max} 사이 정수여야 합니다)`)
  }
  return value
}

// 실행 정책. 시험 변수가 하나도 없으면 기본값을 쓴다. 시험 변수가 있는데
// 시험 모드가 아니면 무시하고 기본값을 쓴다(호출부가 경고 한 줄을 남긴다).
// 시험 모드에서 시험 변수가 있으면 제공자가 가짜(fake)일 때만 범위(횟수 1~3,
// 창 1000~600000ms) 안에서 받고, 범위 밖은 시작 오류로 던진다. 시험 모드라도
// 제공자가 가짜가 아니면 무시하지 않고 시작 오류로 던진다(시험 손잡이를 실제
// 제공자와 함께 쓰는 설정 실수를 숨기지 않으려는 것이다). 이름은 위 _ENV 상수와 같다.
export function resolveAuthReloginPolicy(env: Record<string, string | undefined>): AxAuthReloginPolicy {
  if (!hasAuthTestVars(env)) {
    return { windowMs: AX_AUTH_RELOGIN_WINDOW_MS, maxCount: AX_AUTH_RELOGIN_MAX_COUNT }
  }
  if (!isAuthTestMode(env)) {
    return { windowMs: AX_AUTH_RELOGIN_WINDOW_MS, maxCount: AX_AUTH_RELOGIN_MAX_COUNT }
  }
  if ((env[AX_AUTH_PROVIDER_ENV] ?? "").trim() !== AX_AUTH_TEST_ONLY_PROVIDER) {
    throw new Error(AX_AUTH_TEST_VARS_PROVIDER_MESSAGE)
  }
  const windowRaw = env[AX_AUTH_RELOGIN_WINDOW_MS_ENV] ?? ""
  const countRaw = env[AX_AUTH_RELOGIN_MAX_COUNT_ENV] ?? ""
  return {
    windowMs: windowRaw.trim() === ""
      ? AX_AUTH_RELOGIN_WINDOW_MS
      : parseTestInt(windowRaw, AX_AUTH_RELOGIN_WINDOW_MS_ENV, AX_AUTH_RELOGIN_WINDOW_MIN_MS, AX_AUTH_RELOGIN_WINDOW_MAX_MS),
    maxCount: countRaw.trim() === ""
      ? AX_AUTH_RELOGIN_MAX_COUNT
      : parseTestInt(countRaw, AX_AUTH_RELOGIN_MAX_COUNT_ENV, AX_AUTH_RELOGIN_COUNT_MIN, AX_AUTH_RELOGIN_COUNT_MAX),
  }
}

// 창 안 다시 로그인 시각 기록. 서로 끊기를 반복하면 횟수가 찬다.
export class AxAuthReloginTracker {
  private readonly windowMs: number
  private readonly maxCount: number
  private readonly stamps: number[] = []

  constructor(windowMs: number = AX_AUTH_RELOGIN_WINDOW_MS, maxCount: number = AX_AUTH_RELOGIN_MAX_COUNT) {
    if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error("인증 회복 창을 확인해 주세요.")
    if (!Number.isInteger(maxCount) || maxCount <= 0) throw new Error("인증 회복 상한을 확인해 주세요.")
    this.windowMs = windowMs
    this.maxCount = maxCount
  }

  get policy(): AxAuthReloginPolicy {
    return { windowMs: this.windowMs, maxCount: this.maxCount }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.stamps.length > 0 && (this.stamps[0] as number) <= cutoff) this.stamps.shift()
  }

  count(now: number = Date.now()): number {
    this.prune(now)
    return this.stamps.length
  }

  note(now: number = Date.now()): number {
    this.stamps.push(now)
    this.prune(now)
    return this.stamps.length
  }

  exceeded(now: number = Date.now()): boolean {
    return this.count(now) > this.maxCount
  }
}

// 고정 오류 판정. 문구로만 가린다(토큰·원문을 비교하지 않는다).
export function isAuthExhaustedError(error: unknown): boolean {
  return error instanceof Error && error.message === AX_AUTH_DUPLICATE_BOT_MESSAGE
}

// 다시 로그인 1회를 기록한다. 창 안 횟수를 넘기면 고정 오류를 던진다.
// 던지기 전에 로그인하지 않으므로, 서로 끊기 싸움에 한 번 덜 끼어든다.
export function noteReloginOrThrow(tracker: AxAuthReloginTracker, now: number = Date.now()): void {
  tracker.note(now)
  if (tracker.exceeded(now)) throw new Error(AX_AUTH_DUPLICATE_BOT_MESSAGE)
}

export type AuthRecoveryFetchDeps = {
  url: string | URL
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }
  fetchImpl?: typeof fetch
  getToken: () => string
  // 저장한 토큰 버리기·같은 고정 장치로 다시 로그인·새 토큰 저장을 호출부가
  // 맡는다. 새 토큰을 돌려주면 이 함수가 같은 요청을 한 번 더 보낸다.
  relogin: () => Promise<string>
  tracker: AxAuthReloginTracker
  now?: () => number
}

// 인증 회복 fetch. 401이면 다시 로그인한 뒤 새 토큰으로 같은 요청을 한 번만
// 더 보낸다. 일반 오류(500 등)는 손대지 않고 그대로 돌려준다(호출부의 1초
// 재시도가 맡는다). 망 끊김(fetch 자체 던짐)도 그대로 던진다.
export async function fetchWithAuthRecovery(deps: AuthRecoveryFetchDeps): Promise<Response> {
  const run = deps.fetchImpl ?? fetch
  const stamp = deps.now ?? Date.now
  const send = (token: string): Promise<Response> =>
    run(deps.url.toString(), {
      ...deps.init,
      headers: { ...(deps.init.headers ?? {}), authorization: `Bearer ${token}` },
    })
  const first = await send(deps.getToken())
  if (!isMatrixAuthFailure(first.status)) return first
  noteReloginOrThrow(deps.tracker, stamp())
  const fresh = await deps.relogin()
  return send(fresh)
}

export type BotTokenRecord = {
  deviceId: string
  userId: string
  accessToken: string
}

// 다시 로그인 기록 파일(기관별 데이터 폴더 안 `nextain-ai-relogins.json`).
// 시각 목록(JSON 숫자 배열, 밀리초)을 남겨 재시작 뒤에도 창 안 기록을 잇는다.
// 쓰기는 토큰 파일과 같은 길(0600 임시 파일+rename), 읽기는 같은 권한 검사다.
export const AX_RELOGIN_HISTORY_FILE = "nextain-ai-relogins.json"

// 기록 파일이 깨졌으면 비운 것으로 보지 않고 시작 오류로 던진다. 비운 것으로
// 보면 파일을 지우거나 어지럽혀 상한을 우회하는 길이 되기 때문이다. 상한 찬
// 것으로 보는 대신 별도 문구로 던지는 까닭은, 어느 파일을 고쳐야 하는지
// 밝히려는 것이다(고정 오류 문구는 다른 곳에서 도는 봇을 뜻해 오해를 준다).
export const AX_RELOGIN_HISTORY_CORRUPT_MESSAGE = "넥스테인 AI의 다시 로그인 기록이 깨져 시작하지 않습니다."
// 다시 로그인 기록 파일 없이 토큰 파일만 있을 때의 시작 오류 문구. 기록 파일
// 유무로 최초 로그인을 가리므로 이 어긋남은 그냥 넘기지 않는다. 둘 다 지우는
// 것은 운영자 초기화로 본다(그때는 처음 로그인·횟수 0). 토큰·원문은 담지 않는다.
export const AX_AUTH_STATE_MISMATCH_MESSAGE =
  "넥스테인 AI의 다시 로그인 기록 없이 접속 기록만 있어 시작하지 않습니다."
export const AX_RELOGIN_HISTORY_SYMLINK_MESSAGE = "넥스테인 AI의 다시 로그인 기록이 심볼릭 링크라 시작하지 않습니다."
export const AX_RELOGIN_HISTORY_OWNER_MESSAGE = "넥스테인 AI의 다시 로그인 기록 소유자가 달라 시작하지 않습니다."
export const AX_RELOGIN_HISTORY_MODE_MESSAGE = "넥스테인 AI의 다시 로그인 기록 권한을 고치지 못해 시작하지 않습니다."
export const AX_RELOGIN_HISTORY_READ_MESSAGE = "넥스테인 AI의 다시 로그인 기록을 읽을 수 없습니다."

type PrivateFileMessages = {
  symlink: string
  owner: string
  mode: string
}

const TOKEN_FILE_MESSAGES: PrivateFileMessages = {
  symlink: AX_TOKEN_SYMLINK_MESSAGE,
  owner: AX_TOKEN_OWNER_MESSAGE,
  mode: AX_TOKEN_MODE_MESSAGE,
}

const HISTORY_FILE_MESSAGES: PrivateFileMessages = {
  symlink: AX_RELOGIN_HISTORY_SYMLINK_MESSAGE,
  owner: AX_RELOGIN_HISTORY_OWNER_MESSAGE,
  mode: AX_RELOGIN_HISTORY_MODE_MESSAGE,
}

// 비밀 파일을 읽기 전에 lstat으로 확인한다. 없으면 ENOENT가 난다(호출부가
// null·새로 로그인·빈 기록으로 다룬다). 심볼릭 링크·소유자 불일치·모드 고침
// 실패는 시작 거부 오류를 던진다.
async function assertPrivateFileReady(
  filePath: string,
  messages: PrivateFileMessages,
  opts?: { expectedUid?: number },
): Promise<void> {
  const st = await lstat(filePath)
  if (st.isSymbolicLink()) throw new Error(messages.symlink)
  const expected = opts?.expectedUid ?? (typeof process.getuid === "function" ? process.getuid() : st.uid)
  if (st.uid !== expected) throw new Error(messages.owner)
  if ((st.mode & 0o777) !== AX_BOT_TOKEN_FILE_MODE) {
    try {
      await chmod(filePath, AX_BOT_TOKEN_FILE_MODE)
    } catch {
      throw new Error(messages.mode)
    }
  }
}

// 토큰 파일을 읽기 전에 lstat으로 확인한다. 없으면 ENOENT가 난다(호출부가
// null·새로 로그인으로 다룬다). 심볼릭 링크·소유자 불일치·모드 고침 실패는
// 시작 거부 오류를 던진다.
export async function assertTokenFileReady(
  filePath: string,
  opts?: { expectedUid?: number },
): Promise<void> {
  await assertPrivateFileReady(filePath, TOKEN_FILE_MESSAGES, opts)
}

// 토큰 파일을 읽는다. 없거나·깨졌거나·모양이 다르면 null(호출부는 새로
// 로그인한다). 권한 문제(링크·소유자·모드 고침 실패)는 거부로 던진다.
export async function readBotTokenFile(
  filePath: string,
  opts?: { expectedUid?: number },
): Promise<BotTokenRecord | null> {
  try {
    await assertTokenFileReady(filePath, opts)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null
    throw error
  }
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return null
    throw new Error(AX_TOKEN_READ_MESSAGE)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  if (
    typeof record.deviceId !== "string" || !record.deviceId ||
    typeof record.userId !== "string" || !record.userId ||
    typeof record.accessToken !== "string" || !record.accessToken
  ) {
    return null
  }
  return { deviceId: record.deviceId, userId: record.userId, accessToken: record.accessToken }
}

// 비밀 파일을 쓴다. 임시 파일(0600)에 쓰고 rename으로 바꾼다.
export async function writePrivateFileAtomic(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  await writeFile(tmp, text, { mode: AX_BOT_TOKEN_FILE_MODE, flag: "wx" })
  try {
    await chmod(tmp, AX_BOT_TOKEN_FILE_MODE)
    await rename(tmp, filePath)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // 임시 파일 지우기 실패는 원래 오류를 가리지 않는다.
    }
    throw error
  }
}

// 토큰 파일을 쓴다. 임시 파일(0600)에 쓰고 rename으로 바꾼다.
export async function writeBotTokenFileAtomic(filePath: string, text: string): Promise<void> {
  await writePrivateFileAtomic(filePath, text)
}

function parseReloginStamps(raw: string): number[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(AX_RELOGIN_HISTORY_CORRUPT_MESSAGE)
  }
  if (
    !Array.isArray(parsed) ||
    !(parsed as unknown[]).every((value) => typeof value === "number" && Number.isInteger(value) && (value as number) > 0)
  ) {
    throw new Error(AX_RELOGIN_HISTORY_CORRUPT_MESSAGE)
  }
  return parsed as number[]
}

function pruneStamps(stamps: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs
  return stamps.filter((stamp) => stamp > cutoff)
}

// 다시 로그인 기록을 읽는다. 없으면 빈 목록(처음 기동)이다. 깨졌으면 비운
// 것으로 보지 않고 시작 오류로 던진다(우회 길이 되므로). 권한 문제도 던진다.
export async function loadReloginStamps(
  filePath: string,
  windowMs: number,
  now: number = Date.now(),
  opts?: { expectedUid?: number },
): Promise<number[]> {
  let raw: string
  try {
    await assertPrivateFileReady(filePath, HISTORY_FILE_MESSAGES, opts)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return []
    throw error
  }
  try {
    raw = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return []
    throw new Error(AX_RELOGIN_HISTORY_READ_MESSAGE)
  }
  return pruneStamps(parseReloginStamps(raw), windowMs, now)
}

// 다시 로그인 1회를 기록 파일에 남긴다. 읽기·쓰기 모두 토큰 파일과 같은
// 권한 검사·원자 쓰기다. 깨진 파일은 비우지 않고 시작 오류로 던진다.
export async function appendReloginStamp(
  filePath: string,
  now: number = Date.now(),
  windowMs: number = AX_AUTH_RELOGIN_WINDOW_MS,
  opts?: { expectedUid?: number },
): Promise<number[]> {
  let existing: number[]
  try {
    await assertPrivateFileReady(filePath, HISTORY_FILE_MESSAGES, opts)
    try {
      existing = parseReloginStamps(await readFile(filePath, "utf8"))
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") existing = []
      else throw error
    }
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") existing = []
    else throw error
  }
  const pruned = pruneStamps(existing, windowMs, now)
  pruned.push(now)
  await writePrivateFileAtomic(filePath, `${JSON.stringify(pruned)}\n`)
  return pruned
}

export type DataDirDecision = "ok" | "group-writable" | "world-writable"

// 데이터 폴더 모드 판정. 세계 쓰기(다른 사용자 쓰기)는 거부한다: 폴더에
// 쓸 수 있으면 토큰 파일을 바꿔치기할 수 있어 0600이 소용없어진다.
// 함께 쓰기(그룹 쓰기)는 같은 운영 팀 나눔으로 보고 경고만 남긴다: 묶음
// 볼륨·기본 umask 환경에서 거부하면 봇이 뜨지 않으므로, 토큰 파일 0600이
// 내용을 지키는 동안은 경고로 둔다.
export function checkDataDirMode(mode: number): DataDirDecision {
  if ((mode & 0o002) !== 0) return "world-writable"
  if ((mode & 0o020) !== 0) return "group-writable"
  return "ok"
}

export async function checkDataDirReady(dirPath: string): Promise<DataDirDecision> {
  try {
    return checkDataDirMode((await lstat(dirPath)).mode)
  } catch (error) {
    // 폴더가 아직 없으면 물을 것이 없다(호출부가 만든다).
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return "ok"
    throw error
  }
}

// 시작 때 저장 토큰 확인(`whoami`) 판정. 401일 때만 토큰 무효다. 5xx·연결
// 실패·본문 깨짐은 저장 토큰을 지키고 일반 재시도로 다룰 "모름"이다.
export type SavedTokenVerdict = "valid" | "invalid" | "unknown"

export async function checkSavedToken(
  fetchImpl: typeof fetch,
  whoamiUrl: string,
  token: string,
  expectedUserId: string,
): Promise<SavedTokenVerdict> {
  let response: Response
  try {
    response = await fetchImpl(whoamiUrl, { headers: { authorization: `Bearer ${token}` } })
  } catch {
    return "unknown"
  }
  if (response.status === 401) return "invalid"
  if (!response.ok) return "unknown"
  try {
    const who = (await response.json()) as { user_id?: unknown } | null
    return who?.user_id === expectedUserId ? "valid" : "invalid"
  } catch {
    return "unknown"
  }
}

// 시작 확인 재시도 상한. "모름"이면 물러나며(1초·2초·4초·8초) 다시 묻고,
// 그래도 모르면 다시 로그인하지 않고 시작 오류로 끝낸다.
export const AX_AUTH_START_PROBE_ATTEMPTS = 5
export const AX_AUTH_START_PROBE_BASE_DELAY_MS = 1_000
export const AX_AUTH_START_PROBE_MESSAGE =
  "넥스테인 AI의 접속 확인이 되지 않아 다시 로그인하지 않고 시작하지 않습니다."

export async function probeSavedToken(deps: {
  fetchImpl?: typeof fetch
  whoamiUrl: string
  token: string
  expectedUserId: string
  attempts?: number
  baseDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<SavedTokenVerdict> {
  const run = deps.fetchImpl ?? fetch
  const attempts = deps.attempts ?? AX_AUTH_START_PROBE_ATTEMPTS
  const baseDelayMs = deps.baseDelayMs ?? AX_AUTH_START_PROBE_BASE_DELAY_MS
  const sleep = deps.sleep ?? sleepMs
  let verdict: SavedTokenVerdict = "unknown"
  for (let attempt = 0; attempt < attempts; attempt++) {
    verdict = await checkSavedToken(run, deps.whoamiUrl, deps.token, deps.expectedUserId)
    if (verdict !== "unknown") return verdict
    if (attempt + 1 < attempts) await sleep(baseDelayMs * 2 ** attempt)
  }
  return verdict
}

export type StartAuthLogin = (kind: "fresh" | "relogin") => Promise<{ userId: string; accessToken: string }>

export type PerformStartAuthDeps = {
  tokenPath: string
  historyPath: string
  deviceId: string
  expectedUserId: string
  whoamiUrl: string
  policy: AxAuthReloginPolicy
  fetchImpl?: typeof fetch
  login: StartAuthLogin
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  probeAttempts?: number
  probeBaseDelayMs?: number
}

export type StartAuthResult = {
  // reused: 저장 토큰 유효. fresh: 토큰 파일이 없어 처음 로그인(횟수에 안 셈).
  // relogin: 저장 토큰이 401이라 다시 로그인(횟수에 셈).
  status: "reused" | "fresh" | "relogin"
  tracker: AxAuthReloginTracker
  userId: string
  accessToken: string
}

// 파일이 있는지만 본다. 없으면(ENOENT) false다. 권한 문제(링크·소유자·모드)는
// 호출부의 읽기 함수가 같은 검사로 던지므로 여기서는 lstat 실패를 그대로 던진다.
async function fileExistsAt(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath)
    return true
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return false
    throw error
  }
}

// 시작 인증 한 번. "최초 로그인"은 토큰 파일 유무가 아니라 다시 로그인 기록
// 파일 유무로 가른다. 기록 파일이 없으면: 토큰 파일도 없을 때만 처음 로그인
// 직전에 기록 파일을 빈 목록으로 만들고 처음 로그인한다(세지 않음, 횟수 0).
// 토큰 파일만 있으면 어긋난 상태이므로 시작 오류로 끝난다(둘 다 지우는 것은
// 운영자 초기화로 본다). 기록 파일이 있으면: 토큰이 없든·깨졌든·401이든 모든
// 로그인을 로그인 전에 기록하고 상한에 넣는다(상한 초과면 로그인 전에 고정
// 오류). 저장 토큰이 유효하면 재사용한다(로그인이 아니므로 기록하지 않음).
// 5xx·연결 실패면 저장 토큰을 지킨 채 물러나며 다시 묻고, 상한을 넘기면 로그인
// 없이 시작 오류로 끝난다. 토큰·내부 원문은 담지 않는다.
export async function performStartAuth(deps: PerformStartAuthDeps): Promise<StartAuthResult> {
  const nowFn = deps.now ?? Date.now
  const loadedAt = nowFn()
  const tracker = new AxAuthReloginTracker(deps.policy.windowMs, deps.policy.maxCount)
  for (const stamp of await loadReloginStamps(deps.historyPath, deps.policy.windowMs, loadedAt)) {
    tracker.note(stamp)
  }
  const historyExists = await fileExistsAt(deps.historyPath)
  const saved = await readBotTokenFile(deps.tokenPath)
  if (!historyExists) {
    if (saved || (await fileExistsAt(deps.tokenPath))) {
      throw new Error(AX_AUTH_STATE_MISMATCH_MESSAGE)
    }
    await writePrivateFileAtomic(deps.historyPath, "[]\n")
    const fresh = await deps.login("fresh")
    await writePrivateFileAtomic(
      deps.tokenPath,
      `${JSON.stringify({ deviceId: deps.deviceId, userId: fresh.userId, accessToken: fresh.accessToken })}\n`,
    )
    return { status: "fresh", tracker, userId: fresh.userId, accessToken: fresh.accessToken }
  }
  if (
    saved &&
    saved.deviceId === deps.deviceId &&
    saved.userId === deps.expectedUserId &&
    saved.accessToken
  ) {
    const verdict = await probeSavedToken({
      fetchImpl: deps.fetchImpl,
      whoamiUrl: deps.whoamiUrl,
      token: saved.accessToken,
      expectedUserId: deps.expectedUserId,
      attempts: deps.probeAttempts,
      baseDelayMs: deps.probeBaseDelayMs,
      sleep: deps.sleep,
    })
    if (verdict === "valid") {
      return { status: "reused", tracker, userId: saved.userId, accessToken: saved.accessToken }
    }
    if (verdict === "invalid") {
      const stamp = nowFn()
      noteReloginOrThrow(tracker, stamp)
      await appendReloginStamp(deps.historyPath, stamp, deps.policy.windowMs)
      const fresh = await deps.login("relogin")
      await writePrivateFileAtomic(
        deps.tokenPath,
        `${JSON.stringify({ deviceId: deps.deviceId, userId: fresh.userId, accessToken: fresh.accessToken })}\n`,
      )
      return { status: "relogin", tracker, userId: fresh.userId, accessToken: fresh.accessToken }
    }
    throw new Error(AX_AUTH_START_PROBE_MESSAGE)
  }
  const stamp = nowFn()
  noteReloginOrThrow(tracker, stamp)
  await appendReloginStamp(deps.historyPath, stamp, deps.policy.windowMs)
  const relogin = await deps.login("relogin")
  await writePrivateFileAtomic(
    deps.tokenPath,
    `${JSON.stringify({ deviceId: deps.deviceId, userId: relogin.userId, accessToken: relogin.accessToken })}\n`,
  )
  return { status: "relogin", tracker, userId: relogin.userId, accessToken: relogin.accessToken }
}
