import assert from "node:assert/strict"
import { test } from "node:test"
import { getRedirectUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server"
import nextConfig from "../../next.config"

const origin = "https://dashboard.example.test"

test("a bookmarked work calendar opens the schedule and retains its deep link and query filters", async () => {
  const previous = new URL("/work?view=schedule&item=work%3Acard-1&date=2026-11-22&role=editor", origin)
  const response = await unstable_getResponseFromNextConfig({ url: previous.href, nextConfig })
  assert.equal(response.status, 307)
  const destination = new URL(getRedirectUrl(response)!)
  assert.equal(destination.origin, origin)
  assert.equal(destination.pathname, "/schedule")
  assert.deepEqual([...destination.searchParams], [...previous.searchParams])
})

test("the work board, its other views and the schedule do not redirect", async () => {
  for (const pathname of ["/work", "/work?view=detail&role=editor", "/work?tab=archive&role=editor", "/schedule?view=schedule"]) {
    const response = await unstable_getResponseFromNextConfig({ url: new URL(pathname, origin).href, nextConfig })
    assert.equal(getRedirectUrl(response), null, pathname)
  }
})
