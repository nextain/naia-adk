#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export function parseArgs(rawArgs) {
  const args = {
    company: null,
    pull: false,
    dryRun: false,
  }

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === "--company") {
      args.company = rawArgs[++i] || null
    } else if (arg.startsWith("--company=")) {
      args.company = arg.slice("--company=".length)
    } else if (arg === "--pull") {
      args.pull = true
    } else if (arg === "--dry-run") {
      args.dryRun = true
    }
  }

  return args
}

export function extractRepoName(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== "string") return ""
  let clean = remoteUrl.trim().replace(/[/\\]+$/, "")
  if (clean.endsWith(".git")) {
    clean = clean.slice(0, -4)
  }
  const parts = clean.split(/[/:/\\]/)
  return parts.pop() || ""
}

export function validateCompanyConfigRaw(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, error: "adk-company.json: must be a JSON object" }
  }
  if (raw.schemaVersion !== 1) {
    return { valid: false, error: "adk-company.json: schemaVersion must be 1" }
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    return { valid: false, error: "adk-company.json: title must be a non-empty string" }
  }
  if (raw.repos !== undefined) {
    if (!Array.isArray(raw.repos)) {
      return { valid: false, error: "adk-company.json: repos must be an array" }
    }
    for (let i = 0; i < raw.repos.length; i++) {
      const repo = raw.repos[i]
      if (typeof repo !== "object" || repo === null || Array.isArray(repo)) {
        return { valid: false, error: `adk-company.json: repos[${i}] must be an object` }
      }
      if (typeof repo.id !== "string" || repo.id.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].id must be a non-empty string` }
      }
      if (typeof repo.remote !== "string" || repo.remote.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].remote must be a non-empty string` }
      }
      if (typeof repo.path !== "string" || repo.path.trim() === "") {
        return { valid: false, error: `adk-company.json: repos[${i}].path must be a non-empty string` }
      }
      const norm = repo.path.replace(/\\/g, "/")
      const isAbsolute = path.isAbsolute(repo.path) || norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)
      const hasDotDot = norm.split("/").includes("..")
      const isAllowed = norm.startsWith("projects/") || norm.startsWith("data-company/")
      if (isAbsolute || hasDotDot || !isAllowed) {
        return {
          valid: false,
          error: `adk-company.json: repos[${i}].path must be under projects/ or data-company/ without '..'`,
        }
      }
    }
  }
  return { valid: true, data: raw }
}

export function isGitTreeClean(repoDir) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return status.length === 0
  } catch {
    return false
  }
}

export function findCompanyConfigs(adkRoot) {
  const dataCompanyDir = path.join(adkRoot, "data-company")
  if (!fs.existsSync(dataCompanyDir)) return []

  const results = []
  const entries = fs.readdirSync(dataCompanyDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const configPath = path.join(dataCompanyDir, entry.name, "adk-company.json")
      if (fs.existsSync(configPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"))
          const validated = validateCompanyConfigRaw(raw)
          results.push({
            dirName: entry.name,
            configPath,
            valid: validated.valid,
            error: validated.valid ? null : validated.error,
            config: validated.valid ? validated.data : null,
          })
        } catch (err) {
          results.push({
            dirName: entry.name,
            configPath,
            valid: false,
            error: `adk-company.json: invalid JSON syntax (${err.message})`,
            config: null,
          })
        }
      }
    }
  }
  return results
}

export function runSetup(options = {}, customAdkRoot = null) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const adkRoot = customAdkRoot || path.resolve(__dirname, "..")
  const { company, pull, dryRun } = options

  const summary = {
    received: [],
    skipped: [],
    errors: [],
  }

  // 1. --company clone
  if (company) {
    const repoName = extractRepoName(company)
    // 폴더 이름으로 쓰므로 영문·숫자·._- 만 허용하고 . 과 .. 은 거부한다.
    if (!repoName || !/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === "." || repoName === "..") {
      summary.errors.push(`잘못된 git 주소입니다: ${company}`)
    } else {
      const targetDir = path.join(adkRoot, "data-company", repoName)
      if (fs.existsSync(targetDir)) {
        // --pull이면 아래에서 최신으로 받고 그 결과를 따로 적으므로 여기서는 건너뜀으로 적지 않는다.
        if (!pull) summary.skipped.push({ target: `data-company/${repoName}`, reason: "이미 받아 둔 폴더입니다." })
      } else {
        if (dryRun) {
          summary.received.push(`[dry-run] git clone ${company} data-company/${repoName}`)
        } else {
          try {
            fs.mkdirSync(path.join(adkRoot, "data-company"), { recursive: true })
            execFileSync("git", ["clone", "--", company, targetDir], { stdio: "inherit" })
            summary.received.push(`data-company/${repoName}`)
          } catch (err) {
            summary.errors.push(`git clone 실패 (${company}): ${err.message}`)
          }
        }
      }
    }
  }

  // 2. data-company/*/adk-company.json 탐색 및 repos clone
  const companyConfigs = findCompanyConfigs(adkRoot)
  const reposToPull = []

  for (const item of companyConfigs) {
    if (!item.valid) {
      summary.errors.push(`${item.configPath}: ${item.error}`)
      continue
    }

    const config = item.config
    if (Array.isArray(config.repos)) {
      for (const repo of config.repos) {
        const repoAbsPath = path.resolve(adkRoot, repo.path)
        if (fs.existsSync(repoAbsPath)) {
          // --pull이면 아래에서 최신으로 받고 그 결과를 따로 적는다. 같은 저장소가 두 번 나오지 않게 한다.
          if (!pull) summary.skipped.push({ target: repo.path, reason: "이미 받아 둔 폴더입니다." })
          reposToPull.push({ path: repo.path, absPath: repoAbsPath })
        } else {
          if (dryRun) {
            summary.received.push(`[dry-run] git clone ${repo.remote} ${repo.path}`)
          } else {
            try {
              fs.mkdirSync(path.dirname(repoAbsPath), { recursive: true })
              execFileSync("git", ["clone", "--", repo.remote, repoAbsPath], { stdio: "inherit" })
              summary.received.push(repo.path)
              reposToPull.push({ path: repo.path, absPath: repoAbsPath })
            } catch (err) {
              summary.errors.push(`git clone 실패 (${repo.remote} -> ${repo.path}): ${err.message}`)
            }
          }
        }
      }
    }
  }

  // 3. --pull 처리
  if (pull) {
    const pullTargets = [
      { name: "ADK (맨 위 폴더)", absPath: adkRoot },
    ]

    for (const item of companyConfigs) {
      if (item.valid) {
        const companyDir = path.dirname(item.configPath)
        pullTargets.push({ name: `data-company/${item.dirName}`, absPath: companyDir })
      }
    }

    for (const r of reposToPull) {
      pullTargets.push({ name: r.path, absPath: r.absPath })
    }

    const seen = new Set()
    for (const target of pullTargets) {
      // 같은 폴더를 두 번 받지 않는다.
      const key = path.resolve(target.absPath)
      if (seen.has(key)) continue
      seen.add(key)
      if (!fs.existsSync(path.join(target.absPath, ".git"))) {
        continue
      }
      if (isGitTreeClean(target.absPath)) {
        if (dryRun) {
          summary.received.push(`[dry-run] git pull --ff-only (${target.name})`)
        } else {
          try {
            execFileSync("git", ["pull", "--ff-only"], { cwd: target.absPath, stdio: "inherit" })
            summary.received.push(`최신으로 받음: ${target.name}`)
          } catch (err) {
            summary.errors.push(`pull 실패 (${target.name}): ${err.message}`)
          }
        }
      } else {
        const msg = `고치던 파일이 있어 건너뜁니다: ${target.name}`
        console.log(msg)
        summary.skipped.push({ target: target.name, reason: "고치던 파일이 있어 최신으로 받지 않음" })
      }
    }
  }

  // 요약 출력
  console.log("\n================ 작업 공간 준비 결과 ================")
  if (summary.received.length > 0) {
    console.log("받은 항목:")
    for (const r of summary.received) {
      console.log(`  + ${r}`)
    }
  } else {
    console.log("받은 항목: 없음")
  }

  if (summary.skipped.length > 0) {
    console.log("건너뛴 항목:")
    for (const s of summary.skipped) {
      console.log(`  - ${s.target} (${s.reason})`)
    }
  } else {
    console.log("건너뛴 항목: 없음")
  }

  if (summary.errors.length > 0) {
    console.log("오류 항목:")
    for (const e of summary.errors) {
      console.log(`  ! ${e}`)
    }
  }

  console.log("\n다음 할 일: ./start.sh 또는 start.bat 을 실행하여 ADK 서버와 대시보드를 시작하세요.\n")

  return summary
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2))
  const summary = runSetup(options)
  if (summary.errors.length > 0) {
    process.exit(1)
  }
}
