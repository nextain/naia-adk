#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export function resolveBoardConfig(adkRoot, env = process.env) {
  const dataCompanyDir = path.join(adkRoot, "data-company")
  if (!fs.existsSync(dataCompanyDir)) {
    return null
  }

  let entries = []
  try {
    entries = fs.readdirSync(dataCompanyDir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const configPath = path.join(dataCompanyDir, entry.name, "adk-company.json")
    if (!fs.existsSync(configPath)) continue

    let config
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
    } catch {
      continue
    }

    if (!config || typeof config !== "object" || !config.board || typeof config.board !== "object") {
      continue
    }

    const { board, repos } = config
    if (!board.repo || !board.script || !board.port) {
      continue
    }

    if (!Array.isArray(repos)) {
      continue
    }

    const targetRepo = repos.find((r) => r && r.id === board.repo)
    if (!targetRepo || !targetRepo.path) {
      continue
    }

    const repoAbsPath = path.resolve(adkRoot, targetRepo.path)
    const scriptAbsPath = path.resolve(repoAbsPath, board.script)

    if (!fs.existsSync(scriptAbsPath)) {
      continue
    }

    const host = env.ADK_HOST || "127.0.0.1"
    const publicHost = env.ADK_PUBLIC_HOST || "localhost"
    const port = Number(board.port)
    const docsViewerUrl = `http://${publicHost}:3142/docs`

    const args = [
      scriptAbsPath,
      "--host",
      host,
      "--port",
      String(port),
      "--docs-viewer-url",
      docsViewerUrl,
    ]

    return {
      repoDir: repoAbsPath,
      scriptPath: scriptAbsPath,
      host,
      port,
      publicHost,
      docsViewerUrl,
      args,
    }
  }

  return null
}

export function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const adkRoot = path.resolve(__dirname, "..")

  const boardConfig = resolveBoardConfig(adkRoot)

  if (!boardConfig) {
    console.log("작업보드 없음: pnpm adk:setup 먼저")
    process.exit(0)
  }

  console.log(`작업보드 실행 중: node ${boardConfig.args.join(" ")}`)
  const child = spawn(process.execPath, boardConfig.args, {
    cwd: boardConfig.repoDir,
    stdio: "inherit",
    env: process.env,
  })

  child.on("close", (code) => {
    process.exit(code ?? 0)
  })

  child.on("error", (err) => {
    console.error(`작업보드 프로세스 에러: ${err.message}`)
    process.exit(1)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
