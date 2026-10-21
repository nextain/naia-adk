#!/usr/bin/env node
/**
 * scripts/e2e/workspace-docs-e2e.mjs
 *
 * 나이아 워크스페이스 문서 기능 브라우저 E2E 검증 스크립트
 *
 * 실행:
 *   node scripts/e2e/workspace-docs-e2e.mjs --mode scratch --out .agents/work/e2e1
 *   node scripts/e2e/workspace-docs-e2e.mjs --mode uc01 --root <루트> --out <폴더> \
 *     --content-source <id> --script-source <id> --plan-source <id> \
 *     --plan-path <경로> --episode <편폴더>
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import process from "node:process"
import crypto from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

import {
  sleep,
  findFreePorts,
  waitForPortListening,
  getDirFingerprint,
  cleanupChildren,
} from "../it/workspace-docs-it.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, "../..")

const require = createRequire(import.meta.url)
let chromium
try {
  const modPath = process.env.PLAYWRIGHT_MODULE || "playwright"
  const pw = require(modPath)
  chromium = pw.chromium
} catch (err) {
  console.error("Playwright를 불러올 수 없습니다.")
  console.error("설치 방법:")
  console.error("  pnpm add -D playwright")
  console.error("  npx playwright install chromium")
  console.error("또는 환경 변수로 지정:")
  console.error("  PLAYWRIGHT_MODULE=/path/to/playwright node scripts/e2e/workspace-docs-e2e.mjs ...")
  process.exit(1)
}

// 고정 안내 문구 (SP, kinds.ts SoT)
const MSG_TRUNCATED_GRID = "500개까지만 보입니다"
const MSG_FORBIDDEN = "이 주소에서는 문서만 볼 수 있습니다"
const MSG_CONFLICT_DOC =
  "편집을 연 뒤 이 문서가 바뀌었습니다. 쓰신 글은 그대로 두었으니 복사해 두고 새로 고쳐 주세요."
const MSG_SAVED_DOC = "저장했습니다. 아직 저장소에는 올리지 않았습니다."
const MSG_UNSUPPORTED_PREVIEW = "미리 볼 수 없는 파일입니다"
const MSG_CONFIRM_DISCARD = "고친 내용이 사라집니다. 나갈까요?"
const MSG_READ_ONLY = "보기 전용"
const MSG_NOT_FOUND = "찾을 수 없음"
const MSG_QUOTE_WHOLE_DOC = "문서 전체"
const MSG_READ_ONLY_DOC = "이 출처는 보기 전용이라 문서를 고칠 수 없습니다"
const MSG_FAVORITES_INVALID = "즐겨찾기 파일을 읽을 수 없어 바꾸지 않았습니다"

// 4x4 PNG (검은색 4x4 비트맵)
const SAMPLE_PNG_4X4 = Buffer.from(
  [
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAE",
    "CAYAAACp8Z5+AAAAAXNSR0IArs4c6QAA",
    "AARnQU1BAACxjwv8YQUAAAAJcEhZcwAA",
    "DsMAAA7DAcdvqGQAAAAUSURBVBhXY2AY",
    "BcMIA0YGBgYGBgAB6QABFqT1qQAAAABJ",
    "RU5ErkJggg==",
  ].join(""),
  "base64",
)

// 1초 유효 MP4 (H.264 320x240 무음 단편)
const SAMPLE_MP4_1S = Buffer.from(
  [
    "AAAAJGZ0eXBpc29tAAACAGlzb21pc282",
    "aXNvMmF2YzFtcDQxAAADFG1vb3YAAABs",
    "bXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAA",
    "AAEAAAEAAAAAAAAAAAAAAAABAAAAAAAA",
    "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAA",
    "QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AAAAAAAAAAIAAAHxdHJhawAAAFx0a2hk",
    "AAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAA",
    "AAAAAAAAAAAAAAAAAAAAAAABAAAAAAAA",
    "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAA",
    "QAAAAAFAAAAA8AAAAAABjW1kaWEAAAAg",
    "bWRoZAAAAAAAAAAAAAAAAAAAMgAAAAAA",
    "VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRl",
    "AAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVy",
    "AAAAAThtaW5mAAAAFHZtaGQAAAABAAAA",
    "AAAAAAAAAAAkZGluZgAAABxkcmVmAAAA",
    "AAAAAAEAAAAMdXJsIAAAAAEAAAD4c3Ri",
    "bAAAAKxzdHNkAAAAAAAAAAEAAACcYXZj",
    "MQAAAAAAAAABAAAAAAAAAAAAAAAAAAAA",
    "AAFAAPAASAAAAEgAAAAAAAAAARVMYXZj",
    "NjIuMjguMTAyIGxpYngyNjQAAAAAAAAA",
    "AAAAABj//wAAADZhdmNDAWQADf/hABln",
    "ZAANrNlBQfsBEAAAAwAQAAADAyDxQplg",
    "AQAGaOvjyyLA/fj4AAAAABBwYXNwAAAA",
    "AQAAAAEAAAAQc3R0cwAAAAAAAAAAAAAA",
    "EHN0c2MAAAAAAAAAAAAAABRzdHN6AAAA",
    "AAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAA",
    "AAAAAChtdmV4AAAAIHRyZXgAAAAAAAAA",
    "AQAAAAEAAAAAAAAAAAAAAAAAAACHdWR0",
    "YQAAAH9tZXRhAAAAAAAAACFoZGxyAAAA",
    "AAAAAABtZGlyYXBwbAAAAAAAAAAAAAAA",
    "AFJpbHN0AAAAJal0b28AAAAdZGF0YQAA",
    "AAEAAAAATGF2ZjYyLjEyLjEwMgAAACWp",
    "ZW5jAAAAHWRhdGEAAAABAAAAAExhdmY2",
    "Mi4xMi4xMDIAAAE4bW9vZgAAABBtZmhk",
    "AAAAAAAAAAEAAAEgdHJhZgAAACR0Zmhk",
    "AAAAOQAAAAEAAAAAAAADOAAAAgAAAALp",
    "AQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAA",
    "AAAA4HRydW4AAAoFAAAAGQAAAUACAAAA",
    "AAAC6QAABAAAAAARAAAKAAAAAA4AAAQA",
    "AAAADgAAAAAAAAAOAAACAAAAABcAAAoA",
    "AAAAEAAABAAAAAAOAAAAAAAAAA4AAAIA",
    "AAAAFwAACgAAAAAQAAAEAAAAAA4AAAAA",
    "AAAADgAAAgAAAAAXAAAKAAAAABAAAAQA",
    "AAAADgAAAAAAAAAOAAACAAAAABYAAAoA",
    "AAAAEAAABAAAAAAOAAAAAAAAAA4AAAIA",
    "AAAAFgAACgAAAAAQAAAEAAAAAA4AAAAA",
    "AAAADgAAAgAAAAR5bWRhdAAAAqAGBf//",
    "nNxF6b3m2Ui3lizYINkj7u94MjY0IC0g",
    "Y29yZSAxNjUgLSBILjI2NC9NUEVHLTQg",
    "QVZDIGNvZGVjIC0gQ29weWxlZnQgMjAw",
    "My0yMDI1IC0gaHR0cDovL3d3dy52aWRl",
    "b2xhbi5vcmcveDI2NC5odG1sIC0gb3B0",
    "aW9uczogY2FiYWM9MSByZWY9MyBkZWJs",
    "b2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4",
    "MTEzIG1lPWhleCBzdWJtZT03IHBzeT0x",
    "IHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRf",
    "cmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21h",
    "X21lPTEgdHJlbGxpcz0xIDh4OGRjdD0x",
    "IGNxbT0wIGRlYWR6b25lPTIxLDExIGZh",
    "c3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zm",
    "c2V0PS0yIHRocmVhZHM9NyBsb29rYWhl",
    "YWRfdGhyZWFkcz0xIHNsaWNlZF90aHJl",
    "YWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGlu",
    "dGVybGFjZWQ9MCBibHVyYXlfY29tcGF0",
    "PTAgY29uc3RyYWluZWRfaW50cmE9MCBi",
    "ZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9h",
    "ZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0x",
    "IHdlaWdodGI9MSBvcGVuX2dvcD0wIHdl",
    "aWdodHA9MiBrZXlpbnQ9MjUwIGtleWlu",
    "dF9taW49MjUgc2NlbmVjdXQ9NDAgaW50",
    "cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVh",
    "ZD00MCByYz1jcmYgbWJ0cmVlPTEgY3Jm",
    "PTIzLjAgcWNvbXA9MC42MCBxcG1pbj0w",
    "IHFwbWF4PTY5IHFwc3RlcD00IGlwX3Jh",
    "dGlvPTEuNDAgYXE9MToxLjAwAIAAAABB",
    "ZYiEADv//uOr+BTYUFR0TMUo/oW0Y0/P",
    "FJds8hM3HK/+B301YAAsYZb0KcZMlUbQ",
    "ASwAABLAzYYwmqnJPPr6V1EAAAANQZok",
    "bEO//qmWAABvwAAAAApBnkJ4hf8AAIOB",
    "AAAACgGeYXRCvwAAtoAAAAAKAZ5jakK/",
    "AAC2gQAAABNBmmhJqEFomUwId//+qZYA",
    "AG/BAAAADEGehkURLC//AACDgQAAAAoB",
    "nqV0Qr8AALaBAAAACgGep2pCvwAAtoAA",
    "AAATQZqsSahBbJlMCHf//qmWAABvwAAA",
    "AAxBnspFFSwv/wAAg4EAAAAKAZ7pdEK/",
    "AAC2gAAAAAoBnutqQr8AALaAAAAAE0Ga",
    "8EmoQWyZTAhv//6nhAAA3oEAAAAMQZ8O",
    "RRUsL/8AAIOBAAAACgGfLXRCvwAAtoEA",
    "AAAKAZ8vakK/AAC2gAAAABJBmzRJqEFs",
    "mUwIZ//+nhAAA2YAAAAMQZ9SRRUsL/8A",
    "AIOBAAAACgGfcXRCvwAAtoAAAAAKAZ9z",
    "akK/AAC2gAAAABJBm3hJqEFsmUwIV//+",
    "OEAADUkAAAAMQZ+WRRUsL/8AAIOAAAAA",
    "CgGftXRCvwAAtoEAAAAKAZ+3akK/AAC2",
    "gQAAAENtZnJhAAAAK3RmcmEBAAAAAAAA",
    "AQAAAAAAAAABAAAAAAAABAAAAAAAAAAD",
    "OAEBAQAAABBtZnJvAAAAAAAAAEM=",
  ].join(""),
  "base64",
)

// 1초 유효 WAV 생성 함수 (44100Hz 16-bit PCM 모노 무음)
function createWavBuffer(seconds = 1, sampleRate = 44100) {
  const numSamples = sampleRate * seconds
  const buf = Buffer.alloc(44 + numSamples * 2)
  buf.write("RIFF", 0)
  buf.writeUInt32LE(36 + numSamples * 2, 4)
  buf.write("WAVE", 8)
  buf.write("fmt ", 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // Mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32) // BlockAlign
  buf.writeUInt16LE(16, 34) // BitsPerSample
  buf.write("data", 36)
  buf.writeUInt32LE(numSamples * 2, 40)
  return buf
}

// ── 검수 반영 3 & 9: 작업공간 내 잔류 프로세스 검사 ────────────────────────
function checkNoRunningProcesses(repoRoot) {
  if (process.platform !== "linux") return
  const myPid = process.pid
  const myPpid = process.ppid
  const pids = fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))
  const found = []
  for (const pid of pids) {
    const p = parseInt(pid, 10)
    if (p === myPid || p === myPpid) continue
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
      if (cwd === repoRoot || cwd.startsWith(`${repoRoot}/`)) {
        const rawCmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8")
        const args = rawCmd.split("\0").filter(Boolean)
        if (args.length === 0) continue
        const bin = args[0]
        // agy 또는 부모 agent 실행 래퍼는 제외
        if (bin.includes("agy") || bin.includes("timeout") || args.some((a) => a.includes("--dangerously-skip-permissions"))) {
          continue
        }
        const cmdStr = args.join(" ")
        const isNextBuild = (bin.endsWith("next") || cmdStr.includes("/next")) && args.includes("build")
        const isNextStart = (bin.endsWith("next") || cmdStr.includes("/next")) && args.includes("start")
        const isServerMjs = args.some((a) => a.endsWith("server.mjs"))
        if (isNextBuild || isNextStart || isServerMjs) {
          found.push({ pid, cmd: cmdStr.slice(0, 100), cwd })
        }
      }
    } catch {}
  }
  if (found.length > 0) {
    throw new Error(`동일 작업공간에서 이미 실행 중인 프로세스가 있습니다: ${JSON.stringify(found)}`)
  }
}

// ── 트리 안정화 대기 (트리 항목 수가 지정 시간 동안 변하지 않을 때까지 대기) ──
async function waitForStableTree(page, stableMs = 500, timeout = 10000) {
  const startTime = Date.now()
  let lastCount = -1
  let lastChange = Date.now()
  while (Date.now() - startTime < timeout) {
    const count = await page
      .evaluate(() => document.querySelectorAll("aside a, aside button, aside li, aside div[role='treeitem']").length)
      .catch(() => -1)
    const now = Date.now()
    if (count !== lastCount) {
      lastCount = count
      lastChange = now
    } else if (now - lastChange >= stableMs) {
      return count
    }
    await sleep(50)
  }
  return lastCount
}

// ── 화면 보이는 글 검사 (화면 글 규칙: 절대경로, /api/, 64자 hex 금지) ─────
async function checkVisibleTextViolations(page, testWsRoot) {
  const text = await page.evaluate(() => document.body.innerText || "")
  const violations = []
  if (/\/(?:var\/)?home\/[^\s"')]+/i.test(text)) {
    violations.push("Found absolute path (/home/ or /var/home/) in visible text")
  }
  if (testWsRoot && text.includes(testWsRoot)) {
    violations.push("Found testWsRoot path in visible text")
  }
  if (/\/api\/[a-z0-9_-]+/i.test(text)) {
    violations.push("Found /api/ path in visible text")
  }
  if (/\b[a-f0-9]{64}\b/i.test(text)) {
    violations.push("Found 64-character hex hash in visible text")
  }
  return violations
}

// ── 메인 함수 ─────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  let mode = "scratch"
  let outArg = null
  let rootArg = null
  let contentSource = null
  let scriptSource = null
  let planSource = null
  let planPath = null
  let episode = null
  let contentTab = "common"
  let scriptTab = "common"
  let planTab = "common"

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && argv[i + 1]) mode = argv[++i]
    else if (argv[i] === "--out" && argv[i + 1]) outArg = argv[++i]
    else if (argv[i] === "--root" && argv[i + 1]) rootArg = argv[++i]
    else if (argv[i] === "--content-source" && argv[i + 1]) contentSource = argv[++i]
    else if (argv[i] === "--script-source" && argv[i + 1]) scriptSource = argv[++i]
    else if (argv[i] === "--plan-source" && argv[i + 1]) planSource = argv[++i]
    else if (argv[i] === "--plan-path" && argv[i + 1]) planPath = argv[++i]
    else if (argv[i] === "--episode" && argv[i + 1]) episode = argv[++i]
    else if (argv[i] === "--content-tab" && argv[i + 1]) contentTab = argv[++i]
    else if (argv[i] === "--script-tab" && argv[i + 1]) scriptTab = argv[++i]
    else if (argv[i] === "--plan-tab" && argv[i + 1]) planTab = argv[++i]
  }

  if (!outArg) {
    console.error("오류: --out <폴더> 인자는 필수입니다.")
    process.exit(1)
  }

  const outDir = path.resolve(outArg)
  fs.mkdirSync(outDir, { recursive: true })

  if (mode === "uc01") {
    await runUc01Mode({
      rootArg,
      outDir,
      contentSource,
      scriptSource,
      planSource,
      planPath,
      episode,
      contentTab,
      scriptTab,
      planTab,
    })
    return
  }

  if (mode === "scratch") {
    await runScratchMode({ outDir })
    return
  }

  console.error(`오류: 알 수 없는 모드입니다: "${mode}" (--mode scratch 또는 --mode uc01)`)
  process.exit(1)
}

// =========================================================================
// .next 백업 / 복원 / 이전 실행 복구 헬퍼 함수
// =========================================================================
function recoverPreviousNextBackup({
  dashboardDir,
  dotNextDir,
  nextBackupDir,
  nextBackupFingerprintFile,
  tag = "E2E1",
}) {
  if (!fs.existsSync(nextBackupDir) && !fs.existsSync(nextBackupFingerprintFile)) {
    return
  }

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

  let staleDir = null
  if (fs.existsSync(dotNextDir)) {
    do {
      const rnd = crypto.randomBytes(6).toString("hex")
      staleDir = path.join(dashboardDir, `.next.${tag.toLowerCase()}-stale-${rnd}`)
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

function backupNextDir({
  dotNextDir,
  nextBackupDir,
  nextBackupFingerprintFile,
  tag = "E2E1",
}) {
  const originalBuildExisted = fs.existsSync(dotNextDir)
  let initialNextFingerprint = null
  let backupMoved = false

  const workDir = path.dirname(nextBackupFingerprintFile)
  fs.mkdirSync(workDir, { recursive: true })

  if (originalBuildExisted) {
    console.log(`[${tag}] 기존 packages/dashboard/.next 지문 채취 및 백업...`)
    initialNextFingerprint = getDirFingerprint(dotNextDir)
    fs.writeFileSync(
      nextBackupFingerprintFile,
      JSON.stringify(initialNextFingerprint, null, 2),
      "utf-8",
    )
    fs.renameSync(dotNextDir, nextBackupDir)
    backupMoved = true
  } else {
    console.log(`[${tag}] 기존 packages/dashboard/.next 없음 (원래 빌드 없음 기록)...`)
    fs.writeFileSync(
      nextBackupFingerprintFile,
      JSON.stringify({ noOriginalBuild: true }, null, 2),
      "utf-8",
    )
    initialNextFingerprint = null
    backupMoved = false
  }

  return { originalBuildExisted, initialNextFingerprint, backupMoved }
}

function restoreNextDir({
  dashboardDir,
  dotNextDir,
  nextBackupDir,
  nextBackupFingerprintFile,
  originalBuildExisted,
  backupMoved,
  initialNextFingerprint,
  tag = "E2E1",
}) {
  if (originalBuildExisted) {
    if (backupMoved) {
      console.log(`[${tag}] 시험 빌드 치우기 및 원본 .next 복원...`)
      let staleDir = null
      if (fs.existsSync(dotNextDir)) {
        do {
          const rnd = crypto.randomBytes(6).toString("hex")
          staleDir = path.join(dashboardDir, `.next.${tag.toLowerCase()}-stale-${rnd}`)
        } while (fs.existsSync(staleDir))

        try {
          fs.renameSync(dotNextDir, staleDir)
        } catch (err) {
          console.error(`[${tag} 치명적 오류] 시험 .next rename 실패:`, err.message)
          process.exit(1)
        }
      }

      if (fs.existsSync(nextBackupDir)) {
        try {
          fs.renameSync(nextBackupDir, dotNextDir)
        } catch (err) {
          console.error(`[${tag} 치명적 오류] .next 백업 복원 rename 실패:`, err.message)
          process.exit(1)
        }
      } else {
        console.error(`[${tag} 치명적 오류] .next 백업 디렉터리를 찾을 수 없습니다!`)
        process.exit(1)
      }

      const restoredFingerprint = getDirFingerprint(dotNextDir)
      const matched = JSON.stringify(initialNextFingerprint) === JSON.stringify(restoredFingerprint)
      if (!matched) {
        console.error(`치명적 오류: 복원된 .next 지문이 시작 때와 다릅니다!`)
        process.exit(1)
      } else {
        console.log(`[${tag}] .next 지문 완벽 복원 확인됨.`)
        if (staleDir && fs.existsSync(staleDir)) {
          try {
            fs.rmSync(staleDir, { recursive: true, force: true })
          } catch {}
        }
        if (fs.existsSync(nextBackupFingerprintFile)) {
          try {
            fs.unlinkSync(nextBackupFingerprintFile)
          } catch {}
        }
      }
    }
  } else {
    console.log(`[${tag}] 원래 빌드 없음: 시험이 생성한 packages/dashboard/.next 삭제...`)
    if (fs.existsSync(dotNextDir)) {
      try {
        fs.rmSync(dotNextDir, { recursive: true, force: true })
      } catch (err) {
        console.error(`[${tag} 치명적 오류] 시험 .next 삭제 실패:`, err.message)
        process.exit(1)
      }
    }
    if (fs.existsSync(dotNextDir)) {
      console.error(`치명적 오류: .next 삭제 확인 실패 (디렉터리 잔류)`)
      process.exit(1)
    }
    console.log(`[${tag}] .next 원래 빌드 없음 복원 확인됨 (.next 없음).`)

    if (fs.existsSync(nextBackupFingerprintFile)) {
      try {
        fs.unlinkSync(nextBackupFingerprintFile)
      } catch {}
    }
  }
}

// =========================================================================
// MODE: SCRATCH (UC-02~06, SP-06, 추가 확인 항목 E2E 관통 검증)
// =========================================================================
async function runScratchMode({ outDir }) {
  console.log(`[E2E1 scratch] 시작: 결과 폴더 ${outDir}`)

  // 1. 잔류 프로세스 검사
  checkNoRunningProcesses(REPO_ROOT)

  // 시작 전 저장소 .agents/work 상태 기록 (오염 방지 및 원래 존재 여부)
  const repoWorkDir = path.join(REPO_ROOT, ".agents", "work")
  const repoWorkExistedInitially = fs.existsSync(repoWorkDir)
  const repoWorkBefore = {
    viewFolders: fs.existsSync(path.join(repoWorkDir, "view-folders.json")),
    docNotes: fs.existsSync(path.join(repoWorkDir, "doc-notes")),
    docFavorites: fs.existsSync(path.join(repoWorkDir, "doc-favorites.json")),
  }

  // 2. .next 백업 및 이전 실행 복구 (e2e1 전용 경로)
  const dashboardDir = path.join(REPO_ROOT, "packages", "dashboard")
  const dotNextDir = path.join(dashboardDir, ".next")
  const nextBackupDir = path.join(REPO_ROOT, ".agents", "work", "e2e1-next-backup")
  const nextBackupFingerprintFile = path.join(
    REPO_ROOT,
    ".agents",
    "work",
    "e2e1-next-backup.fingerprint.json",
  )

  recoverPreviousNextBackup({
    dashboardDir,
    dotNextDir,
    nextBackupDir,
    nextBackupFingerprintFile,
    tag: "E2E1",
  })

  const { originalBuildExisted, initialNextFingerprint, backupMoved } = backupNextDir({
    dotNextDir,
    nextBackupDir,
    nextBackupFingerprintFile,
    tag: "E2E1 scratch",
  })

  let testRoot = null
  const childPids = []
  const results = []

  function recordResult({ step, uc, sp, expected, actual, pass, status, absentWhileEditing }) {
    const entry = { step, uc, sp, expected, actual }
    if (status !== undefined) entry.status = status
    if (absentWhileEditing !== undefined) entry.absentWhileEditing = absentWhileEditing
    if (pass !== undefined) entry.pass = pass
    results.push(entry)
    if (status === "not-applicable") {
      console.log(`[E2E1 Step ${step}] N/A (${uc}, ${sp}): ${expected}`)
      console.log(`  -> Actual: ${actual}`)
    } else {
      console.log(`[E2E1 Step ${step}] ${pass ? "PASS" : "FAIL"} (${uc}, ${sp}): ${expected}`)
      if (!pass) {
        console.error(`  -> Actual: ${actual}`)
      }
    }
  }

  let browser = null

  let cleanupDone = false
  async function performCleanup() {
    if (cleanupDone) return
    cleanupDone = true

    if (browser) {
      await browser.close().catch(() => {})
    }

    console.log("[E2E1] 자식 프로세스 그룹 종료 중...")
    await cleanupChildren(childPids)

    restoreNextDir({
      dashboardDir,
      dotNextDir,
      nextBackupDir,
      nextBackupFingerprintFile,
      originalBuildExisted,
      backupMoved,
      initialNextFingerprint,
      tag: "E2E1",
    })

    if (testRoot && fs.existsSync(testRoot)) {
      try {
        fs.rmSync(testRoot, { recursive: true, force: true })
        console.log("[E2E1] 시험 루트 디렉터리 삭제 완료.")
      } catch (err) {
        console.warn(`[E2E1] 시험 루트 삭제 경고: ${err.message}`)
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
          console.log("[E2E1] .agents/work 디렉터리 정리 완료.")
        } else {
          console.warn(`[E2E1 경고] .agents/work 에 다른 파일이 남아 있어 폴더를 유지합니다: ${remaining.join(", ")}`)
        }
      } catch (err) {
        console.warn(`[E2E1 경고] .agents/work 정리 실패: ${err.message}`)
      }
    }
  }

  const signalHandler = async (sig) => {
    console.warn(`\n[E2E1] 신호 수신 (${sig}): 정리 절차 수행 중...`)
    removeSignalHandlers()
    try {
      await performCleanup()
    } catch (err) {
      console.error("[E2E1] 정리 중 오류:", err)
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

  addSignalHandlers()
  try {
    // 3. 포트 3개 탐색 (P_API, P_DASH_SERVER, P_DASH_NEXT_START)
    const ports = await findFreePorts(3, 3171)
    const [P_API, P_DASH_SERVER, P_DASH_NEXT_START] = ports
    console.log(
      `[E2E1] 할당 포트: API=${P_API}, server.mjs=${P_DASH_SERVER}, next-start(SP-06)=${P_DASH_NEXT_START}`,
    )

    // 4. 시험 작업공간 생성 (mkdtemp)
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "naia-adk-e2e1-root-"))
    const testHome = path.join(testRoot, "home")
    const testTmp = path.join(testRoot, "tmp")
    const testXdg = path.join(testRoot, "xdg")
    const testWs = path.join(testRoot, "ws")
    const testDataDir = path.join(testHome, "data-folder")

    fs.mkdirSync(testHome, { recursive: true })
    fs.mkdirSync(testTmp, { recursive: true })
    fs.mkdirSync(testXdg, { recursive: true })
    fs.mkdirSync(testWs, { recursive: true })
    fs.mkdirSync(testDataDir, { recursive: true })

    // 시험 작업공간 git 저장소 초기화
    execFileSync("git", ["init"], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["config", "user.name", "E2E Tester"], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["config", "user.email", "tester@example.com"], { cwd: testWs, stdio: "ignore" })

    fs.writeFileSync(path.join(testWs, ".gitignore"), ".agents/work/\n")
    fs.writeFileSync(path.join(testWs, "AGENTS.md"), "# Test ADK Agents\n")
    fs.writeFileSync(path.join(testWs, "CLAUDE.md"), "@AGENTS.md\n")
    fs.writeFileSync(path.join(testWs, "GEMINI.md"), "@AGENTS.md\n")

    // 도구 복사
    const wsScripts = path.join(testWs, "scripts")
    fs.mkdirSync(wsScripts, { recursive: true })
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "doc-notes.mjs"), path.join(wsScripts, "doc-notes.mjs"))
    fs.copyFileSync(path.join(REPO_ROOT, "scripts", "view-folders.mjs"), path.join(wsScripts, "view-folders.mjs"))

    const wsDocs = path.join(testWs, "docs")
    fs.mkdirSync(wsDocs, { recursive: true })

    // 시험 파일들 배치
    fs.writeFileSync(path.join(wsDocs, "index.md"), `# ADK 색인\n공통 탭 색인 문서입니다.\n`, "utf-8")
    fs.writeFileSync(
      path.join(wsDocs, "doc-a.md"),
      `# 문서 A\n이것은 첫 번째 테스트 문서입니다.\n\n[[doc-b|문서 B 링크]]\n\n[상대 링크](./doc-b.md)\n\n메모 작성을 위한 선택 대상 문장입니다. 드래그하여 메모를 달 수 있습니다.\n`,
      "utf-8",
    )
    fs.writeFileSync(path.join(wsDocs, "doc-b.md"), `# 문서 B\n두 번째 테스트 문서입니다.\n`, "utf-8")

    fs.mkdirSync(path.join(wsDocs, "sub"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, "sub", "doc-c.md"), `# 서브 문서 C\n서브 디렉토리에 있는 문서입니다.\n`, "utf-8")

    fs.mkdirSync(path.join(wsDocs, "archive"), { recursive: true })
    fs.writeFileSync(path.join(wsDocs, "archive", "doc-old.md"), `# 보관 문서\n이 문서는 보관 폴더에 든 옛 문서입니다.\n`, "utf-8")

    fs.writeFileSync(path.join(wsDocs, "image-sample.png"), SAMPLE_PNG_4X4)
    fs.writeFileSync(path.join(wsDocs, "sample-video.mp4"), SAMPLE_MP4_1S)
    fs.writeFileSync(path.join(wsDocs, "sample-audio.wav"), createWavBuffer(1))
    fs.writeFileSync(
      path.join(wsDocs, "sample.pdf"),
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n190\n%%EOF\n`,
      "utf-8",
    )
    fs.writeFileSync(path.join(wsDocs, "sample.json"), `{"title":"Test JSON","number":42,"nested":{"key":"value"}}`, "utf-8")
    fs.writeFileSync(path.join(wsDocs, "sample.yaml"), `version: 1\nname: test-yaml\nenabled: true\n`, "utf-8")
    fs.writeFileSync(path.join(wsDocs, "sample.txt"), `Hello, this is a plain text file for testing.`, "utf-8")
    fs.writeFileSync(path.join(wsDocs, "sample.csv"), `id,name,value\n1,Alpha,100\n2,Beta,200\n`, "utf-8")
    fs.writeFileSync(
      path.join(wsDocs, "sample.zip"),
      Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    )
    fs.mkdirSync(path.join(wsDocs, "empty-dir"), { recursive: true })

    // 501개 항목 폴더 (500개 하위폴더 + 501번째 sub-501 폴더 안에 그림)
    const folder501 = path.join(wsDocs, "folder-501")
    fs.mkdirSync(folder501, { recursive: true })
    for (let i = 1; i <= 501; i++) {
      const pad = String(i).padStart(3, "0")
      const sub = path.join(folder501, `sub-${pad}`)
      fs.mkdirSync(sub)
      fs.writeFileSync(path.join(sub, "item.txt"), `item ${pad}`)
    }
    fs.writeFileSync(path.join(folder501, "sub-501", "nested-image.png"), SAMPLE_PNG_4X4)

    // 하위 폴더에만 그림이 있는 폴더 (대표 그림 검증용)
    const coverFolder = path.join(wsDocs, "folder-cover-test")
    fs.mkdirSync(path.join(coverFolder, "sub"), { recursive: true })
    fs.writeFileSync(path.join(coverFolder, "sub", "cover.png"), SAMPLE_PNG_4X4)

    // git 커밋
    execFileSync("git", ["add", "."], { cwd: testWs, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "init test files"], { cwd: testWs, stdio: "ignore" })
    const initialCommitCount = parseInt(
      execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
      10,
    )

    // 가짜 홈 데이터 폴더 생성 및 등록
    fs.writeFileSync(path.join(testDataDir, ".naia-view"), "")
    fs.writeFileSync(path.join(testDataDir, "data-doc.md"), `# 데이터 폴더 문서\n이 문서는 보기 전용 출처입니다.\n`, "utf-8")
    fs.writeFileSync(path.join(testDataDir, "data-pic.png"), SAMPLE_PNG_4X4)

    const childEnv = {
      ...process.env,
      HOME: testHome,
      TMPDIR: testTmp,
      XDG_RUNTIME_DIR: testXdg,
      NAIA_API_PORT: String(P_API),
    }
    delete childEnv.NEXT_PUBLIC_API_URL

    // view-folders add 로 등록
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "add", "--path", testDataDir, "--id", "content-res", "--label", "결과물 폴더", "--root", testWs],
      { env: childEnv, stdio: "ignore" },
    )

    // 사전 오픈 메모 (doc-b.md) 및 사전 즐겨찾기 (doc-b.md) 생성 (검수 반영 1, 6번)
    const wsWork = path.join(testWs, ".agents", "work")
    const wsNotesDir = path.join(wsWork, "doc-notes")
    fs.mkdirSync(wsNotesDir, { recursive: true })
    const initNoteB = {
      schemaVersion: 1,
      id: "20260925-100000-init01",
      source: "adk",
      path: "doc-b.md",
      quote: "두 번째 테스트 문서입니다.",
      body: "사전 생성된 문서 B 오픈 메모",
      status: "open",
      createdAt: "2026-09-25T10:00:00.000Z",
      updatedAt: "2026-09-25T10:00:00.000Z",
      reply: null,
      resolvedAt: null,
    }
    fs.writeFileSync(path.join(wsNotesDir, "20260925-100000-init01.json"), JSON.stringify(initNoteB, null, 2), "utf-8")

    const initFavorites = {
      schemaVersion: 1,
      items: [
        {
          source: "adk",
          path: "doc-b.md",
          type: "file",
          addedAt: "2026-09-25T10:00:00.000Z",
        },
      ],
    }
    fs.writeFileSync(path.join(wsWork, "doc-favorites.json"), JSON.stringify(initFavorites, null, 2), "utf-8")


    // 5. 대시보드 next build 실행
    console.log(`[E2E1] next build 실행 (NAIA_API_PORT=${P_API})...`)
    const buildLogFile = path.join(outDir, "next-build.log")
    const buildLogStream = fs.createWriteStream(buildLogFile)
    await new Promise((resolve, reject) => {
      const cp = spawn("pnpm", ["exec", "next", "build"], {
        cwd: dashboardDir,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      cp.stdout.pipe(buildLogStream)
      cp.stderr.pipe(buildLogStream)
      cp.on("error", reject)
      cp.on("close", (code) => {
        buildLogStream.end()
        if (code === 0) resolve()
        else reject(new Error(`next build exited with code ${code}`))
      })
    })

    // 검수 반영 4: 빌드 산출물의 rewrite 대상 확인
    const routesManifestPath = path.join(dotNextDir, "routes-manifest.json")
    if (!fs.existsSync(routesManifestPath)) {
      throw new Error(`routes-manifest.json 이 생성되지 않았습니다: ${routesManifestPath}`)
    }
    const routesManifest = JSON.parse(fs.readFileSync(routesManifestPath, "utf-8"))
    const rewriteMatches = JSON.stringify(routesManifest.rewrites).includes(`http://127.0.0.1:${P_API}/api/portal`)
    if (!rewriteMatches) {
      throw new Error(`routes-manifest.json 내에 시험 포트(${P_API}) rewrite 대상이 없습니다!`)
    }

    // 6. 프로세스 3개 기동
    const logFiles = {
      api: path.join(outDir, "api.log"),
      serverMjs: path.join(outDir, "server-mjs.log"),
      nextStart: path.join(outDir, "next-start.log"),
    }
    const apiFd = fs.openSync(logFiles.api, "w")
    const serverFd = fs.openSync(logFiles.serverMjs, "w")
    const nextStartFd = fs.openSync(logFiles.nextStart, "w")

    console.log("[E2E1] API 서버 시작...")
    const cpApi = spawn(
      "pnpm",
      ["exec", "tsx", "packages/server/src/cli.ts", "serve", "--port", String(P_API), "--host", "127.0.0.1", "--root", testWs],
      {
        cwd: REPO_ROOT,
        env: { ...childEnv, NAIA_API_PORT: "" },
        detached: true,
        stdio: ["ignore", apiFd, apiFd],
      },
    )
    childPids.push(cpApi.pid)

    console.log("[E2E1] 대시보드 server.mjs 시작...")
    const cpServer = spawn(
      process.execPath,
      ["server.mjs", "-H", "127.0.0.1", "-p", String(P_DASH_SERVER)],
      {
        cwd: dashboardDir,
        env: childEnv,
        detached: true,
        stdio: ["ignore", serverFd, serverFd],
      },
    )
    childPids.push(cpServer.pid)

    console.log("[E2E1] 대시보드 next start (SP-06) 시작...")
    const cpNextStart = spawn(
      "pnpm",
      ["exec", "next", "start", "-H", "127.0.0.1", "-p", String(P_DASH_NEXT_START)],
      {
        cwd: dashboardDir,
        env: childEnv,
        detached: true,
        stdio: ["ignore", nextStartFd, nextStartFd],
      },
    )
    childPids.push(cpNextStart.pid)

    // 포트 리스닝 대기
    const boundApi = await waitForPortListening(P_API)
    const boundServer = await waitForPortListening(P_DASH_SERVER)
    const boundNextStart = await waitForPortListening(P_DASH_NEXT_START)
    if (!boundApi || !boundServer || !boundNextStart) {
      throw new Error(`포트 바인딩 실패: API=${boundApi}, server=${boundServer}, nextStart=${boundNextStart}`)
    }
    console.log("[E2E1] 프로세스 3개 모두 정상 기동됨. 브라우저 시작...")

    // 7. Playwright 브라우저 기동
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    })
    const page = await context.newPage()

    const BASE_URL = `http://127.0.0.1:${P_DASH_SERVER}`
    const NEXT_START_URL = `http://127.0.0.1:${P_DASH_NEXT_START}`

    // -----------------------------------------------------------------------
    // UC-02: 파일 종류별 뷰 검증
    // -----------------------------------------------------------------------

    // Step 01: 트리에 종류 아이콘 노출
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector("aside a svg, aside div svg", { state: "visible", timeout: 10000 })
      await waitForStableTree(page, 300)
      const treeIcons = await page.evaluate(() => {
        const aside = document.querySelector("aside")
        if (!aside) return []
        const svgs = Array.from(aside.querySelectorAll("a svg, div svg"))
        return svgs.map((s) => s.getAttribute("class") || "")
      })
      const hasEmerald = treeIcons.some((c) => c.includes("text-emerald-400")) // image
      const hasPurple = treeIcons.some((c) => c.includes("text-purple-400")) // video
      const hasPink = treeIcons.some((c) => c.includes("text-pink-400")) // audio
      const hasRose = treeIcons.some((c) => c.includes("text-rose-400")) // pdf
      const hasSky = treeIcons.some((c) => c.includes("text-sky-400")) // text
      const hasNeutral = treeIcons.some((c) => c.includes("text-neutral-400")) // other
      const hasBlue = treeIcons.some((c) => c.includes("text-blue-400")) // doc
      const pass = hasEmerald && hasPurple && hasPink && hasRose && hasSky && hasNeutral && hasBlue
      await page.screenshot({ path: path.join(outDir, "01-tree-kinds.png") })
      recordResult({
        step: "01",
        uc: "UC-02",
        sp: "SP-01",
        expected: "트리에 7종류 파일 아이콘(문서, 그림, 영상, 소리, PDF, 글자, 기타)이 모두 보인다",
        actual: `icons: doc=${hasBlue}, img=${hasEmerald}, vid=${hasPurple}, aud=${hasPink}, pdf=${hasRose}, txt=${hasSky}, other=${hasNeutral}`,
        pass,
      })
    }

    // Step 02: 그림 맞춤↔원본, 이름, 크기, 가로×세로
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=image-sample.png`)
      await page.waitForSelector("article img", { state: "visible" })
      // 이미지 로드 및 치수 렌더링 대기 ("4×4")
      await page.waitForFunction(() => {
        const img = document.querySelector("article img")
        const text = document.querySelector("article")?.innerText || ""
        return Boolean(img && img.naturalWidth > 0 && text.includes("4×4"))
      })

      const initialFit = await page.evaluate(() => document.querySelector("article img")?.classList.contains("max-w-full"))
      await page.click("article img")
      await page.waitForFunction(() => document.querySelector("article img")?.classList.contains("max-w-none"))
      const afterFirstClick = true
      await page.click("article img")
      await page.waitForFunction(() => document.querySelector("article img")?.classList.contains("max-w-full"))
      const afterSecondClick = true

      const imgInfo = await page.evaluate(() => {
        const img = document.querySelector("article img")
        const h1 = document.querySelector("article h1")
        const text = document.querySelector("article")?.innerText || ""
        return {
          title: h1?.innerText || "",
          naturalWidth: img?.naturalWidth || 0,
          naturalHeight: img?.naturalHeight || 0,
          hasDimensionText: text.includes("4×4"),
        }
      })
      await page.screenshot({ path: path.join(outDir, "02-image-view.png") })
      const pass =
        imgInfo.title.includes("image-sample.png") &&
        imgInfo.naturalWidth === 4 &&
        imgInfo.naturalHeight === 4 &&
        imgInfo.hasDimensionText &&
        initialFit &&
        afterFirstClick &&
        afterSecondClick
      recordResult({
        step: "02",
        uc: "UC-02",
        sp: "SP-03",
        expected: "그림 이름·크기·가로×세로가 보이고, 클릭 시 맞춤↔원본 크기 토글이 동작한다",
        actual: `name=${imgInfo.title}, dims=${imgInfo.naturalWidth}x${imgInfo.naturalHeight}, dimText=${imgInfo.hasDimensionText}, toggle=${initialFit && afterFirstClick && afterSecondClick}`,
        pass,
      })
    }

    // Step 03: 영상 재생 및 되감기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample-video.mp4`)
      await page.waitForSelector("article video", { state: "visible" })

      let playRes = await page.evaluate(async () => {
        const vid = document.querySelector("article video")
        if (!vid) return { found: false, playRejected: true, error: "video element not found" }
        try {
          await vid.play()
          return {
            found: true,
            playRejected: false,
            paused: vid.paused,
            currentTime: vid.currentTime,
            readyState: vid.readyState,
            duration: vid.duration,
          }
        } catch (err) {
          return {
            found: true,
            playRejected: true,
            error: err?.message || String(err),
            paused: vid.paused,
            currentTime: vid.currentTime,
            readyState: vid.readyState,
            duration: vid.duration,
          }
        }
      })

      // 헤드리스에서 자동재생이 막히면 page.click으로 재생 단추를 누른 뒤 확인
      if (playRes.playRejected) {
        await page.click("article video")
        await sleep(300)
        playRes = await page.evaluate(() => {
          const vid = document.querySelector("article video")
          if (!vid) return { found: false, playRejected: true, error: "video element not found" }
          return {
            found: true,
            playRejected: vid.paused && vid.currentTime === 0,
            paused: vid.paused,
            currentTime: vid.currentTime,
            readyState: vid.readyState,
            duration: vid.duration,
          }
        })
      }

      const isPlaying = !playRes.playRejected && (playRes.currentTime > 0 || !playRes.paused)

      const seekRes = await page.evaluate(async () => {
        const vid = document.querySelector("article video")
        if (!vid) return { seekOk: false, currentTime: 0 }
        vid.currentTime = 0.5
        await new Promise((r) => setTimeout(r, 150))
        return {
          seekOk: Math.abs(vid.currentTime - 0.5) < 0.2,
          currentTime: vid.currentTime,
        }
      })

      await page.screenshot({ path: path.join(outDir, "03-video-view.png") })
      const pass = Boolean(
        playRes.found &&
        !playRes.playRejected &&
        isPlaying &&
        playRes.readyState >= 1 &&
        playRes.duration > 0 &&
        seekRes.seekOk
      )
      recordResult({
        step: "03",
        uc: "UC-02",
        sp: "SP-03",
        expected: "브라우저 영상 재생기가 표시되고 play() 거부 없이 재생(!paused 또는 currentTime > 0) 및 되감기가 동작한다",
        actual: `playRejected=${playRes.playRejected}, paused=${playRes.paused}, isPlaying=${isPlaying}, readyState=${playRes.readyState}, duration=${playRes.duration}, seekOk=${seekRes.seekOk}, currentTime=${seekRes.currentTime}`,
        pass,
      })
    }

    // Step 04: 소리 재생 및 되감기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample-audio.wav`)
      await page.waitForSelector("article audio", { state: "visible" })

      let playRes = await page.evaluate(async () => {
        const aud = document.querySelector("article audio")
        if (!aud) return { found: false, playRejected: true, error: "audio element not found" }
        try {
          await aud.play()
          return {
            found: true,
            playRejected: false,
            paused: aud.paused,
            currentTime: aud.currentTime,
            readyState: aud.readyState,
            duration: aud.duration,
          }
        } catch (err) {
          return {
            found: true,
            playRejected: true,
            error: err?.message || String(err),
            paused: aud.paused,
            currentTime: aud.currentTime,
            readyState: aud.readyState,
            duration: aud.duration,
          }
        }
      })

      // 헤드리스에서 자동재생이 막히면 page.click으로 재생 단추를 누른 뒤 확인
      if (playRes.playRejected) {
        await page.click("article audio")
        await sleep(300)
        playRes = await page.evaluate(() => {
          const aud = document.querySelector("article audio")
          if (!aud) return { found: false, playRejected: true, error: "audio element not found" }
          return {
            found: true,
            playRejected: aud.paused && aud.currentTime === 0,
            paused: aud.paused,
            currentTime: aud.currentTime,
            readyState: aud.readyState,
            duration: aud.duration,
          }
        })
      }

      const isPlaying = !playRes.playRejected && (playRes.currentTime > 0 || !playRes.paused)

      const seekRes = await page.evaluate(async () => {
        const aud = document.querySelector("article audio")
        if (!aud) return { seekOk: false, currentTime: 0 }
        aud.currentTime = 0.5
        await new Promise((r) => setTimeout(r, 150))
        return {
          seekOk: Math.abs(aud.currentTime - 0.5) < 0.2,
          currentTime: aud.currentTime,
        }
      })

      await page.screenshot({ path: path.join(outDir, "04-audio-view.png") })
      const pass = Boolean(
        playRes.found &&
        !playRes.playRejected &&
        isPlaying &&
        playRes.readyState >= 1 &&
        playRes.duration > 0 &&
        seekRes.seekOk
      )
      recordResult({
        step: "04",
        uc: "UC-02",
        sp: "SP-03",
        expected: "브라우저 오디오 재생기가 표시되고 play() 거부 없이 재생(!paused 또는 currentTime > 0) 및 되감기가 동작한다",
        actual: `playRejected=${playRes.playRejected}, paused=${playRes.paused}, isPlaying=${isPlaying}, readyState=${playRes.readyState}, duration=${playRes.duration}, seekOk=${seekRes.seekOk}, currentTime=${seekRes.currentTime}`,
        pass,
      })
    }

    // Step 05: PDF 브라우저 안 보기 및 내려받기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.pdf`)
      await page.waitForSelector("article object", { state: "visible" })
      const pdfInfo = await page.evaluate(() => {
        const obj = document.querySelector("article object")
        const dl = document.querySelector('article a[download="sample.pdf"]')
        return {
          hasObject: Boolean(obj),
          type: obj?.getAttribute("type"),
          dataUrl: obj?.getAttribute("data"),
          hasDownload: Boolean(dl),
        }
      })
      await page.screenshot({ path: path.join(outDir, "05-pdf-view.png") })
      const pass =
        pdfInfo.hasObject &&
        pdfInfo.type === "application/pdf" &&
        pdfInfo.dataUrl?.includes("/api/portal/asset") &&
        pdfInfo.hasDownload
      recordResult({
        step: "05",
        uc: "UC-02",
        sp: "SP-03",
        expected: "PDF가 브라우저 object 태그로 임베드되고 내려받기 버튼이 표시된다",
        actual: `type=${pdfInfo.type}, data=${pdfInfo.dataUrl}, dl=${pdfInfo.hasDownload}`,
        pass,
      })
    }

    // Step 06: JSON 들여쓰기 글자 파일 보기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.json`)
      await page.waitForSelector("article pre", { state: "visible" })
      await page.waitForFunction(() => (document.querySelector("article pre")?.innerText || "").trim().length > 0)
      const jsonText = await page.evaluate(() => document.querySelector("article pre")?.innerText || "")
      await page.screenshot({ path: path.join(outDir, "06-json-view.png") })
      const isIndented = jsonText.includes('\n  "title": "Test JSON"') || jsonText.includes('\n  "number": 42')
      const pass = isIndented && jsonText.includes('"nested"')
      recordResult({
        step: "06",
        uc: "UC-02",
        sp: "SP-03",
        expected: "JSON 파일이 들여쓰기된 읽기 전용 글자로 보인다",
        actual: `isIndented=${isIndented}, text=${jsonText.slice(0, 50).replace(/\n/g, "\\n")}`,
        pass,
      })
    }

    // Step 07: YAML / TXT / CSV 고정폭 보기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.yaml`)
      await page.waitForSelector("article pre", { state: "visible" })
      await page.waitForFunction(() => (document.querySelector("article pre")?.innerText || "").trim().length > 0)
      const yamlPre = await page.evaluate(() => {
        const pre = document.querySelector("article pre")
        return { text: pre?.innerText || "", font: window.getComputedStyle(pre).fontFamily }
      })

      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.txt`)
      await page.waitForSelector("article pre", { state: "visible" })
      await page.waitForFunction(() => (document.querySelector("article pre")?.innerText || "").trim().length > 0)
      const txtPre = await page.evaluate(() => document.querySelector("article pre")?.innerText || "")

      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.csv`)
      await page.waitForSelector("article pre", { state: "visible" })
      await page.waitForFunction(() => (document.querySelector("article pre")?.innerText || "").trim().length > 0)
      const csvPre = await page.evaluate(() => document.querySelector("article pre")?.innerText || "")

      await page.screenshot({ path: path.join(outDir, "07-text-views.png") })
      const pass =
        yamlPre.text.includes("version: 1") &&
        txtPre.includes("Hello, this is a plain text file") &&
        csvPre.includes("1,Alpha,100")
      recordResult({
        step: "07",
        uc: "UC-02",
        sp: "SP-03",
        expected: "YAML, TXT, CSV 파일이 고정폭 글꼴로 정상 렌더링된다",
        actual: `yaml=${yamlPre.text.includes("version: 1")}, txt=${txtPre.includes("Hello")}, csv=${csvPre.includes("Alpha")}`,
        pass,
      })
    }

    // Step 08: ZIP 미리 볼 수 없는 파일 및 내려받기
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=sample.zip`)
      await page.waitForSelector('article a[download="sample.zip"]', { state: "visible", timeout: 10000 })
      const zipInfo = await page.evaluate(() => {
        const article = document.querySelector("article")?.innerText || ""
        const dl = document.querySelector('article a[download="sample.zip"]')
        return {
          hasMessage: article.includes("미리 볼 수 없는 파일입니다"),
          hasDownload: Boolean(dl),
          dlHref: dl?.getAttribute("href"),
        }
      })
      await page.screenshot({ path: path.join(outDir, "08-zip-view.png") })
      const pass = zipInfo.hasMessage && zipInfo.hasDownload && zipInfo.dlHref?.includes("&download=1")
      recordResult({
        step: "08",
        uc: "UC-02",
        sp: "SP-03",
        expected: "ZIP 파일에 대해 '미리 볼 수 없는 파일입니다' 문구와 내려받기 버튼이 표시된다",
        actual: `msg=${zipInfo.hasMessage}, dl=${zipInfo.hasDownload}, href=${zipInfo.dlHref}`,
        pass,
      })
    }

    // Step 09: 주소 복사 후 새 탭에서 같은 파일
    {
      const currentUrl = page.url()
      const newPage = await context.newPage()
      await newPage.goto(currentUrl)
      await newPage.waitForSelector('article a[download="sample.zip"]', { state: "visible", timeout: 10000 })
      const sameView = await newPage.evaluate(() => {
        return document.querySelector("article")?.innerText?.includes("미리 볼 수 없는 파일입니다")
      })
      await newPage.screenshot({ path: path.join(outDir, "09-new-tab-same-url.png") })
      await newPage.close()
      const pass = Boolean(sameView)
      recordResult({
        step: "09",
        uc: "UC-02",
        sp: "SP-03",
        expected: "주소창 주소를 새 탭에서 열었을 때 같은 파일 뷰가 정상 표시된다",
        actual: `sameView=${sameView}`,
        pass,
      })
    }

    // -----------------------------------------------------------------------
    // UC-03: 데이터 폴더 출처 검증
    // -----------------------------------------------------------------------

    // Step 10: 데이터 폴더 출처 "보기 전용", 편집 단추 없음
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=data:content-res&path=data-doc.md`)
      await page.waitForSelector("article h1", { state: "visible" })
      const dataDocInfo = await page.evaluate(() => {
        const asideText = document.querySelector("aside")?.innerText || ""
        const buttons = Array.from(document.querySelectorAll("article button")).map((b) => b.innerText.trim())
        const hasEditBtn = buttons.some((b) => b.includes("편집"))
        const hasReadOnlyBadge = asideText.includes("보기 전용")
        return { hasEditBtn, hasReadOnlyBadge }
      })
      await page.screenshot({ path: path.join(outDir, "10-data-folder-readonly.png") })
      const pass = dataDocInfo.hasReadOnlyBadge && !dataDocInfo.hasEditBtn
      recordResult({
        step: "10",
        uc: "UC-03",
        sp: "SP-01",
        expected: "데이터 폴더 출처 이름 옆에 '보기 전용'이 붙고 문서에 [편집] 단추가 없다",
        actual: `readOnlyBadge=${dataDocInfo.hasReadOnlyBadge}, hasEditBtn=${dataDocInfo.hasEditBtn}`,
        pass,
      })
    }

    // Step 11: 등록 빼고 새로 고치면 출처 사라짐 (파일은 그대로)
    {
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "remove", "--id", "content-res", "--root", testWs],
        { env: childEnv, stdio: "ignore" },
      )
      await page.reload()
      await waitForStableTree(page, 500)

      let pass11 = false
      let actual11 = ""
      try {
        const handle11 = await page.waitForFunction(() => {
          const asideText = document.querySelector("aside")?.innerText || ""
          if (!asideText.includes("결과물 폴더")) {
            return { inTree: false, asideText }
          }
          return false
        }, null, { timeout: 10000 })
        const val11 = await handle11.jsonValue()
        const fileStillExists = fs.existsSync(path.join(testDataDir, "data-doc.md"))
        pass11 = !val11.inTree && fileStillExists
        actual11 = `inTree=${val11.inTree}, fileExists=${fileStillExists}`
      } catch (err) {
        const curAside = await page.evaluate(() => document.querySelector("aside")?.innerText || "").catch(() => "")
        pass11 = false
        actual11 = `타임아웃/오류: ${err.message}, asideText=${curAside}`
      }
      await page.screenshot({ path: path.join(outDir, "11-data-folder-removed.png") })
      recordResult({
        step: "11",
        uc: "UC-03",
        sp: "SP-01",
        expected: "데이터 폴더 등록을 빼고 새로 고치면 출처가 사라지고 디스크 파일은 유지된다",
        actual: actual11,
        pass: pass11,
      })
    }

    // Step 12: 없는 경로 등록 시 "찾을 수 없음"·펼치지 않음·다른 출처 정상 (검수 반영 6)
    {
      const missingFolder = path.join(testHome, "missing-test-folder")
      fs.mkdirSync(missingFolder, { recursive: true })
      fs.writeFileSync(path.join(missingFolder, ".naia-view"), "")
      fs.writeFileSync(path.join(missingFolder, "temp.md"), "# temp\n")

      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "add", "--path", missingFolder, "--id", "missing-src", "--label", "삭제될폴더", "--root", testWs],
        { env: childEnv, stdio: "ignore" },
      )
      // 디스크에서 그 폴더만 삭제
      fs.rmSync(missingFolder, { recursive: true, force: true })

      await page.reload()
      let pass12 = false
      let actual12 = ""
      try {
        const handle12 = await page.waitForFunction(() => {
          const asideText = document.querySelector("aside")?.innerText || ""
          if (asideText.includes("찾을 수 없음") && asideText.includes("ADK 문서")) {
            return {
              hasNotFound: true,
              hasAdk: true,
              hasTempMd: asideText.includes("temp.md"),
            }
          }
          return false
        }, null, { timeout: 10000 })
        const missingInfo = await handle12.jsonValue()
        pass12 = missingInfo.hasNotFound && !missingInfo.hasTempMd && missingInfo.hasAdk
        actual12 = `notFound=${missingInfo.hasNotFound}, unexpanded=${!missingInfo.hasTempMd}, adkOk=${missingInfo.hasAdk}`
      } catch (err) {
        const curText = await page.evaluate(() => document.querySelector("aside")?.innerText || "").catch(() => "")
        pass12 = false
        actual12 = `타임아웃/오류: ${err.message}, aside=${curText}`
      }
      await page.screenshot({ path: path.join(outDir, "12-data-folder-missing.png") })

      // 정리 및 복구
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "remove", "--id", "missing-src", "--root", testWs],
        { env: childEnv, stdio: "ignore" },
      )
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "view-folders.mjs"), "add", "--path", testDataDir, "--id", "content-res", "--label", "결과물 폴더", "--root", testWs],
        { env: childEnv, stdio: "ignore" },
      )

      recordResult({
        step: "12",
        uc: "UC-03",
        sp: "SP-01",
        expected: "없는 폴더 출처는 '찾을 수 없음' 표시 후 펼쳐지지 않으며 다른 출처는 정상이다",
        actual: actual12,
        pass: pass12,
      })
    }

    // -----------------------------------------------------------------------
    // SP-02: 폴더 격자 (FolderGrid)
    // -----------------------------------------------------------------------

    // Step 13: 폴더 클릭 → 트리 펼침과 동시 격자
    {
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=doc-a.md`)
      await page.waitForFunction(() => document.querySelector("article h1")?.innerText === "doc-a")
      // 트리에서 sub 폴더 링크 클릭
      const subLink = page.locator('aside a[href*="path=sub"]').first()
      await subLink.click()

      let pass13 = false
      let actual13 = ""
      try {
        const handle13 = await page.waitForFunction(() => {
          const h1 = document.querySelector("article h1")?.innerText?.trim() || ""
          const items = Array.from(document.querySelectorAll("article a")).map((a) => a.innerText.trim())
          const hasDocC = items.some((t) => t.includes("doc-c"))
          if (h1 === "sub" && hasDocC) {
            const nav = document.querySelector('article nav[aria-label="폴더 경로"]')?.innerText || ""
            return { title: h1, nav, hasDocC: true }
          }
          return false
        }, null, { timeout: 10000 })
        const gridInfo = await handle13.jsonValue()
        pass13 = gridInfo.title === "sub" && gridInfo.hasDocC
        actual13 = `title=${gridInfo.title}, hasDocC=${gridInfo.hasDocC}`
      } catch (err) {
        const curTitle = await page.evaluate(() => document.querySelector("article h1")?.innerText || "").catch(() => "")
        const curItems = await page.evaluate(() => Array.from(document.querySelectorAll("article a")).map((a) => a.innerText.trim())).catch(() => [])
        pass13 = false
        actual13 = `타임아웃/오류: ${err.message}, curTitle=${curTitle}, items=${curItems.join(", ")}`
      }
      await page.screenshot({ path: path.join(outDir, "13-folder-grid-open.png") })
      recordResult({
        step: "13",
        uc: "SP-02",
        sp: "SP-02",
        expected: "폴더 클릭 시 트리가 펼쳐지고 동시에 오른쪽에 그 폴더의 격자가 뜬다",
        actual: actual13,
        pass: pass13,
      })
    }

    // Step 14: 대표 그림 (하위 폴더 그림 포함, 가까운 깊이부터)
    {
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=folder-cover-test`)
      await page.waitForFunction(() => {
        const coverImg = document.querySelector("article a img")
        return Boolean(coverImg && coverImg.naturalWidth > 0 && coverImg.getAttribute("src")?.includes("cover.png"))
      })
      const coverOk = true
      await page.screenshot({ path: path.join(outDir, "14-folder-cover.png") })
      recordResult({
        step: "14",
        uc: "SP-02",
        sp: "SP-02",
        expected: "하위 폴더에만 그림이 있는 폴더 칸에 첫 대표 그림(cover)이 보인다",
        actual: `coverOk=${coverOk}`,
        pass: coverOk,
      })
    }

    // Step 15: 빈 폴더 격자
    {
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=empty-dir`)
      let pass15 = false
      let actual15 = ""
      try {
        const handle15 = await page.waitForFunction(() => {
          const text = document.querySelector("article")?.innerText || ""
          if (text.includes("폴더가 비어 있습니다.")) {
            return { found: true }
          }
          return false
        }, null, { timeout: 10000 })
        const val15 = await handle15.jsonValue()
        pass15 = Boolean(val15.found)
        actual15 = `found=${val15.found}`
      } catch (err) {
        const curText = await page.evaluate(() => document.querySelector("article")?.innerText || "").catch(() => "")
        pass15 = false
        actual15 = `타임아웃/오류: ${err.message}, text=${curText}`
      }
      await page.screenshot({ path: path.join(outDir, "15-empty-folder-grid.png") })
      recordResult({
        step: "15",
        uc: "SP-02",
        sp: "SP-02",
        expected: "빈 폴더를 열었을 때 '폴더가 비어 있습니다.' 문구가 표시된다",
        actual: actual15,
        pass: pass15,
      })
    }

    // Step 16: 501개 항목 폴더 "500개까지만 보입니다"와 항목 수 501
    {
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=folder-501`)
      let pass16 = false
      let actual16 = ""
      try {
        const handle16 = await page.waitForFunction(() => {
          const text = document.querySelector("article")?.innerText || ""
          const gridLinks = document.querySelectorAll("article .grid a")
          const hasTruncatedMsg = text.includes("500개까지만 보입니다")
          const has501Total = text.includes("501개 항목")
          const renderedCount = gridLinks.length
          if (hasTruncatedMsg && has501Total && renderedCount === 500) {
            return { hasTruncatedMsg, has501Total, renderedCount }
          }
          return false
        }, null, { timeout: 10000 })
        const f501Info = await handle16.jsonValue()
        pass16 = f501Info.hasTruncatedMsg && f501Info.has501Total && f501Info.renderedCount === 500
        actual16 = `msg=${f501Info.hasTruncatedMsg}, total=${f501Info.has501Total}, count=${f501Info.renderedCount}`
      } catch (err) {
        const curInfo = await page.evaluate(() => ({
          text: document.querySelector("article")?.innerText || "",
          count: document.querySelectorAll("article .grid a").length,
        })).catch(() => ({}))
        pass16 = false
        actual16 = `타임아웃/오류: ${err.message}, info=${JSON.stringify(curInfo)}`
      }
      await page.screenshot({ path: path.join(outDir, "16-folder-501.png") })
      recordResult({
        step: "16",
        uc: "SP-02",
        sp: "SP-02",
        expected: "501개 폴더에서 '500개까지만 보입니다'와 '501개 항목'이 표시되고 500개만 렌더링된다",
        actual: actual16,
        pass: pass16,
      })
    }

    // Step 17 (추가 확인 항목): 트리 500개 밖 폴더로 주소를 직접 열면 격자
    {
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=folder-501%2Fsub-501`)
      let pass17 = false
      let actual17 = ""
      try {
        const handle17 = await page.waitForFunction(() => {
          const h1 = document.querySelector("article h1")?.innerText || ""
          const text = document.querySelector("article")?.innerText || ""
          const hasNestedImg = text.includes("nested-image.png")
          if (h1 === "sub-501" && hasNestedImg) {
            return { title: h1, hasNestedImg: true }
          }
          return false
        }, null, { timeout: 10000 })
        const beyond500Info = await handle17.jsonValue()
        pass17 = beyond500Info.title === "sub-501" && beyond500Info.hasNestedImg
        actual17 = `title=${beyond500Info.title}, hasImg=${beyond500Info.hasNestedImg}`
      } catch (err) {
        const curH1 = await page.evaluate(() => document.querySelector("article h1")?.innerText || "").catch(() => "")
        const curText = await page.evaluate(() => document.querySelector("article")?.innerText || "").catch(() => "")
        pass17 = false
        actual17 = `타임아웃/오류: ${err.message}, curH1=${curH1}, text=${curText}`
      }
      await page.screenshot({ path: path.join(outDir, "17-folder-beyond-500.png") })
      recordResult({
        step: "17",
        uc: "SP-02",
        sp: "SP-02",
        expected: "트리 500개 목록 밖에 있는 하위 폴더로 주소를 직접 열면 격자가 정상 표시된다",
        actual: actual17,
        pass: pass17,
      })
    }

    // -----------------------------------------------------------------------
    // UC-04: 문서 직접 고치기 (DocEditor)
    // -----------------------------------------------------------------------

    // Step 18: [편집] → 좌우(데스크톱)
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
      await page.click('article button:has-text("편집")')
      await page.waitForSelector("article textarea", { state: "visible" })
      const editorLayout = await page.evaluate(() => {
        const ta = document.querySelector("article textarea")
        const preview = document.querySelector("article .prose")
        return {
          hasTextarea: Boolean(ta),
          hasPreview: Boolean(preview),
        }
      })
      await page.screenshot({ path: path.join(outDir, "18-doc-editor-desktop.png") })
      const pass = editorLayout.hasTextarea && editorLayout.hasPreview
      recordResult({
        step: "18",
        uc: "UC-04",
        sp: "SP-04",
        expected: "[편집] 클릭 시 좌우(데스크톱) 원문 편집창과 미리보기가 나란히 뜬다",
        actual: `ta=${editorLayout.hasTextarea}, preview=${editorLayout.hasPreview}`,
        pass,
      })
    }

    // Step 19: 저장 → 정확한 저장 문구·디스크 바뀜·git 커밋 수 그대로 (검수 반영 9)
    {
      await page.fill("article textarea", "# 문서 A\n수정된 본문 내용입니다.\n")
      await page.click('article button:has-text("저장")')
      await page.waitForSelector('article div:has-text("저장했습니다")', { state: "visible" })

      const saveMsg = await page.evaluate(() => {
        const banner = document.querySelector('article div[class*="bg-emerald"]')
        return banner?.innerText?.trim() || ""
      })
      const diskContent = fs.readFileSync(path.join(testWs, "docs", "doc-a.md"), "utf-8")
      const currentCommitCount = parseInt(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
        10,
      )

      await page.screenshot({ path: path.join(outDir, "19-doc-save-success.png") })
      const pass =
        saveMsg === MSG_SAVED_DOC &&
        diskContent.includes("수정된 본문 내용입니다") &&
        currentCommitCount === initialCommitCount
      recordResult({
        step: "19",
        uc: "UC-04",
        sp: "SP-04",
        expected: "저장 직후 문구가 '저장했습니다. 아직 저장소에는 올리지 않았습니다.'와 같고 디스크 파일 변경, git 커밋 없음",
        actual: `msg="${saveMsg}", diskChanged=${diskContent.includes("수정된 본문")}, commitCount=${currentCommitCount}`,
        pass,
      })
    }

    // Step 20: 충돌 (409) → 전체 문장 일치·편집창 글 유지·디스크 바이트 유지 (검수 반영 9)
    {
      // 다시 편집 열기
      await page.click('article button:has-text("편집")')
      await page.waitForSelector("article textarea", { state: "visible" })

      // 편집을 연 뒤 스크립트가 파일을 디스크에서 직접 수정하여 충돌 유발
      const externalChange = "# 충돌 유발 외부 변경\n다른 에이전트가 고침\n"
      fs.writeFileSync(path.join(testWs, "docs", "doc-a.md"), externalChange, "utf-8")

      const userDraft = "# 문서 A\n내가 입력한 충돌 방지 초안 글입니다.\n"
      await page.fill("article textarea", userDraft)
      await page.click('article button:has-text("저장")')

      await page.waitForSelector('article div:has-text("편집을 연 뒤")', { state: "visible" })
      const conflictMsg = await page.evaluate(() => {
        const box = document.querySelector('article div[class*="bg-amber"]')
        return box?.innerText?.trim() || ""
      })
      const taValue = await page.inputValue("article textarea")
      const diskContentAfter = fs.readFileSync(path.join(testWs, "docs", "doc-a.md"), "utf-8")

      await page.screenshot({ path: path.join(outDir, "20-doc-conflict-409.png") })
      const pass =
        conflictMsg === MSG_CONFLICT_DOC &&
        taValue === userDraft &&
        diskContentAfter === externalChange
      recordResult({
        step: "20",
        uc: "UC-04",
        sp: "SP-04",
        expected: "409 충돌 시 SP 충돌 문장 전체 일치, 편집창 글 유지, 디스크 바이트 유지",
        actual: `msgMatched=${conflictMsg === MSG_CONFLICT_DOC}, taKept=${taValue === userDraft}, diskKept=${diskContentAfter === externalChange}`,
        pass,
      })
    }

    // Step 21: 고친 채 [취소]·트리 이동 → 확인 대화 (거절 시 머묾, 수락 시 이동)
    {
      let dismissedMsg = ""
      page.once("dialog", async (dialog) => {
        dismissedMsg = dialog.message()
        await dialog.dismiss()
      })
      await page.click('article button:has-text("취소")')
      await sleep(200)
      const stillInEditor = await page.locator("article textarea").isVisible()

      let acceptedMsg = ""
      page.once("dialog", async (dialog) => {
        acceptedMsg = dialog.message()
        await dialog.accept()
      })
      await page.click('article button:has-text("취소")')
      await sleep(200)
      const exitedEditor = !(await page.locator("article textarea").isVisible())

      await page.screenshot({ path: path.join(outDir, "21-doc-discard-confirm.png") })
      const pass =
        dismissedMsg === MSG_CONFIRM_DISCARD &&
        stillInEditor &&
        acceptedMsg === MSG_CONFIRM_DISCARD &&
        exitedEditor
      recordResult({
        step: "21",
        uc: "UC-04",
        sp: "SP-04",
        expected: "고친 채 [취소] 시 확인 대화가 뜨며, 거절 시 머물고 수락 시 이동한다",
        actual: `dismissMsg="${dismissedMsg}", stayed=${stillInEditor}, acceptMsg="${acceptedMsg}", exited=${exitedEditor}`,
        pass,
      })
    }

    // -----------------------------------------------------------------------
    // UC-05: 메모를 적어 AI에게 맡긴다 (Notes)
    // -----------------------------------------------------------------------

    // Step 22: 본문 글 드래그 → [메모] → 인용 채워짐 → 저장 → 목록·트리 숫자·배너
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector("article .prose", { state: "visible" })

      // 본문 문장 선택 시뮬레이션
      await page.evaluate(() => {
        const p = document.querySelector("article .prose p")
        if (p) {
          const range = document.createRange()
          range.selectNodeContents(p)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
          p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
        }
      })

      await page.waitForSelector('button[data-testid="quote-memo-btn"]', { state: "visible" })
      await page.click('button[data-testid="quote-memo-btn"]')
      await page.waitForSelector('textarea[placeholder*="수정 방향"]', { state: "visible" })

      const quoteVal = await page.evaluate(() => {
        return document.querySelector("span.italic")?.innerText || ""
      })

      await page.fill('textarea[placeholder*="수정 방향"]', "첫 번째 단락 수정 요청")
      await page.locator('div:has(textarea[placeholder*="수정 방향"]) button:has-text("저장")').click()
      await page.waitForSelector('button:has-text("열린 메모 2건")', { state: "visible" })

      const noteInfo = await page.evaluate(() => {
        const bannerBtn = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("열린 메모"))
        const bannerText = bannerBtn?.innerText || ""
        const treeBadge = document.querySelector('aside a[href*="doc-a"] span[class*="bg-blue-900"]')?.innerText || ""
        const noteCards = Array.from(document.querySelectorAll("span")).filter((s) => s.innerText.trim() === "열림").length
        return { bannerText, treeBadge, noteCards }
      })
      await page.screenshot({ path: path.join(outDir, "22-note-with-quote.png") })
      const pass =
        quoteVal.length > 0 &&
        noteInfo.treeBadge === "1" &&
        noteInfo.bannerText.includes("열린 메모 2건")
      recordResult({
        step: "22",
        uc: "UC-05",
        sp: "SP-05",
        expected: "글 드래그 후 [메모] 클릭 시 인용이 채워져 저장되고 트리 숫자 1과 상단 배너가 표시된다",
        actual: `quote="${quoteVal.slice(0, 20)}...", badge=${noteInfo.treeBadge}, banner="${noteInfo.bannerText}"`,
        pass,
      })
    }

    // Step 23: 글 고르지 않은 [메모 추가] → 인용란 "문서 전체" (검수 반영 7)
    {
      await page.click('button:has-text("메모 추가")')
      await page.waitForSelector('textarea[placeholder*="수정 방향"]', { state: "visible" })
      const wholeQuote = await page.evaluate(() => {
        return document.querySelector("span.italic")?.innerText || ""
      })
      await page.fill('textarea[placeholder*="수정 방향"]', "문서 전체 피드백 메모")
      await page.locator('div:has(textarea[placeholder*="수정 방향"]) button:has-text("저장")').click()
      await page.waitForSelector('button:has-text("열린 메모 3건")', { state: "visible" })

      const banner2 = await page.evaluate(() => {
        const bannerBtn = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("열린 메모"))
        return bannerBtn?.innerText || ""
      })
      await page.screenshot({ path: path.join(outDir, "23-note-whole-doc.png") })
      const pass = wholeQuote === MSG_QUOTE_WHOLE_DOC && banner2.includes("열린 메모 3건")
      recordResult({
        step: "23",
        uc: "UC-05",
        sp: "SP-05",
        expected: "선택 없이 메모 추가 시 인용란에 '문서 전체'가 들어가고 저장된다",
        actual: `quote="${wholeQuote}", banner="${banner2}"`,
        pass,
      })
    }

    // Step 24: 전체 메모 목록 모달에서 다른 문서(doc-b)에 달린 메모로 이동 (검수 반영 6)
    {
      await page.click('button:has-text("열린 메모")')
      await page.waitForSelector('h2:has-text("전체 열린 메모")', { state: "visible" })
      const modalItem = page.locator('div.fixed a[href*="doc-b.md"]').first()
      await modalItem.waitFor({ state: "visible" })
      await modalItem.click()

      let pass24 = false
      let actual24 = ""
      try {
        const handleClose = await page.waitForFunction(
          () => !Array.from(document.querySelectorAll("h2")).some((h) => h.innerText.includes("전체 열린 메모")),
          null,
          { timeout: 10000 },
        )
        const modalClosed = await handleClose.jsonValue()

        const handleNav = await page.waitForFunction(() => {
          const href = window.location.href
          const h1 = document.querySelector("article h1")?.innerText || ""
          if (href.includes("doc-b.md") && h1.includes("doc-b")) {
            return { url: href, title: h1 }
          }
          return false
        }, null, { timeout: 10000 })
        const navInfo = await handleNav.jsonValue()
        const isDocB = Boolean(navInfo && navInfo.url.includes("doc-b.md") && navInfo.title.includes("doc-b"))
        pass24 = Boolean(modalClosed && isDocB)
        actual24 = `modalClosed=${modalClosed}, url=${navInfo.url}, title=${navInfo.title}`
      } catch (err) {
        const curUrl = page.url()
        const curTitle = await page.evaluate(() => document.querySelector("article h1")?.innerText || "").catch(() => "")
        pass24 = false
        actual24 = `타임아웃/오류: ${err.message}, url=${curUrl}, title=${curTitle}`
      }

      await page.screenshot({ path: path.join(outDir, "24-notes-modal.png") })
      recordResult({
        step: "24",
        uc: "UC-05",
        sp: "SP-05",
        expected: "상단 배너 클릭 시 전체 열린 메모 모달이 뜨고 다른 문서(doc-b) 메모 클릭 시 해당 문서로 이동한다",
        actual: actual24,
        pass: pass24,
      })
    }

    // Step 25: doc-notes.mjs resolve 뒤 새로고침 → 처리됨·AI 답·[다시 열기] (검수 반영 7)
    {
      const notesDir = path.join(testWs, ".agents", "work", "doc-notes")
      const noteFiles = fs.readdirSync(notesDir).filter((f) => f.endsWith(".json"))
      let noteId = null
      for (const f of noteFiles) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(notesDir, f), "utf-8"))
          if (data.path === "doc-a.md" && data.status === "open") {
            noteId = data.id
            break
          }
        } catch {}
      }
      if (!noteId) throw new Error("doc-a.md의 생성된 메모 ID를 찾을 수 없습니다")

      const fixedReply = "테스트 AI 답변: 요청 내용을 반영하였습니다."
      const docBytesBefore = fs.statSync(path.join(testWs, "docs", "doc-a.md")).size
      const commitCountBefore = parseInt(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
        10,
      )

      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "doc-notes.mjs"), "resolve", noteId, "--reply", fixedReply, "--root", testWs],
        { env: childEnv, stdio: "ignore" },
      )

      const docBytesAfter = fs.statSync(path.join(testWs, "docs", "doc-a.md")).size
      const commitCountAfter = parseInt(
        execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: testWs, encoding: "utf-8" }).trim(),
        10,
      )

      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector("article", { state: "visible" })
      await page.waitForSelector('article span:has-text("처리됨")', { state: "visible" })

      const resolvedView = await page.evaluate((reply) => {
        const text = document.querySelector("article")?.innerText || ""
        const hasResolved = text.includes("처리됨")
        const hasReply = text.includes(reply)
        const hasReopenBtn = Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("다시 열기"))
        return { hasResolved, hasReply, hasReopenBtn }
      }, fixedReply)

      // [다시 열기] 클릭
      await page.click('button:has-text("다시 열기")')
      await page.waitForSelector('button:has-text("고치기")', { state: "visible" })
      const reopened = true

      await page.screenshot({ path: path.join(outDir, "25-note-resolve-reopen.png") })
      const pass =
        docBytesBefore === docBytesAfter &&
        commitCountBefore === commitCountAfter &&
        resolvedView.hasResolved &&
        resolvedView.hasReply &&
        resolvedView.hasReopenBtn &&
        reopened
      recordResult({
        step: "25",
        uc: "UC-05",
        sp: "SP-05",
        expected: "CLI resolve 후 새로고침 시 처리됨·AI답·다시열기 표시 및 문서/커밋 불변, 다시열기 동작",
        actual: `bytesSame=${docBytesBefore === docBytesAfter}, commitsSame=${commitCountBefore === commitCountAfter}, resolved=${resolvedView.hasResolved}, reopened=${reopened}`,
        pass,
      })
    }

    // -----------------------------------------------------------------------
    // UC-06: 즐겨찾기 (Favorites)
    // -----------------------------------------------------------------------

    // Step 26: 문서·그림·폴더 별 누름 → 트리 위 즐겨찾기 묶음 순서, 다시 누르면 빠짐
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForFunction(() => document.querySelector("article h1")?.innerText === "doc-a")
      await page.waitForSelector('button[title="즐겨찾기 추가"]', { state: "visible" })
      await page.click('button[title="즐겨찾기 추가"]')
      await page.waitForFunction(() => {
        const favHeader = Array.from(document.querySelectorAll("aside span")).find((s) => s.innerText.trim() === "즐겨찾기")
        const favContainer = favHeader?.closest("div.border-b")
        return (favContainer ? Array.from(favContainer.querySelectorAll("a")).length : 0) === 2
      })

      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=image-sample.png`)
      await page.waitForFunction(() => document.querySelector("article h1")?.innerText === "image-sample.png")
      await page.waitForSelector('button[title="즐겨찾기 추가"]', { state: "visible" })
      await page.click('button[title="즐겨찾기 추가"]')
      await page.waitForFunction(() => {
        const favHeader = Array.from(document.querySelectorAll("aside span")).find((s) => s.innerText.trim() === "즐겨찾기")
        const favContainer = favHeader?.closest("div.border-b")
        return (favContainer ? Array.from(favContainer.querySelectorAll("a")).length : 0) === 3
      })

      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=sub`)
      await page.waitForFunction(() => document.querySelector("article h1")?.innerText === "sub")
      await page.waitForSelector('button[title="즐겨찾기 추가"]', { state: "visible" })
      await page.click('button[title="즐겨찾기 추가"]')
      const handle3 = await page.waitForFunction(() => {
        const favHeader = Array.from(document.querySelectorAll("aside span")).find((s) => s.innerText.trim() === "즐겨찾기")
        const favContainer = favHeader?.closest("div.border-b")
        const links = favContainer ? Array.from(favContainer.querySelectorAll("a")).map((a) => a.innerText.trim()) : []
        if (links.length === 4) {
          return links
        }
        return false
      }, null, { timeout: 10000 })
      const favItems3 = await handle3.jsonValue()

      // 폴더 별 다시 누르기
      await page.waitForSelector('button[title="즐겨찾기 해제"]', { state: "visible" })
      await page.click('button[title="즐겨찾기 해제"]')

      const handle2 = await page.waitForFunction(() => {
        const favHeader = Array.from(document.querySelectorAll("aside span")).find((s) => s.innerText.trim() === "즐겨찾기")
        const favContainer = favHeader?.closest("div.border-b")
        const links = favContainer ? Array.from(favContainer.querySelectorAll("a")).map((a) => a.innerText.trim()) : []
        if (links.length === 3) {
          return links
        }
        return false
      }, null, { timeout: 10000 })
      const favItems2 = await handle2.jsonValue()

      await page.screenshot({ path: path.join(outDir, "26-favorites-add-remove.png") })
      const pass =
        favItems3.length >= 3 &&
        favItems2.length === favItems3.length - 1 &&
        favItems3.some((i) => i.includes("doc-a")) &&
        favItems3.some((i) => i.includes("image-sample.png"))
      recordResult({
        step: "26",
        uc: "UC-06",
        sp: "SP-01",
        expected: "별 클릭 시 트리 맨 위 즐겨찾기 묶음에 순서대로 추가되고 다시 누르면 빠진다",
        actual: `beforeCount=${favItems3.length}, afterCount=${favItems2.length}, items=${favItems3.join(", ")}`,
        pass,
      })
    }

    // Step 27: 파일을 디스크에서 지우면 흐림·빼기만
    {
      fs.unlinkSync(path.join(testWs, "docs", "image-sample.png"))
      await page.reload()
      await page.waitForSelector("aside", { state: "visible" })
      await page.waitForSelector('aside span[title="없어진 항목입니다"]', { state: "visible" })

      const missingFavInfo = await page.evaluate(() => {
        const missingSpan = document.querySelector('aside span[title*="없어진 항목"]')
        const xBtn = document.querySelector('aside div.opacity-60 button[title*="즐겨찾기에서 빼기"]')
        return {
          hasMissing: Boolean(missingSpan),
          isStrikethrough: missingSpan?.classList.contains("line-through"),
          hasXBtn: Boolean(xBtn),
        }
      })

      // 없어진 항목 전용 빼기 버튼 클릭
      await page.click('aside div.opacity-60 button[title*="즐겨찾기에서 빼기"]')
      await page.waitForFunction(() => !document.querySelector('aside span[title*="없어진 항목"]'))
      const afterRemoved = true

      // 파일 복구
      fs.writeFileSync(path.join(testWs, "docs", "image-sample.png"), SAMPLE_PNG_4X4)

      await page.screenshot({ path: path.join(outDir, "27-favorite-missing.png") })
      const pass = missingFavInfo.hasMissing && missingFavInfo.isStrikethrough && afterRemoved
      recordResult({
        step: "27",
        uc: "UC-06",
        sp: "SP-01",
        expected: "디스크에서 파일 삭제 시 즐겨찾기에서 흐림(line-through) 처리되며 빼기만 가능하다",
        actual: `hasMissing=${missingFavInfo.hasMissing}, strike=${missingFavInfo.isStrikethrough}, removed=${afterRemoved}`,
        pass,
      })
    }

    // Step 28: 다른 탭에서 같은 목록
    {
      const p2 = await context.newPage()
      await p2.goto(`${BASE_URL}/docs`)
      await p2.waitForSelector("aside", { state: "visible" })
      let pass28 = false
      let actual28 = ""
      try {
        const handleP2 = await p2.waitForFunction(() => {
          const favHeader = Array.from(document.querySelectorAll("aside span")).find((s) => s.innerText.trim() === "즐겨찾기")
          const favContainer = favHeader?.closest("div.border-b")
          const links = favContainer ? Array.from(favContainer.querySelectorAll("a")).map((a) => a.innerText.trim()) : []
          if (links.length >= 1) {
            return links
          }
          return false
        }, null, { timeout: 10000 })
        const p2Favs = await handleP2.jsonValue()
        pass28 = Boolean(p2Favs && p2Favs.some((t) => t.includes("doc-a")))
        actual28 = `p2Favs=${(p2Favs || []).join(", ")}`
      } catch (err) {
        pass28 = false
        actual28 = `타임아웃/오류: ${err.message}`
      }
      await p2.screenshot({ path: path.join(outDir, "28-favorites-cross-tab.png") })
      await p2.close()
      recordResult({
        step: "28",
        uc: "UC-06",
        sp: "SP-01",
        expected: "다른 브라우저 탭에서도 동일한 즐겨찾기 목록이 공유된다",
        actual: actual28,
        pass: pass28,
      })
    }

    // -----------------------------------------------------------------------
    // 모바일 뷰포트 (390×844) 및 반응형 검증
    // -----------------------------------------------------------------------

    // Step 29: 휴대폰 폭 검사 (격자 2칸, 가로스크롤 없음, 편집 탭, 메모 아래)
    {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${BASE_URL}/docs?tab=developer&source=adk&path=sub`)
      await page.waitForSelector("article", { state: "visible" })

      let pass29 = false
      let actual29 = ""
      try {
        const handleGrid = await page.waitForFunction(() => {
          const grid = document.querySelector("article .grid")
          if (grid) {
            const noHScroll = document.documentElement.scrollWidth <= window.innerWidth
            const is2Col = grid.classList.contains("grid-cols-2")
            return { noHScroll, is2Col }
          }
          return false
        }, null, { timeout: 10000 })
        const mobileGrid = await handleGrid.jsonValue()

        // 문서 편집 탭 검사
        await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
        await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
        await page.click('article button:has-text("편집")')
        await page.waitForSelector("article textarea", { state: "visible" })

        const handleEdit = await page.waitForFunction(() => {
          const btnOrigin = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("원문"))
          const btnPreview = Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("미리보기"))
          if (btnOrigin && btnPreview) {
            const noHScroll = document.documentElement.scrollWidth <= window.innerWidth
            return { noHScroll, hasTabs: true }
          }
          return false
        }, null, { timeout: 10000 })
        const mobileEdit = await handleEdit.jsonValue()

        // 취소하고 메모 패널 위치 검사
        await page.click('article button:has-text("취소")')
        const handleNotes = await page.waitForFunction(() => {
          const prose = document.querySelector("article .prose")?.getBoundingClientRect()
          const notes = Array.from(document.querySelectorAll("h3")).find((el) => el.innerText.trim() === "메모")?.getBoundingClientRect()
          if (prose && notes) {
            return { notesBelow: notes.top > prose.top }
          }
          return false
        }, null, { timeout: 10000 })
        const notesCheck = await handleNotes.jsonValue()

        pass29 = Boolean(mobileGrid.noHScroll && mobileGrid.is2Col && mobileEdit.noHScroll && mobileEdit.hasTabs && notesCheck.notesBelow)
        actual29 = `gridScroll=${mobileGrid.noHScroll}, grid2=${mobileGrid.is2Col}, editScroll=${mobileEdit.noHScroll}, editTabs=${mobileEdit.hasTabs}, notesBelow=${notesCheck.notesBelow}`
      } catch (err) {
        pass29 = false
        actual29 = `타임아웃/오류: ${err.message}`
      }

      await page.screenshot({ path: path.join(outDir, "29-mobile-390.png") })
      await page.setViewportSize({ width: 1280, height: 800 })

      recordResult({
        step: "29",
        uc: "SP-02",
        sp: "SP-04",
        expected: "휴대폰 폭(390px)에서 가로 스크롤 없음, 격자 2칸, 편집 [원문][미리보기] 탭, 메모 아래 배치",
        actual: actual29,
        pass: pass29,
      })
    }

    // -----------------------------------------------------------------------
    // UI1c 추가 확인 항목 (이동 확인 거절·수락, 디바운스, 재로딩, 403, 409 내성)
    // -----------------------------------------------------------------------

    // Step 30: 편집 중 11가지 이동 경로에서 확인 거절 시 글/주소 유지, 수락 시 이동 (검수 반영 1)
    {
      async function setupDirtyDocA() {
        await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
        await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
        await page.click('article button:has-text("편집")')
        await page.waitForSelector("article textarea", { state: "visible" })
        const dirtyContent = `# 더러운 편집 글 유지 시험\n\n[[doc-b|문서 B 링크]]\n\n[상대 링크](./doc-b.md)\n\n메모 작성을 위한 선택 대상 문장입니다.\n`
        await page.fill("article textarea", dirtyContent)
        const startUrl = page.url()
        return { dirtyContent, startUrl }
      }

      const navPaths = [
        {
          id: "01-tree",
          name: "트리",
          getLocator: async () => page.locator('aside a[href*="doc-b.md"]').first(),
        },
        {
          id: "02-breadcrumb",
          name: "이동 경로",
          getLocator: async () => page.locator('nav[aria-label="문서 경로"] a'),
        },
        {
          id: "03-wiki-link",
          name: "위키 링크",
          getLocator: async () => page.locator('article .prose a[href*="doc-b"]').first(),
        },
        {
          id: "04-relative-link",
          name: "상대 링크",
          getLocator: async () => page.locator('article .prose a:has-text("상대 링크")').first(),
        },
        {
          id: "05-tab",
          name: "탭",
          getLocator: async () => page.locator('aside a[role="tab"]:has-text("개발자")').first(),
        },
        {
          id: "06-search-result",
          name: "검색 결과",
          getLocator: async () => page.locator('div:has(> h1:has-text("검색 결과")) a[href*="/docs?"]'),
        },
        {
          id: "07-favorite",
          name: "즐겨찾기",
          getLocator: async () => page.locator('aside div.border-b a[href*="doc-b"]').first(),
        },
        {
          id: "08-open-note",
          name: "열린 메모",
          getLocator: async () => {
            const bannerBtn = page.locator('button:has-text("열린 메모")').first()
            if (await bannerBtn.isVisible().catch(() => false)) {
              await bannerBtn.click()
              await page.waitForSelector('h2:has-text("전체 열린 메모")', { state: "visible", timeout: 2000 }).catch(() => {})
            }
            return page.locator('div.fixed a[href*="doc-b.md"]').first()
          },
        },
        {
          id: "09-grid-card",
          name: "격자 칸",
          getLocator: async () => page.locator('article a[class*="group"]'),
        },
        {
          id: "10-search-close",
          name: "검색 닫기",
          getLocator: async () => page.locator('button:has-text("검색 닫기")'),
        },
        {
          id: "11-archived-include",
          name: "보관 문서 포함",
          getLocator: async () => {
            const byLabel = page.getByLabel(/보관 문서 포함/).first()
            if ((await byLabel.count().catch(() => 0)) > 0) return byLabel
            return page.locator('label:has-text("보관 문서 포함") input[type="checkbox"]').first()
          },
        },
      ]

      const naCandidates = new Set(["02-breadcrumb", "06-search-result", "09-grid-card", "10-search-close"])
      const subResults = []
      for (const p of navPaths) {
        const { dirtyContent, startUrl } = await setupDirtyDocA()
        let locator = null
        try {
          locator = await p.getLocator()
        } catch {}

        const count = locator ? await locator.count().catch(() => 0) : 0

        // 편집 중 화면에 없는 요소 판정 (02, 06, 09, 10): count === 0 확인 시 not-applicable 기록
        if (naCandidates.has(p.id) && count === 0) {
          const isSearchRelated = p.id === "06-search-result" || p.id === "10-search-close"
          let actualReason = `편집 중 요소 부재 (count=0, absentWhileEditing=true)`
          if (p.id === "02-breadcrumb") {
            actualReason += `. DocsView는 편집 중 문서 헤더의 nav[aria-label="문서 경로"]를 그리지 않음`
          } else if (p.id === "09-grid-card") {
            actualReason += `. 격자 칸은 격자 보기에만 있음`
          }
          if (isSearchRelated) {
            actualReason += `. 검색으로 이동하는 경로는 31번(검색 입력 뒤 확인 대화)이 맡는다`
          }

          subResults.push({
            id: p.id,
            name: p.name,
            status: "not-applicable",
            absentWhileEditing: true,
            actual: actualReason,
          })
          recordResult({
            step: `30-${p.id}`,
            uc: "UC-04",
            sp: "SP-04",
            expected: `편집 중 ${p.name} 이동 시 거절하면 주소와 글 유지, 수락 시 이동 (편집 중 미노출 요소는 부재 확인)`,
            actual: actualReason,
            status: "not-applicable",
            absentWhileEditing: true,
          })
          continue
        }

        const isVisible = Boolean(locator && count > 0 && (await locator.first().isVisible().catch(() => false)))

        if (!isVisible) {
          subResults.push({ id: p.id, name: p.name, pass: false, actual: "대상 화면 요소 없음 (도달 불가)" })
          recordResult({
            step: `30-${p.id}`,
            uc: "UC-04",
            sp: "SP-04",
            expected: `편집 중 ${p.name} 이동 시 거절하면 주소와 글 유지, 수락 시 이동`,
            actual: "대상 화면 요소 없음 (도달 불가)",
            pass: false,
          })
          continue
        }

        const targetLocator = locator.first()

        // 체크박스 여부 및 초기 체크 상태 확인 (11-archived-include)
        const isCheckbox =
          p.id === "11-archived-include" ||
          ((await targetLocator.getAttribute("type").catch(() => null)) === "checkbox")
        let initialChecked = null
        if (isCheckbox) {
          initialChecked = await targetLocator.isChecked().catch(() => false)
        }

        // 거절 시험 (Dismiss)
        let dismissed = false
        const dismissListener = async (dialog) => {
          dismissed = true
          await dialog.dismiss()
        }
        page.once("dialog", dismissListener)
        await targetLocator.click()
        await sleep(200)
        const urlAfterDismiss = page.url()
        const textAfterDismiss = (await page.inputValue("article textarea").catch(() => ""))
        let checkboxKept = true
        if (isCheckbox) {
          const checkedAfterDismiss = await targetLocator.isChecked().catch(() => null)
          checkboxKept = checkedAfterDismiss === initialChecked
        }
        const rejectOk =
          dismissed &&
          urlAfterDismiss === startUrl &&
          textAfterDismiss === dirtyContent &&
          checkboxKept

        // 수락 시험 (Accept)
        let accepted = false
        const acceptListener = async (dialog) => {
          accepted = true
          await dialog.accept()
        }
        page.once("dialog", acceptListener)
        let acceptLocator = targetLocator
        try {
          const freshLocator = await p.getLocator()
          if (freshLocator) acceptLocator = freshLocator.first()
        } catch {}
        await acceptLocator.click()
        await sleep(300)
        const urlAfterAccept = page.url()
        let acceptOk = accepted && urlAfterAccept !== startUrl
        if (p.id === "11-archived-include") {
          acceptOk = acceptOk && urlAfterAccept.includes("archived=1")
        }

        const subPass = Boolean(rejectOk && acceptOk)
        const subActual = `rejectOk=${rejectOk} (dialog=${dismissed}, urlKept=${urlAfterDismiss === startUrl}, textKept=${textAfterDismiss === dirtyContent}${isCheckbox ? `, checkboxKept=${checkboxKept}` : ""}), acceptOk=${acceptOk} (dialog=${accepted}, urlChanged=${urlAfterAccept !== startUrl}${p.id === "11-archived-include" ? `, hasArchived1=${urlAfterAccept.includes("archived=1")}` : ""})`

        subResults.push({
          id: p.id,
          name: p.name,
          pass: subPass,
          actual: subActual,
        })
        recordResult({
          step: `30-${p.id}`,
          uc: "UC-04",
          sp: "SP-04",
          expected: `편집 중 ${p.name} 이동 시 거절하면 주소와 글 유지, 수락 시 이동`,
          actual: subActual,
          pass: subPass,
        })
      }

      await page.screenshot({ path: path.join(outDir, "30-dirty-nav-guards.png") })

      const applicableResults = subResults.filter((r) => r.status !== "not-applicable")
      const naResults = subResults.filter((r) => r.status === "not-applicable")

      const applicablePass =
        applicableResults.length > 0 && applicableResults.every((r) => r.pass === true)
      const naAbsent =
        naResults.length > 0 && naResults.every((r) => r.absentWhileEditing === true)

      const pass30 = Boolean(applicablePass && naAbsent)

      const summaryLine = `적용 ${applicableResults.length}·해당없음 ${naResults.length}`
      const actualSummary = `${summaryLine} (적용: ${applicableResults.map((r) => `${r.name}=${r.pass ? "PASS" : "FAIL"}`).join(", ")}; 해당없음: ${naResults.map((r) => `${r.name}=absent(${r.absentWhileEditing})`).join(", ")})`

      console.log(`[E2E1 Step 30 요약] ${summaryLine} (판정: ${pass30 ? "PASS" : "FAIL"})`)

      recordResult({
        step: "30",
        uc: "UC-04",
        sp: "SP-04",
        expected: "편집 중 11개 이동 경로 중 적용 가능한 하위 항목은 모두 거절 시 글/주소 유지·수락 시 이동하고, 해당없음 항목은 편집 중 요소 부재가 확인된다",
        actual: actualSummary,
        pass: pass30,
      })
    }

    // Step 31: 검색 디바운스 300ms 안 편집 시 확인 대화
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector('article button:has-text("편집")', { state: "visible" })

      // 디바운스 300ms 만료 시 검색 네비게이션 트리거 -> 확인 대화 거절 리스너를 미리 등록
      let debounceDialog = false
      page.once("dialog", async (d) => {
        debounceDialog = true
        await d.dismiss()
      })

      // 검색창에 한 글자 입력 직후 바로 [편집] 누르고 내용 고침
      await page.fill('input[type="search"]', "검")
      await page.click('article button:has-text("편집")')
      await page.waitForSelector("article textarea", { state: "visible" })
      await page.fill("article textarea", "# 검색 디바운스 가드 시험 글")

      await sleep(600)
      const contentPreserved = (await page.inputValue("article textarea")) === "# 검색 디바운스 가드 시험 글"

      // 편집 취소 및 검색 초기화
      page.once("dialog", async (d) => await d.accept())
      await page.click('article button:has-text("취소")')
      await page.fill('input[type="search"]', "")
      await sleep(400)

      await page.screenshot({ path: path.join(outDir, "31-search-debounce-guard.png") })
      const pass = debounceDialog && contentPreserved
      recordResult({
        step: "31",
        uc: "UC-04",
        sp: "SP-04",
        expected: "검색창 입력 직후(300ms 안) 편집 시 검색 이동 때 확인 대화가 뜨고 거절 시 글이 유지된다",
        actual: `dialog=${debounceDialog}, kept=${contentPreserved}`,
        pass,
      })
    }

    // Step 32: 같은 주소 재로딩(포털 응답 지연) 시 편집 글 유지
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
      await page.click('article button:has-text("편집")')
      await page.waitForSelector("article textarea", { state: "visible" })
      await page.fill("article textarea", "# 같은 주소 재로딩 글 유지 시험")

      // 2초 대기
      await sleep(2000)
      const keptAfter2s = (await page.inputValue("article textarea")) === "# 같은 주소 재로딩 글 유지 시험"

      page.once("dialog", async (d) => await d.accept())
      await page.click('article button:has-text("취소")')

      await page.screenshot({ path: path.join(outDir, "32-reload-content-retention.png") })
      recordResult({
        step: "32",
        uc: "UC-04",
        sp: "SP-04",
        expected: "페이지 로드 직후 [편집]을 눌러 고치고 2초 기다린 뒤에도 편집 글이 유지된다",
        actual: `kept=${keptAfter2s}`,
        pass: keptAfter2s,
      })
    }

    // Step 33: 보기 전용 출처 저장 403 문구 및 믿지 않는 주소 편집 가드 (검수 반영 2)
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=data:content-res&path=data-doc.md`)
      await page.waitForSelector("article", { state: "visible" })

      const hasEditBtn = await page.locator('article button:has-text("편집")').isVisible()
      const unreachable = !hasEditBtn ? "보기 전용 출처는 편집 단추 없음" : ""

      // 서버 응답 403 Source is read-only 별도 값 기록
      const server403Res = await page.evaluate(async () => {
        const res = await fetch("/api/portal/doc?source=data:content-res&path=data-doc.md", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "test", baseHash: "xxx" }),
        })
        const json = await res.json().catch(() => ({}))
        return { status: res.status, error: json.error || "" }
      })

      // 믿지 않는 주소 (SP-06 인스턴스)에서 [편집] 누르면 편집창 없이 "이 주소에서는 문서만 볼 수 있습니다" 보이는지 확인
      await page.goto(`${NEXT_START_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector("article", { state: "visible" })
      await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
      await page.click('article button:has-text("편집")')
      await sleep(200)

      const untrustedEditCheck = await page.evaluate((msgForbidden) => {
        const text = document.querySelector("article")?.innerText || ""
        const hasTextarea = Boolean(document.querySelector("article textarea"))
        const hasForbiddenMsg = text.includes(msgForbidden)
        return { hasTextarea, hasForbiddenMsg }
      }, MSG_FORBIDDEN)

      await page.screenshot({ path: path.join(outDir, "33-readonly-save-403.png") })
      const pass = Boolean(!hasEditBtn && !untrustedEditCheck.hasTextarea && untrustedEditCheck.hasForbiddenMsg)
      recordResult({
        step: "33",
        uc: "UC-04",
        sp: "SP-04",
        expected: "보기 전용 출처는 편집 단추 없고(서버 403), 믿지 않는 주소에서 [편집] 클릭 시 편집창 없이 '이 주소에서는 문서만 볼 수 있습니다'가 보인다",
        actual: `unreachable="${unreachable}", serverStatus=${server403Res.status}, serverError="${server403Res.error}", untrustedEditBlocked=${!untrustedEditCheck.hasTextarea}, untrustedMsg=${untrustedEditCheck.hasForbiddenMsg}`,
        pass,
      })
    }

    // Step 34: 즐겨찾기 409 시 본문·격자·파일 보기 유지 및 에러는 별/묶음 옆에만 표시 (검수 반영 3)
    {
      const favFile = path.join(testWs, ".agents", "work", "doc-favorites.json")
      const originalFavBytes = fs.readFileSync(favFile)

      const views = [
        {
          name: "doc",
          url: `${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`,
          targetItem: { source: "adk", path: "doc-a.md", type: "file" },
          contentSelector: "article .prose",
        },
        {
          name: "grid",
          url: `${BASE_URL}/docs?tab=developer&source=adk&path=sub`,
          targetItem: { source: "adk", path: "sub", type: "directory" },
          contentSelector: "article .grid",
        },
        {
          name: "file",
          url: `${BASE_URL}/docs?tab=common&source=adk&path=image-sample.png`,
          targetItem: { source: "adk", path: "image-sample.png", type: "file" },
          contentSelector: "article img",
        },
      ]

      const viewChecks = {}
      const dummyItem = { source: "adk", path: "doc-b.md", type: "file" }

      for (const v of views) {
        const check = {
          contentKept: false,
          starAddErrorOk: false,
          starRemoveErrorOk: false,
          groupRemoveErrorOk: false,
          errorNotInContent: false,
          starAddError: "",
          starRemoveError: "",
          groupError: "",
        }

        // 동작 1: 별 추가 동작 (해당 항목 미등록 상태에서 시도 -> 409)
        fs.writeFileSync(
          favFile,
          JSON.stringify({ schemaVersion: 1, items: [dummyItem] }, null, 2),
          "utf-8",
        )
        await page.goto(v.url)
        await page.waitForSelector(v.contentSelector, { state: "visible" })
        await page.waitForSelector('button[title*="즐겨찾기 추가"]', { state: "visible" })

        // 409 유발을 위해 파일 손상
        fs.writeFileSync(favFile, "{ corrupted json invalid for 409 test", "utf-8")

        // 별 추가 클릭
        await page.click('button[title*="즐겨찾기 추가"]')
        const handleStarAdd = await page.waitForFunction(
          (expectedMsg) => {
            const starErrorEl = document.querySelector('article span[class*="text-amber-400"]')
            const starText = starErrorEl?.innerText?.trim() || ""
            if (starText === expectedMsg) {
              return { starAddText: starText }
            }
            return false
          },
          MSG_FAVORITES_INVALID,
          { timeout: 10000 },
        )
        const starAddRes = await handleStarAdd.jsonValue()
        check.starAddErrorOk = Boolean(starAddRes && starAddRes.starAddText === MSG_FAVORITES_INVALID)
        check.starAddError = starAddRes?.starAddText || ""

        // 동작 2: 별 빼기 동작 (해당 항목 등록 상태에서 시도 -> 409)
        fs.writeFileSync(
          favFile,
          JSON.stringify({ schemaVersion: 1, items: [v.targetItem, dummyItem] }, null, 2),
          "utf-8",
        )
        await page.reload()
        await page.waitForSelector(v.contentSelector, { state: "visible" })
        await page.waitForSelector('button[title*="즐겨찾기 해제"]', { state: "visible" })

        // 409 유발을 위해 파일 손상
        fs.writeFileSync(favFile, "{ corrupted json invalid for 409 test", "utf-8")

        // 별 빼기 클릭
        await page.click('button[title*="즐겨찾기 해제"]')
        const handleStarRemove = await page.waitForFunction(
          (expectedMsg) => {
            const starErrorEl = document.querySelector('article span[class*="text-amber-400"]')
            const starText = starErrorEl?.innerText?.trim() || ""
            if (starText === expectedMsg) {
              return { starRemoveText: starText }
            }
            return false
          },
          MSG_FAVORITES_INVALID,
          { timeout: 10000 },
        )
        const starRemoveRes = await handleStarRemove.jsonValue()
        check.starRemoveErrorOk = Boolean(starRemoveRes && starRemoveRes.starRemoveText === MSG_FAVORITES_INVALID)
        check.starRemoveError = starRemoveRes?.starRemoveText || ""

        // 동작 3: 왼쪽 묶음 빼기 동작 (건너뛰기 금지, opacity-0 단추 hover 후 강제 클릭)
        const groupItem = page.locator("aside div.border-b div.group").first()
        await groupItem.waitFor({ state: "visible", timeout: 10000 })
        await groupItem.hover()
        const groupXBtn = groupItem.locator('button[title*="즐겨찾기에서 빼기"]').first()
        await groupXBtn.click({ force: true })

        // 묶음 안내 선택자는 실제 화면 클래스 text-amber-400으로 검사
        const handleGroupRemove = await page.waitForFunction(
          (expectedMsg) => {
            const groupErrorEl = document.querySelector('aside div[class*="text-amber-400"]')
            const groupText = groupErrorEl?.innerText?.trim() || ""
            if (groupText === expectedMsg) {
              return { groupText }
            }
            return false
          },
          MSG_FAVORITES_INVALID,
          { timeout: 10000 },
        )
        const groupRemoveRes = await handleGroupRemove.jsonValue()
        check.groupRemoveErrorOk = Boolean(groupRemoveRes && groupRemoveRes.groupText === MSG_FAVORITES_INVALID)
        check.groupError = groupRemoveRes?.groupText || ""

        // 본문 요소 유지 및 본문 영역에 안내 문장 없음 확인
        const contentValidation = await page.evaluate(
          ({ selector, expectedMsg }) => {
            const el = document.querySelector(selector)
            const text = el ? el.innerText || "" : ""
            const hasContent = Boolean(el)
            const notInContent = !text.includes(expectedMsg)
            return { hasContent, notInContent }
          },
          { selector: v.contentSelector, expectedMsg: MSG_FAVORITES_INVALID },
        )

        check.contentKept = contentValidation.hasContent
        check.errorNotInContent = contentValidation.notInContent

        viewChecks[v.name] = check
      }

      // 파일 원래 바이트로 복구 및 되돌림 확인
      fs.writeFileSync(favFile, originalFavBytes)
      const restoredBytes = fs.readFileSync(favFile)
      const restoreVerified = Buffer.compare(originalFavBytes, restoredBytes) === 0

      await page.screenshot({ path: path.join(outDir, "34-favorites-fault-tolerance.png") })
      const pass = Boolean(
        viewChecks.doc.contentKept &&
        viewChecks.doc.starAddErrorOk &&
        viewChecks.doc.starRemoveErrorOk &&
        viewChecks.doc.groupRemoveErrorOk &&
        viewChecks.doc.errorNotInContent &&
        viewChecks.grid.contentKept &&
        viewChecks.grid.starAddErrorOk &&
        viewChecks.grid.starRemoveErrorOk &&
        viewChecks.grid.groupRemoveErrorOk &&
        viewChecks.grid.errorNotInContent &&
        viewChecks.file.contentKept &&
        viewChecks.file.starAddErrorOk &&
        viewChecks.file.starRemoveErrorOk &&
        viewChecks.file.groupRemoveErrorOk &&
        viewChecks.file.errorNotInContent &&
        restoreVerified,
      )
      recordResult({
        step: "34",
        uc: "UC-06",
        sp: "SP-01",
        expected: `즐겨찾기 409 시 문서·격자·파일 보기 요소 유지, 별/묶음 옆에만 안내 "${MSG_FAVORITES_INVALID}" 정확 표시 및 본문 제외, 복구 검증`,
        actual: `doc(kept=${viewChecks.doc.contentKept},starAdd=${viewChecks.doc.starAddErrorOk},starRem=${viewChecks.doc.starRemoveErrorOk},grpRem=${viewChecks.doc.groupRemoveErrorOk},noErr=${viewChecks.doc.errorNotInContent}), grid(kept=${viewChecks.grid.contentKept},starAdd=${viewChecks.grid.starAddErrorOk},starRem=${viewChecks.grid.starRemoveErrorOk},grpRem=${viewChecks.grid.groupRemoveErrorOk},noErr=${viewChecks.grid.errorNotInContent}), file(kept=${viewChecks.file.contentKept},starAdd=${viewChecks.file.starAddErrorOk},starRem=${viewChecks.file.starRemoveErrorOk},grpRem=${viewChecks.file.groupRemoveErrorOk},noErr=${viewChecks.file.errorNotInContent}), restoreVerified=${restoreVerified}`,
        pass,
      })
    }

    // -----------------------------------------------------------------------
    // SP-06: 쓰기가 막혔을 때 (비밀 값 없는 next start 인스턴스, 검수 반영 4 & 5)
    // -----------------------------------------------------------------------

    // Step 35: SP-06 권장 방식 없이 띄운 인스턴스 (next start)
    {
      await page.goto(`${NEXT_START_URL}/docs?tab=developer&source=adk&path=doc-a.md`)
      await page.waitForSelector("aside", { state: "visible" })

      // "없음" 판정은 트리 항목 수가 500ms 동안 변하지 않을 때까지 기다린 뒤 읽는다
      await waitForStableTree(page, 500)

      let pass35 = false
      let actual35 = ""
      try {
        const handleUntrustedTree = await page.waitForFunction(() => {
          const aside = document.querySelector("aside")
          if (!aside) return false
          const text = aside.innerText || ""
          const hasDoc = text.includes("doc-a")
          const hasPng = text.includes("image-sample.png")
          if (!hasDoc || !hasPng) return false
          return {
            hasDataFolder: text.includes("결과물 폴더") || text.includes("data-folder"),
            hasJson: text.includes("sample.json"),
            hasYaml: text.includes("sample.yaml"),
            hasTxt: text.includes("sample.txt"),
            hasCsv: text.includes("sample.csv"),
            hasZip: text.includes("sample.zip"),
            hasPdf: text.includes("sample.pdf"),
            hasMp4: text.includes("sample-video.mp4"),
            hasWav: text.includes("sample-audio.wav"),
            hasPng,
            hasDoc,
          }
        }, null, { timeout: 10000 })
        const untrustedTree = await handleUntrustedTree.jsonValue()

        // 트리에서 폴더를 클릭해 격자 요소 없이 SP-06 문장만 있는지 확인
        const folderTreeLink = page.locator('aside a[href*="path=sub"]').first()
        await folderTreeLink.waitFor({ state: "visible" })
        await folderTreeLink.click()
        await page.waitForSelector("article", { state: "visible" })

        const handleFolder = await page.waitForFunction((expectedMsg) => {
          const article = document.querySelector("article")
          const h1 = document.querySelector("article h1")?.innerText?.trim() || ""
          const text = article?.innerText || ""
          const hasGrid = Boolean(document.querySelector("article .grid"))
          if (h1 === "sub" && text.includes(expectedMsg) && !hasGrid) {
            return { hasGrid, hasOnlyBlockedMsg: true, text }
          }
          return false
        }, MSG_FORBIDDEN, { timeout: 10000 })
        const folderCheck = await handleFolder.jsonValue()

        // 기존 문서는 열림 확인
        const docLink = page.locator('aside a[href*="doc-a.md"]').first()
        await docLink.click()
        await page.waitForSelector("article h1", { state: "visible" })
        await page.waitForSelector("article .prose", { state: "visible" })
        const handleDocOpen = await page.waitForFunction(() => {
          const text = document.querySelector("article")?.innerText || ""
          const hasProse = Boolean(document.querySelector("article .prose"))
          if (hasProse || text.includes("문서 A")) {
            return { docOpened: true }
          }
          return false
        }, null, { timeout: 10000 })
        const docOpenRes = await handleDocOpen.jsonValue()
        const docOpened = Boolean(docOpenRes && docOpenRes.docOpened)

        // 35번: 메모·편집·별을 각각 누르기 전에 페이지를 새로 불러와 앞 동작의 문장이 없는 상태에서 시작하고,
        // 누른 직후 그 요소 주변(해당 버튼의 가장 가까운 영역)의 문장만 본다. 편집은 편집창(textarea) 없음, 메모는 입력칸 없음도 함께.

        // 1) [메모 추가] 동작
        await page.goto(`${NEXT_START_URL}/docs?tab=developer&source=adk&path=doc-a.md`)
        await page.waitForSelector("article .prose", { state: "visible" })
        await page.waitForSelector('button:has-text("메모 추가")', { state: "visible" })
        await page.click('button:has-text("메모 추가")', { force: true })

        const handleMemoCheck = await page.waitForFunction((expectedMsg) => {
          const memoPanel = document.querySelector("div.lg\\:col-span-1") || document.querySelector('button:has-text("메모 추가")')?.closest("div")
          const memoText = memoPanel?.innerText || ""
          const hasMemoTextarea = Boolean(document.querySelector('textarea[placeholder*="수정 방향"]'))
          if (!hasMemoTextarea && memoText.includes(expectedMsg)) {
            return { hasMemoTextarea: false, hasForbiddenMsg: true, memoText }
          }
          return false
        }, MSG_FORBIDDEN, { timeout: 10000 })
        const memoCheck = await handleMemoCheck.jsonValue()

        // 2) [편집] 동작
        await page.goto(`${NEXT_START_URL}/docs?tab=developer&source=adk&path=doc-a.md`)
        await page.waitForSelector("article .prose", { state: "visible" })
        await page.waitForSelector('article button:has-text("편집")', { state: "visible" })
        await page.click('article button:has-text("편집")', { force: true })

        const handleEditCheck = await page.waitForFunction((expectedMsg) => {
          const hasEditTextarea = Boolean(document.querySelector("article textarea"))
          // 편집 버튼 주변(문서 헤더 상단 안내 박스)의 문장만 확인
          const noticeBox = document.querySelector("article div.text-center")
          const noticeText = noticeBox?.innerText || ""
          if (!hasEditTextarea && noticeText.includes(expectedMsg)) {
            return { hasEditTextarea: false, hasForbiddenMsg: true, noticeText }
          }
          return false
        }, MSG_FORBIDDEN, { timeout: 10000 })
        const editCheck = await handleEditCheck.jsonValue()

        // 3) [별] 동작
        await page.goto(`${NEXT_START_URL}/docs?tab=developer&source=adk&path=doc-a.md`)
        await page.waitForSelector("article .prose", { state: "visible" })
        await page.waitForSelector('button[title*="즐겨찾기"]', { state: "visible" })
        await page.click('button[title*="즐겨찾기"]', { force: true })

        const handleStarCheck = await page.waitForFunction((expectedMsg) => {
          const starContainer = document.querySelector('button[title*="즐겨찾기"]')?.parentElement
          const starAreaText = starContainer?.innerText || ""
          const noticeBox = document.querySelector("article div.text-center")
          const noticeText = noticeBox?.innerText || ""
          const hasForbiddenMsg = starAreaText.includes(expectedMsg) || noticeText.includes(expectedMsg)
          if (hasForbiddenMsg) {
            return { hasForbiddenMsg: true, starAreaText, noticeText }
          }
          return false
        }, MSG_FORBIDDEN, { timeout: 10000 })
        const starBlockedMsg = await handleStarCheck.jsonValue()

        const nonDocNonImgExcluded =
          !untrustedTree.hasJson &&
          !untrustedTree.hasYaml &&
          !untrustedTree.hasTxt &&
          !untrustedTree.hasCsv &&
          !untrustedTree.hasZip &&
          !untrustedTree.hasPdf &&
          !untrustedTree.hasMp4 &&
          !untrustedTree.hasWav
        const treeFilterPass =
          !untrustedTree.hasDataFolder &&
          nonDocNonImgExcluded &&
          untrustedTree.hasPng &&
          untrustedTree.hasDoc
        const folderPass = folderCheck.hasOnlyBlockedMsg
        const memoBlocked = !memoCheck.hasMemoTextarea && memoCheck.hasForbiddenMsg
        const editBlocked = !editCheck.hasEditTextarea && editCheck.hasForbiddenMsg
        const starBlocked = starBlockedMsg.hasForbiddenMsg

        pass35 = Boolean(
          treeFilterPass &&
          folderPass &&
          docOpened &&
          memoBlocked &&
          editBlocked &&
          starBlocked,
        )
        actual35 = `treeFilter=${treeFilterPass}, folderBlocked=${folderPass}, docOpened=${docOpened}, memoBlocked=${memoBlocked}, editBlocked=${editBlocked}, starBlocked=${starBlocked}`
      } catch (err) {
        pass35 = false
        actual35 = `타임아웃/오류: ${err.message}`
      }

      await page.screenshot({ path: path.join(outDir, "35-sp06-untrusted-instance.png") })
      recordResult({
        step: "35",
        uc: "SP-06",
        sp: "SP-06",
        expected: "비밀 값 없는 인스턴스에서 비문서/비그림 제외 및 png 유지, 폴더 클릭 시 격자 없이 안내만, [메모 추가]·[편집]·별 각각 새로고침 후 주변 안내문 검증, 편집창/입력칸 없음",
        actual: actual35,
        pass: pass35,
      })
    }

    // Step 36: 화면 글 규칙 (절대 경로, /api/, 64자 hex 없음)
    {
      await page.goto(`${BASE_URL}/docs?tab=common&source=adk&path=doc-a.md`)
      await page.waitForSelector("article", { state: "visible" })
      const violations = await checkVisibleTextViolations(page, testWs)
      await page.screenshot({ path: path.join(outDir, "36-visible-text-clean.png") })
      const pass = violations.length === 0
      recordResult({
        step: "36",
        uc: "공통",
        sp: "화면글규칙",
        expected: "화면 보이는 글에 절대 경로, /api/, 64자 hex가 없다",
        actual: violations.length === 0 ? "clean" : violations.join("; "),
        pass,
      })
    }

    // Step 37: 포털 지연 시 오판 표시 없음 및 격자 정상 렌더 관찰
    {
      const delayPage = await context.newPage()

      // page.route로 /api/portal GET을 응답 꾸미지 않고 await sleep(2000) 뒤 route.continue() (fulfill 금지)
      await delayPage.route("**/api/portal", async (route) => {
        if (route.request().method() === "GET") {
          await sleep(2000)
          await delayPage
            .evaluate(() => {
              window.__portalResponded = true
            })
            .catch(() => {})
        }
        await route.continue()
      })

      // MutationObserver로 전 구간 관찰
      await delayPage.addInitScript(() => {
        window.__observedForbidden = []
        const check = () => {
          const text = document.documentElement ? document.documentElement.innerText || "" : ""
          if (text.includes("미리 볼 수 없는 파일입니다")) {
            window.__observedForbidden.push("미리 볼 수 없는 파일입니다")
          }
          if (!window.__portalResponded && text.includes("회사 설정이 아직 없습니다")) {
            window.__observedForbidden.push("회사 설정이 아직 없습니다")
          }
        }
        const observer = new MutationObserver(() => {
          check()
        })
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
        })
        document.addEventListener("DOMContentLoaded", check)
      })

      await delayPage.goto(`${BASE_URL}/docs?source=adk&path=sub`)

      let pass37 = false
      let actual37 = ""
      try {
        const handleGrid = await delayPage.waitForFunction(() => {
          const grid = document.querySelector("article .grid")
          const h1 = document.querySelector("article h1")?.innerText?.trim() || ""
          const cards = document.querySelectorAll("article .grid a, article .grid div")
          if (grid && h1 === "sub" && cards.length > 0) {
            return { gridFound: true, cardCount: cards.length }
          }
          return false
        }, null, { timeout: 15000 })
        const gridRes = await handleGrid.jsonValue()

        const observed = await delayPage.evaluate(() => {
          return Array.from(new Set(window.__observedForbidden || []))
        })

        pass37 = Boolean(gridRes && gridRes.gridFound) && observed.length === 0
        actual37 = `gridFound=${Boolean(gridRes?.gridFound)}, cardCount=${gridRes?.cardCount || 0}, forbiddenObserved=[${observed.join(", ")}]`
      } catch (err) {
        pass37 = false
        actual37 = `타임아웃/오류: ${err.message}`
      }

      await delayPage.screenshot({ path: path.join(outDir, "37-portal-delay-no-misjudgment.png") })
      await delayPage.close()

      recordResult({
        step: "37",
        uc: "UC-01",
        sp: "SP-02",
        expected: "포털 2초 지연 동안 '미리 볼 수 없는 파일입니다'와 '회사 설정이 아직 없습니다'가 한 번도 보이지 않고 끝내 격자가 뜬다",
        actual: actual37,
        pass: pass37,
      })
    }
  } finally {
    // 8. 정리 절차
    removeSignalHandlers()
    await performCleanup()
  }

  // 9. 저장소 .agents/work 오염 검사
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
    console.error("오류: 저장소 .agents/work 에 시험 파일이 생성되었습니다!")
    process.exit(1)
  }

  // 10. 결과 JSON 저장
  const resultsJsonPath = path.join(outDir, "e2e-results.json")
  fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2) + "\n", "utf-8")
  console.log(`[E2E1] 결과 저장 완료: ${resultsJsonPath}`)

  const total = results.length
  const passed = results.filter((r) => r.pass === true).length
  const notApplicable = results.filter((r) => r.status === "not-applicable").length
  const failed = results.filter((r) => r.pass === false).length

  console.log("==========================================")
  console.log(`E2E1 총 항목: ${total}`)
  console.log(`통과 (PASS): ${passed}`)
  if (notApplicable > 0) {
    console.log(`해당없음 (N/A): ${notApplicable}`)
  }
  console.log(`실패 (FAIL): ${failed}`)
  console.log("==========================================")

  if (failed > 0) {
    console.error("[E2E1] 실패 항목:")
    for (const f of results.filter((r) => r.pass === false)) {
      console.error(`- Step ${f.step} (${f.uc}, ${f.sp}): expected='${f.expected}', actual='${f.actual}'`)
    }
    process.exit(1)
  }
}

// =========================================================================
// MODE: UC01 (보기 전용 검증, 코드 작성 전용 — 조정자 실행)
// =========================================================================
async function runUc01Mode({
  rootArg,
  outDir,
  contentSource,
  scriptSource,
  planSource,
  planPath,
  episode,
  contentTab = "common",
  scriptTab = "common",
  planTab = "common",
}) {
  if (!rootArg) {
    console.error("오류: --mode uc01 에는 --root <작업공간 경로> 가 필수입니다.")
    process.exit(1)
  }
  const targetRoot = path.resolve(rootArg)
  console.log(`[E2E1 uc01] 시작: 대상 작업공간 ${targetRoot}, 결과 폴더 ${outDir}`)

  // 검수 반영 1: XDG_RUNTIME_DIR, TMPDIR은 스크립트가 만든 임시 폴더로 고정
  const tempRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "naia-adk-uc01-runtime-"))

  // 검수 반영 3 & 9: 잔류 프로세스 검사 (예외 발생 시 즉시 중단)
  checkNoRunningProcesses(REPO_ROOT)

  // 시작 전 저장소 .agents/work 상태 기록 (초기 존재 여부)
  const repoWorkDir = path.join(REPO_ROOT, ".agents", "work")
  const repoWorkExistedInitially = fs.existsSync(repoWorkDir)

  // .next 백업 및 이전 실행 복구
  const dashboardDir = path.join(REPO_ROOT, "packages", "dashboard")
  const dotNextDir = path.join(dashboardDir, ".next")
  const nextBackupDir = path.join(REPO_ROOT, ".agents", "work", "e2e1-next-backup")
  const nextBackupFingerprintFile = path.join(
    REPO_ROOT,
    ".agents",
    "work",
    "e2e1-next-backup.fingerprint.json",
  )

  recoverPreviousNextBackup({
    dashboardDir,
    dotNextDir,
    nextBackupDir,
    nextBackupFingerprintFile,
    tag: "E2E1 uc01",
  })

  const { originalBuildExisted, initialNextFingerprint, backupMoved } = backupNextDir({
    dotNextDir,
    nextBackupDir,
    nextBackupFingerprintFile,
    tag: "E2E1 uc01",
  })

  // -------------------------------------------------------------------------
  // 검수 반영 7 & 8: 실행 전 디스크를 읽어 기대값 선작성 및 e2e-results.json 저장
  // -------------------------------------------------------------------------
  let viewFolders = []
  const vfPath = path.join(targetRoot, ".agents", "work", "view-folders.json")
  if (fs.existsSync(vfPath)) {
    try {
      const vfData = JSON.parse(fs.readFileSync(vfPath, "utf-8"))
      viewFolders = vfData.folders || []
    } catch {}
  }

  function resolveSourceDir(sourceId) {
    if (!sourceId) return null
    if (sourceId === "adk") {
      return targetRoot
    }
    if (sourceId.startsWith("company:")) {
      const companyName = sourceId.slice("company:".length)
      return path.join(targetRoot, "data-company", companyName)
    }
    // 서버 규칙(packages/server/src/routes/portal.ts loadCompanyConfigs)
    const dataCompanyDir = path.join(targetRoot, "data-company")
    if (fs.existsSync(dataCompanyDir)) {
      try {
        const entries = fs.readdirSync(dataCompanyDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const configPath = path.join(dataCompanyDir, entry.name, "adk-company.json")
          if (!fs.existsSync(configPath)) continue
          try {
            const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
            if (Array.isArray(raw?.repos)) {
              for (const repo of raw.repos) {
                if (repo && repo.id === sourceId && repo.path) {
                  const repoPathNorm = repo.path.replace(/\\/g, "/")
                  return path.resolve(targetRoot, repoPathNorm)
                }
              }
            }
          } catch {}
        }
      } catch {}
    }
    const id = sourceId.startsWith("data:") ? sourceId.slice(5) : sourceId
    const found = viewFolders.find((f) => f.id === id)
    if (found && found.path) {
      const p = found.path.startsWith("~/")
        ? path.join(process.env.HOME || "", found.path.slice(2))
        : found.path
      return path.resolve(p)
    }
    // targetRoot로 되돌려 영상 기대를 거짓으로 떨어뜨리지 않는다
    return null
  }

  function resolveSourceLabel(sourceId) {
    if (!sourceId) return ""
    const id = sourceId.startsWith("data:") ? sourceId.slice(5) : sourceId
    const found = viewFolders.find((f) => f.id === id)
    return found?.label || id
  }

  // 편 폴더 안(하위 3단계)에 png/jpg/webp/gif 유무 검사
  function hasImageWithin3Levels(dirPath) {
    function scan(currentDir, currentDepth) {
      if (currentDepth > 3 || !fs.existsSync(currentDir)) return false
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true })
        for (const ent of entries) {
          if (ent.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(ent.name)) {
            return true
          }
        }
        if (currentDepth < 3) {
          for (const ent of entries) {
            if (ent.isDirectory()) {
              if (scan(path.join(currentDir, ent.name), currentDepth + 1)) {
                return true
              }
            }
          }
        }
      } catch {}
      return false
    }
    return scan(dirPath, 1)
  }

  const contentDir = resolveSourceDir(contentSource)
  const contentLabel = resolveSourceLabel(contentSource)

  const diskEpisodesImageInfo = {}
  if (contentDir && fs.existsSync(contentDir)) {
    try {
      const entries = fs.readdirSync(contentDir, { withFileTypes: true })
      for (const ent of entries) {
        if (ent.isDirectory()) {
          diskEpisodesImageInfo[ent.name] = hasImageWithin3Levels(path.join(contentDir, ent.name))
        }
      }
    } catch {}
  }

  const episodeDir = contentDir && episode ? path.join(contentDir, episode) : null
  const outDirDisk = episodeDir ? path.join(episodeDir, "out") : null
  let diskReadFailed = false
  let expectedOutFiles = []
  let expectedHasVideo = false
  let expectedHasImage = false
  if (!contentDir || !fs.existsSync(contentDir) || !episodeDir || !fs.existsSync(episodeDir) || !outDirDisk || !fs.existsSync(outDirDisk)) {
    diskReadFailed = true
  } else {
    try {
      expectedOutFiles = fs.readdirSync(outDirDisk)
      expectedHasVideo = expectedOutFiles.some((f) => /\.(mp4|webm)$/i.test(f))
      expectedHasImage = expectedOutFiles.some((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    } catch {
      diskReadFailed = true
    }
  }

  const TARGET_SUBFOLDER_NAMES = ["out", "cuts", "package", "lines"]
  let expectedEpisodeSubFolders = []
  if (episodeDir && fs.existsSync(episodeDir)) {
    try {
      const diskSubs = fs.readdirSync(episodeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
      expectedEpisodeSubFolders = TARGET_SUBFOLDER_NAMES.filter((name) => diskSubs.includes(name))
    } catch {
      diskReadFailed = true
    }
  }
  if (expectedEpisodeSubFolders.length === 0) {
    diskReadFailed = true
  }

  const scriptDir = resolveSourceDir(scriptSource)
  const scriptPathDisk = scriptDir && episode ? path.join(scriptDir, episode, "script.md") : null
  let expectedScriptTitle = ""
  if (scriptPathDisk && fs.existsSync(scriptPathDisk)) {
    try {
      const lines = fs.readFileSync(scriptPathDisk, "utf-8").split("\n")
      const firstHash = lines.find((l) => l.trim().startsWith("#"))
      expectedScriptTitle = firstHash ? firstHash.trim() : ""
    } catch {}
  }

  let planPathDisk = null
  if (planSource && planPath) {
    const planDir = resolveSourceDir(planSource)
    planPathDisk = planDir ? path.join(planDir, planPath) : null
  }
  let expectedPlanTitle = ""
  if (planPathDisk && fs.existsSync(planPathDisk)) {
    try {
      const lines = fs.readFileSync(planPathDisk, "utf-8").split("\n")
      const firstHash = lines.find((l) => l.trim().startsWith("#"))
      expectedPlanTitle = firstHash ? firstHash.trim() : ""
    } catch {}
  }

  const results = [
    {
      step: "01",
      uc: "UC-01",
      sp: "SP-01",
      expected: `출처 "${contentSource}"(tab: "${contentTab}", label: "${contentLabel}") 루트 격자에 편 폴더 "${episode}"와 대표 그림(img.naturalWidth > 0, img 없는 편은 디스크 하위 3단계 이미지 부재 확인)`,
      actual: "미실행",
      pass: false,
    },
    {
      step: "02",
      uc: "UC-01",
      sp: "SP-02",
      expected: `출처 "${contentSource}"(tab: "${contentTab}") 편 "${episode}" 폴더 안 [${expectedEpisodeSubFolders.join(", ")}] 칸 모두 표시`,
      actual: "미실행",
      pass: false,
    },
    {
      step: "03",
      uc: "UC-01",
      sp: "SP-03",
      expected: `출처 "${contentSource}"(tab: "${contentTab}") out 기대 파일 [${expectedOutFiles.join(", ")}] — 그림 클릭 크게 보기(naturalWidth>0) 및 영상 클릭 재생(readyState>=1) 둘 다`,
      actual: "미실행",
      pass: false,
    },
    {
      step: "04",
      uc: "UC-01",
      sp: "SP-03",
      expected: `대본 출처 "${scriptSource}"(tab: "${scriptTab}") 편 "${episode}"의 script.md 첫 제목줄("${expectedScriptTitle}")과 episode.json 들여쓰기 글자`,
      actual: "미실행",
      pass: false,
    },
    {
      step: "05",
      uc: "UC-01",
      sp: "SP-01",
      expected: `발행 계획 출처 "${planSource}"(tab: "${planTab}") 경로 "${planPath}" 첫 제목줄("${expectedPlanTitle}") 본문 표시`,
      actual: "미실행",
      pass: false,
    },
    {
      step: "06",
      uc: "UC-01",
      sp: "SP-06",
      expected: "PUT/POST/PATCH/DELETE 쓰기 요청 0건 (모든 요청 GET)",
      actual: "미실행",
      pass: false,
    },
  ]

  // 브라우저를 열기 전에 e2e-results.json 파일에 기대값 선기록
  fs.mkdirSync(outDir, { recursive: true })
  const resultsJsonPath = path.join(outDir, "e2e-results.json")
  fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2) + "\n", "utf-8")
  console.log(`[E2E1 uc01] 브라우저 열기 전 기대값 선기록 완료: ${resultsJsonPath}`)

  // 기대 필드 스냅샷 (실행 뒤 불변 검증용)
  const initialExpectedSnapshot = JSON.stringify(
    results.map((r) => ({ step: r.step, uc: r.uc, sp: r.sp, expected: r.expected })),
  )

  const childPids = []
  let browser = null
  let writeAttempted = false
  let writeDetails = []

  let cleanupDone = false
  async function performCleanup() {
    if (cleanupDone) return
    cleanupDone = true

    if (browser) {
      await browser.close().catch(() => {})
    }

    console.log("[E2E1 uc01] 자식 프로세스 그룹 종료 중...")
    await cleanupChildren(childPids)

    if (tempRuntime && fs.existsSync(tempRuntime)) {
      try {
        fs.rmSync(tempRuntime, { recursive: true, force: true })
      } catch {}
    }

    restoreNextDir({
      dashboardDir,
      dotNextDir,
      nextBackupDir,
      nextBackupFingerprintFile,
      originalBuildExisted,
      backupMoved,
      initialNextFingerprint,
      tag: "E2E1 uc01",
    })

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
          console.log("[E2E1 uc01] .agents/work 디렉터리 정리 완료.")
        } else {
          console.warn(`[E2E1 uc01 경고] .agents/work 에 다른 파일이 남아 있어 폴더를 유지합니다: ${remaining.join(", ")}`)
        }
      } catch (err) {
        console.warn(`[E2E1 uc01 경고] .agents/work 정리 실패: ${err.message}`)
      }
    }
  }

  const signalHandler = async (sig) => {
    console.warn(`\n[E2E1 uc01] 신호 수신 (${sig}): 정리 절차 수행 중...`)
    removeSignalHandlers()
    try {
      await performCleanup()
    } catch (err) {
      console.error("[E2E1 uc01] 정리 중 오류:", err)
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

  addSignalHandlers()
  try {
    const ports = await findFreePorts(2, 3171)
    const [P_API, P_DASH_SERVER] = ports
    console.log(`[E2E1 uc01] 할당 포트: API=${P_API}, 대시보드=${P_DASH_SERVER}`)

    const childEnv = {
      ...process.env,
      HOME: process.env.HOME, // 실제 홈 유지 (등록 경로 ~/ 풀이용)
      TMPDIR: tempRuntime,
      XDG_RUNTIME_DIR: tempRuntime,
      NAIA_API_PORT: String(P_API),
    }
    delete childEnv.NEXT_PUBLIC_API_URL

    // 대시보드 빌드
    console.log(`[E2E1 uc01] next build 실행 (NAIA_API_PORT=${P_API})...`)
    await new Promise((resolve, reject) => {
      const cp = spawn("pnpm", ["exec", "next", "build"], {
        cwd: dashboardDir,
        env: childEnv,
        stdio: "ignore",
      })
      cp.on("error", reject)
      cp.on("close", (code) => {
        if (code === 0) resolve()
        else reject(new Error(`next build failed code ${code}`))
      })
    })

    // 프로세스 기동
    const cpApi = spawn(
      "pnpm",
      ["exec", "tsx", "packages/server/src/cli.ts", "serve", "--port", String(P_API), "--host", "127.0.0.1", "--root", targetRoot],
      { cwd: REPO_ROOT, env: { ...childEnv, NAIA_API_PORT: "" }, detached: true, stdio: "ignore" },
    )
    childPids.push(cpApi.pid)

    const cpDash = spawn(
      process.execPath,
      ["server.mjs", "-H", "127.0.0.1", "-p", String(P_DASH_SERVER)],
      { cwd: dashboardDir, env: childEnv, detached: true, stdio: "ignore" },
    )
    childPids.push(cpDash.pid)

    await waitForPortListening(P_API)
    await waitForPortListening(P_DASH_SERVER)

    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

    // 쓰기 요청 가로채서 즉시 차단(abort) 및 실패 기록
    await page.route("**/*", async (route) => {
      const method = route.request().method()
      if (["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
        writeAttempted = true
        writeDetails.push(`${method} ${route.request().url()}`)
        await route.abort()
        return
      }
      await route.continue()
    })

    const BASE_URL = `http://127.0.0.1:${P_DASH_SERVER}`

    // Step 01: 결과물 출처 루트 격자에 편 폴더들과 대표 그림
    try {
      await page.goto(`${BASE_URL}/docs?tab=${encodeURIComponent(contentTab)}&source=${encodeURIComponent(contentSource || "")}`)
      await page.waitForSelector("aside", { timeout: 10000 })

      let step1TreePass = false
      try {
        const handleTreeCheck = await page.waitForFunction(
          (targetLabel) => {
            const headingEls = Array.from(
              document.querySelectorAll("aside div.text-xs.font-bold > span, aside div[class*='font-bold'] > span"),
            )
            const headings = headingEls.map((el) => (el.innerText || el.textContent || "").trim())
            return headings.includes(targetLabel)
          },
          contentLabel,
          { timeout: 20000, polling: 100 },
        )
        step1TreePass = Boolean(await handleTreeCheck.jsonValue())
      } catch {
        step1TreePass = false
      }

      if (!step1TreePass) {
        const diag = await page
          .evaluate(async () => {
            let apiStatus = 0
            let sources = []
            try {
              const res = await fetch("/api/portal")
              apiStatus = res.status
              if (res.ok) {
                const data = await res.json()
                if (Array.isArray(data.sources)) {
                  sources = data.sources.map((s) => ({
                    id: s.id,
                    tab: s.tab,
                    missing: Boolean(s.missing),
                    treeCount: Array.isArray(s.tree) ? s.tree.length : 0,
                  }))
                }
              }
            } catch {
              apiStatus = -1
            }

            const asideHeadings = Array.from(
              document.querySelectorAll("aside div.text-xs.font-bold > span, aside div[class*='font-bold'] > span"),
            )
              .map((el) => (el.innerText || el.textContent || "").trim())
              .filter(Boolean)

            const currentUrl = window.location.href

            const activeTabEl = document.querySelector(
              'aside [role="tab"][aria-selected="true"], aside [role="tab"].bg-neutral-700',
            )
            const activeTabLabel = (activeTabEl?.innerText || activeTabEl?.textContent || "").trim()

            return {
              apiStatus,
              sources,
              asideHeadings,
              currentUrl,
              activeTabLabel,
            }
          })
          .catch((err) => ({
            apiStatus: -1,
            sources: [],
            asideHeadings: [],
            currentUrl: "",
            activeTabLabel: "",
            evalError: err.message,
          }))

        results[0].actual =
          `트리에 요청한 출처 label "${contentLabel}" 가 없음 (시한 20초 초과 FAIL): ` +
          JSON.stringify({
            status: diag.apiStatus,
            sources: diag.sources,
            asideHeadings: diag.asideHeadings,
            currentUrl: diag.currentUrl,
            activeTab: diag.activeTabLabel,
          })
        results[0].pass = false
        console.error(`[E2E1 uc01] 트리에 출처 label "${contentLabel}" 이 없어 멈춤 (검수 반영 8):`, results[0].actual)
        await page.screenshot({ path: path.join(outDir, "01-uc01-content-root.png") }).catch(() => {})
        return
      }

      await page.waitForSelector("article", { timeout: 10000 })
      await page.waitForSelector("article .grid", { timeout: 10000 }).catch(() => {})
      await page
        .waitForFunction(
          () => document.querySelectorAll("article .grid > a, article .grid a").length > 0,
          null,
          { timeout: 10000 },
        )
        .catch(() => {})

      // 격자 내 카드(편 폴더 칸) 목록 확인
      const cardCount = await page.evaluate(() => {
        return document.querySelectorAll("article .grid > a, article .grid a").length
      })

      const cardResults = []
      let allCardsPassed = cardCount > 0

      for (let i = 0; i < cardCount; i++) {
        const initialInfo = await page.evaluate((idx) => {
          const cards = document.querySelectorAll("article .grid > a, article .grid a")
          const card = cards[idx]
          if (!card) return null
          card.scrollIntoView({ block: "nearest", inline: "nearest" })
          const titleEl = card.querySelector("span.font-medium, span[title]")
          const name =
            titleEl?.getAttribute("title") ||
            titleEl?.innerText?.trim() ||
            card.innerText?.trim() ||
            ""
          const img = card.querySelector("img")
          return {
            name,
            hasImg: Boolean(img),
          }
        }, i)

        if (!initialInfo) continue
        const { name, hasImg } = initialInfo

        if (hasImg) {
          const startMs = Date.now()
          let naturalWidth = 0
          let loadMs = 0
          let loaded = false

          try {
            const waitRes = await page.waitForFunction(
              (idx) => {
                const cards = document.querySelectorAll("article .grid > a, article .grid a")
                const card = cards[idx]
                if (!card) return false
                const img = card.querySelector("img")
                if (!img) return false
                if (img.complete && img.naturalWidth > 0) {
                  return { naturalWidth: img.naturalWidth }
                }
                return false
              },
              i,
              { timeout: 20000, polling: 100 },
            )
            const resVal = await waitRes.jsonValue()
            loadMs = Date.now() - startMs
            naturalWidth = resVal.naturalWidth
            loaded = true
          } catch {
            loadMs = Date.now() - startMs
            naturalWidth = await page
              .evaluate((idx) => {
                const cards = document.querySelectorAll("article .grid > a, article .grid a")
                const img = cards[idx]?.querySelector("img")
                return img ? img.naturalWidth : 0
              }, i)
              .catch(() => 0)
            loaded = false
          }

          cardResults.push({ name, hasImg: true, naturalWidth, loadMs })
          if (!loaded) {
            allCardsPassed = false
          }
        } else {
          // img가 없는 칸 (그림 없는 편)
          // 기대값 선기록 때 디스크에서 그 편 안(하위 3단계)에 png/jpg/webp/gif가 없는 것으로 확인된 경우만 통과
          const diskHasImg = Boolean(diskEpisodesImageInfo[name])
          const passNoImg = !diskHasImg
          cardResults.push({ name, hasImg: false, naturalWidth: 0, loadMs: 0 })
          if (!passNoImg) {
            allCardsPassed = false
          }
        }
      }

      // 스크린숏은 모든 칸 판정 뒤 찍는다
      await page.screenshot({ path: path.join(outDir, "01-uc01-content-root.png") })

      const epFound = episode
        ? cardResults.some((c) => c.name === episode || c.name.includes(episode))
        : true
      const step1Pass = Boolean(cardCount > 0 && epFound && allCardsPassed)

      results[0].actual = JSON.stringify({ epFound, allCardsPassed, cards: cardResults })
      results[0].pass = step1Pass
    } catch (err) {
      results[0].actual = `오류: ${err.message}`
      results[0].pass = false
      return
    }

    // Step 02: 편 폴더는 기대 하위 폴더(out·cuts·package·lines 중 디스크에 있는 것 전부) 칸 모두 표시
    try {
      if (diskReadFailed || !episodeDir || !fs.existsSync(episodeDir)) {
        throw new Error(`출처 폴더를 풀지 못했거나 디스크 읽기에 실패했습니다 (episodeDir=${episodeDir})`)
      }
      if (expectedEpisodeSubFolders.length === 0) {
        throw new Error("디스크에서 읽은 기대 하위 폴더 목록이 비어 있습니다")
      }

      await page.goto(`${BASE_URL}/docs?tab=${encodeURIComponent(contentTab)}&source=${encodeURIComponent(contentSource || "")}&path=${encodeURIComponent(episode || "")}`)
      await page.waitForSelector("article", { timeout: 10000 })

      // 칸 이름 요소 글 전체가 expectedEpisodeSubFolders의 각 항목과 일치하는지 확인
      const handleStep2 = await page.waitForFunction(
        (expectedList) => {
          const titleEls = Array.from(document.querySelectorAll("article .grid a span.font-medium, article .grid a span[title]"))
          const renderedNames = titleEls.map((el) => (el.innerText || el.textContent || "").trim())
          const allPresent = expectedList.every((name) => renderedNames.includes(name))
          if (allPresent) {
            return { allPresent, renderedNames }
          }
          return false
        },
        expectedEpisodeSubFolders,
        { timeout: 10000 },
      )
      const step2Check = await handleStep2.jsonValue()

      results[1].actual = `expected=[${expectedEpisodeSubFolders.join(", ")}], rendered=[${step2Check.renderedNames.join(", ")}]`
      results[1].pass = true
    } catch (err) {
      results[1].actual = `오류: ${err.message}`
      results[1].pass = false
    } finally {
      // 그 단계 판정(대기 조건 충족 또는 시한 초과) 뒤에 찍는다
      await page.screenshot({ path: path.join(outDir, "02-uc01-episode-folders.png") }).catch(() => {})
    }

    // Step 03: 그림 크게 보기 & 영상 재생 둘 다 (out에 영상이 없으면 absent 기록)
    try {
      if (diskReadFailed) {
        throw new Error(`출처 폴더를 풀지 못했거나 디스크 읽기에 실패했습니다 (outDirDisk=${outDirDisk})`)
      }

      await page.goto(`${BASE_URL}/docs?tab=${encodeURIComponent(contentTab)}&source=${encodeURIComponent(contentSource || "")}&path=${encodeURIComponent(`${episode || ""}/out`)}`)
      await page.waitForSelector("article", { timeout: 10000 })

      // 그림 칸 클릭하여 파일 보기 큰 그림 확인
      let imgOk = false
      const imgCard = page.locator("article a:has(img)").first()
      await imgCard.waitFor({ state: "visible", timeout: 10000 })
      await imgCard.click()

      // 파일 보기로 넘어간 뒤 큰 그림 naturalWidth>0만 인정 (.catch(() => {}) 삭제, 대기 실패=FAIL)
      const handleLargeImg = await page.waitForFunction(() => {
        const isFileView =
          window.location.search.includes(".png") ||
          window.location.search.includes(".jpg") ||
          window.location.search.includes(".jpeg") ||
          window.location.search.includes(".webp") ||
          window.location.search.includes(".gif") ||
          Boolean(document.querySelector("article a[download]"))
        const img = document.querySelector("article img")
        if (isFileView && img && img.naturalWidth > 0) {
          return { naturalWidth: img.naturalWidth }
        }
        return false
      }, null, { timeout: 10000 })
      const imgRes = await handleLargeImg.jsonValue()
      imgOk = Boolean(imgRes && imgRes.naturalWidth > 0)

      // out 격자로 복귀
      await page.goto(`${BASE_URL}/docs?tab=${encodeURIComponent(contentTab)}&source=${encodeURIComponent(contentSource || "")}&path=${encodeURIComponent(`${episode || ""}/out`)}`)
      await page.waitForSelector("article", { timeout: 10000 })

      // 영상 칸 클릭하여 파일 보기 영상 재생 확인
      let vidStatus = "absent"
      if (expectedHasVideo) {
        const vidCard = page.locator('article a:has-text(".mp4"), article a:has-text(".webm")').first()
        await vidCard.waitFor({ state: "visible", timeout: 10000 })
        await vidCard.click()

        const handleVideo = await page.waitForFunction(() => {
          const vid = document.querySelector("article video")
          if (vid && vid.readyState >= 1) {
            return { readyState: vid.readyState }
          }
          return false
        }, null, { timeout: 10000 })
        const vidRes = await handleVideo.jsonValue()
        vidStatus = vidRes && vidRes.readyState >= 1 ? "played" : "not_ready"
      }

      let step3Pass = false
      if (!expectedHasVideo) {
        step3Pass = imgOk
      } else {
        step3Pass = imgOk && vidStatus === "played"
      }

      results[2].actual = `imgLargeNaturalWidth=${imgOk}, videoStatus=${vidStatus} (expectedHasVideo=${expectedHasVideo})`
      results[2].pass = step3Pass
    } catch (err) {
      results[2].actual = `오류: ${err.message}`
      results[2].pass = false
    } finally {
      await page.screenshot({ path: path.join(outDir, "03-uc01-media-preview.png") }).catch(() => {})
    }

    // Step 04: 대본 출처 script.md 첫 제목줄 글 일치 및 episode.json 들여쓰기
    try {
      if (!scriptPathDisk || !fs.existsSync(scriptPathDisk)) {
        results[3].actual = `경로가 없음: ${scriptPathDisk} (FAIL 후 다음 단계)`
        results[3].pass = false
      } else {
        await page.goto(
          `${BASE_URL}/docs?tab=${encodeURIComponent(scriptTab)}&source=${encodeURIComponent(scriptSource || "")}&path=${encodeURIComponent(`${episode || ""}/script.md`)}`,
        )
        await page.waitForSelector("article", { timeout: 10000 })

        const expectedCleanTitle = expectedScriptTitle.replace(/^#+\s*/, "").trim()
        let displayedTitle = ""
        let scriptTitleOk = false

        try {
          const handleScript = await page.waitForFunction(
            ({ clean, raw }) => {
              const el =
                document.querySelector("article .prose h1") ||
                document.querySelector(".prose h1, .prose h2, .prose h3")
              const text = el?.innerText?.trim() || ""
              if (text && (text === clean || text === raw)) {
                return { matched: true, text }
              }
              return false
            },
            { clean: expectedCleanTitle, raw: expectedScriptTitle },
            { timeout: 10000, polling: 100 },
          )
          const scriptRes = await handleScript.jsonValue()
          displayedTitle = scriptRes.text
          scriptTitleOk = scriptRes.matched
        } catch {
          displayedTitle = await page.evaluate(() => {
            const el =
              document.querySelector("article .prose h1") ||
              document.querySelector(".prose h1, .prose h2, .prose h3")
            return el?.innerText?.trim() || ""
          })
          scriptTitleOk = displayedTitle === expectedCleanTitle || displayedTitle === expectedScriptTitle
        }
        await page.screenshot({ path: path.join(outDir, "04a-uc01-script-md.png") })

        await page.goto(
          `${BASE_URL}/docs?tab=${encodeURIComponent(scriptTab)}&source=${encodeURIComponent(scriptSource || "")}&path=${encodeURIComponent(`${episode || ""}/episode.json`)}`,
        )
        await page.waitForSelector("article pre", { timeout: 10000 })

        let jsonText = ""
        let jsonIndented = false

        try {
          const handleJson = await page.waitForFunction(
            () => {
              const pre = document.querySelector("article pre")
              const text = pre?.innerText || ""
              if (text && text.includes("\n  ")) {
                return { indented: true, text }
              }
              return false
            },
            null,
            { timeout: 10000, polling: 100 },
          )
          const jsonRes = await handleJson.jsonValue()
          jsonText = jsonRes.text
          jsonIndented = jsonRes.indented
        } catch {
          jsonText = await page.evaluate(() => document.querySelector("article pre")?.innerText || "")
          jsonIndented = jsonText.includes("\n  ")
        }
        await page.screenshot({ path: path.join(outDir, "04b-uc01-episode-json.png") })

        results[3].actual = `scriptTitleMatched=${scriptTitleOk} (displayed="${displayedTitle}", expected="${expectedCleanTitle}"), jsonIndented=${jsonIndented}`
        results[3].pass = Boolean(scriptTitleOk && jsonIndented)
      }
    } catch (err) {
      results[3].actual = `오류: ${err.message}`
      results[3].pass = false
    }

    // Step 05: 발행 계획 문서 첫 제목줄 일치
    try {
      if (!planPathDisk || !fs.existsSync(planPathDisk)) {
        results[4].actual = `경로가 없음: ${planPathDisk} (FAIL 후 다음 단계)`
        results[4].pass = false
      } else {
        await page.goto(
          `${BASE_URL}/docs?tab=${encodeURIComponent(planTab)}&source=${encodeURIComponent(planSource || "")}&path=${encodeURIComponent(planPath || "")}`,
        )
        await page.waitForSelector("article", { timeout: 10000 })

        const expectedPlanClean = expectedPlanTitle.replace(/^#+\s*/, "").trim()
        let displayedPlanTitle = ""
        let planTitleOk = false

        try {
          const handlePlan = await page.waitForFunction(
            ({ clean, raw }) => {
              const el =
                document.querySelector("article .prose h1") ||
                document.querySelector(".prose h1, .prose h2, .prose h3")
              const text = el?.innerText?.trim() || ""
              if (text && (text === clean || text === raw)) {
                return { matched: true, text }
              }
              return false
            },
            { clean: expectedPlanClean, raw: expectedPlanTitle },
            { timeout: 10000, polling: 100 },
          )
          const planRes = await handlePlan.jsonValue()
          displayedPlanTitle = planRes.text
          planTitleOk = planRes.matched
        } catch {
          displayedPlanTitle = await page.evaluate(() => {
            const el =
              document.querySelector("article .prose h1") ||
              document.querySelector(".prose h1, .prose h2, .prose h3")
            return el?.innerText?.trim() || ""
          })
          planTitleOk = displayedPlanTitle === expectedPlanClean || displayedPlanTitle === expectedPlanTitle
        }
        await page.screenshot({ path: path.join(outDir, "05-uc01-plan-doc.png") })

        results[4].actual = `planTitleMatched=${planTitleOk} (displayed="${displayedPlanTitle}", expected="${expectedPlanClean}")`
        results[4].pass = Boolean(planTitleOk)
      }
    } catch (err) {
      results[4].actual = `오류: ${err.message}`
      results[4].pass = false
    }

    // Step 06: 쓰기 차단 검증
    results[5].actual = writeAttempted ? `쓰기 발생 차단됨: ${writeDetails.join(", ")}` : "쓰기 요청 없음 (정상)"
    results[5].pass = !writeAttempted

  } finally {
    removeSignalHandlers()
    await performCleanup()

    // 검수 반영 7: 쓰기 전후 기대 필드 JSON 동일 확인
    const finalExpectedSnapshot = JSON.stringify(
      results.map((r) => ({ step: r.step, uc: r.uc, sp: r.sp, expected: r.expected })),
    )
    if (initialExpectedSnapshot !== finalExpectedSnapshot) {
      console.error("치명적 오류: uc01 기대 필드가 실행 중 변조되었습니다!")
      process.exit(1)
    }

    // 결과 기록 (기대 필드는 유지하고 실제값·판정만 갱신)
    fs.writeFileSync(resultsJsonPath, JSON.stringify(results, null, 2) + "\n", "utf-8")
    console.log(`[E2E1 uc01] 결과 JSON 저장 완료: ${resultsJsonPath}`)

    const total = results.length
    const passed = results.filter((r) => r.pass === true).length
    const failed = results.filter((r) => r.pass === false).length

    console.log("==========================================")
    console.log(`[E2E1 uc01] 총 항목: ${total}`)
    console.log(`통과 (PASS): ${passed}`)
    console.log(`실패 (FAIL): ${failed}`)
    console.log("==========================================")

    if (failed > 0) {
      console.error("[E2E1 uc01] 실패 항목:")
      for (const f of results.filter((r) => r.pass === false)) {
        console.error(`- Step ${f.step} (${f.uc}, ${f.sp}): expected='${f.expected}', actual='${f.actual}'`)
      }
      process.exit(1)
    }
  }
}

// 직접 실행 시
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((err) => {
    console.error("E2E 스크립트 실행 중 예외 발생:", err)
    process.exit(1)
  })
}
