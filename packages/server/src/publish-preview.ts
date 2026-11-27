import { canonicalBytes, hashBytes } from "./publish-canonical.js"
import type { Json, PublishFrontmatter } from "./publish-bundle.js"
import { profileStyle, type PublishTargetProfile } from "./publish-targets.js"

export const PUBLISH_MAPPER_VERSION = "publish-ko-v1"
// Mapper config is built from the operator's target profiles at runtime
// (see mapperConfigFor). The static fallback below carries no site data.
export const PUBLISH_MAPPER_CONFIG = {
  version: PUBLISH_MAPPER_VERSION,
  language: "ko",
  body_assets: "approved-relative-assets",
  targets: {} as Record<string, { style: string; heroField: string; categoryField?: string; fieldMap?: Record<string, string> | null }>,
}
export const PUBLISH_MAPPER_HASH = hashBytes(canonicalBytes(PUBLISH_MAPPER_CONFIG))

export function mapperConfigFor(profiles: Record<string, PublishTargetProfile>) {
  // 원형 없는 사전을 쓴다: 대상 id 조회·직렬화에 물려받은 이름이 끼지 않게 한다.
  const targets: Record<string, { style: string; heroField: string; categoryField?: string; fieldMap?: Record<string, string> | null }> = Object.create(null)
  for (const [id, profile] of Object.entries(profiles)) {
    if (id === "__proto__") continue
    targets[id] = {
      style: profileStyle(profile),
      heroField: profile.heroField ?? "hero",
      ...(profile.categoryField ? { categoryField: profile.categoryField } : {}),
      ...(profile.previewFieldMap ? { fieldMap: profile.previewFieldMap } : {}),
    }
  }
  return { version: PUBLISH_MAPPER_VERSION, language: "ko", body_assets: "approved-relative-assets", targets }
}

export interface PublishPreview {
  site: string
  language: "ko"
  slug: string
  title: string
  summary: string
  body: string
  hero?: string
  frontmatter: Record<string, Json>
  media_map: Record<string, Json>
  targets: string[]
  languages: Record<string, string[]>
  date: string
  mapper_version: string
  mapper_hash: string
  bytes: Buffer
  sha256: string
}
export type PublishPreviews = Record<string, { ko: PublishPreview }>

const RESERVED_STANDARD_FIELDS = new Set(["slug", "targets", "languages", "summary", "hero"])

function standardPreview(fm: PublishFrontmatter, otherCategoryFields: Set<string>, ownCategoryField?: string): Record<string, Json> {
  const mapped: Record<string, Json> = {
    kind: fm.kind, title: fm.title, description: fm.summary ?? "", date: fm.date,
    tags: fm.tags, canonical: fm.canonical,
  }
  for (const key of Object.keys(fm)) {
    if (key in mapped || RESERVED_STANDARD_FIELDS.has(key)) continue
    if (otherCategoryFields.has(key) && key !== ownCategoryField) continue
    mapped[key] = fm[key]!
  }
  return mapped
}

function mappedPreview(fm: PublishFrontmatter, profile: PublishTargetProfile): Record<string, Json> {
  const map = profile.previewFieldMap ?? {}
  const titleKey = map.title ?? "title"
  const summaryKey = map.summary ?? "summary"
  const dateKey = map.date ?? "date"
  const canonicalKey = map.canonical ?? "canonical"
  const categoryKey = map.category ?? profile.categoryField ?? "category"
  const out: Record<string, Json> = {
    [titleKey]: fm.title,
    [summaryKey]: typeof fm.summary === "string" ? fm.summary : "",
    tags: fm.tags,
    [canonicalKey]: fm.canonical,
  }
  if (dateKey === "date") out.date = fm.date
  else {
    out[dateKey] = fm.date
    out.date = String(fm.date).slice(0, 10)
  }
  if (profile.categoryField !== undefined && fm[profile.categoryField] !== undefined) {
    out[categoryKey] = fm[profile.categoryField]!
  }
  return out
}

export function buildPublishPreviews(
  fm: PublishFrontmatter,
  body: Buffer,
  media: Record<string, Json>,
  profiles: Record<string, PublishTargetProfile> = {},
): PublishPreviews {
  const otherCategoryFields = new Set<string>()
  for (const profile of Object.values(profiles)) if (profile.categoryField) otherCategoryFields.add(profile.categoryField)
  const previews: PublishPreviews = {}
  for (const site of fm.targets) {
    const profile = profiles[site]
    const style = profile ? profileStyle(profile) : "standard"
    const mapped: Record<string, Json> = profile && style === "mapped"
      ? mappedPreview(fm, profile)
      : standardPreview(fm, otherCategoryFields, profile?.categoryField)
    const heroField = profile?.heroField ?? (style === "mapped" ? profile?.previewFieldMap?.hero ?? "hero" : "hero")
    if (fm.hero !== undefined) mapped[heroField] = fm.hero
    const mapperConfig = Object.keys(profiles).length ? mapperConfigFor(profiles) : PUBLISH_MAPPER_CONFIG
    const artifact = {
      site, language: "ko" as const, slug: fm.slug, title: fm.title,
      summary: typeof fm.summary === "string" ? fm.summary : "", body: body.toString("utf8"),
      ...(typeof fm.hero === "string" ? { hero: fm.hero } : {}), frontmatter: mapped,
      media_map: media, targets: fm.targets, languages: fm.languages, date: fm.date,
      mapper_version: PUBLISH_MAPPER_VERSION, mapper_hash: hashBytes(canonicalBytes(mapperConfig)),
    }
    const bytes = canonicalBytes(artifact)
    previews[site] = { ko: { ...artifact, bytes, sha256: hashBytes(bytes) } }
  }
  return previews
}
