// Generic publish target fixtures for tests. Production sources must never
// hardcode operator/company domains; every publish test below configures its
// own targets via NAIA_PUBLISH_TARGETS_JSON (or a config file) using these
// example-only ".example" sites.
import type { PublishTargetProfile } from "../src/publish-targets.js"

export const SITE_ALPHA = "site-alpha.example"
export const SITE_BETA = "site-beta.example"

/** Standard-style site: full frontmatter mapping, hero renamed to og_image. */
export const ALPHA_PROFILE: PublishTargetProfile = {
  id: SITE_ALPHA,
  label: "Fixture Alpha",
  allowedKinds: ["post", "episode"],
  allowedLanguages: ["ko", "en"],
  kindLanguages: {
    post: ["en", "ko", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi"],
  },
  defaultCanonicalBase: `https://${SITE_ALPHA}/ko/blog`,
  categoryField: "category",
  allowedCategories: ["update"],
  previewStyle: "standard",
  heroField: "og_image",
}

/** Mapped-style site: post only, renamed preview fields, own category field. */
export const BETA_PROFILE: PublishTargetProfile = {
  id: SITE_BETA,
  label: "Fixture Beta",
  allowedKinds: ["post"],
  allowedLanguages: ["ko", "en"],
  defaultCanonicalBase: `https://${SITE_BETA}/desk`,
  categoryField: "site_beta_category",
  allowedCategories: ["beta-a", "beta-b", "beta-c", "beta-d", "beta-e", "beta-f", "beta-g", "beta-h"],
  previewStyle: "mapped",
  previewFieldMap: {
    title: "titleKo",
    summary: "summaryKo",
    date: "publishedAt",
    hero: "thumbnail",
    category: "category",
    canonical: "canonicalUrl",
  },
  heroField: "thumbnail",
}

export const PUBLISH_FIXTURE_PROFILES: Record<string, PublishTargetProfile> = {
  [SITE_ALPHA]: ALPHA_PROFILE,
  [SITE_BETA]: BETA_PROFILE,
}

export const PUBLISH_FIXTURE_TARGETS_JSON = JSON.stringify({ targets: [ALPHA_PROFILE, BETA_PROFILE] })

/** Test-only actor/identity values (no real operator data). */
export const PUBLISH_TEST_SCOPE = "test-gate"
export const publishTestActor = (name: string) => `${PUBLISH_TEST_SCOPE}:${name}`
