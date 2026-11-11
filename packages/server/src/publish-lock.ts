import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { FileLockTimeoutError } from "./file-lock.js"

const heldLocks = new AsyncLocalStorage<Map<string, { active: boolean }>>()

// 존재하지 않는 저장 대상도 가장 가까운 실제 부모를 기준으로 검사한다.
function projectedRealPath(value: string): string {
  let current = path.resolve(value)
  const missing: string[] = []
  while (true) {
    try { return path.join(fs.realpathSync.native(current), ...missing) } catch (error: any) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return path.resolve(value)
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(value)
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

function insideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** 문서 출처의 별칭·링크와 무관하게 승인 보관소와 서명키를 숨긴다. */
export function isPublishPrivatePath(targetPath: string): boolean {
  const candidate = path.resolve(targetPath)
  const realCandidate = projectedRealPath(candidate)
  const stateDir = process.env.PUBLISH_STATE_DIR?.trim()
  if (stateDir && (insideOrEqual(candidate, path.resolve(stateDir)) || insideOrEqual(realCandidate, projectedRealPath(stateDir)))) return true
  const keyFile = process.env.PUBLISH_SIGNING_KEY_FILE?.trim()
  return !!keyFile && (candidate === path.resolve(keyFile) || realCandidate === projectedRealPath(keyFile))
}

function sameInode(first: fs.Stats, second: fs.Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

function secureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || fs.realpathSync.native(directory) !== directory) {
    throw new Error("게시 잠금 폴더의 실제 경로를 확인할 수 없습니다.")
  }
}

function acquireKernelLock(fd: number, waitSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // flock은 상속한 열린 파일 설명자에 잠금을 건다. 자식 종료 뒤에도 부모의
    // 같은 설명자가 잠금을 유지하며, 부모 중단 시 커널이 즉시 회수한다.
    const child = spawn("flock", ["--exclusive", "--timeout", String(waitSeconds), "--conflict-exit-code", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 6_000,
      killSignal: "SIGKILL",
    })
    child.once("error", () => reject(new Error("게시 잠금에 필요한 flock을 실행할 수 없습니다.")))
    child.once("exit", (code) => {
      if (code === 0) resolve()
      else if (code === 75) reject(new FileLockTimeoutError("게시 자료를 다른 요청에서 처리 중입니다."))
      else reject(new Error("게시 잠금을 확보하지 못했습니다."))
    })
  })
}

/** 문서·그림·설정·승인을 프로세스 사이에서도 같은 잠금으로 직렬화한다. */
export async function withPublishLock<T>(
  fn: () => Promise<T> | T,
  stateDir: string | undefined = process.env.PUBLISH_STATE_DIR,
  waitSeconds = 5,
): Promise<T> {
  if (!stateDir?.trim()) return fn()
  const directory = path.resolve(stateDir)
  const inherited = heldLocks.getStore()
  if (inherited?.get(directory)?.active) return fn()
  secureDirectory(directory)
  const lockDirectory = path.join(directory, "locks")
  secureDirectory(lockDirectory)
  const lockPath = path.join(lockDirectory, "bundle.lock")
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1) throw new Error("게시 잠금 파일이 올바르지 않습니다.")
    await acquireKernelLock(fd, waitSeconds)
    const token = crypto.randomUUID()
    const checkName = () => {
      const named = fs.lstatSync(lockPath)
      if (!named.isFile() || named.nlink !== 1 || !sameInode(opened, named)
        || fs.realpathSync.native(lockDirectory) !== lockDirectory
        || fs.realpathSync.native(directory) !== directory) throw new Error("게시 잠금 파일의 연결이 바뀌었습니다.")
    }
    checkName()
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }), 0, "utf8")
    fs.fsyncSync(fd)
    const ownership = { active: true }
    const context = new Map(inherited)
    context.set(directory, ownership)
    try {
      const result = await heldLocks.run(context, fn)
      checkName()
      const owner = JSON.parse(fs.readFileSync(fd, "utf8"))
      if (owner.token !== token) throw new Error("게시 잠금의 소유자가 바뀌었습니다.")
      return result
    } finally {
      ownership.active = false
    }
  } finally {
    // 잠금 이름을 지우거나 오래된 PID로 판정하지 않는다. 다른 요청의 inode를
    // 지울 수 없고, 중단한 소유자의 커널 잠금은 파일 시각과 무관하게 해제된다.
    fs.closeSync(fd)
  }
}
