import fs from "node:fs"
import path from "node:path"
import os from "node:os"

export default function globalSetup() {
  // 1. 준비 단계: 새 임시 폴더를 만들어 환경변수에 주입
  const isolatedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "adk-test-xdg-runtime-"))
  const isolatedLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "adk-test-localapp-"))

  process.env.XDG_RUNTIME_DIR = isolatedRuntimeDir
  process.env.LOCALAPPDATA = isolatedLocalAppData

  // 2. 정리용 경로를 변수에 고정 (끝날 때 process.env.XDG_RUNTIME_DIR를 다시 읽지 않음)
  const dirsToClean = [isolatedRuntimeDir, isolatedLocalAppData]

  return async () => {
    // 3. 고정된 변수의 경로만 검증 후 정리
    for (const dirPath of dirsToClean) {
      const resolvedPath = path.resolve(dirPath)
      const resolvedTmp = path.resolve(os.tmpdir())

      // 지우기 전에 그 경로가 os.tmpdir() 아래이고 /run/user/로 시작하지 않는지 확인
      const isUnderTmp = resolvedPath.startsWith(resolvedTmp + path.sep) || resolvedPath === resolvedTmp
      const startsWithRunUser = resolvedPath.startsWith("/run/user/")

      if (!isUnderTmp || startsWithRunUser) {
        throw new Error(
          `임시 폴더 격리 위반: ${resolvedPath}는 os.tmpdir() 아래가 아니거나 /run/user/로 시작합니다. 안전을 위해 삭제를 중단하고 실패 처리합니다.`
        )
      }

      try {
        fs.rmSync(resolvedPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}
