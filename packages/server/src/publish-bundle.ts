import fs from "node:fs"
import path from "node:path"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { canonicalBytes, hashBytes, PublishError } from "./publish-canonical.js"
import { readRegularFile, sameRegularFile as sameFile } from "./publish-files.js"
import { buildPublishPreviews, PUBLISH_MAPPER_CONFIG, PUBLISH_MAPPER_HASH, PUBLISH_MAPPER_VERSION, type PublishPreviews } from "./publish-preview.js"
export { canonicalBytes, hashBytes, PublishError } from "./publish-canonical.js"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type PublishSite = "site-a" | "site-b"
export interface PublishDescriptor {
  source: string
  path: string
  slug: string
  body_selector: { start_heading: string; end_heading: string; separator: "---" }
  frontmatter: Record<string, Json>
  asset_roots: string[]
  asset_path_map: Record<string, string>
  media_map: Record<string, Json>
}
export interface PublishAsset {
  path: string
  source_path: string
  format: "png" | "jpg" | "webp"
  size: number
  sha256: string
  bytes: Buffer
}
export interface PublishFrontmatter extends Record<string, Json> {
  kind: "post" | "episode"
  slug: string
  title: string
  targets: PublishSite[]
  languages: Record<string, string[]>
  date: string
  tags: string[]
}
export interface PublishManifest {
  schema_version: 1
  input_hash: string
  slug: string
  source: string
  path: string
  source_hash: string
  descriptor_hash: string
  body_hash: string
  frontmatter_hash: string
  asset_hashes: Omit<PublishAsset, "bytes" | "source_path">[]
  media_map_hash: string
  targets: PublishSite[]
  languages: Record<string, string[]>
  date: string
  mapper_version: string
  mapper_hash: string
  preview_hashes: Record<string, { ko: string }>
}
export interface PublishBundle {
  input_hash: string
  descriptor: PublishDescriptor
  frontmatter: PublishFrontmatter
  media_map: Record<string, Json>
  manifest: PublishManifest
  preview_hash: string
  revision_id: string
  source_bytes: Buffer
  body_bytes: Buffer
  frontmatter_bytes: Buffer
  index_bytes: Buffer
  media_map_bytes: Buffer
  descriptor_bytes: Buffer
  manifest_bytes: Buffer
  assets: PublishAsset[]
  previews: PublishPreviews
  files: Record<string, Buffer>
}
export const PUBLISH_ASSET_LIMIT = 5_242_880
export const PUBLISH_BUNDLE_LIMIT = 83_886_080

function invalid(field: string, message: string): never {
  throw new PublishError(422, "invalid_bundle", message, field)
}
function readFailure(error: unknown, field: string, message: string): never {
  if (error instanceof PublishError) throw error
  const code = (error as NodeJS.ErrnoException)?.code
  if (["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EMLINK", "ESTALE", "ENAMETOOLONG"].includes(code ?? "")) invalid(field, message)
  throw new PublishError(503, "PUBLISH_UNAVAILABLE", "문서·그림을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.", field)
}
function object(input: unknown, field: string): Record<string, Json> {
  if (!input || Array.isArray(input) || typeof input !== "object") invalid(field, `${field} 값을 객체로 지정해 주세요.`)
  canonicalBytes(input, field)
  return input as Record<string, Json>
}
function fields(input: Record<string, unknown>, allowed: string[], field: string) {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) invalid(`${field}.${key}`, `지원하지 않는 칸입니다: ${key}`)
}
function string(input: unknown, field: string, min = 1, max = 2000): string {
  if (typeof input !== "string" || Array.from(input).length < min || Array.from(input).length > max || !input.trim() || input.includes("\0")) invalid(field, `${field} 값을 ${min}~${max}자로 지정해 주세요.`)
  return input
}
function strings(input: unknown, field: string, min = 0, max = 100): string[] {
  if (!Array.isArray(input) || input.length < min || input.length > max) invalid(field, `${field} 목록의 개수를 확인해 주세요.`)
  return input.map((entry, i) => string(entry, `${field}.${i}`))
}
function relative(input: unknown, field: string): string {
  const value = string(input, field)
  if (value.startsWith("/") || /[\\?#%\x00-\x1f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) invalid(field, "문서 경계 안의 상대 경로를 지정해 주세요.")
  return value
}
function assetPath(input: unknown, field: string): string {
  const value = relative(input, field)
  if (!value.startsWith("assets/")) invalid(field, "게시 그림은 assets/ 안의 상대 경로여야 합니다.")
  if (!/^[\p{L}\p{N}._/-]+$/u.test(value)) invalid(field, "게시 그림 경로에는 글자·숫자·붙임표·밑줄·마침표·슬래시만 사용할 수 있습니다.")
  return value
}
function url(input: unknown, field: string, shorts = false): string {
  const value = string(input, field)
  let parsed: URL
  try { parsed = new URL(value) } catch { invalid(field, "올바른 공개 주소를 지정해 주세요.") }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (shorts && !["youtube.com", "www.youtube.com", "youtu.be"].includes(parsed.hostname))) invalid(field, "허용된 HTTPS 공개 주소를 지정해 주세요.")
  return value
}
function date(input: unknown, field: string): string {
  const value = string(input, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+09:00$/.test(value)) invalid(field, "한국 시각을 분 단위와 +09:00 시간대로 지정해 주세요.")
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 16) !== value.slice(0, 16)) invalid(field, "실제 달력에 있는 공개 시각을 지정해 주세요.")
  return value
}
const FRONTMATTER_FIELDS = ["kind", "slug", "targets", "languages", "title", "date", "summary", "hero", "category", "secondary_category", "tags", "canonical", "series", "format", "episode_no", "pages", "cover", "shorts_url", "event", "name", "line", "image", "debut", "notice_type", "source_id", "aliases", "episode_kind"]
const LAND_LANGUAGES = ["en", "ko", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"]
function validateEvent(input: unknown, field: string): Record<string, Json> {
  const event = object(input, field)
  fields(event, ["id", "deadline", "items"], field)
  string(event.id, `${field}.id`)
  date(event.deadline, `${field}.deadline`)
  if (!Array.isArray(event.items) || !event.items.length) invalid(`${field}.items`, "이벤트 항목을 지정해 주세요.")
  const ids = new Set<string>()
  for (const [i, value] of event.items.entries()) {
    const item = object(value, `${field}.items.${i}`)
    fields(item, ["id", "name", "image"], `${field}.items.${i}`)
    const id = string(item.id, `${field}.items.${i}.id`)
    if (ids.has(id)) invalid(`${field}.items.${i}.id`, "이벤트 항목 식별값이 겹칩니다.")
    ids.add(id)
    string(item.name, `${field}.items.${i}.name`)
    assetPath(item.image, `${field}.items.${i}.image`)
  }
  return event
}
function validateFrontmatter(input: unknown, slug: string): PublishFrontmatter {
  const fm = { ...object(input, "frontmatter") }
  fields(fm, FRONTMATTER_FIELDS, "frontmatter")
  if (fm.kind !== "post" && fm.kind !== "episode") invalid("frontmatter.kind", "단계 1은 post·episode 게시 초안을 지원합니다.")
  if (fm.slug !== slug) invalid("frontmatter.slug", "게시 설정과 앞머리의 slug가 다릅니다.")
  string(fm.title, "frontmatter.title", 1, 120)
  date(fm.date, "frontmatter.date")
  const targets = strings(fm.targets, "frontmatter.targets", 1, 2)
  if (new Set(targets).size !== targets.length || targets.some(site => !["site-a", "site-b"].includes(site))) invalid("frontmatter.targets", "대상 사이트를 중복 없이 지정해 주세요.")
  if (fm.kind !== "post" && targets.includes("site-b")) invalid("frontmatter.targets", "두 번째 대상는 post만 받을 수 있습니다.")
  fm.targets = targets.sort()
  const languages = object(fm.languages, "frontmatter.languages")
  fields(languages, targets, "frontmatter.languages")
  const normalized: Record<string, Json> = {}
  for (const site of targets) {
    const allowed = site === "site-a" && fm.kind === "post" ? LAND_LANGUAGES : ["ko", "en"]
    const langs = strings(languages[site], `frontmatter.languages.${site}`, 1, allowed.length)
    if (!langs.includes("ko") || new Set(langs).size !== langs.length || langs.some(lang => !allowed.includes(lang))) invalid(`frontmatter.languages.${site}`, "한국어를 포함한 허용 언어를 중복 없이 지정해 주세요.")
    normalized[site] = langs.sort()
  }
  fm.languages = normalized
  fm.tags = fm.tags === undefined ? [] : strings(fm.tags, "frontmatter.tags")
  if (fm.kind === "post" || fm.summary !== undefined) string(fm.summary, "frontmatter.summary", 1, 200)
  if (fm.kind === "post" || fm.hero !== undefined) assetPath(fm.hero, "frontmatter.hero")
  if (fm.category !== undefined && fm.category !== "update") invalid("frontmatter.category", "지원하는 대상 분류를 지정해 주세요.")
  if (targets.includes("site-b") || fm.secondary_category !== undefined) {
    if (typeof fm.secondary_category !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(fm.secondary_category)) invalid("frontmatter.secondary_category", "두 번째 대상 분류를 영문 소문자·숫자·붙임표로 지정해 주세요.")
  }
  if (fm.canonical !== undefined) fm.canonical = url(fm.canonical, "frontmatter.canonical")
  for (const key of ["series", "name", "line", "debut", "source_id"]) if (fm[key] !== undefined) string(fm[key], `frontmatter.${key}`, 1, key === "name" ? 20 : key === "line" ? 80 : 200)
  if (fm.aliases !== undefined) strings(fm.aliases, "frontmatter.aliases")
  if (fm.image !== undefined) assetPath(fm.image, "frontmatter.image")
  if (fm.notice_type !== undefined && !["hiatus", "info"].includes(String(fm.notice_type))) invalid("frontmatter.notice_type", "알림 종류를 확인해 주세요.")
  if (fm.episode_kind !== undefined && !["episode", "special"].includes(String(fm.episode_kind))) invalid("frontmatter.episode_kind", "회차 종류를 확인해 주세요.")
  if (fm.format !== undefined && !["webtoon", "shorts", "event"].includes(String(fm.format))) invalid("frontmatter.format", "회차 형식을 확인해 주세요.")
  if (fm.episode_no !== undefined && (typeof fm.episode_no !== "number" || !Number.isSafeInteger(fm.episode_no) || fm.episode_no < 1)) invalid("frontmatter.episode_no", "회차 번호는 1 이상의 정수여야 합니다.")
  if (fm.pages !== undefined) strings(fm.pages, "frontmatter.pages", 0, 40).forEach((p, i) => assetPath(p, `frontmatter.pages.${i}`))
  if (fm.cover !== undefined) assetPath(fm.cover, "frontmatter.cover")
  if (fm.shorts_url !== undefined) url(fm.shorts_url, "frontmatter.shorts_url", true)
  if (fm.event !== undefined) validateEvent(fm.event, "frontmatter.event")
  if (fm.kind === "episode") {
    string(fm.series, "frontmatter.series")
    if (fm.format === undefined) invalid("frontmatter.format", "회차 형식을 지정해 주세요.")
    if (fm.episode_no === undefined) invalid("frontmatter.episode_no", "정규 회차 번호를 지정해 주세요.")
    assetPath(fm.cover, "frontmatter.cover")
    if (fm.format === "webtoon") strings(fm.pages, "frontmatter.pages", 1, 40)
    if (fm.format === "shorts") url(fm.shorts_url, "frontmatter.shorts_url", true)
    if (fm.format === "event") validateEvent(fm.event, "frontmatter.event")
  }
  return fm as PublishFrontmatter
}
function checkedPath(target: string, directory: boolean): fs.Stats {
  const absolute = path.resolve(target)
  let current = path.parse(absolute).root
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) invalid("path", "심벌릭 링크가 없는 실제 문서·그림 경로를 사용해 주세요.")
    if (current !== absolute && !stat.isDirectory()) invalid("path", "실제 폴더 경로를 사용해 주세요.")
  }
  const stat = fs.lstatSync(absolute)
  if (fs.realpathSync.native(absolute) !== absolute || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) invalid("path", "실제 문서·그림 파일 경로를 사용해 주세요.")
  return stat
}
function readBytes(target: string, field: string, max?: number): Buffer {
  try {
    const named = checkedPath(target, false)
    if (max !== undefined && named.size > max) throw new PublishError(413, "asset_limit", "그림 한 장은 5메비바이트까지입니다.", field)
    let bytes: Buffer
    try { bytes = readRegularFile(target, max, named) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EFBIG") throw new PublishError(413, "asset_limit", "그림 한 장은 5메비바이트까지입니다.", field)
      throw error
    }
    checkedPath(target, false)
    return bytes
  } catch (error) {
    readFailure(error, field, "필요한 문서·그림 파일을 읽을 수 없습니다.")
  }
}
export function selectPublishBody(source: Buffer, selector: PublishDescriptor["body_selector"]): Buffer {
  fields(object(selector, "body_selector"), ["start_heading", "end_heading", "separator"], "body_selector")
  const start = string(selector.start_heading, "body_selector.start_heading")
  const end = string(selector.end_heading, "body_selector.end_heading")
  if (!/^#{1,6} [^\r\n]+$/.test(start) || !/^#{1,6} [^\r\n]+$/.test(end) || start === end || selector.separator !== "---") invalid("body_selector", "정확한 시작·종료 제목과 구분선을 지정해 주세요.")
  const lines: { text: string; start: number; end: number }[] = []
  let offset = 0
  for (const bytes of source.toString("binary").split("\n")) {
    const lineEnd = Math.min(source.length, offset + bytes.length + 1)
    const raw = source.subarray(offset, offset + bytes.length)
    lines.push({ text: raw.toString("utf8").replace(/\r$/, ""), start: offset, end: lineEnd })
    offset = lineEnd
  }
  const starts = lines.filter(line => line.text === start)
  const ends = lines.map((line, i) => line.text === end ? i : -1).filter(i => i >= 0)
  if (starts.length !== 1 || ends.length !== 1) invalid("body_selector", "게시 본문 제목 경계가 없거나 두 번 이상 나옵니다.")
  const endIndex = ends[0]
  if (endIndex < 2 || lines[endIndex - 1].text !== "" || lines[endIndex - 2].text !== selector.separator || lines[endIndex - 2].start <= starts[0].end) invalid("body_selector", "종료 제목 앞의 정확한 구분선·빈 줄을 확인해 주세요.")
  return source.subarray(starts[0].end, lines[endIndex - 2].start)
}
function imageFormat(bytes: Buffer, name: string): PublishAsset["format"] {
  let format: PublishAsset["format"] | undefined
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) format = "png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = "jpg"
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") format = "webp"
  const ext = path.posix.extname(name).toLowerCase().slice(1)
  if (!format || !(ext === format || (ext === "jpeg" && format === "jpg"))) invalid(name, "그림의 확장자와 실제 PNG·JPEG·WebP 형식을 확인해 주세요.")
  return format
}
function loadAssets(docDir: string, sourceRoot: string, descriptor: PublishDescriptor, captured: Map<string, Buffer>): { assets: PublishAsset[]; sourceMappings: Map<string, string>; publishPaths: Set<string> } {
  const assets = new Map<string, PublishAsset>()
  const sourceMappings = new Map<string, string>()
  const sources = new Set<string>()
  const roots = strings(descriptor.asset_roots, "asset_roots")
  const map = object(descriptor.asset_path_map, "asset_path_map")
  for (const [key, value] of Object.entries(map)) { relative(key, `asset_path_map.${key}`); assetPath(value, `asset_path_map.${key}`) }
  let total = 0
  function visit(directory: string, root: string) {
    checkedPath(directory, true)
    const before = fs.lstatSync(directory)
    for (const name of fs.readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const filename = path.join(directory, name)
      const stat = fs.lstatSync(filename)
      if (stat.isSymbolicLink()) invalid("asset_roots", "그림 폴더 안의 링크는 사용할 수 없습니다.")
      if (stat.isDirectory()) { visit(filename, root); continue }
      if (!stat.isFile()) invalid("asset_roots", "그림 폴더에는 실제 그림 파일만 둘 수 있습니다.")
      const sourcePath = path.relative(docDir, filename).split(path.sep).join("/")
      if (sources.has(sourcePath)) invalid("asset_roots", "그림 출처 폴더가 겹칩니다.")
      sources.add(sourcePath)
      const destination = assetPath(map[sourcePath] ?? `assets/${path.relative(root, filename).split(path.sep).join("/")}`, `asset_path_map.${sourcePath}`)
      if (assets.has(destination)) invalid(destination, "서로 다른 그림의 게시 경로가 겹칩니다.")
      const bytes = captured.get(sourcePath)
      if (!bytes) invalid("asset_roots", "읽는 동안 그림 폴더가 바뀌었습니다.")
      total += bytes.length
      if (total > PUBLISH_BUNDLE_LIMIT) throw new PublishError(413, "bundle_limit", "그림 묶음은 80메비바이트까지입니다.", "assets")
      const format = imageFormat(bytes, sourcePath)
      imageFormat(bytes, destination)
      assets.set(destination, { path: destination, source_path: path.relative(sourceRoot, filename).split(path.sep).join("/"), format, size: bytes.length, sha256: hashBytes(bytes), bytes })
      sourceMappings.set(sourcePath, destination)
    }
    if (!sameFile(before, checkedPath(directory, true))) invalid("asset_roots", "읽는 동안 그림 폴더가 바뀌었습니다.")
  }
  try {
    for (const value of roots) {
      const root = relative(value, "asset_roots")
      visit(path.join(docDir, root), path.join(docDir, root))
    }
  } catch (error) {
    readFailure(error, "asset_roots", "그림 폴더를 읽을 수 없습니다.")
  }
  for (const key of Object.keys(map)) if (!sources.has(key)) invalid(`asset_path_map.${key}`, "선언한 그림이 출처 폴더에 없습니다.")
  if (sources.size !== captured.size) invalid("asset_roots", "읽는 동안 그림 폴더가 바뀌었습니다.")
  return { assets: [...assets.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))), sourceMappings, publishPaths: new Set(assets.keys()) }
}
function rewriteImagePaths(body: Buffer, sourceMappings: Map<string, string>, publishPaths: Set<string>): { bytes: Buffer; images: string[] } {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
  // Keep the same CommonMark + GFM grammar and options as DocMarkdown.
  const tree = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).parse(text)
  type Node = { type: string; url?: string; identifier?: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
  const nodes: Node[] = []
  const walk = (node: Node) => { nodes.push(node); node.children?.forEach(walk) }
  walk(tree)
  const replacements: { start: number; end: number; path: string }[] = []
  const references = new Map<string, Node>()
  for (const node of nodes) if (node.type === "definition") {
    if (references.has(node.identifier!)) invalid("body.image", "중복된 그림 참조 정의를 하나로 정리해 주세요.")
    references.set(node.identifier!, node)
  }
  function add(value: string, start: number, end: number) {
    relative(value, "body.image")
    const target = sourceMappings.get(value) ?? (publishPaths.has(value) ? value : undefined)
    if (!target) invalid("body.image", `본문 그림을 찾을 수 없습니다: ${value}`)
    replacements.push({ start, end, path: target })
    return target
  }
  const occurrences: { start: number; path: string }[] = []
  function markdownDestination(node: Node): [number, number] {
    const offset = node.position!.start.offset!
    const raw = text.slice(offset, node.position!.end.offset!)
    let cursor = node.type === "image" ? 2 : 1
    let brackets = 1
    while (cursor < raw.length && brackets) {
      const char = raw[cursor++]
      if (char === "\\") cursor++
      else if (char === "[") brackets++
      else if (char === "]") brackets--
    }
    if (brackets || raw[cursor++] !== (node.type === "image" ? "(" : ":")) invalid("body.image", "본문 그림 경로를 확인해 주세요.")
    while (/\s/.test(raw[cursor] ?? "") && cursor < raw.length) cursor++
    const enclosed = raw[cursor] === "<"
    if (enclosed) cursor++
    const start = cursor
    let parentheses = 0
    while (cursor < raw.length) {
      const char = raw[cursor]
      if (char === "\\") { cursor += 2; continue }
      if (enclosed ? char === ">" : /\s/.test(char) || (char === ")" && parentheses === 0)) break
      if (char === "(") parentheses++
      if (char === ")") parentheses--
      cursor++
    }
    return [offset + start, offset + cursor]
  }
  for (const node of nodes) {
    if (node.type === "image" || node.type === "imageReference") {
      const resource = node.type === "image" ? node : references.get(node.identifier!)
      if (!resource) invalid("body.image", "본문 그림 참조의 정확한 경로를 지정해 주세요.")
      const [start, end] = markdownDestination(resource)
      if (text.slice(start, end) !== resource.url) invalid("body.image", "본문 그림의 경로를 이스케이프 없이 정확히 지정해 주세요.")
      occurrences.push({ start: node.position!.start.offset!, path: add(resource.url!, start, end) })
    }
    if (node.type !== "html") continue
    const html = node.value!
    // Tokenize tags only inside parser-recognized HTML, respecting quotes and comments.
    for (const match of html.matchAll(/<!--(?:>|->|[\s\S]*?(?:--!?>|$))|<(?:(?:"[^"]*"|'[^']*'|[^<'">])*)>/g)) {
      if (match[0].startsWith("<!--")) continue
      const tag = /^<([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(match[0])
      if (!tag) continue
      if (/^(source|image|video|audio|iframe|object|embed)$/i.test(tag[1])) invalid("body.image", "게시 매체는 단일 그림과 승인한 쇼츠 주소로 지정해 주세요.")
      if (tag[1].toLowerCase() !== "img") continue
      const raw = match[0]
      let cursor = tag[0].length
      const sources: { value: string; start: number; end: number }[] = []
      while (cursor < raw.length) {
        const space = /^\s*/.exec(raw.slice(cursor))![0]
        cursor += space.length
        if (/^\/?>$/.test(raw.slice(cursor))) break
        const attribute = /^[^\s"'<>/=`]+/.exec(raw.slice(cursor))
        if (!space || !attribute) invalid("body.image", "그림 속성을 확인해 주세요.")
        const name = attribute[0].toLowerCase()
        cursor += attribute[0].length
        const assignment = /^\s*=\s*/.exec(raw.slice(cursor))
        let value = "", start = cursor, end = cursor
        if (assignment) {
          cursor += assignment[0].length
          const quote = raw[cursor] === '"' || raw[cursor] === "'" ? raw[cursor++] : null
          start = cursor
          if (quote) { end = raw.indexOf(quote, cursor); if (end < 0) invalid("body.image", "그림 속성을 확인해 주세요."); cursor = end + 1 }
          else { const unquoted = /^[^\s"'=<>`]+/.exec(raw.slice(cursor)); if (!unquoted) invalid("body.image", "그림 속성을 확인해 주세요."); cursor += unquoted[0].length; end = cursor }
          value = raw.slice(start, end)
        }
        if (name === "srcset") invalid("body.image", "여러 후보 그림은 게시 전에 단일 그림으로 지정해 주세요.")
        if (name === "src") sources.push({ value, start, end })
      }
      if (sources.length !== 1) invalid("body.image", "그림 주소를 정확히 하나 지정해 주세요.")
      const source = sources[0]
      const offset = node.position!.start.offset! + match.index!
      occurrences.push({ start: offset, path: add(source.value, offset + source.start, offset + source.end) })
    }
  }
  let output = text
  const unique = [...new Map(replacements.map(r => [`${r.start}:${r.end}`, r])).values()]
  for (const replacement of unique.sort((a, b) => b.start - a.start)) output = output.slice(0, replacement.start) + replacement.path + output.slice(replacement.end)
  return { bytes: Buffer.from(output, "utf8"), images: occurrences.sort((a, b) => a.start - b.start).map(entry => entry.path) }
}
function rewriteImages(body: Buffer, sourceMappings: Map<string, string>, publishPaths: Set<string>): { bytes: Buffer; images: string[] } {
  const rewritten = rewriteImagePaths(body, sourceMappings, publishPaths)
  // 최종 본문의 실제 그림을 검사한다. 이미 치환한 게시 경로는 다시 대응하지 않는다.
  const final = rewriteImagePaths(rewritten.bytes, new Map(), publishPaths)
  if (!final.bytes.equals(rewritten.bytes) || !canonicalBytes(final.images).equals(canonicalBytes(rewritten.images))) invalid("body.image", "게시 경로 치환 뒤 본문 그림의 개수·순서가 바뀌었습니다.")
  return final
}
function validateMedia(input: unknown, fm: PublishFrontmatter, assets: PublishAsset[], bodyImages: string[]): Record<string, Json> {
  const media = object(input, "media_map")
  const languages = [...new Set(Object.values(fm.languages).flat())].sort()
  fields(media, languages, "media_map")
  const byPath = new Map(assets.map(asset => [asset.path, asset]))
  function reference(value: unknown, field: string): Json {
    const ref = typeof value === "string" ? { path: value } : object(value, field)
    fields(ref, ["path", "sha256"], field)
    const p = assetPath(ref.path, field)
    const asset = byPath.get(p)
    if (!asset) invalid(field, `그림을 찾을 수 없습니다: ${p}`)
    if ("sha256" in ref && ref.sha256 !== asset.sha256) invalid(field, "미디어 대응표와 실제 그림 지문이 다릅니다.")
    return { path: p, sha256: asset.sha256 }
  }
  function refs(value: unknown, field: string): Json[] {
    if (!Array.isArray(value)) invalid(field, "순서 있는 그림 목록을 지정해 주세요.")
    return value.map((v, i) => reference(v, `${field}.${i}`))
  }
  for (const key of ["hero", "cover", "image"]) if (fm[key] !== undefined) reference(fm[key], `frontmatter.${key}`)
  if (fm.pages !== undefined) refs(fm.pages, "frontmatter.pages")
  if (fm.event !== undefined) for (const [i, item] of ((fm.event as Record<string, Json>).items as Record<string, Json>[]).entries()) reference(item.image, `frontmatter.event.items.${i}.image`)
  const output: Record<string, Json> = {}
  for (const lang of languages) {
    const entry = object(media[lang], `media_map.${lang}`)
    fields(entry, ["ready", "hero", "body_images", "pages", "cover", "shorts_url", "event", "image"], `media_map.${lang}`)
    if (typeof entry.ready !== "boolean" || (lang === "ko" && entry.ready !== true)) invalid(`media_map.${lang}.ready`, "한국어 매체 준비 상태를 확인해 주세요.")
    const result: Record<string, Json> = { ready: entry.ready }
    for (const key of ["hero", "cover", "image"]) if (entry[key] !== undefined) result[key] = reference(entry[key], `media_map.${lang}.${key}`)
    for (const key of ["body_images", "pages"]) if (entry[key] !== undefined) result[key] = refs(entry[key], `media_map.${lang}.${key}`)
    if (entry.shorts_url !== undefined) result.shorts_url = url(entry.shorts_url, `media_map.${lang}.shorts_url`, true)
    if (entry.event !== undefined) {
      const event = validateEvent(entry.event, `media_map.${lang}.event`)
      result.event = { ...event, items: (event.items as Record<string, Json>[]).map((item, i) => ({ ...item, image: reference(item.image, `media_map.${lang}.event.items.${i}.image`) })) }
    }
    if (entry.ready) {
      for (const key of ["hero", "cover", "image", "shorts_url", "event"]) if (fm[key] !== undefined && result[key] === undefined) invalid(`media_map.${lang}.${key}`, "준비된 언어의 필수 매체를 지정해 주세요.")
      if (fm.format === "webtoon" && result.pages === undefined) invalid(`media_map.${lang}.pages`, "웹툰 장 순서를 지정해 주세요.")
      if (result.pages !== undefined && ((result.pages as Json[]).length > 40 || (fm.format === "webtoon" && (result.pages as Json[]).length < 1))) invalid(`media_map.${lang}.pages`, "웹툰은 1~40장, 다른 형식은 40장까지 지정해 주세요.")
      if (result.body_images === undefined) invalid(`media_map.${lang}.body_images`, "본문 그림 순서를 지정해 주세요.")
    }
    if (lang === "ko") {
      for (const key of ["hero", "cover", "image"]) if (fm[key] !== undefined && (result[key] as { path: string } | undefined)?.path !== fm[key]) invalid(`media_map.ko.${key}`, "앞머리와 한국어 미디어 대응이 다릅니다.")
      const paths = (result.body_images as { path: string }[]).map(ref => ref.path)
      if (!canonicalBytes(paths).equals(canonicalBytes(bodyImages))) invalid("media_map.ko.body_images", "한국어 본문 그림의 개수·순서와 대응표가 다릅니다.")
      if (fm.pages !== undefined && !canonicalBytes((result.pages as { path: string }[] | undefined ?? []).map(ref => ref.path)).equals(canonicalBytes(fm.pages))) invalid("media_map.ko.pages", "앞머리와 한국어 장 순서가 다릅니다.")
      if (fm.shorts_url !== undefined && result.shorts_url !== fm.shorts_url) invalid("media_map.ko.shorts_url", "앞머리와 한국어 쇼츠 주소가 다릅니다.")
      if (fm.event !== undefined && !canonicalBytes(entry.event).equals(canonicalBytes(fm.event))) invalid("media_map.ko.event", "앞머리와 한국어 이벤트가 다릅니다.")
    }
    output[lang] = result
  }
  return output
}
// 의미 검사 전에 입력을 고정하고, 이후 묶음에도 같은 버퍼를 사용한다.
function captureInput(input: PublishDescriptor, sourceRoot: string) {
  const raw = JSON.parse(canonicalBytes(input).toString())
  if (Array.isArray(raw.frontmatter?.targets)) raw.frontmatter.targets.sort()
  if (raw.frontmatter?.languages && typeof raw.frontmatter.languages === "object") {
    for (const value of Object.values(raw.frontmatter.languages)) if (Array.isArray(value)) value.sort()
  }
  const descriptorHash = hashBytes(canonicalBytes(raw))
  const filename = path.join(sourceRoot, relative(input.path, "path"))
  const sourceBytes = readBytes(filename, "source")
  const assets = new Map<string, Buffer>()
  let total = 0
  const visit = (directory: string) => {
    checkedPath(directory, true)
    const before = fs.lstatSync(directory)
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name)
      const stat = fs.lstatSync(target)
      if (stat.isSymbolicLink()) invalid("asset_roots", "그림 폴더 안의 링크는 사용할 수 없습니다.")
      if (stat.isDirectory()) { visit(target); continue }
      const key = path.relative(path.dirname(filename), target).split(path.sep).join("/")
      if (assets.has(key)) invalid("asset_roots", "그림 출처 폴더가 겹칩니다.")
      const bytes = readBytes(target, key, PUBLISH_ASSET_LIMIT)
      total += bytes.length
      if (total > PUBLISH_BUNDLE_LIMIT) throw new PublishError(413, "bundle_limit", "그림 묶음은 80메비바이트까지입니다.", "assets")
      assets.set(key, bytes)
    }
    if (!sameFile(before, checkedPath(directory, true))) invalid("asset_roots", "읽는 동안 그림 폴더가 바뀌었습니다.")
  }
  try {
    for (const root of strings(input.asset_roots, "asset_roots")) visit(path.join(path.dirname(filename), relative(root, "asset_roots")))
  } catch (error) {
    readFailure(error, "asset_roots", "그림 폴더를 읽을 수 없습니다.")
  }
  const inputHash = hashBytes(canonicalBytes({ descriptor_hash: descriptorHash, source_hash: hashBytes(sourceBytes), assets: [...assets].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([path, bytes]) => ({ path, sha256: hashBytes(bytes) })) }))
  return { sourceBytes, assets, inputHash }
}

export async function buildPublishBundle(input: PublishDescriptor, sourceRoot: string, expectedInputHash?: string): Promise<PublishBundle> {
  try { return await buildBundle(input, sourceRoot, expectedInputHash) } catch (error) {
    if (expectedInputHash && error instanceof PublishError && [422, 413].includes(error.status)) throw new PublishError(409, "PREVIEW_CHANGED", "내용이 바뀌었습니다. 다시 확인해 주세요")
    throw error
  }
}

async function buildBundle(input: PublishDescriptor, sourceRoot: string, expectedInputHash?: string): Promise<PublishBundle> {
  const raw = object(input, "descriptor")
  const captured = captureInput(input, path.resolve(sourceRoot))
  if (expectedInputHash && captured.inputHash !== expectedInputHash) throw new PublishError(409, "PREVIEW_CHANGED", "내용이 바뀌었습니다. 다시 확인해 주세요")
  fields(raw, ["source", "path", "slug", "body_selector", "frontmatter", "asset_roots", "asset_path_map", "media_map"], "descriptor")
  const descriptor = JSON.parse(canonicalBytes(input).toString("utf8")) as PublishDescriptor
  string(descriptor.source, "source")
  const sourcePath = relative(descriptor.path, "path")
  const slug = string(descriptor.slug, "slug")
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) invalid("slug", "slug는 영문 소문자·숫자·붙임표로 지정해 주세요.")
  const fm = validateFrontmatter(descriptor.frontmatter, slug)
  descriptor.frontmatter = fm
  let root: string
  try { root = path.resolve(sourceRoot); checkedPath(root, true) } catch (error) {
    readFailure(error, "source", "문서 출처의 실제 루트를 확인해 주세요.")
  }
  const filename = path.join(root, sourcePath)
  const sourceBytes = captured.sourceBytes
  try { new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes) } catch { invalid("source", "원고를 올바른 UTF-8로 저장해 주세요.") }
  const selected = selectPublishBody(sourceBytes, descriptor.body_selector)
  const { assets, sourceMappings, publishPaths } = loadAssets(path.dirname(filename), root, descriptor, captured.assets)
  const { bytes: bodyBytes, images } = rewriteImages(selected, sourceMappings, publishPaths)
  const media = validateMedia(descriptor.media_map, fm, assets, images)
  const frontmatterBytes = Buffer.concat([Buffer.from("---\n"), canonicalBytes(fm), Buffer.from("\n---\n")])
  const indexBytes = Buffer.concat([frontmatterBytes, bodyBytes])
  const mediaBytes = canonicalBytes(media)
  const descriptorBytes = canonicalBytes(descriptor)
  const previews = buildPublishPreviews(fm, bodyBytes, media)
  const previewHashes: Record<string, { ko: string }> = {}
  for (const [site, preview] of Object.entries(previews)) previewHashes[site] = { ko: preview.ko.sha256 }
  const manifest: PublishManifest = {
    schema_version: 1, input_hash: captured.inputHash, slug, source: descriptor.source, path: sourcePath,
    source_hash: hashBytes(sourceBytes), descriptor_hash: hashBytes(descriptorBytes), body_hash: hashBytes(bodyBytes), frontmatter_hash: hashBytes(frontmatterBytes),
    asset_hashes: assets.map(({ bytes: _bytes, source_path: _sourcePath, ...asset }) => asset), media_map_hash: hashBytes(mediaBytes),
    targets: fm.targets, languages: fm.languages, date: fm.date,
    mapper_version: PUBLISH_MAPPER_VERSION, mapper_hash: PUBLISH_MAPPER_HASH, preview_hashes: previewHashes,
  }
  const manifestBytes = canonicalBytes(manifest)
  const previewHash = hashBytes(manifestBytes)
  const files: Record<string, Buffer> = {
    "source.bin": sourceBytes, "index.ko.md": indexBytes, "frontmatter.json": canonicalBytes(fm), "media-map.json": mediaBytes, "manifest.json": manifestBytes,
    "descriptor.json": descriptorBytes, "mapper.json": canonicalBytes(PUBLISH_MAPPER_CONFIG),
  }
  for (const asset of assets) files[asset.path] = asset.bytes
  for (const [site, preview] of Object.entries(previews)) files[`previews/${site}/ko.json`] = preview.ko.bytes
  return { input_hash: captured.inputHash, descriptor, frontmatter: fm, media_map: media, manifest, preview_hash: previewHash, revision_id: `rev_${previewHash}`, source_bytes: sourceBytes, body_bytes: bodyBytes, frontmatter_bytes: frontmatterBytes, index_bytes: indexBytes, media_map_bytes: mediaBytes, descriptor_bytes: descriptorBytes, manifest_bytes: manifestBytes, assets, previews, files }
}
