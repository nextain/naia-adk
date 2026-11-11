import { canonicalBytes, hashBytes } from "./publish-canonical.js"
import type { Json, PublishFrontmatter } from "./publish-bundle.js"

export const PUBLISH_MAPPER_VERSION = "publish-ko-v1"
export const PUBLISH_MAPPER_CONFIG = {
  version: PUBLISH_MAPPER_VERSION,
  language: "ko",
  body_assets: "approved-relative-assets",
  naia: { title: "title", summary: "description", date: "date", hero: "og_image", category: "category", canonical: "canonical" },
  site_b: { title: "titleKo", summary: "summaryKo", date: "publishedAt", local_date: "date", hero: "thumbnail", category: "category", canonical: "canonicalUrl" },
}
export const PUBLISH_MAPPER_HASH = hashBytes(canonicalBytes(PUBLISH_MAPPER_CONFIG))

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

export function buildPublishPreviews(fm: PublishFrontmatter, body: Buffer, media: Record<string, Json>): PublishPreviews {
  const previews: PublishPreviews = {}
  for (const site of fm.targets) {
    const mapped: Record<string, Json> = site === "site-a" ? {
      kind: fm.kind, title: fm.title, description: fm.summary ?? "", date: fm.date,
      tags: fm.tags, ...(fm.canonical !== undefined ? { canonical: fm.canonical } : {}),
    } : {
      titleKo: fm.title, summaryKo: fm.summary ?? "", publishedAt: fm.date,
      date: fm.date.slice(0, 10), category: fm.secondary_category, ...(fm.canonical !== undefined ? { canonicalUrl: fm.canonical } : {}),
      tags: fm.tags,
    }
    if (fm.hero !== undefined) mapped[site === "site-a" ? "og_image" : "thumbnail"] = fm.hero
    if (site === "site-a") {
      for (const key of ["category", "series", "format", "episode_no", "pages", "cover", "shorts_url", "event", "name", "line", "image", "debut", "notice_type", "source_id", "aliases", "episode_kind"]) {
        if (fm[key] !== undefined) mapped[key] = fm[key]
      }
    }
    const artifact = {
      site, language: "ko" as const, slug: fm.slug, title: fm.title,
      summary: typeof fm.summary === "string" ? fm.summary : "", body: body.toString("utf8"),
      ...(typeof fm.hero === "string" ? { hero: fm.hero } : {}), frontmatter: mapped,
      media_map: media, targets: fm.targets, languages: fm.languages, date: fm.date,
      mapper_version: PUBLISH_MAPPER_VERSION, mapper_hash: PUBLISH_MAPPER_HASH,
    }
    const bytes = canonicalBytes(artifact)
    previews[site] = { ko: { ...artifact, bytes, sha256: hashBytes(bytes) } }
  }
  return previews
}
