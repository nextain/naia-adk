#!/usr/bin/env node
// 문서 짧은 주소 만들기 (ADK 기본 기능)
//
// 쓰는 법:
//   node packages/dashboard/scripts/short-link.mjs <긴 주소 | /d/출처/경로 | 문서 경로> [--source <출처>] [--base <바깥 주소>] [--path-form] [--root <ADK 뿌리>] [--verify]
// 예:
//   node packages/dashboard/scripts/short-link.mjs docs/developer/architecture/ARCHITECTURE.md
//   node packages/dashboard/scripts/short-link.mjs "http://<대시보드 주소>/docs?tab=developer&source=adk&path=developer%2Farchitecture%2FARCHITECTURE.md"
// 출력: 짧은 주소 한 줄 (예: http://<대시보드 주소>/d/1a2b3c)
//
// 바깥 주소는 --base > 긴 주소의 앞부분 > NAIA_DASHBOARD_PUBLIC_URL > 테일넷 이름+NAIA_DASHBOARD_PORT > localhost 순.
// 키 등록은 그 주소의 대시보드(POST /d)에 맡긴다. 그래야 저장소 사본이 여럿이어도 서버가 읽는 표 하나에 남는다.
// 대시보드가 응답하지 않을 때만 이 사본의 표 파일(NAIA_SHORT_LINKS_FILE, 없으면 packages/dashboard/data/short-links.json)에
// 직접 쓰고 표준 오류에 알린다.
//
// 대시보드가 열 수 없는 경로는 키를 만들지 않고 거절한다(문서 API /api/portal/doc 가 404 를 주는 경로).
//   - .md 가 아닌 파일
//   - 점으로 시작하는 폴더·파일(.agents/ 등), node_modules, data-private 이 든 경로 (대시보드가 숨긴다)
//   - adk 출처에서 docs/ 밖에 있는 저장소 파일 (adk 출처의 뿌리는 docs/ 다). --root(없으면 NAIA_ADK_ROOT,
//     없으면 현재 폴더부터 위로 AGENTS.md 와 docs/ 가 있는 곳)에서 파일이 docs/ 밖에만 있으면 거절한다.
// 거절하면 "docs/ 아래로 옮기라"고 알린다.
// --verify: 키를 만든 뒤 /d/<키> 가 넘기는 문서를 문서 API 로 읽어 200 이 아니면 실패한다(302 만으로는 내용이 뜨는지 모른다).

import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { getTailscaleDnsName } from "../host-guard.mjs"
import { defaultTableFile, parseDocTarget, publicBaseUrl, registerShortLink } from "../short-links.mjs"

const MOVE_HINT = "the dashboard only shows markdown under docs/ (source adk); move or copy the document under docs/ and make the link from there"

function usage(code) {
  const out = code === 0 ? process.stdout : process.stderr
  out.write(
    "usage: node packages/dashboard/scripts/short-link.mjs <long-url | /d/<source>/<path> | doc-path> [--source <id>] [--base <url>] [--path-form] [--root <adk-root>] [--verify]\n",
  )
  process.exit(code)
}

// 대시보드 서버의 숨김 규칙과 같다: 끝의 점·공백을 떼고 소문자로 본 이름이 점으로 시작하거나 node_modules·data-private 이면 숨김.
function hiddenSegment(docPath) {
  for (const seg of docPath.split("/")) {
    const name = seg.normalize("NFC").replace(/[\s.]+$/, "").toLowerCase()
    if (!name || name.startsWith(".") || name === "node_modules" || name === "data-private") return seg
  }
  return null
}

export function findAdkRoot({ explicit, env = process.env, cwd = process.cwd() } = {}) {
  if (explicit) return path.resolve(explicit)
  if (env.NAIA_ADK_ROOT) return path.resolve(env.NAIA_ADK_ROOT)
  let dir = path.resolve(cwd)
  for (;;) {
    if (fs.existsSync(path.join(dir, "AGENTS.md")) && fs.existsSync(path.join(dir, "docs"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// 대시보드 문서 API 가 열 수 있는 경로인지 미리 본다. 못 열면 이유와 옮길 곳을 담아 던진다.
//   input: 사람이 준 원래 입력(저장소 기준 경로일 수 있음). root: ADK 뿌리(없으면 파일 위치 검사는 건너뜀).
export function assertDashboardReadable({ source, path: docPath, input, root }) {
  if (!docPath.toLowerCase().endsWith(".md")) {
    throw new Error(`not a markdown document: ${docPath}; ${MOVE_HINT}`)
  }
  const hidden = hiddenSegment(docPath)
  if (hidden !== null) {
    throw new Error(`the dashboard hides "${hidden}" (${source}:${docPath}); ${MOVE_HINT}`)
  }
  if (source === "adk" && root && typeof input === "string" && !/^https?:\/\//i.test(input) && !input.startsWith("/")) {
    const rel = input.trim().replace(/^\.\//, "")
    if (!rel.startsWith("docs/") && !isFile(path.join(root, "docs", docPath)) && isFile(path.join(root, rel))) {
      throw new Error(`${rel} is outside docs/ and the dashboard cannot open it; ${MOVE_HINT}`)
    }
  }
}

async function registerViaServer(origin, target, fetchImpl) {
  const res = await fetchImpl(`${origin}/d`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ source: target.source, path: target.path }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`dashboard answered ${res.status}`)
  const body = await res.json()
  if (typeof body?.key !== "string" || !/^[0-9a-f]{6,16}$/.test(body.key)) throw new Error("dashboard answered without a key")
  return body.key
}

// 짧은 주소가 실제로 문서 내용을 띄우는지 확인한다: /d/… 의 302 대상에서 출처·경로를 읽고 문서 API 가 200 인지 본다.
export async function verifyShortLink(shortUrl, { fetchImpl = fetch } = {}) {
  const u = new URL(shortUrl)
  const hop = await fetchImpl(u.href, { redirect: "manual", signal: AbortSignal.timeout(5000) })
  if (hop.status !== 302 && hop.status !== 301 && hop.status !== 307 && hop.status !== 308) {
    throw new Error(`verify: ${shortUrl} answered ${hop.status}, not a redirect`)
  }
  const location = hop.headers.get("location")
  if (!location) throw new Error(`verify: ${shortUrl} redirect has no location`)
  const target = new URL(location, u.origin)
  const source = target.searchParams.get("source")
  const docPath = target.searchParams.get("path")
  if (!source || !docPath) throw new Error(`verify: ${shortUrl} does not point at a document (${location})`)
  const api = `${u.origin}/api/portal/doc?source=${encodeURIComponent(source)}&path=${encodeURIComponent(docPath)}`
  const res = await fetchImpl(api, { signal: AbortSignal.timeout(5000) })
  if (res.status !== 200) {
    throw new Error(`verify: document API answered ${res.status} for ${source}:${docPath}; the link redirects but shows nothing. ${MOVE_HINT}`)
  }
  return { source, path: docPath }
}

export async function run(argv, { env = process.env, cwd = process.cwd(), fetchImpl = fetch, tailscaleDns = () => getTailscaleDnsName(), stderr = process.stderr } = {}) {
  let input = null
  let source = "adk"
  let base = null
  let pathForm = false
  let rootArg = null
  let verify = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "-h" || a === "--help") return { help: true }
    else if (a === "--source" && argv[i + 1]) source = argv[++i]
    else if (a === "--base" && argv[i + 1]) base = argv[++i]
    else if (a === "--root" && argv[i + 1]) rootArg = argv[++i]
    else if (a === "--path-form") pathForm = true
    else if (a === "--verify") verify = true
    else if (input === null) input = a
    else return { usage: true }
  }
  if (input === null) return { usage: true }

  const target = parseDocTarget(input, { defaultSource: source })
  assertDashboardReadable({ source: target.source, path: target.path, input, root: findAdkRoot({ explicit: rootArg, env, cwd }) })
  const origin = publicBaseUrl({ explicit: base || target.origin, env, tailscaleDns })
  let line
  if (pathForm) {
    const encoded = [target.source, ...target.path.split("/")].map(encodeURIComponent).join("/")
    line = `${origin}/d/${encoded}`
  } else {
    let key
    try {
      key = await registerViaServer(origin, target, fetchImpl)
    } catch (err) {
      const file = defaultTableFile(env)
      stderr.write(`short-link: dashboard at ${origin} did not register (${err.message}); writing ${file} directly\n`)
      key = registerShortLink(target.source, target.path, file)
    }
    line = `${origin}/d/${key}`
  }
  if (verify) await verifyShortLink(line, { fetchImpl })
  return line
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    (out) => {
      if (out && out.help) usage(0)
      if (out && out.usage) usage(2)
      process.stdout.write(`${out}\n`)
    },
    (err) => {
      process.stderr.write(`short-link: ${err.message}\n`)
      process.exit(1)
    },
  )
}
