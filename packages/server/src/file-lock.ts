import fs from "node:fs"
import path from "node:path"
import process from "node:process"

export class FileLockTimeoutError extends Error {
  constructor(message = "Lock timeout") {
    super(message)
    this.name = "FileLockTimeoutError"
  }
}

const inProcessLocks = new Map<string, Promise<void>>()

/**
 * 대상 파일 단위 파일 잠금 (<targetFilePath>.lock).
 * 서버와 CLI가 똑같은 규칙으로 사용:
 * - O_CREAT | O_EXCL 로 잠금 파일을 생성 (내용은 pid와 ISO 시각)
 * - 이미 존재하면 50ms 간격으로 최대 2초 재시도
 * - 잠금 파일 수정 시각이 30초보다 오래되었으면 stale로 간주하여 지우고 재시도
 * - 타임아웃 시 FileLockTimeoutError 발생 (서버는 409 { error: "changed" })
 * - finally 블록에서 잠금 파일 해제 (unlink)
 * - 동일 프로세스 내 동시 호출도 순차 실행 보장 (Promise 체인)
 */
export async function withFileLock<T>(
  targetFilePath: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const prev = inProcessLocks.get(targetFilePath) ?? Promise.resolve()
  let release: () => void
  const current = new Promise<void>((r) => {
    release = r
  })
  inProcessLocks.set(targetFilePath, prev.then(() => current, () => current))

  try {
    await prev

    const lockFilePath = `${targetFilePath}.lock`
    const dir = path.dirname(lockFilePath)
    fs.mkdirSync(dir, { recursive: true })

    const timeoutMs = 2000
    const retryIntervalMs = 50
    const staleThresholdMs = 30000
    const startTime = Date.now()

    let acquired = false
    while (!acquired) {
      try {
        const fd = fs.openSync(
          lockFilePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o644,
        )
        try {
          fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
        } finally {
          fs.closeSync(fd)
        }
        acquired = true
      } catch (err: any) {
        if (err?.code === "EEXIST") {
          try {
            const stat = fs.statSync(lockFilePath)
            if (Date.now() - stat.mtimeMs > staleThresholdMs) {
              try {
                fs.unlinkSync(lockFilePath)
              } catch {}
              continue
            }
          } catch {}

          if (Date.now() - startTime >= timeoutMs) {
            throw new FileLockTimeoutError(`Lock timeout on ${lockFilePath}`)
          }

          await new Promise((r) => setTimeout(r, retryIntervalMs))
        } else {
          throw err
        }
      }
    }

    try {
      return await fn()
    } finally {
      try {
        fs.unlinkSync(lockFilePath)
      } catch {}
    }
  } finally {
    release!()
    if (inProcessLocks.get(targetFilePath) === current) {
      inProcessLocks.delete(targetFilePath)
    }
  }
}
