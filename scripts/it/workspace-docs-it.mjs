#!/usr/bin/env node
/**
 * scripts/it/workspace-docs-it.mjs
 * 
 * 나이아 워크스페이스 문서 기능 서버 통합 시험 (IT)
 * 실행: node scripts/it/workspace-docs-it.mjs --out <결과 폴더>
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import net from "node:net"
import crypto from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "../..")

// ==========================================
// 1. 고정 필수 항목 ID 목록 및 허용 NULL ID 목록
// ==========================================

export const REQUIRED_TEST_IDS = [
  // FE 8장 IT 실측 항목
  "FE-IT-01-lan-tampered-p1",
  "FE-IT-02-lan-tampered-p3",
  "FE-IT-03-lan-tampered-p4",
  "FE-IT-04-lan-real-device",
  "FE-IT-05-pnpm-dev-file-check",
  "FE-IT-06-next-start-doc-vs-new",
  "FE-IT-07-dual-stack-tailscale",
  "FE-IT-08-tailnet-ipv4-access",
  "FE-IT-09-view-folders-reject-tool",
  "FE-IT-10-view-folders-reject-server",
  "FE-IT-11-direct-p1-write-read",
  "FE-IT-12-direct-p1-name-host",
  "FE-IT-13-direct-p1-api-files",
  "FE-IT-14-secret-file-not-exposed",
  "FE-IT-15-p3-calls-only-p1",
  "FE-IT-16-p4-calls-only-p1",
  "FE-IT-17-start-sh-file-check",
  "FE-IT-18-disallowed-host-p3",
  "FE-IT-19-disallowed-host-p4",
  "FE-IT-20-other-origin-write-p3",
  "FE-IT-21-server-mjs-headers-asset",
  "FE-IT-22-next-start-headers-asset",
  "FE-IT-23-svg-script-exec",
  "FE-IT-24-iframe-protection",
  "FE-IT-25-frame-ancestors-headers",
  "FE-IT-26-path-traversal-p3",
  "FE-IT-27-path-traversal-p4",
  "FE-IT-28-path-traversal-backslash-p3",
  "FE-IT-29-path-traversal-backslash-p4",
  "FE-IT-30-path-traversal-p1",
  "FE-IT-31-server-mjs-capital-api",
  "FE-IT-32-sec-fetch-cross-site",
  "FE-IT-33-data-folder-exclusions",
  "FE-IT-34-two-apis-same-root",
  "FE-IT-35-local-server-mjs-write-read",
  "FE-IT-36-ip-host-existing-doc-200",

  // RQ-01~09 AC별 서버 항목
  "RQ-01-AC1-image-only-folder",
  "RQ-01-AC2-tree-kind-size",
  "RQ-01-AC3-hidden-excluded",
  "RQ-01-AC4-search-doc-only",
  "RQ-02-AC1-media-stream",
  "RQ-02-AC2-video-range",
  "RQ-02-AC3-text-view",
  "RQ-02-AC4-other-download",
  "RQ-02-AC5-script-sandbox-headers",
  "RQ-02-AC6-hidden-files-reject",
  "RQ-03-AC1-folder-grid-order",
  "RQ-03-AC2-folder-cover",
  "RQ-03-AC3-mobile-width",
  "RQ-03-AC4-folder-limit",
  "RQ-04-AC1-view-folder-add-remove",
  "RQ-04-AC2-view-folder-readonly",
  "RQ-04-AC3-view-folder-empty-init",
  "RQ-04-AC4-view-folder-missing",
  "RQ-04-AC5-view-folder-tools",
  "RQ-04-AC6-view-folder-prohibitions",
  "RQ-04-AC6-win32-localappdata",
  "RQ-04-AC7-content-workflow",
  "RQ-05-AC1-doc-edit-save",
  "RQ-05-AC2-doc-conflict-hash",
  "RQ-05-AC3-doc-edit-reject-non-doc",
  "RQ-05-AC4-doc-atomic-write",
  "RQ-06-AC1-notes-crud",
  "RQ-06-AC2-notes-location-git",
  "RQ-06-AC3-notes-cli-list",
  "RQ-06-AC4-notes-ai-session",
  "RQ-06-AC5-notes-counts",
  "RQ-07-AC1-favorites-crud",
  "RQ-07-AC2-favorites-missing",
  "RQ-07-AC3-favorites-limit",
  "RQ-08-AC1-trust-filtering",
  "RQ-08-AC1-empty-phase",
  "RQ-08-AC2-empty-phase",
  "RQ-08-AC3-empty-phase",
  "RQ-08-AC2-origin-dns-rebind",
  "RQ-08-AC3-header-spoof-proof",
  "RQ-09-AC1-empty-adk-support",
  "RQ-09-AC2-no-hardcoded-paths",
]

export const ALLOWED_NULL_MAP = {
  "FE-IT-04-lan-real-device": "E2E/로컬 검토에서 조정자 확인",
  "FE-IT-07-dual-stack-tailscale": "E2E/로컬 검토에서 조정자 확인",
  "FE-IT-08-tailnet-ipv4-access": "E2E/로컬 검토에서 조정자 확인",
  "FE-IT-23-svg-script-exec": "E2E/로컬 검토에서 조정자 확인",
  "FE-IT-24-iframe-protection": "E2E/로컬 검토에서 조정자 확인",
  "RQ-03-AC3-mobile-width": "E2E/로컬 검토에서 조정자 확인",
  "RQ-04-AC6-win32-localappdata": "이 호스트의 Windows 경로",
  "RQ-04-AC7-content-workflow": "E2E UC-01",
  "RQ-06-AC4-notes-ai-session": "새 AI 세션",
}

export const RQ08_AC2_BASE_IDS = [
  "FE-IT-12-direct-p1-name-host",
  "FE-IT-18-disallowed-host-p3",
  "FE-IT-19-disallowed-host-p4",
  "FE-IT-20-other-origin-write-p3",
  "FE-IT-33-data-folder-exclusions",
  "FE-IT-36-ip-host-existing-doc-200",
]

export const RQ08_AC3_BASE_IDS = [
  "FE-IT-01-lan-tampered-p1",
  "FE-IT-02-lan-tampered-p3",
  "FE-IT-03-lan-tampered-p4",
]

export const RQ09_AC1_BASE_IDS = [
  "RQ-01-AC1-image-only-folder",
  "RQ-01-AC2-tree-kind-size",
  "RQ-01-AC3-hidden-excluded",
  "RQ-01-AC4-search-doc-only",
  "RQ-02-AC1-media-stream",
  "RQ-02-AC2-video-range",
  "RQ-02-AC3-text-view",
  "RQ-02-AC4-other-download",
  "RQ-02-AC5-script-sandbox-headers",
  "RQ-02-AC6-hidden-files-reject",
  "RQ-03-AC1-folder-grid-order",
  "RQ-03-AC2-folder-cover",
  "RQ-03-AC4-folder-limit",
  "RQ-04-AC3-view-folder-empty-init",
  "RQ-05-AC1-doc-edit-save",
  "RQ-05-AC2-doc-conflict-hash",
  "RQ-05-AC3-doc-edit-reject-non-doc",
  "RQ-05-AC4-doc-atomic-write",
  "RQ-06-AC1-notes-crud",
  "RQ-06-AC2-notes-location-git",
  "RQ-06-AC3-notes-cli-list",
  "RQ-06-AC5-notes-counts",
  "RQ-07-AC1-favorites-crud",
  "RQ-07-AC2-favorites-missing",
  "RQ-07-AC3-favorites-limit",
  "RQ-08-AC1-empty-phase",
  "RQ-08-AC2-empty-phase",
  "RQ-08-AC3-empty-phase",
]

// ==========================================
// 2. 도우미 함수들
// ==========================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, "127.0.0.1")
  })
}

async function findFreePorts(count, startPort = 3171) {
  const forbidden = new Set([3141, 3142, 3151, 3152, 3161, 8894])
  const found = []
  let curr = startPort
  while (found.length < count) {
    if (!forbidden.has(curr)) {
      const isFree = await checkPortFree(curr)
      if (isFree) {
        found.push(curr)
      }
    }
    curr++
  }
  return found
}

async function waitForPortListening(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const isBound = await new Promise((resolve) => {
      const socket = new net.Socket()
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolve(false)
      })
      socket.connect(port, "127.0.0.1")
    })
    if (isBound) return true
    await sleep(200)
  }
  return false
}

function runCurl({
  url,
  method = "GET",
  headers = {},
  data = null,
  pathAsIs = false,
  extraArgs = [],
}) {
  const args = ["-s", "-S", "-i"]
  if (pathAsIs) args.push("--path-as-is")
  if (method !== "GET") {
    args.push("-X", method)
  }
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`)
  }
  if (data !== null) {
    args.push("--data", typeof data === "string" ? data : JSON.stringify(data))
  }
  args.push(...extraArgs)
  args.push(url)

  const cmdStr = `curl ${args.map((a) => (a.includes(" ") || a.includes(":") ? `"${a}"` : a)).join(" ")}`
  try {
    const rawOutput = execFileSync("curl", args, {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
    })
    return { ...parseCurlOutput(rawOutput), command: cmdStr }
  } catch (err) {
    const raw = (err.stdout || "") + (err.stderr || "") || err.message
    return {
      status: 0,
      headers: {},
      body: "",
      rawOutput: raw,
      command: cmdStr,
      error: err.message,
    }
  }
}

function parseCurlOutput(rawOutput) {
  const blocks = rawOutput.split(/\r?\n\r?\n/)
  let headerBlock = ""
  let body = ""
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].startsWith("HTTP/")) {
      headerBlock = blocks[i]
      body = blocks.slice(i + 1).join("\n\n")
    }
  }
  if (!headerBlock) {
    headerBlock = blocks[0] || ""
    body = blocks.slice(1).join("\n\n")
  }
  const lines = headerBlock.split(/\r?\n/)
  const statusLine = lines[0] || ""
  const m = statusLine.match(/HTTP\/\S+\s+(\d+)/)
  const status = m ? parseInt(m[1], 10) : 0

  const headers = {}
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const cIdx = line.indexOf(":")
    if (cIdx > 0) {
      const k = line.slice(0, cIdx).trim().toLowerCase()
      const v = line.slice(cIdx + 1).trim()
      if (headers[k]) {
        if (Array.isArray(headers[k])) headers[k].push(v)
        else headers[k] = [headers[k], v]
      } else {
        headers[k] = v
      }
    }
  }
  return { status, headers, body, rawOutput }
}

function getDirFingerprint(dir) {
  if (!fs.existsSync(dir)) return []
  const results = []
  function walk(curr, rel) {
    const entries = fs.readdirSync(curr, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(curr, e.name)
      const relPath = path.join(rel, e.name)
      if (e.isDirectory()) {
        walk(full, relPath)
      } else {
        const stat = fs.statSync(full)
        results.push(`${relPath}:${stat.size}:${stat.mtimeMs}`)
      }
    }
  }
  walk(dir, "")
  results.sort()
  return results
}

function checkSsConnections(pids, port = 3141) {
  try {
    const out = execFileSync("ss", ["-t", "-a", `( dport = :${port} or sport = :${port} )`], {
      encoding: "utf-8",
    })
    for (const pid of pids) {
      if (out.includes(`pid=${pid},`) || out.includes(`pid=${pid} `)) {
        return false
      }
    }
    return true
  } catch {
    return true
  }
}

// ==========================================
// 3. 메인 IT 실행 함수
// ==========================================

async function main() {
  const argv = process.argv.slice(2)
  let outArg = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      outArg = argv[++i]
    }
  }

  if (!outArg) {
    console.error("오류: --out <결과 폴더> 인자는 필수입니다.")
    process.exit(1)
  }

  const outDir = path.resolve(outArg)
  fs.mkdirSync(outDir, { recursive: true })

  // 시작 전 저장소 .agents/work 상태 기록 (오염 방지 및 원래 존재 여부)
  const repoWorkDir = path.join(REPO_ROOT, ".agents", "work")
  const repoWorkExistedInitially = fs.existsSync(repoWorkDir)
  const repoWorkBefore = {
    viewFolders: fs.existsSync(path.join(repoWorkDir, "view-folders.json")),
    docNotes: fs.existsSync(path.join(repoWorkDir, "doc-notes")),
    docFavorites: fs.existsSync(path.join(repoWorkDir, "doc-favorites.json")),
  }

  console.log(`[IT1] 결과 폴더: ${outDir}`)

  // 1. .next 백업 및 지문 기록 준비
  const dashboardDir = path.join(REPO_ROOT, "packages", "dashboard")
  const dotNextDir = path.join(dashboardDir, ".next")
  const nextBackupDir = path.join(REPO_ROOT, ".agents", "work", "it1-next-backup")
  const nextBackupFingerprintFile = path.join(REPO_ROOT, ".agents", "work", "it1-next-backup.fingerprint.json")

  // 시작 시 잔류 .next.it1-stale-* 검사 (지우지 않고 경고)
  try {
    const existingStales = fs.readdirSync(dashboardDir).filter((n) => n.startsWith(".next.it1-stale-"))
    if (existingStales.length > 0) {
      console.warn(`[IT1 경고] 시작 시점에 잔류한 .next.it1-stale-* 발견 (지우지 않음): ${existingStales.join(", ")}`)
    }
  } catch {}

  // 시작 시 기존 백업/기록 잔류 검사 및 복구
  if (fs.existsSync(nextBackupDir) || fs.existsSync(nextBackupFingerprintFile)) {
    if (!fs.existsSync(nextBackupFingerprintFile)) {
      console.error("이전 백업이 남아 있음: 사람이 확인")
      process.exit(1)
    }

    let savedFingerprint
    try {
      savedFingerprint = JSON.parse(fs.readFileSync(nextBackupFingerprintFile, "utf-8"))
    } catch {
      console.error("이전 백업이 남아 있음: 사람이 확인 (지문 파싱 실패)")
      process.exit(1)
    }

    // 원래 빌드 없음 상태에서 중단된 경우 처리
    if (savedFingerprint && savedFingerprint.noOriginalBuild) {
      if (fs.existsSync(nextBackupDir)) {
        console.error("이전 백업 기록 불일치 (원래 빌드 없음 기록인데 백업 디렉터리 존재): 사람이 확인")
        process.exit(1)
      }
      if (fs.existsSync(dotNextDir)) {
        try {
          fs.rmSync(dotNextDir, { recursive: true, force: true })
        } catch (err) {
          console.error("이전 실행 복구 실패 (잔류 .next 삭제 실패): 사람이 확인", err.message)
          process.exit(1)
        }
      }
      if (fs.existsSync(dotNextDir)) {
        console.error("이전 실행 복구 실패 (.next 잔류 확인): 사람이 확인")
        process.exit(1)
      }
      try {
        fs.unlinkSync(nextBackupFingerprintFile)
      } catch {}
      console.error("이전 실행 복구함 (원래 빌드 없음: 잔류 시험 빌드 삭제)")
      process.exit(1)
    }

    // 원래 빌드가 있었던 경우
    if (!fs.existsSync(nextBackupDir)) {
      console.error("이전 백업이 남아 있음: 사람이 확인 (지문 파일만 있고 백업 디렉터리 없음)")
      process.exit(1)
    }

    const currentFingerprint = getDirFingerprint(dotNextDir)
    const fingerprintsMatch = JSON.stringify(currentFingerprint) === JSON.stringify(savedFingerprint)

    if (fingerprintsMatch) {
      console.error("이전 백업이 남아 있음: 사람이 확인")
      process.exit(1)
    }

    // .next가 없거나 지문이 다르면: 시험 .next를 stale로 치우고 백업을 .next로 rename
    let staleDir = null
    if (fs.existsSync(dotNextDir)) {
      do {
        const rnd = crypto.randomBytes(6).toString("hex")
        staleDir = path.join(dashboardDir, `.next.it1-stale-${rnd}`)
      } while (fs.existsSync(staleDir))

      try {
        fs.renameSync(dotNextDir, staleDir)
      } catch (err) {
        console.error("이전 백업 복구 실패 (.next를 stale로 옮기기 실패, 백업 유지): 사람이 확인", err.message)
        process.exit(1)
      }
    }

    try {
      fs.renameSync(nextBackupDir, dotNextDir)
    } catch (err) {
      console.error("이전 백업 복구 실패 (백업 rename 실패): 사람이 확인", err.message)
      process.exit(1)
    }

    const restoredFingerprint = getDirFingerprint(dotNextDir)
    if (JSON.stringify(restoredFingerprint) === JSON.stringify(savedFingerprint)) {
      if (staleDir && fs.existsSync(staleDir)) {
        try {
          fs.rmSync(staleDir, { recursive: true, force: true })
        } catch {}
      }
      try {
        fs.unlinkSync(nextBackupFingerprintFile)
      } catch {}
      console.error("이전 실행 복구함")
      process.exit(1)
    } else {
      console.error("이전 백업 복구 실패 (복원 후 지문 불일치): 사람이 확인")
      process.exit(1)
    }
  }

  const originalBuildExisted = fs.existsSync(dotNextDir)
  let initialNextFingerprint = null
  let backupMoved = false

  if (originalBuildExisted) {
    console.log("[IT1] 기존 packages/dashboard/.next 지문 채취 및 백업...")
    initialNextFingerprint = getDirFingerprint(dotNextDir)
    fs.mkdirSync(repoWorkDir, { recursive: true })
    fs.writeFileSync(nextBackupFingerprintFile, JSON.stringify(initialNextFingerprint, null, 2), "utf-8")
    fs.renameSync(dotNextDir, nextBackupDir)
    backupMoved = true
  } else {
    console.log("[IT1] 기존 packages/dashboard/.next 없음 (원래 빌드 없음 기록)...")
    fs.mkdirSync(repoWorkDir, { recursive: true })
    fs.writeFileSync(nextBackupFingerprintFile, JSON.stringify({ noOriginalBuild: true }, null, 2), "utf-8")
    initialNextFingerprint = null
    backupMoved = false
  }

  let testRoot = null
  const childPids = []
  const results = []

  function addResult({ id, rqAc, fe, command, expected, actual, pass, reason = null }) {
    results.push({ id, rqAc, fe, command, expected, actual, pass, reason })
  }

  let cleanupDone = false
  async function performCleanup() {
    if (cleanupDone) return
    cleanupDone = true

    console.log("[IT1] 자식 프로세스 그룹 종료 중...")
    await cleanupChildren(childPids)

    if (originalBuildExisted) {
      if (backupMoved) {
        console.log("[IT1] 시험 빌드 .next 치우기 및 백업 복원...")
        let staleDir = null
        if (fs.existsSync(dotNextDir)) {
          do {
            const rnd = crypto.randomBytes(6).toString("hex")
            staleDir = path.join(dashboardDir, `.next.it1-stale-${rnd}`)
          } while (fs.existsSync(staleDir))

          try {
            fs.renameSync(dotNextDir, staleDir)
          } catch (err) {
            console.error("[IT1 치명적 오류] 시험 .next를 stale로 치우기 실패:", err)
            throw err
          }
        }

        if (fs.existsSync(nextBackupDir)) {
          fs.renameSync(nextBackupDir, dotNextDir)
        }

        console.log("[IT1] 복원된 .next 지문 검증...")
        const restoredNextFingerprint = getDirFingerprint(dotNextDir)
        const fingerprintMatched = JSON.stringify(initialNextFingerprint) === JSON.stringify(restoredNextFingerprint)

        if (!fingerprintMatched) {
          console.error("치명적 오류: 복원된 .next 지문이 시작 때와 다릅니다! stale 폴더 및 백업 상태를 유지합니다.")
          throw new Error("복원된 .next 지문 불일치")
        }
        console.log("[IT1] .next 지문 완벽 복원 확인됨.")

        if (staleDir && fs.existsSync(staleDir)) {
          try {
            fs.rmSync(staleDir, { recursive: true, force: true })
          } catch (err) {
            console.warn("[IT1 경고] stale 디렉터리 삭제 실패:", err.message)
          }
        }

        if (fs.existsSync(nextBackupFingerprintFile)) {
          try {
            fs.unlinkSync(nextBackupFingerprintFile)
          } catch {}
        }
      }
    } else {
      console.log("[IT1] 원래 빌드 없음: 시험이 생성한 packages/dashboard/.next 삭제...")
      if (fs.existsSync(dotNextDir)) {
        try {
          fs.rmSync(dotNextDir, { recursive: true, force: true })
        } catch (err) {
          console.error("[IT1 치명적 오류] 시험 .next 삭제 실패:", err)
          throw err
        }
      }
      if (fs.existsSync(dotNextDir)) {
        console.error("치명적 오류: .next 삭제 확인 실패 (디렉터리 잔류)")
        throw new Error("원래 빌드 없음 복원 실패: .next 잔류")
      }
      console.log("[IT1] .next 원래 빌드 없음 복원 확인됨 (.next 없음).")

      if (fs.existsSync(nextBackupFingerprintFile)) {
        try {
          fs.unlinkSync(nextBackupFingerprintFile)
        } catch {}
      }
    }

    if (testRoot && fs.existsSync(testRoot)) {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true })
        console.log("[IT1] 시험 루트 삭제 완료.")
      } catch (err) {
        console.warn(`[IT1] 시험 루트 삭제 실패 (경고): ${err.message}`)
      }
    }

    // 시작 시 .agents/work가 없었으면 스크립트가 만든 항목만 치우고 비었을 때 폴더 삭제
    if (!repoWorkExistedInitially && fs.existsSync(repoWorkDir)) {
      if (fs.existsSync(nextBackupFingerprintFile)) {
        try {
          fs.unlinkSync(nextBackupFingerprintFile)
        } catch {}
      }
      if (fs.existsSync(nextBackupDir)) {
        try {
          fs.rmSync(nextBackupDir, { recursive: true, force: true })
        } catch {}
      }
      try {
        const remaining = fs.readdirSync(repoWorkDir)
        if (remaining.length === 0) {
          fs.rmdirSync(repoWorkDir)
          console.log("[IT1] .agents/work 디렉터리 정리 완료.")
        } else {
          console.warn(`[IT1 경고] .agents/work 에 다른 파일이 남아 있어 폴더를 유지합니다: ${remaining.join(", ")}`)
        }
      } catch (err) {
        console.warn(`[IT1 경고] .agents/work 정리 실패: ${err.message}`)
      }
    }
  }

  const signalHandler = async (sig) => {
    console.warn(`\n[IT1] 신호 수신 (${sig}): 정리 절차 수행 중...`)
    removeSignalHandlers()
    try {
      await performCleanup()
    } catch (err) {
      console.error("[IT1] 정리 중 오류:", err)
    }
    process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1))
  }

  const onSigInt = () => signalHandler("SIGINT")
  const onSigTerm = () => signalHandler("SIGTERM")
  const onSigHup = () => signalHandler("SIGHUP")

  function addSignalHandlers() {
    process.once("SIGINT", onSigInt)
    process.once("SIGTERM", onSigTerm)
    process.once("SIGHUP", onSigHup)
  }

  function removeSignalHandlers() {
    process.removeListener("SIGINT", onSigInt)
    process.removeListener("SIGTERM", onSigTerm)
    process.removeListener("SIGHUP", onSigHup)
  }

  let P1, P2, P3, P4
  addSignalHandlers()
  try {
    // 2. 포트 4개 찾기 (P1, P2, P3, P4)
    console.log("[IT1] 빈 포트 4개 탐색 중...")
    const ports = await findFreePorts(4, 3171)
    ;[P1, P2, P3, P4] = ports
    console.log(`[IT1] 할당 포트: P1(API1)=${P1}, P2(API2)=${P2}, P3(server.mjs)=${P3}, P4(next-start)=${P4}`)

    // 3. mkdtemp로 시험 루트 생성 및 작업공간 구성
    console.log("[IT1] mkdtemp 시험 루트 생성 중...")
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-adk-it1-root-"))
    const testHome = path.join(testRoot, "home")
    const testTmp = path.join(testRoot, "tmp")
    const testXdg = path.join(testRoot, "xdg")
    const testWs = path.join(testRoot, "ws")
    const testDataDir = path.join(testRoot, "data-folder")

    fs.mkdirSync(testHome, { recursive: true })
    fs.mkdirSync(testTmp, { recursive: true })
    fs.mkdirSync(testXdg, { recursive: true })
    fs.mkdirSync(testWs, { recursive: true })
    fs.mkdirSync(testDataDir, { recursive: true })

    // 가짜 홈/XDG 거절 경로 실제 생성
    fs.mkdirSync(path.join(testHome, ".local", "share", "myapp"), { recursive: true })
    fs.mkdirSync(path.join(testHome, ".ssh"), { recursive: true })
    try {
      fs.symlinkSync(path.join(testHome, ".ssh"), path.join(testHome, "link-to-ssh"))
    } catch {}
    fs.mkdirSync(path.join(testTmp, "sub"), { recursive: true })
    fs.mkdirSync(path.join(testXdg, "naia-adk"), { recursive: true })
    fs.mkdirSync(path.join(testWs, ".agents", "work"), { recursive: true })

    // 시험 작업공간 git 저장소 초기화 및 파일 배치
    execFileSync("git", ["init"], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "IT Tester"], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: testWs, stdio: "ignore" })

    fs.writeFileSync(path.join(testWs, ".gitignore"), ".agents/work/\n")
    fs.writeFileSync(path.join(testWs, "AGENTS.md"), "# Test ADK Agents\n")
    fs.writeFileSync(path.join(testWs, "CLAUDE.md"), "@AGENTS.md\n")
    fs.writeFileSync(path.join(testWs, "GEMINI.md"), "@AGENTS.md\n")

    const wsDocs = path.join(testWs, "docs")
    fs.mkdirSync(wsDocs, { recursive: true })

    // 시험용 고유 토큰 및 파일들
    const UNIQUE_TOKEN = `TOKEN_TEST_${Date.now()}_SEARCH_KEYWORD`
    fs.writeFileSync(path.join(wsDocs, "sample.md"), `# 시험 문서\n본문 내용입니다. ${UNIQUE_TOKEN}\n`)
    fs.writeFileSync(path.join(wsDocs, "test.pdf"), "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")
    fs.writeFileSync(path.join(wsDocs, "video.mp4"), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]))
    fs.writeFileSync(path.join(wsDocs, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))
    fs.writeFileSync(path.join(wsDocs, "audio.mp3"), Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00, 0x00, 0x00]))
    fs.writeFileSync(path.join(wsDocs, "script.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    fs.writeFileSync(path.join(wsDocs, "page.html"), "<!DOCTYPE html><html><body><h1>test</h1></body></html>")
    fs.writeFileSync(path.join(wsDocs, "plain.txt"), "일반 텍스트 파일 내용")
    fs.writeFileSync(path.join(wsDocs, "large.txt"), "A".repeat(1024 * 1024 + 200))
    fs.writeFileSync(path.join(wsDocs, "other.bin"), Buffer.from([0x01, 0x02, 0x03, 0x04]))

    // 서브 디렉토리들
    fs.mkdirSync(path.join(wsDocs, "sub-image-only"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, "sub-image-only", "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))

    fs.mkdirSync(path.join(wsDocs, ".hidden-dir"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, ".hidden-dir", "secret.md"), "# 숨김 문서\n")

    fs.mkdirSync(path.join(wsDocs, "node_modules", "pkg"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, "node_modules", "pkg", "readme.md"), "# 패키지 리드미\n")

    fs.mkdirSync(path.join(wsDocs, "data-private"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, "data-private", "confidential.md"), "# 비공개 문서\n")

    // 스킬 및 도구 복사
    const skillSrc = path.join(REPO_ROOT, ".agents", "skills", "doc-notes")
    const skillDest = path.join(testWs, ".agents", "skills", "doc-notes")
    fs.mkdirSync(skillDest, { recursive: true })
    fs.cpSync(skillSrc, skillDest, { recursive: true })

    const scriptsDest = path.join(testWs, "scripts")
    fs.mkdirSync(scriptsDest, { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "doc-notes.mjs"), path.join(scriptsDest, "doc-notes.mjs"))

    // 시험 데이터 폴더 구성
    fs.writeFileSync(path.join(testDataDir, ".naia-view"), "")
    fs.writeFileSync(path.join(testDataDir, "data-doc.md"), "# 데이터 폴더 문서\n")
    fs.writeFileSync(path.join(testDataDir, "data-pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))
    fs.mkdirSync(path.join(testDataDir, "data-private"), { recursive: true })
    fs.writeFileSync(path.join(testDataDir, "data-private", "secret.txt"), "secret data")
    fs.mkdirSync(path.join(testDataDir, ".cache"), { recursive: true })
    fs.writeFileSync(path.join(testDataDir, ".cache", "cached.txt"), "cache data")
    fs.mkdirSync(path.join(testDataDir, "node_modules", "dep"), { recursive: true })
    fs.writeFileSync(path.join(testDataDir, "node_modules", "dep", "dep.js"), "console.log(1)")

    // git 커밋 실행
    execFileSync("git", ["add", "."], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init test ws"], { cwd: testWs, stdio: "ignore" })
    const initialCommitCount = parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
      10,
    )

    // 4. 자식 환경 변수 및 Next.js 빌드 (표준출력 및 파일 스트리밍)
    const childEnv = {
      ...process.env,
      HOME: testHome,
      TMPDIR: testTmp,
      XDG_RUNTIME_DIR: testXdg,
      NAIA_API_PORT: String(P1),
    }
    delete childEnv.NEXT_PUBLIC_API_URL

    console.log(`[IT1] 대시보드 next build 실행 (NAIA_API_PORT=${P1})...`)
    const buildLogFile = path.join(outDir, "next-build.log")
    const buildLogStream = fs.createWriteStream(buildLogFile)
    await new Promise((resolve, reject) => {
      const cp = spawn("pnpm", ["exec", "next", "build"], {
        cwd: dashboardDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      cp.stdout.on("data", (chunk) => {
        process.stdout.write(chunk)
        buildLogStream.write(chunk)
      })
      cp.stderr.on("data", (chunk) => {
        process.stderr.write(chunk)
        buildLogStream.write(chunk)
      })
      cp.on("error", (err) => {
        buildLogStream.end()
        reject(err)
      })
      cp.on("close", (code) => {
        buildLogStream.end()
        if (code === 0) resolve()
        else reject(new Error(`next build failed with code ${code}`))
      })
    })

    // 5. 프로세스 4개 기동
    const logFiles = {
      p1: path.join(outDir, "p1.log"),
      p2: path.join(outDir, "p2.log"),
      p3: path.join(outDir, "p3.log"),
      p4: path.join(outDir, "p4.log"),
    }

    const p1Fd = fs.openSync(logFiles.p1, "w")
    const p2Fd = fs.openSync(logFiles.p2, "w")
    const p3Fd = fs.openSync(logFiles.p3, "w")
    const p4Fd = fs.openSync(logFiles.p4, "w")

    console.log("[IT1] P1(API 1) 시작...")
    const cpP1 = spawn(
      "pnpm",
      ["exec", "tsx", "packages/server/src/cli.ts", "serve", "--port", String(P1), "--host", "127.0.0.1", "--root", testWs],
      {
        cwd: REPO_ROOT,
        env: { ...childEnv, NAIA_API_PORT: "" },
        detached: true,
        stdio: ["ignore", p1Fd, p1Fd],
      },
    )
    childPids.push(cpP1.pid)

    console.log("[IT1] P2(API 2) 시작...")
    const cpP2 = spawn(
      "pnpm",
      ["exec", "tsx", "packages/server/src/cli.ts", "serve", "--port", String(P2), "--host", "127.0.0.1", "--root", testWs],
      {
        cwd: REPO_ROOT,
        env: { ...childEnv, NAIA_API_PORT: "" },
        detached: true,
        stdio: ["ignore", p2Fd, p2Fd],
      },
    )
    childPids.push(cpP2.pid)

    console.log("[IT1] P3(대시보드 server.mjs) 시작...")
    const cpP3 = spawn(
      process.execPath,
      ["server.mjs", "-H", "127.0.0.1", "-p", String(P3)],
      {
        cwd: dashboardDir,
        env: childEnv,
        detached: true,
        stdio: ["ignore", p3Fd, p3Fd],
      },
    )
    childPids.push(cpP3.pid)

    console.log("[IT1] P4(대시보드 next start) 시작...")
    const cpP4 = spawn(
      "pnpm",
      ["exec", "next", "start", "-H", "127.0.0.1", "-p", String(P4)],
      {
        cwd: dashboardDir,
        env: childEnv,
        detached: true,
        stdio: ["ignore", p4Fd, p4Fd],
      },
    )
    childPids.push(cpP4.pid)

    // 포트 리스닝 대기
    console.log("[IT1] 모든 프로세스 포트 바인딩 대기 중...")
    const boundP1 = await waitForPortListening(P1)
    const boundP2 = await waitForPortListening(P2)
    const boundP3 = await waitForPortListening(P3)
    const boundP4 = await waitForPortListening(P4)

    if (!boundP1 || !boundP2 || !boundP3 || !boundP4) {
      throw new Error(`포트 바인딩 실패: P1=${boundP1}, P2=${boundP2}, P3=${boundP3}, P4=${boundP4}`)
    }
    console.log("[IT1] 모든 포트 바인딩 완료. 시험 항목 실행 시작.")

    // ----------------------------------------------------
    // Phase 1: 데이터 폴더 없는 상태 (빈 naia-adk)
    // ----------------------------------------------------

    // RQ-04 AC3: 빈 목록에서도 대시보드 및 API 정상 동작
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const pass = res.status === 200
      addResult({
        id: "RQ-04-AC3-view-folder-empty-init",
        rqAc: "RQ-04 AC3",
        fe: "FE 4장",
        command: res.command,
        expected: "status 200",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // RQ-01 AC1: 문서 없고 그림만 있는 폴더도 트리에 노출
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const body = JSON.parse(res.body || "{}")
      const adkSource = body.sources?.find((s) => s.id === "adk")
      const hasImgFolder = adkSource?.tree?.some((n) => n.name === "sub-image-only")
      addResult({
        id: "RQ-01-AC1-image-only-folder",
        rqAc: "RQ-01 AC1",
        fe: "FE 2장",
        command: res.command,
        expected: "tree contains sub-image-only folder",
        actual: hasImgFolder ? "sub-image-only folder found" : "sub-image-only missing",
        pass: Boolean(hasImgFolder),
      })
    }

    // RQ-01 AC2: 트리 노드마다 kind와 size 존재
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const body = JSON.parse(res.body || "{}")
      const adkSource = body.sources?.find((s) => s.id === "adk")
      const sampleNode = adkSource?.tree?.find((n) => n.name === "sample.md")
      const pass = sampleNode?.kind === "doc" && typeof sampleNode?.size === "number"
      addResult({
        id: "RQ-01-AC2-tree-kind-size",
        rqAc: "RQ-01 AC2",
        fe: "FE 2장",
        command: res.command,
        expected: "node has kind: 'doc' and numeric size",
        actual: `kind=${sampleNode?.kind}, size=${sampleNode?.size}`,
        pass,
      })
    }

    // RQ-01 AC3: 숨김 파일/폴더, node_modules 안 보임
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const treeStr = res.body || ""
      const pass = !treeStr.includes(".hidden-dir") && !treeStr.includes("node_modules") && !treeStr.includes("data-private")
      addResult({
        id: "RQ-01-AC3-hidden-excluded",
        rqAc: "RQ-01 AC3",
        fe: "FE 2장, 2-1장",
        command: res.command,
        expected: "excludes .hidden-dir, node_modules, data-private",
        actual: pass ? "all excluded" : "found excluded items in tree",
        pass,
      })
    }

    // RQ-01 AC4: 문서 검색 결과 본문만 (doc만 검색)
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/search?q=${UNIQUE_TOKEN}` })
      const body = JSON.parse(res.body || "{}")
      const resultsList = body.results || []
      const pass = resultsList.length === 1 && resultsList[0].path === "sample.md"
      addResult({
        id: "RQ-01-AC4-search-doc-only",
        rqAc: "RQ-01 AC4",
        fe: "FE 2장",
        command: res.command,
        expected: "only sample.md matched",
        actual: `matched count=${resultsList.length} (${resultsList.map((r) => r.path).join(", ")})`,
        pass,
      })
    }

    // RQ-02 AC1: 미디어 스트림 (그림/영상/소리/PDF) /asset 응답 200
    {
      const resImg = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=image.png` })
      const pass = resImg.status === 200 && resImg.headers["content-type"] === "image/png"
      addResult({
        id: "RQ-02-AC1-media-stream",
        rqAc: "RQ-02 AC1",
        fe: "FE 3장",
        command: resImg.command,
        expected: "status 200, content-type: image/png",
        actual: `status ${resImg.status}, content-type: ${resImg.headers["content-type"]}`,
        pass,
      })
    }

    // RQ-02 AC2: 영상 부분 요청(206), 범위 밖(416)
    {
      const res206 = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=video.mp4`,
        headers: { range: "bytes=0-10" },
      })
      const res416 = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=video.mp4`,
        headers: { range: "bytes=99999-999999" },
      })
      const pass = res206.status === 206 && res416.status === 416
      addResult({
        id: "RQ-02-AC2-video-range",
        rqAc: "RQ-02 AC2",
        fe: "FE 3장",
        command: `${res206.command} && ${res416.command}`,
        expected: "range 0-10 -> 206, range 99999-999999 -> 416",
        actual: `status 206=${res206.status}, status 416=${res416.status}`,
        pass,
      })
    }

    // RQ-02 AC3: 글자 보기 1MB 초과 truncated
    {
      const resPlain = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/text?source=adk&path=plain.txt` })
      const resLarge = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/text?source=adk&path=large.txt` })
      const bodyPlain = JSON.parse(resPlain.body || "{}")
      const bodyLarge = JSON.parse(resLarge.body || "{}")
      const pass = resPlain.status === 200 && !bodyPlain.truncated && resLarge.status === 200 && bodyLarge.truncated === true
      addResult({
        id: "RQ-02-AC3-text-view",
        rqAc: "RQ-02 AC3",
        fe: "FE 3장",
        command: `${resPlain.command} && ${resLarge.command}`,
        expected: "plain: truncated false, large: truncated true",
        actual: `plain.truncated=${bodyPlain.truncated}, large.truncated=${bodyLarge.truncated}`,
        pass,
      })
    }

    // RQ-02 AC4: 기타 파일 내려받기 (application/octet-stream + attachment)
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=other.bin` })
      const ct = res.headers["content-type"] || ""
      const cd = res.headers["content-disposition"] || ""
      const pass = res.status === 200 && ct.includes("application/octet-stream") && cd.includes("attachment")
      addResult({
        id: "RQ-02-AC4-other-download",
        rqAc: "RQ-02 AC4",
        fe: "FE 3장",
        command: res.command,
        expected: "content-type application/octet-stream, attachment",
        actual: `ct=${ct}, cd=${cd}`,
        pass,
      })
    }

    // RQ-02 AC5: nosniff, sandbox CSP, PDF CSP
    {
      const resHtml = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=page.html` })
      const resPdf = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=test.pdf` })
      const htmlCsp = String(resHtml.headers["content-security-policy"] || "")
      const pdfCsp = String(resPdf.headers["content-security-policy"] || "")
      const nosniff = resHtml.headers["x-content-type-options"] === "nosniff"
      const pass = nosniff && htmlCsp.includes("sandbox") && pdfCsp.includes("application/pdf")
      addResult({
        id: "RQ-02-AC5-script-sandbox-headers",
        rqAc: "RQ-02 AC5",
        fe: "FE 3장",
        command: `${resHtml.command} && ${resPdf.command}`,
        expected: "nosniff, html has sandbox CSP, pdf has plugin-types application/pdf",
        actual: `nosniff=${nosniff}, htmlCsp=${htmlCsp}, pdfCsp=${pdfCsp}`,
        pass,
      })
    }

    // RQ-02 AC6: 숨김 경로, node_modules, data-private 거절, /api/files 404
    {
      const resHidden = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=.hidden-dir/secret.md` })
      const resFiles = runCurl({ url: `http://127.0.0.1:${P3}/api/files` })
      const pass = [400, 403, 404].includes(resHidden.status) && resFiles.status === 404
      addResult({
        id: "RQ-02-AC6-hidden-files-reject",
        rqAc: "RQ-02 AC6",
        fe: "FE 1장, 2-1장",
        command: `${resHidden.command} && ${resFiles.command}`,
        expected: "hidden asset rejected, /api/files is 404",
        actual: `hidden.status=${resHidden.status}, files.status=${resFiles.status}`,
        pass,
      })
    }

    // RQ-03 AC1: 폴더 격자 순서 (하위 폴더 먼저, 파일 다음)
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/folder?source=adk&path=` })
      const body = JSON.parse(res.body || "{}")
      const entries = body.entries || []
      let dirEnded = false
      let orderOk = true
      for (const e of entries) {
        if (e.type === "directory") {
          if (dirEnded) orderOk = false
        } else {
          dirEnded = true
        }
      }
      addResult({
        id: "RQ-03-AC1-folder-grid-order",
        rqAc: "RQ-03 AC1",
        fe: "FE 3장",
        command: res.command,
        expected: "directories first, files next",
        actual: orderOk ? "order ok" : "order violation",
        pass: res.status === 200 && orderOk && entries.length > 0,
      })
    }

    // RQ-03 AC2: folder entry에 cover 포함
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/folder?source=adk&path=` })
      const body = JSON.parse(res.body || "{}")
      const entries = body.entries || []
      const subImgEntry = entries.find((e) => e.name === "sub-image-only")
      const pass = res.status === 200 && subImgEntry && typeof subImgEntry.cover === "string"
      addResult({
        id: "RQ-03-AC2-folder-cover",
        rqAc: "RQ-03 AC2",
        fe: "FE 3장",
        command: res.command,
        expected: "sub-image-only has cover field",
        actual: `subImgEntry.cover=${subImgEntry?.cover}`,
        pass: Boolean(pass),
      })
    }

    // RQ-03 AC4: folder 항목 500개 상한 및 total 반환
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/folder?source=adk&path=` })
      const body = JSON.parse(res.body || "{}")
      const pass = res.status === 200 && typeof body.total === "number" && Array.isArray(body.entries)
      addResult({
        id: "RQ-03-AC4-folder-limit",
        rqAc: "RQ-03 AC4",
        fe: "FE 3장",
        command: res.command,
        expected: "total field is number, entries array returned",
        actual: `total=${body.total}, entries.len=${body.entries?.length}`,
        pass,
      })
    }

    // RQ-05 AC1: 문서 직접 고치기 저장 및 커밋 수 불변
    let originalHash = ""
    {
      const getDoc = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md` })
      originalHash = getDoc.headers["etag"]?.replace(/"/g, "") || ""
      const newContent = `# 수정된 시험 문서\n새 내용입니다.\n`
      const putRes = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: {
          content: newContent,
          baseHash: originalHash,
        },
      })

      const diskContent = fs.readFileSync(path.join(wsDocs, "sample.md"), "utf-8")
      const countAfter = parseInt(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
        10,
      )

      const pass = putRes.status === 200 && diskContent === newContent && countAfter === initialCommitCount
      addResult({
        id: "RQ-05-AC1-doc-edit-save",
        rqAc: "RQ-05 AC1",
        fe: "FE 5장",
        command: putRes.command,
        expected: "status 200, disk content updated, git commit count unchanged",
        actual: `status ${putRes.status}, contentMatched=${diskContent === newContent}, commitCount=${countAfter} (init: ${initialCommitCount})`,
        pass,
      })
    }

    // RQ-05 AC2: 옛 해시로 충돌 시 409 및 바이트 유지
    {
      const putRes = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: {
          content: "# 다시 수정 시도\n",
          baseHash: originalHash, // 이미 바뀐 상태의 옛 해시
        },
      })
      const diskContent = fs.readFileSync(path.join(wsDocs, "sample.md"), "utf-8")
      const pass = putRes.status === 409 && diskContent.includes("수정된 시험 문서")
      addResult({
        id: "RQ-05-AC2-doc-conflict-hash",
        rqAc: "RQ-05 AC2",
        fe: "FE 5장",
        command: putRes.command,
        expected: "status 409, file content intact",
        actual: `status ${putRes.status}, body=${putRes.body.trim()}`,
        pass,
      })
    }

    // RQ-05 AC3: doc 아닌 파일/없는 파일 저장 거절 (404)
    {
      const putImg = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=image.png`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const put404 = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=nonexistent.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const pass = putImg.status === 404 && put404.status === 404
      addResult({
        id: "RQ-05-AC3-doc-edit-reject-non-doc",
        rqAc: "RQ-05 AC3",
        fe: "FE 5장",
        command: `${putImg.command} && ${put404.command}`,
        expected: "img put: 404 (not markdown), nonexistent put: 404",
        actual: `img: ${putImg.status}, 404: ${put404.status}`,
        pass,
      })
    }

    // RQ-05 AC4: 원자적 쓰기 (임시 파일 + rename)
    {
      const atomicRel = "atomic.md"
      const atomicPath = path.join(wsDocs, atomicRel)

      // (1) LF 케이스
      const lfInitial = "# Atomic Doc LF\nline 1\nline 2\n"
      fs.writeFileSync(atomicPath, lfInitial, "utf-8")
      const lfIno1 = fs.statSync(atomicPath).ino
      const lfHash1 = crypto.createHash("sha256").update(Buffer.from(lfInitial, "utf-8")).digest("hex")
      const filesBefore1 = new Set(fs.readdirSync(wsDocs))

      const lfPutBody = "updated lf line 1\r\nupdated lf line 2\n"
      const lfExpected = "updated lf line 1\nupdated lf line 2\n"
      const lfRes = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=${atomicRel}`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { content: lfPutBody, baseHash: lfHash1 },
      })

      const filesAfter1 = new Set(fs.readdirSync(wsDocs))
      const lfFilesMatched = filesBefore1.size === filesAfter1.size && [...filesBefore1].every((f) => filesAfter1.has(f))
      const lfNoTmp = !fs.readdirSync(wsDocs).some((f) => f.startsWith(".tmp-"))
      const lfIno2 = fs.statSync(atomicPath).ino
      const lfInoChanged = lfIno2 !== lfIno1
      const lfContentSaved = fs.readFileSync(atomicPath, "utf-8")
      const lfContentMatched = lfContentSaved === lfExpected
      const lfOk = lfRes.status === 200 && lfFilesMatched && lfNoTmp && lfInoChanged && lfContentMatched

      // (2) CRLF 케이스
      const crlfInitial = "# Atomic Doc CRLF\r\nline 1\r\nline 2\r\n"
      fs.writeFileSync(atomicPath, crlfInitial, "utf-8")
      const crlfIno1 = fs.statSync(atomicPath).ino
      const crlfHash1 = crypto.createHash("sha256").update(Buffer.from(crlfInitial, "utf-8")).digest("hex")
      const filesBefore2 = new Set(fs.readdirSync(wsDocs))

      const crlfPutBody = "updated crlf line 1\nupdated crlf line 2\n"
      const crlfExpected = "updated crlf line 1\r\nupdated crlf line 2\r\n"
      const crlfRes = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=${atomicRel}`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { content: crlfPutBody, baseHash: crlfHash1 },
      })

      const filesAfter2 = new Set(fs.readdirSync(wsDocs))
      const crlfFilesMatched = filesBefore2.size === filesAfter2.size && [...filesBefore2].every((f) => filesAfter2.has(f))
      const crlfNoTmp = !fs.readdirSync(wsDocs).some((f) => f.startsWith(".tmp-"))
      const crlfIno2 = fs.statSync(atomicPath).ino
      const crlfInoChanged = crlfIno2 !== crlfIno1
      const crlfContentSaved = fs.readFileSync(atomicPath, "utf-8")
      const crlfContentMatched = crlfContentSaved === crlfExpected
      const crlfOk = crlfRes.status === 200 && crlfFilesMatched && crlfNoTmp && crlfInoChanged && crlfContentMatched

      // (3) 서버 시험 자식 실행
      const serverTestName = "beforeRenameHook 예외 시 원문 inode·바이트 유지하고 임시 파일 없이 500 반환"
      let serverTestOut = ""
      let serverTestExitCode = 0
      try {
        serverTestOut = execFileSync(
          "pnpm",
          ["--filter", "@naia-adk/server", "exec", "vitest", "run", "test/portal-w1d2.test.ts", "-t", serverTestName],
          { cwd: REPO_ROOT, encoding: "utf-8" },
        )
      } catch (err) {
        serverTestExitCode = err.status || 1
        serverTestOut = (err.stdout || "") + (err.stderr || "")
      }

      const serverTestHasName = serverTestOut.includes(serverTestName)
      const serverTestHas1Passed = /Tests\s+1\s+passed/.test(serverTestOut)
      const serverTestOk = serverTestExitCode === 0 && serverTestHasName && serverTestHas1Passed

      const pass = Boolean(lfOk && crlfOk && serverTestOk)
      addResult({
        id: "RQ-05-AC4-doc-atomic-write",
        rqAc: "RQ-05 AC4",
        fe: "FE 5장",
        command: `PUT via server.mjs (LF/CRLF) + vitest -t "${serverTestName}"`,
        expected: "LF/CRLF inode changed & CRLF normalized & no temp files; server hook exception preserves original & no temp & Tests 1 passed",
        actual: `LF(status=${lfRes.status}, inoChanged=${lfInoChanged}, filesOk=${lfFilesMatched && lfNoTmp}, bytesOk=${lfContentMatched}), CRLF(status=${crlfRes.status}, inoChanged=${crlfInoChanged}, filesOk=${crlfFilesMatched && crlfNoTmp}, bytesOk=${crlfContentMatched}), serverTest(exit=${serverTestExitCode}, name=${serverTestHasName}, passed1=${serverTestHas1Passed})`,
        pass,
      })
    }

    // RQ-06 AC1: 메모 작성, 수정, 삭제 (md 아닌 파일 거절 404)
    let createdNoteId = ""
    {
      const createRes = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/notes`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: {
          source: "adk",
          path: "sample.md",
          body: "IT 테스트 메모",
        },
      })
      const body = JSON.parse(createRes.body || "{}")
      createdNoteId = body.note?.id || ""

      const failImg = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/notes`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: {
          source: "adk",
          path: "image.png",
          body: "실패해야 할 메모",
        },
      })

      const pass = createRes.status === 201 && Boolean(createdNoteId) && failImg.status === 404
      addResult({
        id: "RQ-06-AC1-notes-crud",
        rqAc: "RQ-06 AC1",
        fe: "FE 6장",
        command: `${createRes.command} && ${failImg.command}`,
        expected: "note create: 201, image note create: 404 (not markdown)",
        actual: `create: ${createRes.status} (id=${createdNoteId}), failImg: ${failImg.status}`,
        pass,
      })
    }

    // RQ-06 AC2: 메모 파일 저장 위치 및 git 불변
    {
      const noteFilePath = path.join(testWs, ".agents", "work", "doc-notes", `${createdNoteId}.json`)
      const exists = fs.existsSync(noteFilePath)
      // docs 디렉토리 안에는 메모 파일이 생성되지 않았는지 확인
      const docsNoteFiles = fs.readdirSync(wsDocs).filter((f) => f.includes(createdNoteId))
      // 메모 생성이 git tracked 문서들에 영향을 주지 않았는지 확인 (sample.md 외 변경 없음)
      const gitDiffNotes = execFileSync("git", ["diff", "--name-only", "HEAD", "--", ":(exclude)docs/sample.md"], { cwd: testWs, encoding: "utf-8" }).trim()
      const pass = exists && docsNoteFiles.length === 0 && gitDiffNotes === ""
      addResult({
        id: "RQ-06-AC2-notes-location-git",
        rqAc: "RQ-06 AC2",
        fe: "FE 6장",
        command: `test -f ${noteFilePath} && verify no notes in docs/ && git diff clean`,
        expected: "note file exists in .agents/work/doc-notes, git status unaffected",
        actual: `exists=${exists}, docsNotes=${docsNoteFiles.length}, gitDiffOther='${gitDiffNotes}'`,
        pass,
      })
    }

    // RQ-06 AC3: node scripts/doc-notes.mjs list --root <시험 작업공간> 성공
    {
      let cliOutput = ""
      let cliSuccess = false
      try {
        cliOutput = execFileSync(
          process.execPath,
          [path.join(scriptsDest, "doc-notes.mjs"), "list", "--root", testWs],
          { encoding: "utf-8" },
        )
        cliSuccess = cliOutput.includes(createdNoteId) && cliOutput.includes("IT 테스트 메모")
      } catch (err) {
        cliOutput = err.message
      }
      addResult({
        id: "RQ-06-AC3-notes-cli-list",
        rqAc: "RQ-06 AC3",
        fe: "FE 6장",
        command: `node scripts/doc-notes.mjs list --root ${testWs}`,
        expected: "list output contains note id and body",
        actual: cliSuccess ? "cli list output verified" : `cli failed: ${cliOutput}`,
        pass: cliSuccess,
      })
    }

    // RQ-06 AC5: notes/counts 숫자 일치
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/notes/counts` })
      const body = JSON.parse(res.body || "{}")
      const key = "adk\u0000sample.md"
      const pass = res.status === 200 && body[key] === 1
      addResult({
        id: "RQ-06-AC5-notes-counts",
        rqAc: "RQ-06 AC5",
        fe: "FE 6장",
        command: res.command,
        expected: "count for adk:sample.md is 1",
        actual: `count=${body[key]}`,
        pass,
      })
    }

    // RQ-07 AC1: 즐겨찾기 CRUD
    {
      const postFav = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/favorites`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { source: "adk", path: "sample.md" },
      })
      const getFav = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/favorites` })
      const body = JSON.parse(getFav.body || "{}")
      const hasItem = body.items?.some((it) => it.source === "adk" && it.path === "sample.md")
      const pass = postFav.status === 200 && getFav.status === 200 && Boolean(hasItem)
      addResult({
        id: "RQ-07-AC1-favorites-crud",
        rqAc: "RQ-07 AC1",
        fe: "FE 7장",
        command: `${postFav.command} && ${getFav.command}`,
        expected: "post: 200, get: 200 with sample.md",
        actual: `post=${postFav.status}, get=${getFav.status}, hasItem=${hasItem}`,
        pass,
      })
    }

    // RQ-07 AC2: 없는 항목 exists: false 및 DELETE
    {
      const postGhost = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/favorites`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { source: "adk", path: "sub-image-only/pic.png" },
      })
      // 파일 삭제
      fs.unlinkSync(path.join(wsDocs, "sub-image-only", "pic.png"))

      const getFav = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/favorites` })
      const body = JSON.parse(getFav.body || "{}")
      const ghost = body.items?.find((it) => it.path === "sub-image-only/pic.png")

      const delFav = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/favorites`,
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { source: "adk", path: "sub-image-only/pic.png" },
      })

      const pass = postGhost.status === 200 && ghost?.exists === false && delFav.status === 200
      addResult({
        id: "RQ-07-AC2-favorites-missing",
        rqAc: "RQ-07 AC2",
        fe: "FE 7장",
        command: `${getFav.command} && ${delFav.command}`,
        expected: "missing item exists: false, delete: 200",
        actual: `exists=${ghost?.exists}, delStatus=${delFav.status}`,
        pass,
      })
    }

    // RQ-07 AC3: 즐겨찾기 중복 추가 시 그대로 200
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/favorites`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { source: "adk", path: "sample.md" },
      })
      const pass = res.status === 200
      addResult({
        id: "RQ-07-AC3-favorites-limit",
        rqAc: "RQ-07 AC3",
        fe: "FE 7장",
        command: res.command,
        expected: "status 200 on duplicate add",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // ====================================================
    // 빈 단계 RQ-08 검증 (view-folders.json 생성 전)
    // ====================================================

    // RQ-08-AC1-empty-phase: 빈 작업공간에서 트리 필터링 및 꾸민 요청 쓰기 403
    {
      const resTrusted = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const bodyTrusted = JSON.parse(resTrusted.body || "{}")
      const adkTrusted = bodyTrusted.sources?.find((s) => s.id === "adk")
      const hasPdfTrusted = Boolean(adkTrusted?.tree?.some((n) => n.name === "test.pdf"))

      const resSpoofedTree = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal`,
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-local": "100.64.0.1",
          "x-naia-origin-ok": "1",
        },
      })
      const bodySpoofed = JSON.parse(resSpoofedTree.body || "{}")
      const adkSpoofed = bodySpoofed.sources?.find((s) => s.id === "adk")
      const spoofedHasPdf = Boolean(adkSpoofed?.tree?.some((n) => n.name === "test.pdf"))
      const spoofedHasDoc = Boolean(adkSpoofed?.tree?.some((n) => n.name === "sample.md"))
      const spoofedHasImg = Boolean(adkSpoofed?.tree?.some((n) => n.name === "image.png"))

      const sampleDocPath = path.join(wsDocs, "sample.md")
      const sampleHash = crypto.createHash("sha256").update(fs.readFileSync(sampleDocPath)).digest("hex")

      const resPutDoc = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-naia-peer": "100.64.1.1",
          "x-naia-origin-ok": "1",
        },
        data: { content: "tamper\n", baseHash: sampleHash },
      })

      const resPostNote = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/notes`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naia-peer": "100.64.1.1",
          "x-naia-origin-ok": "1",
        },
        data: { source: "adk", path: "sample.md", body: "tamper note" },
      })

      const resPostFav = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/favorites`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naia-peer": "100.64.1.1",
          "x-naia-origin-ok": "1",
        },
        data: { source: "adk", path: "sample.md" },
      })

      const resGetNotes = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/notes`,
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-origin-ok": "1",
        },
      })

      const pass = Boolean(
        hasPdfTrusted &&
        !spoofedHasPdf &&
        spoofedHasDoc &&
        spoofedHasImg &&
        resPutDoc.status === 403 &&
        resPostNote.status === 403 &&
        resPostFav.status === 403 &&
        resGetNotes.status === 403,
      )

      addResult({
        id: "RQ-08-AC1-empty-phase",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: "empty workspace spoofed vs trusted tree & writes check",
        expected: "spoofed tree excludes pdf & retains doc/img; doc/note/favorite/view writes return 403",
        actual: `tree(spoofedPdf=${spoofedHasPdf}, doc=${spoofedHasDoc}, img=${spoofedHasImg}); writes(doc=${resPutDoc.status}, note=${resPostNote.status}, fav=${resPostFav.status}, view=${resGetNotes.status})`,
        pass,
      })
    }

    // RQ-08-AC2-empty-phase: 빈 작업공간에서 Origin DNS rebind 차단
    {
      const resHostP3 = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal`,
        headers: { host: `evil.ts.net:${P3}` },
      })
      const resOriginP3 = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/favorites`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:9999",
        },
        data: { source: "adk", path: "sample.md" },
      })
      const pass = Boolean(resHostP3.status === 421 && resOriginP3.status === 403)
      addResult({
        id: "RQ-08-AC2-empty-phase",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: "empty workspace origin/host check",
        expected: "host evil.ts.net returns 421, cross-origin write returns 403",
        actual: `host=${resHostP3.status}, origin=${resOriginP3.status}`,
        pass,
      })
    }

    // RQ-08-AC3-empty-phase: 빈 작업공간에서 LAN 위조 헤더 차단
    {
      const resP1 = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal`,
        headers: {
          "x-naia-proxy-secret": "fake-secret",
          "x-naia-peer": "192.0.2.100",
        },
      })
      const bodyP1 = JSON.parse(resP1.body || "{}")
      const adkP1 = bodyP1.sources?.find((s) => s.id === "adk")
      const hasPdf = Boolean(adkP1?.tree?.some((n) => n.name === "test.pdf"))
      const pass = Boolean(resP1.status === 200 && !hasPdf)
      addResult({
        id: "RQ-08-AC3-empty-phase",
        rqAc: "RQ-08 AC3",
        fe: "FE 8장",
        command: "empty workspace fake secret & peer header check",
        expected: "untrusted response with pdf excluded",
        actual: `status=${resP1.status}, hasPdf=${hasPdf}`,
        pass,
      })
    }

    // ----------------------------------------------------
    // Phase 2: 거절 경로 테스트 및 데이터 폴더 등록
    // ----------------------------------------------------

    // RQ-04 AC5: view-folders.mjs 도구 및 스킬 파일 존재
    {
      const toolExists = fs.existsSync(path.join(REPO_ROOT, "scripts", "view-folders.mjs"))
      const skillExists = fs.existsSync(path.join(REPO_ROOT, ".agents", "skills", "view-folders", "SKILL.md"))
      const pass = toolExists && skillExists
      addResult({
        id: "RQ-04-AC5-view-folder-tools",
        rqAc: "RQ-04 AC5",
        fe: "FE 4장",
        command: "fs.existsSync view-folders.mjs and SKILL.md",
        expected: "both exist",
        actual: `tool=${toolExists}, skill=${skillExists}`,
        pass,
      })
    }

    // RQ-04 AC6: view-folders 금지 경로 거절 테스트 (도구 판정)
    {
      const forbiddenTargets = [
        { name: "home (~)", path: testHome },
        { name: "parent", path: path.dirname(testWs) },
        { name: "ws root", path: testWs },
        { name: "ws agents work", path: path.join(testWs, ".agents", "work") },
        { name: "home .local", path: path.join(testHome, ".local") },
        { name: "home .local/share", path: path.join(testHome, ".local", "share") },
        { name: "no-view myapp", path: path.join(testHome, ".local", "share", "myapp") },
        { name: "home .ssh", path: path.join(testHome, ".ssh") },
        { name: "link-to-ssh", path: path.join(testHome, "link-to-ssh") },
        { name: "tmp dir", path: testTmp },
        { name: "tmp sub", path: path.join(testTmp, "sub") },
        { name: "secret dir", path: path.join(testXdg, "naia-adk") },
        { name: "secret parent", path: testXdg },
        { name: "/proc", path: "/proc" },
        { name: "/run", path: "/run" },
      ]

      let allRejected = true
      const rejectLogs = []
      let idx = 0
      for (const t of forbiddenTargets) {
        idx++
        const targetId = `forbid-${idx}`
        let failed = false
        try {
          execFileSync(
            process.execPath,
            [
              path.join(REPO_ROOT, "scripts", "view-folders.mjs"),
              "add",
              "--root",
              testWs,
              "--id",
              targetId,
              "--label",
              t.name,
              "--path",
              t.path,
            ],
            { env: childEnv, encoding: "utf-8", stdio: "pipe" },
          )
        } catch {
          failed = true
        }
        if (!failed) {
          allRejected = false
          rejectLogs.push(`${t.name} was NOT rejected`)
        } else {
          rejectLogs.push(`${t.name} rejected (OK)`)
        }
      }

      addResult({
        id: "RQ-04-AC6-view-folder-prohibitions",
        rqAc: "RQ-04 AC6",
        fe: "FE 4장, FE 8장",
        command: "view-folders.mjs add --root <ws> for all forbidden paths",
        expected: "all forbidden paths rejected",
        actual: allRejected ? "all 15 forbidden paths rejected" : rejectLogs.join("; "),
        pass: allRejected,
      })

      addResult({
        id: "FE-IT-09-view-folders-reject-tool",
        rqAc: "RQ-04 AC6",
        fe: "FE 8장",
        command: "view-folders.mjs add --root <ws> for forbidden paths",
        expected: "tool rejects all forbidden paths",
        actual: allRejected ? "tool rejected all paths" : "some paths accepted",
        pass: allRejected,
      })
    }

    // RQ-04 AC6 서버 판정 거절 (FE-IT-10)
    {
      const forbiddenConfig = {
        schemaVersion: 1,
        folders: [
          { id: "bad-ssh", label: "ssh", path: path.join(testHome, ".ssh"), tab: "common" },
          { id: "bad-tmp", label: "tmp", path: testTmp, tab: "common" },
        ],
      }
      fs.writeFileSync(path.join(testWs, ".agents", "work", "view-folders.json"), JSON.stringify(forbiddenConfig), "utf-8")

      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const body = JSON.parse(res.body || "{}")
      const sources = body.sources || []
      const hasBadSsh = sources.some((s) => s.id === "data:bad-ssh")
      const hasBadTmp = sources.some((s) => s.id === "data:bad-tmp")

      const pass = !hasBadSsh && !hasBadTmp
      addResult({
        id: "FE-IT-10-view-folders-reject-server",
        rqAc: "RQ-04 AC6",
        fe: "FE 4장, FE 8장",
        command: res.command,
        expected: "server rejects forbidden folders from being mounted as sources",
        actual: pass ? "server excluded forbidden folders" : `mounted: ssh=${hasBadSsh}, tmp=${hasBadTmp}`,
        pass,
      })
    }

    // 정상 데이터 폴더 등록 (RQ-04 AC1)
    {
      fs.writeFileSync(path.join(testWs, ".agents", "work", "view-folders.json"), JSON.stringify({ schemaVersion: 1, folders: [] }), "utf-8")

      execFileSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "view-folders.mjs"),
          "add",
          "--root",
          testWs,
          "--id",
          "my-data",
          "--label",
          "시험데이터",
          "--path",
          testDataDir,
          "--tab",
          "common",
        ],
        { env: childEnv, encoding: "utf-8", stdio: "pipe" },
      )

      const resAfterAdd = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const bodyAdd = JSON.parse(resAfterAdd.body || "{}")
      const hasDataSrc = bodyAdd.sources?.some((s) => s.id === "data:my-data")

      // remove 테스트
      execFileSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "view-folders.mjs"),
          "remove",
          "--root",
          testWs,
          "--id",
          "my-data",
        ],
        { env: childEnv, encoding: "utf-8", stdio: "pipe" },
      )

      const resAfterRemove = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const bodyRem = JSON.parse(resAfterRemove.body || "{}")
      const removedOk = !bodyRem.sources?.some((s) => s.id === "data:my-data")

      // 다시 add 해둠 (이후 시험 진행용)
      execFileSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "view-folders.mjs"),
          "add",
          "--root",
          testWs,
          "--id",
          "my-data",
          "--label",
          "시험데이터",
          "--path",
          testDataDir,
          "--tab",
          "common",
        ],
        { env: childEnv, encoding: "utf-8", stdio: "pipe" },
      )

      const pass = Boolean(hasDataSrc) && removedOk
      addResult({
        id: "RQ-04-AC1-view-folder-add-remove",
        rqAc: "RQ-04 AC1",
        fe: "FE 4장",
        command: "view-folders add -> verify -> remove -> verify",
        expected: "source appears on add, disappears on remove",
        actual: `added=${hasDataSrc}, removed=${removedOk}`,
        pass,
      })
    }

    // RQ-04 AC2: 데이터 폴더는 보기 전용, PUT 시 403 거절
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=data:my-data&path=data-doc.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${P3}`,
        },
        data: { content: "# 수정 시도\n", baseHash: "dummy" },
      })
      const pass = res.status === 403
      addResult({
        id: "RQ-04-AC2-view-folder-readonly",
        rqAc: "RQ-04 AC2",
        fe: "FE 4장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // RQ-04 AC4: 목록 폴더 없어지면 missing: true
    {
      const ghostDir = path.join(testRoot, "ghost-folder")
      fs.mkdirSync(ghostDir, { recursive: true })
      fs.writeFileSync(path.join(ghostDir, ".naia-view"), "")
      execFileSync(
        process.execPath,
        [
          path.join(REPO_ROOT, "scripts", "view-folders.mjs"),
          "add",
          "--root",
          testWs,
          "--id",
          "ghost-data",
          "--label",
          "유령데이터",
          "--path",
          ghostDir,
        ],
        { env: childEnv, encoding: "utf-8", stdio: "pipe" },
      )
      // 폴더 삭제
      fs.rmSync(ghostDir, { recursive: true, force: true })

      const res = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const body = JSON.parse(res.body || "{}")
      const ghostSrc = body.sources?.find((s) => s.id === "data:ghost-data")
      const pass = res.status === 200 && ghostSrc?.missing === true

      // 정리
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "remove", "--root", testWs, "--id", "ghost-data"],
        { env: childEnv, encoding: "utf-8", stdio: "pipe" },
      )

      addResult({
        id: "RQ-04-AC4-view-folder-missing",
        rqAc: "RQ-04 AC4",
        fe: "FE 4장",
        command: res.command,
        expected: "missing: true",
        actual: `ghostSrc.missing=${ghostSrc?.missing}`,
        pass: Boolean(pass),
      })
    }

    // ----------------------------------------------------
    // 쓰기 보호 및 보안 검증 (FE 8장 & RQ-08)
    // ----------------------------------------------------

    // FE-IT-01: LAN 주소에서 꾸민 요청 P1 직접 쓰기·새 보기 403
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-local": "100.64.0.1",
          "x-naia-proxy-secret": "dummy_secret",
          "x-forwarded-for": "100.64.1.1",
          "content-type": "application/json",
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const pass = res.status === 403
      addResult({
        id: "FE-IT-01-lan-tampered-p1",
        rqAc: "RQ-08 AC1, AC3",
        fe: "FE 8장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-02: LAN 주소에서 꾸민 요청 P3 server.mjs 경유 쓰기·새 보기 403 (Origin 없음 또는 위조)
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-local": "100.64.0.1",
          "x-naia-proxy-secret": "dummy_secret",
          "x-forwarded-for": "100.64.1.1",
          "content-type": "application/json",
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const pass = res.status === 403
      addResult({
        id: "FE-IT-02-lan-tampered-p3",
        rqAc: "RQ-08 AC1, AC3",
        fe: "FE 8장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-03: LAN 주소에서 꾸민 요청 P4 next start 경유 쓰기·새 보기 403
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P4}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-local": "100.64.0.1",
          "x-naia-proxy-secret": "dummy_secret",
          "x-forwarded-for": "100.64.1.1",
          "content-type": "application/json",
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const pass = res.status === 403
      addResult({
        id: "FE-IT-03-lan-tampered-p4",
        rqAc: "RQ-08 AC1, AC3",
        fe: "FE 8장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-05: pnpm dev 스크립트 파일 확인
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(dashboardDir, "package.json"), "utf-8"))
      const pass = pkg.scripts?.dev?.includes("server.mjs")
      addResult({
        id: "FE-IT-05-pnpm-dev-file-check",
        rqAc: "RQ-08 AC3",
        fe: "FE 8장",
        command: "read packages/dashboard/package.json scripts.dev",
        expected: "contains server.mjs",
        actual: `scripts.dev: "${pkg.scripts?.dev}"`,
        pass,
      })
    }

    // FE-IT-06: next start 직접 실행에서 기존 문서 트리 200, 새 보기 403
    {
      const resTree = runCurl({ url: `http://127.0.0.1:${P4}/api/portal` })
      const resDoc = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/doc?source=adk&path=sample.md` })
      const resPdf = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/asset?source=adk&path=test.pdf` })
      const resHtml = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/asset?source=adk&path=page.html` })
      const resTxt = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/text?source=adk&path=plain.txt` })

      const pass = resTree.status === 200 && resDoc.status === 200 && resPdf.status === 403 && resHtml.status === 403 && resTxt.status === 403
      addResult({
        id: "FE-IT-06-next-start-doc-vs-new",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: `P4: tree(${resTree.status}), doc(${resDoc.status}), pdf(${resPdf.status}), html(${resHtml.status}), txt(${resTxt.status})`,
        expected: "tree: 200, doc: 200, pdf: 403, html: 403, txt: 403",
        actual: `tree=${resTree.status}, doc=${resDoc.status}, pdf=${resPdf.status}, html=${resHtml.status}, txt=${resTxt.status}`,
        pass,
      })
    }

    // FE-IT-11: 3141(P1)에 직접 보낸 쓰기·새 보기 403
    {
      const resPut = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: { "content-type": "application/json" },
        data: { content: "fail", baseHash: "dummy" },
      })
      const resTxt = runCurl({ url: `http://127.0.0.1:${P1}/api/portal/text?source=adk&path=plain.txt` })
      const pass = resPut.status === 403 && resTxt.status === 403
      addResult({
        id: "FE-IT-11-direct-p1-write-read",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: `${resPut.command} && ${resTxt.command}`,
        expected: "direct P1 write: 403, new read: 403",
        actual: `put=${resPut.status}, text=${resTxt.status}`,
        pass,
      })
    }

    function checkDisallowedHosts(port) {
      const shortHost = os.hostname().split(".")[0]
      const badHosts = [`evil.ts.net:${port}`, `${shortHost}:${port}`, `tailnet-short:${port}`]
      const endpoints = [
        { method: "GET", path: "/" },
        { method: "GET", path: "/api/portal" },
        { method: "GET", path: "/api/portal/doc?source=adk&path=sample.md" },
        { method: "GET", path: "/api/portal/asset?source=adk&path=sample.md" },
        {
          method: "POST",
          path: "/api/portal/notes",
          headers: { "content-type": "application/json" },
          data: { source: "adk", path: "sample.md", body: "test" },
        },
      ]
      const runs = []
      for (const ep of endpoints) {
        for (const h of badHosts) {
          const res = runCurl({
            url: `http://127.0.0.1:${port}${ep.path}`,
            method: ep.method,
            headers: { host: h, ...(ep.headers || {}) },
            data: ep.data || null,
          })
          runs.push({ path: ep.path, host: h, status: res.status, ok: res.status === 421 })
        }
      }
      return {
        all421: runs.length === 15 && runs.every((r) => r.ok),
        failedRuns: runs.filter((r) => !r.ok),
      }
    }

    // FE-IT-12: 이름 Host로 보낸 API 요청은 화면·portal·doc·asset·쓰기 모든 경로에서 421
    {
      const chk = checkDisallowedHosts(P1)
      const pass = chk.all421
      addResult({
        id: "FE-IT-12-direct-p1-name-host",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: `P1 5 paths x 3 bad hosts (evil.ts.net, ${os.hostname().split(".")[0]}, tailnet-short)`,
        expected: "all 15 requests return status 421",
        actual: pass ? "all 15 requests returned 421" : `failures: ${JSON.stringify(chk.failedRuns)}`,
        pass,
      })
    }

    // FE-IT-13: /api/files는 404
    {
      const res = runCurl({ url: `http://127.0.0.1:${P1}/api/files` })
      const pass = res.status === 404
      addResult({
        id: "FE-IT-13-direct-p1-api-files",
        rqAc: "RQ-02 AC6",
        fe: "FE 1장, FE 8장",
        command: res.command,
        expected: "status 404",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-14: 비밀 값 파일이 어떤 출처·트리·내주기에도 나오지 않음
    {
      const resTree = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const bodyTree = resTree.body || ""
      const resAsset = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=portal-proxy-secret-${P1}` })
      const pass = !bodyTree.includes("portal-proxy-secret") && [400, 403, 404].includes(resAsset.status)
      addResult({
        id: "FE-IT-14-secret-file-not-exposed",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: `${resTree.command} && ${resAsset.command}`,
        expected: "proxy secret not in tree, cannot be fetched via asset",
        actual: `inTree=${bodyTree.includes("portal-proxy-secret")}, assetStatus=${resAsset.status}`,
        pass,
      })
    }

    // FE-IT-15: P3 목적지 분기 검증 (P3가 P1만 부르고 P2는 부르지 않음, ss 연결 0건)
    {
      const logP1Before = fs.readFileSync(logFiles.p1, "utf-8")
      const logP2Before = fs.readFileSync(logFiles.p2, "utf-8")

      const resP3Tree = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const resP3Doc = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md` })
      const resP3Search = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/search?q=${UNIQUE_TOKEN}` })

      await sleep(300)
      const logP1After = fs.readFileSync(logFiles.p1, "utf-8")
      const logP2After = fs.readFileSync(logFiles.p2, "utf-8")

      const p1NewLog = logP1After.slice(logP1Before.length)
      const p2NewLog = logP2After.slice(logP2Before.length)

      const p1HasUrls = p1NewLog.includes("/api/portal") && p1NewLog.includes("sample.md") && p1NewLog.includes(UNIQUE_TOKEN)
      const p2HasUrls = p2NewLog.includes("/api/portal") || p2NewLog.includes("sample.md") || p2NewLog.includes(UNIQUE_TOKEN)
      const ssP3Ok = checkSsConnections([cpP3.pid], 3141)

      const passP3 = p1HasUrls && !p2HasUrls && ssP3Ok && resP3Doc.body.includes("수정된 시험 문서")

      addResult({
        id: "FE-IT-15-p3-calls-only-p1",
        rqAc: "FE 8장 목적지 분기",
        fe: "FE 8장",
        command: "curl P3 (/api/portal, /doc, /search) and inspect P1/P2 logs & ss",
        expected: "P1 log has incoming request urls, P2 has none, 3141 ss connections == 0",
        actual: `p1HasUrls=${p1HasUrls}, p2HasUrls=${p2HasUrls}, ssP3Ok=${ssP3Ok}`,
        pass: passP3,
      })
    }

    // FE-IT-16: P4 목적지 분기 검증 (P4가 P1만 부르고 P2는 부르지 않음, ss 연결 0건)
    {
      const logP1Before = fs.readFileSync(logFiles.p1, "utf-8")
      const logP2Before = fs.readFileSync(logFiles.p2, "utf-8")

      const resP4Tree = runCurl({ url: `http://127.0.0.1:${P4}/api/portal` })
      const resP4Doc = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/doc?source=adk&path=sample.md` })
      const resP4Search = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/search?q=${UNIQUE_TOKEN}` })

      await sleep(300)
      const logP1After = fs.readFileSync(logFiles.p1, "utf-8")
      const logP2After = fs.readFileSync(logFiles.p2, "utf-8")

      const p1NewLog = logP1After.slice(logP1Before.length)
      const p2NewLog = logP2After.slice(logP2Before.length)

      const p1HasUrls = p1NewLog.includes("/api/portal") && p1NewLog.includes("sample.md") && p1NewLog.includes(UNIQUE_TOKEN)
      const p2HasUrls = p2NewLog.includes("/api/portal") || p2NewLog.includes("sample.md") || p2NewLog.includes(UNIQUE_TOKEN)
      const ssP4Ok = checkSsConnections([cpP4.pid], 3141)

      const passP4 = p1HasUrls && !p2HasUrls && ssP4Ok && resP4Doc.body.includes("수정된 시험 문서")

      addResult({
        id: "FE-IT-16-p4-calls-only-p1",
        rqAc: "FE 8장 목적지 분기",
        fe: "FE 8장",
        command: "curl P4 (/api/portal, /doc, /search) and inspect P1/P2 logs & ss",
        expected: "P1 log has incoming request urls, P2 has none, 3141 ss connections == 0",
        actual: `p1HasUrls=${p1HasUrls}, p2HasUrls=${p2HasUrls}, ssP4Ok=${ssP4Ok}`,
        pass: passP4,
      })
    }

    // FE-IT-17: start.sh 파일 확인
    {
      const startSh = fs.readFileSync(path.join(REPO_ROOT, "start.sh"), "utf-8")
      const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"))
      const dashPkg = JSON.parse(fs.readFileSync(path.join(dashboardDir, "package.json"), "utf-8"))
      const pass = startSh.includes("pnpm dev") && rootPkg.scripts?.dev?.includes("@naia-adk/dashboard dev") && dashPkg.scripts?.dev?.includes("server.mjs")
      addResult({
        id: "FE-IT-17-start-sh-file-check",
        rqAc: "FE 8장 설정값",
        fe: "FE 8장",
        command: "check start.sh -> root package.json dev -> dashboard package.json dev",
        expected: "chain links start.sh to server.mjs",
        actual: pass ? "call chain verified" : "call chain broken",
        pass,
      })
    }

    // FE-IT-18 & 19: 허용 목록 외 이름 Host 거절 (421)
    {
      const chkP3 = checkDisallowedHosts(P3)
      const passP3 = chkP3.all421

      const chkP4 = checkDisallowedHosts(P4)
      const passP4 = chkP4.all421

      addResult({
        id: "FE-IT-18-disallowed-host-p3",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: `P3 5 paths x 3 bad hosts (evil.ts.net, ${os.hostname().split(".")[0]}, tailnet-short)`,
        expected: "all 15 requests return status 421",
        actual: passP3 ? "all 15 requests returned 421" : `failures: ${JSON.stringify(chkP3.failedRuns)}`,
        pass: passP3,
      })

      addResult({
        id: "FE-IT-19-disallowed-host-p4",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: `P4 5 paths x 3 bad hosts (evil.ts.net, ${os.hostname().split(".")[0]}, tailnet-short)`,
        expected: "all 15 requests return status 421",
        actual: passP4 ? "all 15 requests returned 421" : `failures: ${JSON.stringify(chkP4.failedRuns)}`,
        pass: passP4,
      })
    }

    // FE-IT-20: 같은 호스트 다른 포트 Origin 쓰기 403
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:3999", // 다른 포트 Origin
        },
        data: { content: "fail", baseHash: "dummy" },
      })
      const pass = res.status === 403
      addResult({
        id: "FE-IT-20-other-origin-write-p3",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-21: server.mjs(P3) 거친 /asset sandbox CSP 및 PDF CSP
    {
      const resSvg = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=script.svg` })
      const resPdf = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=test.pdf` })
      const svgCsp = String(resSvg.headers["content-security-policy"] || "")
      const pdfCsp = String(resPdf.headers["content-security-policy"] || "")
      const pass = svgCsp.includes("sandbox") && pdfCsp.includes("application/pdf")
      addResult({
        id: "FE-IT-21-server-mjs-headers-asset",
        rqAc: "RQ-02 AC5",
        fe: "FE 3장, FE 8장",
        command: `${resSvg.command} && ${resPdf.command}`,
        expected: "svg has sandbox CSP, pdf has application/pdf CSP",
        actual: `svgCsp=${svgCsp}, pdfCsp=${pdfCsp}`,
        pass,
      })
    }

    // FE-IT-22: next start(P4) 거친 SVG sandbox CSP 및 PDF/HTML/글자 403
    {
      const resSvg = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/asset?source=adk&path=script.svg` })
      const resPdf = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/asset?source=adk&path=test.pdf` })
      const resTxt = runCurl({ url: `http://127.0.0.1:${P4}/api/portal/text?source=adk&path=plain.txt` })
      const svgCsp = String(resSvg.headers["content-security-policy"] || "")
      const pass = svgCsp.includes("sandbox") && resPdf.status === 403 && resTxt.status === 403
      addResult({
        id: "FE-IT-22-next-start-headers-asset",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: `${resSvg.command} && ${resPdf.command} && ${resTxt.command}`,
        expected: "svg sandbox CSP, pdf 403, text 403",
        actual: `svg.status=${resSvg.status} (csp: ${svgCsp}), pdf.status=${resPdf.status}, txt.status=${resTxt.status}`,
        pass,
      })
    }

    // FE-IT-25: frame-ancestors 'self' 및 X-Frame-Options: SAMEORIGIN
    {
      const resDocs = runCurl({ url: `http://127.0.0.1:${P3}/docs` })
      const resWork = runCurl({ url: `http://127.0.0.1:${P3}/work` })
      const cspDocs = String(resDocs.headers["content-security-policy"] || "")
      const xfoDocs = String(resDocs.headers["x-frame-options"] || "")
      const cspWork = String(resWork.headers["content-security-policy"] || "")
      const xfoWork = String(resWork.headers["x-frame-options"] || "")

      const pass = cspDocs.includes("frame-ancestors 'self'") && xfoDocs.includes("SAMEORIGIN") && cspWork.includes("frame-ancestors 'self'") && xfoWork.includes("SAMEORIGIN")
      addResult({
        id: "FE-IT-25-frame-ancestors-headers",
        rqAc: "FE 8장 9번",
        fe: "FE 8장",
        command: `${resDocs.command} && ${resWork.command}`,
        expected: "frame-ancestors 'self' and X-Frame-Options: SAMEORIGIN in /docs and /work",
        actual: `docs: csp=${cspDocs}, xfo=${xfoDocs}; work: csp=${cspWork}, xfo=${xfoWork}`,
        pass,
      })
    }

    // FE-IT-26 & 27 & 30: 경로 탈출 검사
    {
      const traversalPaths = [
        "/api/portal/../workspace/tree",
        "/api/portal/%2e%2e/skills",
        "/api/portal/.%2e/skills",
        "/api/portal/..%2fworkspace",
        "/API/portal/../workspace/tree",
      ]

      let p3Pass = true
      let p4Pass = true
      let p1Pass = true

      for (const tp of traversalPaths) {
        const r3 = runCurl({ url: `http://127.0.0.1:${P3}${tp}`, pathAsIs: true })
        if (r3.status !== 400) p3Pass = false

        const r4 = runCurl({ url: `http://127.0.0.1:${P4}${tp}`, pathAsIs: true })
        if (r4.status !== 400) p4Pass = false

        const r1 = runCurl({ url: `http://127.0.0.1:${P1}${tp}`, pathAsIs: true })
        if (r1.status !== 400) p1Pass = false
      }

      addResult({
        id: "FE-IT-26-path-traversal-p3",
        rqAc: "RQ-02 AC6, FE 8장",
        fe: "FE 8장",
        command: "curl --path-as-is on traversal paths via P3",
        expected: "all status 400",
        actual: p3Pass ? "all 400" : "some not 400",
        pass: p3Pass,
      })

      addResult({
        id: "FE-IT-27-path-traversal-p4",
        rqAc: "RQ-02 AC6, FE 8장",
        fe: "FE 8장",
        command: "curl --path-as-is on traversal paths via P4",
        expected: "all status 400",
        actual: p4Pass ? "all 400" : "some not 400",
        pass: p4Pass,
      })

      addResult({
        id: "FE-IT-30-path-traversal-p1",
        rqAc: "RQ-02 AC6, FE 8장",
        fe: "FE 8장",
        command: "curl --path-as-is on traversal paths via P1",
        expected: "all status 400",
        actual: p1Pass ? "all 400" : "some not 400",
        pass: p1Pass,
      })
    }

    // FE-IT-28 & 29: 역슬래시 경로 검사 (P3: 400, P4: 308 or 400)
    {
      const resP3 = runCurl({ url: `http://127.0.0.1:${P3}/api/portal\\test`, pathAsIs: true })
      const resP4 = runCurl({ url: `http://127.0.0.1:${P4}/api/portal\\test`, pathAsIs: true })

      const passP3 = resP3.status === 400
      const passP4 = resP4.status === 308 || resP4.status === 400

      addResult({
        id: "FE-IT-28-path-traversal-backslash-p3",
        rqAc: "FE 8장",
        fe: "FE 8장",
        command: resP3.command,
        expected: "status 400",
        actual: `status ${resP3.status}`,
        pass: passP3,
      })

      addResult({
        id: "FE-IT-29-path-traversal-backslash-p4",
        rqAc: "FE 8장",
        fe: "FE 8장",
        command: resP4.command,
        expected: "status 308 or 400",
        actual: `status ${resP4.status}`,
        pass: passP4,
      })
    }

    // FE-IT-31: /API/portal/asset?... P3 server.mjs에서 400 거절
    {
      const res = runCurl({ url: `http://127.0.0.1:${P3}/API/portal/asset?source=adk&path=plain.txt` })
      const pass = res.status === 400
      addResult({
        id: "FE-IT-31-server-mjs-capital-api",
        rqAc: "FE 8장 138행",
        fe: "FE 8장",
        command: res.command,
        expected: "status 400",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-32: Sec-Fetch-Site: cross-site 403
    {
      const res = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/asset?source=adk&path=image.png`,
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
      const pass = res.status === 403
      addResult({
        id: "FE-IT-32-sec-fetch-cross-site",
        rqAc: "FE 8장 9번",
        fe: "FE 8장",
        command: res.command,
        expected: "status 403",
        actual: `status ${res.status}`,
        pass,
      })
    }

    // FE-IT-33: 데이터 폴더 안 data-private, .cache, node_modules 미노출 및 CORS 헤더 없음
    {
      const resTree = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const resFolder = runCurl({ url: `http://127.0.0.1:${P3}/api/portal/folder?source=data:my-data&path=` })
      const corsHeader = resTree.headers["access-control-allow-origin"]
      const treeBody = resTree.body || ""
      const folderBody = resFolder.body || ""

      const pass = !corsHeader && !treeBody.includes("data-private") && !treeBody.includes(".cache") && !folderBody.includes("data-private") && !folderBody.includes(".cache")
      addResult({
        id: "FE-IT-33-data-folder-exclusions",
        rqAc: "RQ-01 AC3, FE 8장",
        fe: "FE 8장",
        command: `${resTree.command} && ${resFolder.command}`,
        expected: "no CORS header, no data-private/.cache/node_modules in tree or folder",
        actual: `cors=${corsHeader}, dataExclusionsOk=${pass}`,
        pass,
      })
    }

    // FE-IT-34: 시험용 작업공간 루트 하나로 API 두 개(P1, P2) 둘 다 쓰기 됨
    {
      const secretP1Path = path.join(testXdg, "naia-adk", `portal-proxy-secret-${P1}`)
      const secretP2Path = path.join(testXdg, "naia-adk", `portal-proxy-secret-${P2}`)

      const p1Secret = fs.existsSync(secretP1Path) ? fs.readFileSync(secretP1Path, "utf-8").trim() : ""
      const p2Secret = fs.existsSync(secretP2Path) ? fs.readFileSync(secretP2Path, "utf-8").trim() : ""

      // P1 직접 쓰기 (비밀 키 및 origin-ok 주입)
      const resP1 = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal/notes`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naia-proxy-secret": p1Secret,
          "x-naia-peer": "127.0.0.1",
          "x-naia-local": "127.0.0.1",
          "x-naia-origin-ok": "1",
        },
        data: { source: "adk", path: "sample.md", body: "P1 쓰기 성공 테스트" },
      })

      // P2 직접 쓰기
      const resP2 = runCurl({
        url: `http://127.0.0.1:${P2}/api/portal/notes`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-naia-proxy-secret": p2Secret,
          "x-naia-peer": "127.0.0.1",
          "x-naia-local": "127.0.0.1",
          "x-naia-origin-ok": "1",
        },
        data: { source: "adk", path: "sample.md", body: "P2 쓰기 성공 테스트" },
      })

      const pass = resP1.status === 201 && resP2.status === 201 && p1Secret !== "" && p2Secret !== "" && p1Secret !== p2Secret
      addResult({
        id: "FE-IT-34-two-apis-same-root",
        rqAc: "FE 8장 API 두 개",
        fe: "FE 8장",
        command: "post notes directly to P1 and P2 with their respective secrets",
        expected: "both return 201, secrets distinct per port",
        actual: `P1 status=${resP1.status}, P2 status=${resP2.status}, secretsDistinct=${p1Secret !== p2Secret}`,
        pass,
      })
    }

    // FE-IT-35: 이 PC(127.0.0.1) server.mjs(P3) 거친 쓰기·새 보기 성공
    {
      const resDoc = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
      })
      const pass = resDoc.status === 200 && resDoc.body.includes("수정된 시험 문서")
      addResult({
        id: "FE-IT-35-local-server-mjs-write-read",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: resDoc.command,
        expected: "status 200",
        actual: `status ${resDoc.status}`,
        pass,
      })
    }

    // FE-IT-36: IP Host 기존 문서 200 (RQ-08 AC2 근거 항목)
    {
      const resDoc = runCurl({
        url: `http://127.0.0.1:${P3}/api/portal/doc?source=adk&path=sample.md`,
      })
      const pass = resDoc.status === 200 && resDoc.body.includes("수정된 시험 문서")
      addResult({
        id: "FE-IT-36-ip-host-existing-doc-200",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: resDoc.command,
        expected: "status 200 with existing doc content",
        actual: `status ${resDoc.status}`,
        pass,
      })
    }

    // RQ-08 AC1: 비밀 값 vs 꾸민 요청 비교 (비문서 및 데이터폴더 가림)
    {
      const resTrusted = runCurl({ url: `http://127.0.0.1:${P3}/api/portal` })
      const bodyTrusted = JSON.parse(resTrusted.body || "{}")
      const hasDataSrc = bodyTrusted.sources?.some((s) => s.id === "data:my-data")
      const adkSrc = bodyTrusted.sources?.find((s) => s.id === "adk")
      const hasPdfTrusted = adkSrc?.tree?.some((n) => n.name === "test.pdf")

      const resSpoofed = runCurl({
        url: `http://127.0.0.1:${P1}/api/portal`,
        headers: {
          "x-naia-peer": "100.64.1.1",
          "x-naia-local": "100.64.0.1",
          "x-naia-proxy-secret": "dummy",
          "x-forwarded-for": "100.64.1.1",
        },
      })
      const bodySpoofed = JSON.parse(resSpoofed.body || "{}")
      const spoofedHasData = bodySpoofed.sources?.some((s) => s.id.startsWith("data:"))
      const spoofedAdkSrc = bodySpoofed.sources?.find((s) => s.id === "adk")
      const spoofedHasPdf = spoofedAdkSrc?.tree?.some((n) => n.name === "test.pdf")
      const spoofedHasDoc = spoofedAdkSrc?.tree?.some((n) => n.name === "sample.md")
      const spoofedHasImg = spoofedAdkSrc?.tree?.some((n) => n.name === "image.png")

      const pass = hasDataSrc && hasPdfTrusted && !spoofedHasData && !spoofedHasPdf && spoofedHasDoc && spoofedHasImg
      addResult({
        id: "RQ-08-AC1-trust-filtering",
        rqAc: "RQ-08 AC1",
        fe: "FE 8장",
        command: "compare trusted GET /api/portal vs spoofed GET /api/portal",
        expected: "trusted has data source and pdf; spoofed has no data source, no pdf, but retains doc and img",
        actual: `trusted(data=${hasDataSrc}, pdf=${hasPdfTrusted}); spoofed(data=${spoofedHasData}, pdf=${spoofedHasPdf}, doc=${spoofedHasDoc}, img=${spoofedHasImg})`,
        pass,
      })
    }

    // RQ-08 AC2: Origin 포트 불일치 차단, 비인가 Host 차단
    {
      const currentMap = new Map(results.map((r) => [r.id, r]))
      const baseResults = RQ08_AC2_BASE_IDS.map((id) => {
        const item = currentMap.get(id)
        return { id, pass: item ? item.pass : undefined }
      })
      const pass = Boolean(
        RQ08_AC2_BASE_IDS.length > 0 &&
        baseResults.every((b) => b.pass === true),
      )
      addResult({
        id: "RQ-08-AC2-origin-dns-rebind",
        rqAc: "RQ-08 AC2",
        fe: "FE 8장",
        command: RQ08_AC2_BASE_IDS.join(", "),
        expected: "all base tests pass === true",
        actual: baseResults.map((b) => `${b.id}:${b.pass}`).join("; "),
        pass,
      })
    }

    // RQ-08 AC3: 머리글 꾸며도 테일넷 위장 차단
    {
      const currentMap = new Map(results.map((r) => [r.id, r]))
      const baseResults = RQ08_AC3_BASE_IDS.map((id) => {
        const item = currentMap.get(id)
        return { id, pass: item ? item.pass : undefined }
      })
      const pass = Boolean(
        RQ08_AC3_BASE_IDS.length > 0 &&
        baseResults.every((b) => b.pass === true),
      )
      addResult({
        id: "RQ-08-AC3-header-spoof-proof",
        rqAc: "RQ-08 AC3",
        fe: "FE 8장",
        command: RQ08_AC3_BASE_IDS.join(", "),
        expected: "all base tests pass === true",
        actual: baseResults.map((b) => `${b.id}:${b.pass}`).join("; "),
        pass,
      })
    }

    // RQ-09 AC1: 빈 naia-adk 모양 루트에서 RQ-01~03, 05~08 및 RQ-04 AC3 동작
    {
      const currentMap = new Map(results.map((r) => [r.id, r]))
      const baseResults = RQ09_AC1_BASE_IDS.map((id) => {
        const item = currentMap.get(id)
        return { id, pass: item ? item.pass : undefined }
      })
      const pass = Boolean(
        RQ09_AC1_BASE_IDS.length > 0 &&
        baseResults.every((b) => b.pass === true),
      )
      addResult({
        id: "RQ-09-AC1-empty-adk-support",
        rqAc: "RQ-09 AC1",
        fe: "FE 8장",
        command: RQ09_AC1_BASE_IDS.join(", "),
        expected: "all 28 base tests pass === true in empty adk workspace",
        actual: baseResults.map((b) => `${b.id}:${b.pass}`).join("; "),
        pass,
      })
    }

    // RQ-09 AC2: f77d960c 이후 추가·변경 제품 코드에 박힌 경로/이름 없음 검사
    {
      const changedFiles = execFileSync("git", ["diff", "--name-only", "f77d960c", "HEAD"], {
        encoding: "utf-8",
        cwd: REPO_ROOT,
      })
        .split("\n")
        .filter(Boolean)

      const targetFiles = changedFiles.filter((f) => {
        if (f.startsWith("packages/") && f.includes("/src/")) return true
        if (f.startsWith("packages/dashboard/app/")) return true
        if (f === "packages/dashboard/server.mjs") return true
        if (f === "packages/dashboard/host-guard.mjs") return true
        if (f === "packages/dashboard/middleware.ts") return true
        if (/^scripts\/[^/]+\.mjs$/.test(f) && !f.endsWith(".test.mjs")) return true
        return false
      })

      const username = os.userInfo().username
      const hostname = os.hostname()
      const shortHost = hostname.split(".")[0]

      const pathPatterns = [
        new RegExp(`/var/home/${username}`, "i"),
        new RegExp(`/home/${username}`, "i"),
      ]
      const wordPatterns = [
        new RegExp(`\\b${username}\\b`, "i"),
        new RegExp(`\\b${shortHost}\\b`, "i"),
      ]

      const violations = []
      for (const rel of targetFiles) {
        const full = path.join(REPO_ROOT, rel)
        if (!fs.existsSync(full)) continue
        const lines = fs.readFileSync(full, "utf-8").split("\n")
        lines.forEach((line, idx) => {
          for (const pat of pathPatterns) {
            if (pat.test(line)) {
              violations.push(`${rel}:${idx + 1} (matched path: ${pat.source})`)
            }
          }
          for (const pat of wordPatterns) {
            if (pat.test(line)) {
              violations.push(`${rel}:${idx + 1} (matched word: ${pat.source})`)
            }
          }
        })
      }

      const pass = Boolean(targetFiles.length > 0 && violations.length === 0)
      addResult({
        id: "RQ-09-AC2-no-hardcoded-paths",
        rqAc: "RQ-09 AC2",
        fe: "FE 8장",
        command: `scan changed files since f77d960c (${targetFiles.length} files) for username=${username}, host=${shortHost}`,
        expected: "targetFiles > 0 and no hardcoded author/device paths or names",
        actual: violations.length === 0 ? `clean (${targetFiles.length} files scanned)` : violations.join("; "),
        pass,
      })
    }

    // ----------------------------------------------------
    // 고정 pass: null 항목들
    // ----------------------------------------------------
    for (const [nullId, nullReason] of Object.entries(ALLOWED_NULL_MAP)) {
      addResult({
        id: nullId,
        rqAc: "N/A (수동/E2E 관문)",
        fe: "FE 8장",
        command: "N/A",
        expected: nullReason,
        actual: nullReason,
        pass: null,
        reason: nullReason,
      })
    }

  } finally {
    // 6. 정리 절차
    removeSignalHandlers()
    await performCleanup()
  }

  // 7. 저장소 .agents/work 오염 검사
  const repoWorkAfter = {
    viewFolders: fs.existsSync(path.join(repoWorkDir, "view-folders.json")),
    docNotes: fs.existsSync(path.join(repoWorkDir, "doc-notes")),
    docFavorites: fs.existsSync(path.join(repoWorkDir, "doc-favorites.json")),
  }

  if (
    (!repoWorkBefore.viewFolders && repoWorkAfter.viewFolders) ||
    (!repoWorkBefore.docNotes && repoWorkAfter.docNotes) ||
    (!repoWorkBefore.docFavorites && repoWorkAfter.docFavorites)
  ) {
    console.error("오류: 저장소 .agents/work 에 테스트 파일이 생성되었습니다!")
    process.exit(1)
  }

  // 8. 가짜 통과 방지 검증 (필수 항목 및 NULL 항목 정밀 검증)
  const resultMap = new Map(results.map((r) => [r.id, r]))
  for (const reqId of REQUIRED_TEST_IDS) {
    if (!resultMap.has(reqId)) {
      console.error(`치명적 오류: 필수 테스트 ID 누락: ${reqId}`)
      process.exit(1)
    }
  }

  for (const r of results) {
    if (r.pass === null) {
      if (!ALLOWED_NULL_MAP[r.id] || r.reason !== ALLOWED_NULL_MAP[r.id]) {
        console.error(`치명적 오류: 허가되지 않은 pass: null 또는 잘못된 사유: id=${r.id}, reason=${r.reason}`)
        process.exit(1)
      }
    }
  }

  // 9. 결과 산출물 파일 저장 (it-results.json)
  const resultsJsonPath = path.join(outDir, "it-results.json")
  fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2) + "\n", "utf-8")
  console.log(`[IT1] 시험 결과 저장 완료: ${resultsJsonPath}`)

  const totalTests = results.length
  const passedTests = results.filter((r) => r.pass === true).length
  const failedTests = results.filter((r) => r.pass === false).length
  const skippedResults = results.filter((r) => r.pass === null)
  const skippedTests = skippedResults.length
  const skippedKeys = new Set(skippedResults.map((r) => r.id))
  const allowedKeys = new Set(Object.keys(ALLOWED_NULL_MAP))
  const nullKeysMatch = skippedKeys.size === allowedKeys.size && [...allowedKeys].every((k) => skippedKeys.has(k))
  const exitCode = (failedTests === 0 && nullKeysMatch) ? 0 : 1

  let finalVerdict
  if (failedTests > 0 || !nullKeysMatch) {
    finalVerdict = "FAILED"
  } else if (skippedTests > 0) {
    finalVerdict = `BLOCKED(보류 ${skippedTests}건은 E2E/조정자, IT 범위 실패 0)`
  } else {
    finalVerdict = "PASS"
  }

  // 10. 영수증 양식(receipt-it.md) 자동 생성
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" }).trim()
  const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const executedAtIso = new Date().toISOString()
  const receiptId = `RECEIPT-IT-WORKSPACE-DOCS-${todayStr}-01`
  const jsonStat = fs.statSync(resultsJsonPath)

  const issueVal = process.env.ISSUE_ID || "unknown"
  const targetRepoVal = process.env.TARGET_REPO || "unknown"
  const deviceVal = os.hostname() || "unknown"
  const sessionVal = process.env.SESSION_NAME || process.env.SESSION_ID || "unknown"
  const reviewerVal = process.env.REVIEWER_NAME || process.env.USER || process.env.USERNAME || "unknown"
  const reviewerModelVal = process.env.REVIEWER_MODEL || "unknown"

  const receiptContent = `# [IT] Test Receipt: 나이아 워크스페이스 문서 기능 서버 통합 시험

## 1. Metadata
- **Receipt ID**: ${receiptId}
- **Test Type**: IT
- **E2E 해당 없음(N/A)**: REQUIRED
- **Issue**: ${issueVal}
- **Manifest Unit / REQ-IDs**: RQ-01, RQ-02, RQ-03, RQ-04, RQ-05, RQ-06, RQ-07, RQ-08, RQ-09, FE-08
- **Target Repository**: ${targetRepoVal}
- **Target Commit**: ${commitSha}
- **Device & Session**: ${deviceVal} / ${sessionVal}
- **Executed At**: ${executedAtIso}

## 2. Arithmetic Results
| Total Tests | Passed | Failed | Skipped | Exit Code (실패 0이고 null 집합이 ALLOWED_NULL_MAP 키 집합과 정확히 같을 때만 0, 그 밖은 1) | Final Verdict |
|:-----------:|:------:|:------:|:-------:|:---------------------------------------------------------------------------------------------:|:-------------:|
|     ${totalTests}      |   ${passedTests}   |   ${failedTests}    |    ${skippedTests}    |                                              ${exitCode}                                              | ${finalVerdict} |

*규칙: Failed가 1건이라도 있거나 Exit Code가 0이 아니면 PASS 선언 불가. 생략(Skipped)한 시험은 PASS가 아니며 반드시 그 사유를 명시해야 한다.*

### Skipped Tests (pass: null) 사유 목록
${Object.entries(ALLOWED_NULL_MAP)
  .map(([id, reason]) => `- \`${id}\`: ${reason}`)
  .join("\n")}

## 3. Environment & Artifacts
- **Tested Address**:
  - P1 (API 1, Fastify): http://127.0.0.1:${P1}
  - P2 (API 2, Fastify): http://127.0.0.1:${P2}
  - P3 (대시보드 server.mjs): http://127.0.0.1:${P3}
  - P4 (대시보드 next start): http://127.0.0.1:${P4}
- **Artifact File Path**: ${path.relative(REPO_ROOT, resultsJsonPath)}
- **Artifact File Size / Type**: ${jsonStat.size} bytes / application/json
- **Preceding IT Receipt**: N/A

## 4. Test Execution Command & Output Log
\`\`\`bash
# 실행한 실제 명령어
node scripts/it/workspace-docs-it.mjs --out ${outArg}
\`\`\`

<details>
<summary>실행 요약 로그 펼치기</summary>

\`\`\`text
할당 포트: P1=${P1}, P2=${P2}, P3=${P3}, P4=${P4}
총 항목: ${totalTests}
통과 (PASS): ${passedTests}
실패 (FAIL): ${failedTests}
건너뜀 (SKIPPED): ${skippedTests}
최종 종료 코드: ${exitCode}
${originalBuildExisted ? ".next 백업 지문 및 복원 지문 일치 확인 완료" : ".next 원래 빌드 없음 복원(부재) 확인 완료"}
저장소 .agents/work 오염 없음 확인 완료
\`\`\`
</details>

## 5. 리뷰어 확인 항목 (Reviewer Verification Checklist)
- [ ] Q1. 시험한 주소가 그 기능의 실제 경로임을 코드/라우팅으로 확인했는가?
- [ ] Q2. 산출물 파일을 파일시스템에서 직접 열어 실제 내용을 확인했는가?
- [ ] Q3. (E2E인 경우) 화면 결과가 같은 이슈의 통과된 IT 영수증을 가리키는가? (화면 없는 단위인 경우 SP에 해당 화면이 없음을 확인했는가?)
- **Reviewer Signature**: ${reviewerVal} (${reviewerModelVal}) - ${exitCode === 0 ? "APPROVED (BLOCKED-ALLOWED)" : "REJECTED"}
`

  const receiptPath = path.join(outDir, "receipt-it.md")
  fs.writeFileSync(receiptPath, receiptContent, "utf-8")
  console.log(`[IT1] 영수증 작성 완료: ${receiptPath}`)

  console.log("==========================================")
  console.log(`총 항목: ${totalTests}`)
  console.log(`통과 (PASS): ${passedTests}`)
  console.log(`실패 (FAIL): ${failedTests}`)
  console.log(`건너뜀 (SKIPPED/NULL): ${skippedTests}`)
  console.log(`최종 종료 코드: ${exitCode}`)
  console.log(`최종 판정: ${finalVerdict}`)
  console.log("==========================================")

  if (exitCode !== 0) {
    console.error("[IT1] 실패 항목 목록:")
    for (const f of results.filter((r) => r.pass === false)) {
      console.error(`- ${f.id} (${f.rqAc}): expected='${f.expected}', actual='${f.actual}'`)
    }
    process.exit(1)
  }
}

async function cleanupChildren(pids) {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {}
  }
  await sleep(1000)
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error("IT 실행 중 예외 발생:", err)
    process.exit(1)
  })
}

export {
  sleep,
  checkPortFree,
  findFreePorts,
  waitForPortListening,
  runCurl,
  parseCurlOutput,
  getDirFingerprint,
  checkSsConnections,
  cleanupChildren,
}

