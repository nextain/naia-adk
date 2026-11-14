#!/usr/bin/env node
// 3층 쓰기 막기의 긴급 예외 기록(.agents/lead-guard/exception.json, 한 번에 하나)을 연다·닫는다·본다.
// 승인자가 허락한 예외만 연다. 3층 세션에서는 이 대본이 열리지 않는다(훅이 막고, 이 대본도 조상 claude 를 보고 거부한다).
// 사용: node scripts/lead-guard-exception.mjs open --scope <절대경로>[,..] --ttl-min <1..480> --approved-by <이름> --approval-ref "<승인자 원문 또는 링크>" --reason "<이유>"
//       node scripts/lead-guard-exception.mjs close | status
import fs from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const g = require("../.claude/hooks/lib/lead-guard.js")

const josa = (word, a, b) => {
  const c = word ? word.charCodeAt(word.length - 1) : 0
  return c >= 0xAC00 && c <= 0xD7A3 ? ((c - 0xAC00) % 28 !== 0 ? a : b) : b
}

const [cmd, ...rest] = process.argv.slice(2)
const opt = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[++i]
const die = (m) => { console.error(m); process.exit(1) }

if (cmd === "status") {
  const ex = g.activeException()
  console.log(ex ? `열림: ${ex.id} 범위 ${ex.scope.join(", ")} ~ ${ex.expires_at}` : "열린 예외 없음")
  process.exit(0)
}
if (cmd !== "open" && cmd !== "close") die("사용: open|close|status")

// 가장 가까운 claude 만이 아니라 조상 전부를 본다: 3층이 띄운 일꾼(claude -p)이 대신 열어도 거부한다.
const leadRole = g.claudeAncestors()
  .filter((a) => !a.headless)
  .map((a) => (a.cwd || a.projectDir) && g.roleConfigFrom(a.cwd || a.projectDir))
  .find(Boolean)
if (leadRole) {
  const { approverLabel } = g.guardMeta(leadRole)
  die(`3층 세션에서는(3층이 띄운 일꾼 포함) 예외를 열거나 닫을 수 없습니다. ${josa(approverLabel, approverLabel + "이", approverLabel + "가")} 직접 엽니다.`)
}

if (cmd === "close") {
  const ex = g.activeException()
  fs.rmSync(g.EXCEPTION_FILE, { force: true })
  g.audit({ event: "exception-close", exception_id: ex && ex.id })
  console.log("닫음")
  process.exit(0)
}

const scope = String(opt.scope || "").split(",").filter(Boolean)
const ttl = Number(opt["ttl-min"])
if (!scope.length || scope.some((s) => !s.startsWith("/"))) die("--scope 는 절대 경로(쉼표로 여러 개)")
if (!(ttl >= 1 && ttl <= g.MAX_EXCEPTION_MS / 60000)) die(`--ttl-min 은 1..${g.MAX_EXCEPTION_MS / 60000}`)
for (const k of ["approved-by", "approval-ref", "reason"]) if (!opt[k]) die(`--${k} 필요`)
const now = Date.now()
const rec = {
  id: `EX-${new Date(now).toISOString().replace(/\D/g, "").slice(0, 14)}`,
  approved_by: opt["approved-by"], approval_ref: opt["approval-ref"], reason: opt.reason, scope,
  created_at: new Date(now).toISOString(), expires_at: new Date(now + ttl * 60000).toISOString(),
}
fs.mkdirSync(g.STATE_DIR, { recursive: true })
fs.writeFileSync(g.EXCEPTION_FILE, JSON.stringify(rec, null, 2) + "\n")
if (!g.activeException()) { fs.rmSync(g.EXCEPTION_FILE, { force: true }); die("기록이 유효 조건(범위 3단계 이상 경로, 근거 8자 이상)을 못 채워 지웠습니다") }
g.audit({ event: "exception-open", ...rec })
console.log(`열림: ${rec.id} ~ ${rec.expires_at}`)
