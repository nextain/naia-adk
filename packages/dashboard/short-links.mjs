// 문서 짧은 주소 (ADK 기본 기능)
//
// 휴대폰에서 긴 문서 주소(/docs?tab=…&source=…&path=…)가 너무 길어서, 대시보드가 짧은 주소를 받아
// 긴 주소로 넘겨 준다(302). 두 가지 형식을 받는다.
//   /d/<키>               키는 "출처\n경로"의 sha256 앞 6자(16진). 표 파일에 등록된 것만 연다.
//   /d/<출처>/<경로>      표 없이 바로 넘겨 준다. 예: /d/adk/developer/architecture/ARCHITECTURE.md
// 표 파일은 NAIA_SHORT_LINKS_FILE, 없으면 이 폴더의 data/short-links.json 이다.
// 키는 문서 경로에서 결정적으로 나오므로 표를 잃어도 같은 명령으로 같은 키를 다시 만든다.
// 기기 이름·포트·테일넷 주소는 이 파일에 두지 않는다. 바깥 주소는 publicBaseUrl()이 설정에서 읽는다.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SHORT_KEY_LENGTH = 6
const MAX_KEY_LENGTH = 16
const MAX_PATH_LENGTH = 1024
// 표 상한. 인증 없는 POST /d 로 표가 끝없이 커지지 않게 한다. 넘으면 새 키를 받지 않는다(이미 있는 키는 그대로 돌려준다).
export const MAX_SHORT_LINKS = 10000
export const MAX_TABLE_BYTES = 4 * 1024 * 1024
const KEY_RE = /^[0-9a-f]{6,16}$/
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/

export function defaultTableFile(env = process.env) {
  return env.NAIA_SHORT_LINKS_FILE || path.join(__dirname, "data", "short-links.json")
}

// 출처 id 검사: 영문·숫자로 시작, 영문·숫자·. _ @ : - 만, 128자 이하.
export function isValidSource(source) {
  return typeof source === "string" && SOURCE_RE.test(source) && !source.includes("..")
}

// 문서 경로 검사: 출처 안의 상대 경로만. 빈 조각·. ·.. ·역슬래시·제어 문자·앞 / 금지.
export function isValidDocPath(docPath) {
  if (typeof docPath !== "string" || docPath.length === 0 || docPath.length > MAX_PATH_LENGTH) return false
  if (docPath.includes("\\") || /[\u0000-\u001f\u007f]/.test(docPath)) return false
  if (docPath.startsWith("/")) return false
  for (const seg of docPath.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false
  }
  return true
}

// 대시보드 문서 API 의 숨김 규칙과 같다: 끝의 점·공백을 떼고 소문자로 본 이름이 점으로 시작하거나
// node_modules·data-private 이면 숨김. 숨긴 조각을 돌려주고, 없으면 null.
export function hiddenSegment(docPath) {
  for (const seg of docPath.split("/")) {
    const name = seg.normalize("NFC").replace(/[\s.]+$/, "").toLowerCase()
    if (!name || name.startsWith(".") || name === "node_modules" || name === "data-private") return seg
  }
  return null
}

// 표에 등록할 수 있는 문서 경로: 출처 안의 .md 이고 대시보드가 숨기는 조각이 없어야 한다.
// 출처 밖(..·앞 /)은 isValidDocPath 가 막는다. adk 출처의 뿌리가 docs/ 라서 등록되는 경로는 늘 docs/ 안이다.
export function isRegistrableDocPath(docPath) {
  return isValidDocPath(docPath) && docPath.toLowerCase().endsWith(".md") && hiddenSegment(docPath) === null
}

function tableError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

export function shortKeyFor(source, docPath, length = SHORT_KEY_LENGTH) {
  return crypto.createHash("sha256").update(`${source}\n${docPath}`, "utf8").digest("hex").slice(0, length)
}

export function emptyTable() {
  return { version: 1, links: {} }
}

function isTableShape(parsed) {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.links !== null &&
    typeof parsed.links === "object" &&
    !Array.isArray(parsed.links)
  )
}

// 등록용 표 읽기. 파일이 없으면 빈 표, 읽을 수 없거나 모양이 깨졌으면 던진다(깨진 표를 덮어쓰거나 저장한 척하지 않는다).
function readTableForWrite(file) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return emptyTable()
    throw tableError("SHORT_LINK_TABLE_UNREADABLE", `short link table cannot be read: ${err.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (!isTableShape(parsed)) throw tableError("SHORT_LINK_TABLE_BROKEN", `short link table is not {"version":1,"links":{…}}: ${file}`)
  return { version: 1, links: parsed.links }
}

// 표 읽기(넘겨 주기용). 파일이 없거나 깨졌으면 빈 표.
export function loadTable(file = defaultTableFile()) {
  try {
    return readTableForWrite(file)
  } catch {
    return emptyTable()
  }
}

// 표 쓰기: 임시 파일에 쓰고 이름을 바꿔, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다. 실패하면 임시 파일을 지운다.
export function saveTable(table, file = defaultTableFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, "utf8")
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

// 표에서 키 찾기(등록 안 한 경우). 같은 문서가 이미 있으면 그 키, 앞 6자가 다른 문서와 겹치면 한 자씩 늘린다.
export function chooseKey(table, source, docPath) {
  const links = table.links || {}
  for (let len = SHORT_KEY_LENGTH; len <= MAX_KEY_LENGTH; len++) {
    const key = shortKeyFor(source, docPath, len)
    const hit = links[key]
    if (!hit || (hit.source === source && hit.path === docPath)) return key
  }
  throw new Error("short key collision could not be resolved")
}

// 문서를 표에 등록하고 키를 돌려준다. 이미 있으면 파일을 다시 쓰지 않는다.
//   limits: { maxLinks, maxBytes } (기본 MAX_SHORT_LINKS·MAX_TABLE_BYTES). 넘으면 code SHORT_LINK_TABLE_FULL 로 던진다.
// 표 파일 하나는 쓰는 쪽 하나(대시보드 하나)를 전제로 한다. 잠금이 없어 둘이 함께 쓰면 키를 잃을 수 있다.
export function registerShortLink(source, docPath, file = defaultTableFile(), now = new Date(), limits = {}) {
  if (!isValidSource(source)) throw new Error(`invalid source: ${source}`)
  if (!isRegistrableDocPath(docPath)) throw new Error(`invalid path: ${docPath}`)
  const maxLinks = limits.maxLinks ?? MAX_SHORT_LINKS
  const maxBytes = limits.maxBytes ?? MAX_TABLE_BYTES
  const table = readTableForWrite(file)
  const key = chooseKey(table, source, docPath)
  if (table.links[key]) return key
  if (Object.keys(table.links).length >= maxLinks) {
    throw tableError("SHORT_LINK_TABLE_FULL", `short link table is full (${maxLinks} links)`)
  }
  table.links[key] = { source, path: docPath, created: now.toISOString() }
  if (Buffer.byteLength(JSON.stringify(table, null, 2), "utf8") + 1 > maxBytes) {
    throw tableError("SHORT_LINK_TABLE_FULL", `short link table would exceed ${maxBytes} bytes`)
  }
  saveTable(table, file)
  return key
}

// 긴 문서 주소. 탭을 알면 앞에 붙인다(대시보드 docHref와 같은 모양).
export function longDocHref(source, docPath, tab) {
  const tabPart = tab ? `tab=${encodeURIComponent(tab)}&` : ""
  return `/docs?${tabPart}source=${encodeURIComponent(source)}&path=${encodeURIComponent(docPath)}`
}

function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg)
  } catch {
    return null
  }
}

// /d/… 경로 해석. 돌려주는 값: { status: 302, location } | { status: 400|404 }
//   tabFor(source, path) 는 탭 이름 또는 undefined 를 돌려주는 함수(없어도 된다).
export function resolveShortPath(rawPathname, { table = emptyTable(), tabFor } = {}) {
  if (!rawPathname.startsWith("/d/")) return { status: 404 }
  const rest = rawPathname.slice(3)
  const rawSegs = rest.split("/")
  const segs = []
  for (const raw of rawSegs) {
    const seg = decodeSegment(raw)
    // 조각 안에 인코딩된 / 나 \ 가 숨어 있으면 경로 밖으로 나가려는 것으로 본다.
    if (seg === null || seg.includes("/") || seg.includes("\\")) return { status: 400 }
    segs.push(seg)
  }
  if (segs.some((s) => s === "." || s === "..")) return { status: 400 }

  const pick = (source, docPath) => {
    let tab
    try {
      tab = tabFor ? tabFor(source, docPath) : undefined
    } catch {
      tab = undefined
    }
    return { status: 302, location: longDocHref(source, docPath, tab) }
  }

  if (segs.length === 1) {
    // 키는 소문자 16진만. 대문자는 키 규칙 밖이라 404.
    const key = segs[0]
    if (!KEY_RE.test(key)) return { status: 404 }
    const hit = table.links?.[key]
    if (!hit || !isValidSource(hit.source) || !isValidDocPath(hit.path)) return { status: 404 }
    return pick(hit.source, hit.path)
  }

  const [source, ...pathSegs] = segs
  const docPath = pathSegs.join("/")
  if (!isValidSource(source) || !isValidDocPath(docPath)) return { status: 400 }
  return pick(source, docPath)
}

// 입력(긴 주소, /d/출처/경로 주소, 출처:… 없이 경로)을 { source, path, origin } 으로.
//   - http(s)://…/docs?…source=…&path=…   → 주소의 source·path, origin 은 그 주소의 것
//   - http(s)://…/d/<출처>/<경로> 또는 /d/<출처>/<경로>
//   - 그 밖은 문서 경로로 보고 defaultSource(기본 adk). adk 출처면 앞의 "docs/" 는 뗀다(adk 출처 뿌리가 docs/).
export function parseDocTarget(input, { defaultSource = "adk" } = {}) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("empty input")
  const text = input.trim()
  let origin = null
  let pathname = null
  let search = null
  if (/^https?:\/\//i.test(text)) {
    const u = new URL(text)
    origin = u.origin
    pathname = u.pathname
    search = u.searchParams
  } else if (text.startsWith("/d/") || text.startsWith("/docs?")) {
    const u = new URL(text, "http://placeholder.invalid")
    pathname = u.pathname
    search = u.searchParams
  }

  if (pathname !== null) {
    if (pathname === "/docs") {
      const source = search.get("source")
      const docPath = search.get("path")
      if (!source || !docPath) throw new Error("long URL needs source and path")
      return checked(source, docPath, origin)
    }
    if (pathname.startsWith("/d/")) {
      const segs = pathname.slice(3).split("/").map((s) => decodeSegment(s))
      if (segs.some((s) => s === null) || segs.length < 2) throw new Error("expected /d/<source>/<path>")
      return checked(segs[0], segs.slice(1).join("/"), origin)
    }
    throw new Error(`unsupported URL: ${text}`)
  }

  let docPath = text.replace(/^\.\//, "")
  if (defaultSource === "adk" && docPath.startsWith("docs/")) docPath = docPath.slice(5)
  return checked(defaultSource, docPath, null)
}

function checked(source, docPath, origin) {
  if (!isValidSource(source)) throw new Error(`invalid source: ${source}`)
  if (!isValidDocPath(docPath)) throw new Error(`invalid path: ${docPath}`)
  return { source, path: docPath, origin }
}

// 짧은 주소 앞부분(바깥에서 여는 주소). 기기 이름을 코드에 두지 않고 차례로 찾는다.
//   1. 명시 값(--base)  2. NAIA_DASHBOARD_PUBLIC_URL  3. 이 PC 테일넷 이름 + NAIA_DASHBOARD_PORT(기본 3142)
//   4. http://localhost:<포트>
export function publicBaseUrl({ explicit, env = process.env, tailscaleDns } = {}) {
  const trim = (s) => String(s).replace(/\/+$/, "")
  if (explicit) return trim(explicit)
  if (env.NAIA_DASHBOARD_PUBLIC_URL) return trim(env.NAIA_DASHBOARD_PUBLIC_URL)
  const port = Number(env.NAIA_DASHBOARD_PORT) || 3142
  const dns = typeof tailscaleDns === "function" ? tailscaleDns() : tailscaleDns
  if (dns) return `http://${dns}:${port}`
  return `http://localhost:${port}`
}

// 서버용: 표 파일을 mtime 이 바뀔 때만 다시 읽는다.
export function createTableReader(file = defaultTableFile()) {
  let cached = emptyTable()
  let cachedMtime = -1
  return function readTable() {
    let mtime
    try {
      mtime = fs.statSync(file).mtimeMs
    } catch {
      cached = emptyTable()
      cachedMtime = -1
      return cached
    }
    if (mtime !== cachedMtime) {
      cached = loadTable(file)
      cachedMtime = mtime
    }
    return cached
  }
}
