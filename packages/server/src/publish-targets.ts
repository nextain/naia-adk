// Config-driven publish target profiles.
//
// Production code must never hardcode operator/company domains, category
// names, or canonical bases. All publish destinations come from:
//   1. NAIA_PUBLISH_TARGETS_FILE (absolute path to a JSON file), or
//   2. NAIA_PUBLISH_TARGETS_JSON (inline JSON string), or
//   3. <adkRoot>/config/publish-targets.json when present,
//   4. otherwise an empty map: every frontmatter target is then unknown and
//      rejected (fail-closed).
//
// JSON shape: { "targets": PublishTargetProfile[] }
// Test suites pass explicit fixture configs (e.g. site-alpha.example) via
// NAIA_PUBLISH_TARGETS_JSON; production sources stay 100% generic.
import fs from "node:fs"
import path from "node:path"
import { PublishError } from "./publish-canonical.js"

export interface PublishTargetProfile {
  /** Target id, e.g. "site-a.example" (hostname/domain slug). */
  id: string
  /** Human display name. */
  label?: string
  /** Allowed frontmatter kinds. Default ["post"]. */
  allowedKinds?: string[]
  /** Allowed languages. Default ["ko", "en"]. */
  allowedLanguages?: string[]
  /** Optional per-kind language override. */
  kindLanguages?: Record<string, string[]>
  /** Optional canonical default base, e.g. "https://site-a.example/ko/blog". */
  defaultCanonicalBase?: string
  /** Optional frontmatter category field name. */
  categoryField?: string
  /** Optional allowed category values (enforced when defined). */
  allowedCategories?: string[]
  /** "standard" or "mapped" preview rendering. Default: previewFieldMap ? "mapped" : "standard". */
  previewStyle?: "standard" | "mapped"
  /** Declarative output-field renames for "mapped" style. */
  previewFieldMap?: Record<string, string>
  /** Frontmatter hero field rename in previews. */
  heroField?: string
}

export const DEFAULT_ALLOWED_KINDS = ["post", "episode"]
export const DEFAULT_ALLOWED_LANGUAGES = ["ko", "en"]

function fail(message: string): never {
  throw new PublishError(503, "PUBLISH_CONFIG_INVALID", message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function cleanStringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail("게시 대상 설정의 목록은 배열이어야 합니다")
  const out = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) fail("게시 대상 설정의 목록 항목은 문자열이어야 합니다")
    return entry.trim()
  })
  return out
}

export function normalizeTargetProfile(raw: unknown): PublishTargetProfile {
  if (!isRecord(raw)) fail("게시 대상 설정은 객체여야 합니다")
  if (typeof raw.id !== "string" || !raw.id.trim() || /[\s/]/.test(raw.id)) fail("게시 대상 id를 확인해 주세요")
  // `__proto__` id는 뒤따르는 일반 객체(`targets[id] = …`, 미리보기 사상)
  // 대입에서 원형을 오염시키므로 설정 단계에서 거절한다.
  if (raw.id.trim() === "__proto__") fail("게시 대상 id를 확인해 주세요")
  const id = raw.id.trim()
  const profile: PublishTargetProfile = { id }
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || !raw.label.trim()) fail(`게시 대상 ${id}의 label을 확인해 주세요`)
    profile.label = raw.label.trim()
  }
  const allowedKinds = cleanStringList(raw.allowedKinds)
  if (allowedKinds !== undefined) {
    if (!allowedKinds.length) fail(`게시 대상 ${id}의 allowedKinds를 확인해 주세요`)
    profile.allowedKinds = [...new Set(allowedKinds)]
  }
  const allowedLanguages = cleanStringList(raw.allowedLanguages)
  if (allowedLanguages !== undefined) {
    if (!allowedLanguages.length) fail(`게시 대상 ${id}의 allowedLanguages를 확인해 주세요`)
    profile.allowedLanguages = [...new Set(allowedLanguages)]
  }
  if (raw.kindLanguages !== undefined) {
    if (!isRecord(raw.kindLanguages)) fail(`게시 대상 ${id}의 kindLanguages를 확인해 주세요`)
    // 원형 오염 없이 조회하려고 원형 없는 사전을 쓴다. `__proto__` 종류는
    // 일반 객체 조회(`map[kind]`)와 어울리지 않으므로 거절한다.
    const kinds: Record<string, string[]> = Object.create(null)
    for (const [kind, langs] of Object.entries(raw.kindLanguages)) {
      if (typeof kind !== "string" || !kind || kind === "__proto__") fail(`게시 대상 ${id}의 kindLanguages를 확인해 주세요`)
      const list = cleanStringList(langs)
      if (!list || !list.length) fail(`게시 대상 ${id}의 kindLanguages를 확인해 주세요`)
      kinds[kind] = [...new Set(list)]
    }
    profile.kindLanguages = kinds
  }
  if (raw.defaultCanonicalBase !== undefined) {
    if (typeof raw.defaultCanonicalBase !== "string" || !/^https:\/\/[^/]+(\/[^?#]*)?$/.test(raw.defaultCanonicalBase.trim())) {
      fail(`게시 대상 ${id}의 defaultCanonicalBase를 확인해 주세요`)
    }
    profile.defaultCanonicalBase = raw.defaultCanonicalBase.trim().replace(/\/+$/, "")
  }
  if (raw.categoryField !== undefined) {
    if (typeof raw.categoryField !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.categoryField)) {
      fail(`게시 대상 ${id}의 categoryField를 확인해 주세요`)
    }
    profile.categoryField = raw.categoryField
  }
  const allowedCategories = cleanStringList(raw.allowedCategories)
  if (allowedCategories !== undefined) {
    if (!allowedCategories.length) fail(`게시 대상 ${id}의 allowedCategories를 확인해 주세요`)
    profile.allowedCategories = [...new Set(allowedCategories)]
  }
  if (raw.previewStyle !== undefined) {
    if (raw.previewStyle !== "standard" && raw.previewStyle !== "mapped") fail(`게시 대상 ${id}의 previewStyle을 확인해 주세요`)
    profile.previewStyle = raw.previewStyle
  }
  if (raw.previewFieldMap !== undefined) {
    if (!isRecord(raw.previewFieldMap)) fail(`게시 대상 ${id}의 previewFieldMap을 확인해 주세요`)
    // 출력 이름표도 식별자 모양만 받는다. 원형 없는 사전에 두어
    // `toString`·`constructor` 같은 물려받은 이름이 값으로 새지 않게 한다.
    const map: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(raw.previewFieldMap)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) fail(`게시 대상 ${id}의 previewFieldMap을 확인해 주세요`)
      if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) fail(`게시 대상 ${id}의 previewFieldMap을 확인해 주세요`)
      map[key] = value
    }
    profile.previewFieldMap = map
  }
  if (raw.heroField !== undefined) {
    if (typeof raw.heroField !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.heroField)) {
      fail(`게시 대상 ${id}의 heroField를 확인해 주세요`)
    }
    profile.heroField = raw.heroField
  }
  return profile
}

export function parseTargetsJson(raw: string): Record<string, PublishTargetProfile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail("게시 대상 설정을 올바른 JSON으로 저장해 주세요")
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.targets)) fail("게시 대상 설정에 targets 배열이 필요합니다")
  // 물려받은 이름(`toString`·`constructor` …)을 모르게 원형 없는 사전을 쓴다.
  const out: Record<string, PublishTargetProfile> = Object.create(null)
  for (const entry of parsed.targets) {
    const profile = normalizeTargetProfile(entry)
    if (Object.hasOwn(out, profile.id)) fail(`게시 대상 id가 겹칩니다: ${profile.id}`)
    out[profile.id] = profile
  }
  return out
}

const MAX_TARGETS_BYTES = 1024 * 1024

function readTargetsFile(filePath: string): Record<string, PublishTargetProfile> {
  // 읽기 전에 정규 파일인지 확인한다: 심볼릭 링크·폴더·특수 파일은 받지
  // 않는다. 크기는 상한 안에서 한 번에 읽는다(다 읽은 뒤 자르지 않는다).
  let link: fs.Stats
  try {
    link = fs.lstatSync(filePath)
  } catch (error: any) {
    if (error?.code === "ENOENT") fail("게시 대상 설정 파일을 찾지 못했습니다")
    throw error
  }
  if (link.isSymbolicLink() || !link.isFile()) fail("게시 대상 설정 파일을 확인해 주세요")
  if (link.size > MAX_TARGETS_BYTES) fail("게시 대상 설정 파일이 너무 큽니다")
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch (error: any) {
    if (error?.code === "ENOENT") fail("게시 대상 설정 파일을 찾지 못했습니다")
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail("게시 대상 설정 파일을 확인해 주세요")
    if (stat.size > MAX_TARGETS_BYTES) fail("게시 대상 설정 파일이 너무 큽니다")
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset)
      if (!count) break
      offset += count
    }
    return parseTargetsJson(bytes.subarray(0, offset).toString("utf8"))
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

export function loadPublishTargets(
  adkRoot?: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, PublishTargetProfile> {
  const file = typeof env.NAIA_PUBLISH_TARGETS_FILE === "string" ? env.NAIA_PUBLISH_TARGETS_FILE.trim() : ""
  if (file) {
    if (!path.isAbsolute(file)) fail("NAIA_PUBLISH_TARGETS_FILE에는 절대 경로를 지정해 주세요")
    return readTargetsFile(file)
  }
  const inline = typeof env.NAIA_PUBLISH_TARGETS_JSON === "string" ? env.NAIA_PUBLISH_TARGETS_JSON.trim() : ""
  if (inline) return parseTargetsJson(inline)
  if (typeof adkRoot === "string" && adkRoot) {
    const fallback = path.join(path.resolve(adkRoot), "config", "publish-targets.json")
    try {
      // 대체 경로는 따라가지 않는다: 심볼릭 링크면 없는 것과 같이 다룬다.
      const link = fs.lstatSync(fallback)
      if (link.isFile() && !link.isSymbolicLink()) return readTargetsFile(fallback)
    } catch {
      // 설정이 없으면 빈 대상으로 fail-closed.
    }
  }
  return Object.create(null)
}

export function profileStyle(profile: PublishTargetProfile): "standard" | "mapped" {
  return profile.previewStyle ?? (profile.previewFieldMap ? "mapped" : "standard")
}

export function languagesForTarget(profile: PublishTargetProfile, kind: string): string[] {
  // 물려받은 이름(`toString`·`constructor`·`__proto__`) 조회는 설정이 아닌
  // 것으로 다룬다: 직접 만든 일반 객체 프로필에서도 함수가 새지 않게
  // `hasOwn`으로만 읽는다.
  if (profile.kindLanguages && Object.hasOwn(profile.kindLanguages, kind)) {
    const list = (profile.kindLanguages as Record<string, string[]>)[kind]
    if (Array.isArray(list)) return list
  }
  return profile.allowedLanguages ?? DEFAULT_ALLOWED_LANGUAGES
}

export function kindsForTarget(profile: PublishTargetProfile): string[] {
  return profile.allowedKinds ?? DEFAULT_ALLOWED_KINDS
}

export function allCategoryFields(profiles: Record<string, PublishTargetProfile>): Set<string> {
  const out = new Set<string>()
  for (const profile of Object.values(profiles)) if (profile.categoryField) out.add(profile.categoryField)
  return out
}

/** Unknown target ids are rejected fail-closed. */
export function requireKnownTargets(ids: string[], profiles: Record<string, PublishTargetProfile>, field = "frontmatter.targets"): string[] {
  const sorted = [...ids].sort()
  for (const id of sorted) {
    // 물려받은 이름은 설정에 없어도 참이 될 수 있으므로(`profiles["toString"]`
    // 같은 조회) `hasOwn`으로만 확인한다.
    if (!Object.hasOwn(profiles, id) || !profiles[id]) {
      throw new PublishError(422, "invalid_bundle", `대상 사이트를 중복 없이 지정해 주세요: ${id}`, field)
    }
  }
  return sorted
}
