import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import crypto from "node:crypto"
import http from "node:http"
import { fileURLToPath } from "node:url"
import { createServer } from "../src/server.js"
import type { PublishDescriptor } from "../src/publish-bundle.js"
import { PUBLISH_FIXTURE_TARGETS_JSON, SITE_ALPHA, SITE_BETA } from "./publish-fixtures.js"

export const sampleFixtureDirectory = fileURLToPath(new URL("./fixtures/sample-docs/", import.meta.url))
export const allowedTemporaryDirectory = path.resolve(process.env.TMPDIR ?? os.tmpdir())
export const checkoutGitMarkers = [fileURLToPath(new URL("../../../.git", import.meta.url)), path.join(allowedTemporaryDirectory, ".git")]
export const fixtureActor = "test-gate:owner"

export function byteSnapshot(directory: string): Record<string, Buffer> {
  const result: Record<string, Buffer> = {}
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) for (const [name, bytes] of Object.entries(byteSnapshot(file))) result[`${entry.name}/${name}`] = bytes
    else if (entry.isFile()) result[entry.name] = fs.readFileSync(file)
    else throw new Error(`시험 사본에는 정규 파일만 허용합니다: ${entry.name}`)
  }
  return result
}

export interface PublishFixtureDocument {
  name: string; slug: string; source: string; path: string; file: string; original: Buffer; descriptor: PublishDescriptor
}

// 임시 산출물을 지우지 않는다. 키·상태·문서 사본은 모두 지정한 TMPDIR 안에만 만든다.
export function createPublishFixture() {
  const temporary = fs.realpathSync(os.tmpdir())
  const relative = path.relative(fs.realpathSync(allowedTemporaryDirectory), temporary)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("TMPDIR은 허용된 임시 폴더 아래여야 합니다")
  const directory = fs.mkdtempSync(path.join(temporary, "publish-dashboard-"))
  const root = path.join(directory, "workspace"), state = path.join(directory, "state")
  const article = path.join(root, "docs/article")
  fs.mkdirSync(article, { recursive: true })
  fs.mkdirSync(path.join(state, "descriptors"), { recursive: true, mode: 0o700 })
  const blogFolder = "sample-blog-4-stages-20261101"
  fs.cpSync(path.join(sampleFixtureDirectory, blogFolder), path.join(article, blogFolder), { recursive: true })
  fs.mkdirSync(path.join(article, "assets"))
  fs.copyFileSync(path.join(sampleFixtureDirectory, blogFolder, "thumbnail.png"), path.join(article, "assets/hero.png"))
  const documents = ["sample-blog-4-stages-20261101.md", "sample-research-note-20261101.md"].map((name): PublishFixtureDocument => {
    const blog = name.startsWith("sample-blog"), slug = blog ? "sample-blog" : "sample-research"
    const original = fs.readFileSync(path.join(sampleFixtureDirectory, name))
    const file = path.join(article, name)
    fs.writeFileSync(file, original)
    const images = [...original.toString("utf8").matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1])
    const mapping = blog ? Object.fromEntries([...images, `${blogFolder}/thumbnail.png`].map(image => [image, `assets/${path.basename(image)}`])) : {}
    const hero = blog ? "assets/thumbnail.png" : "assets/hero.png"
    const descriptor: PublishDescriptor = {
      source: "adk", path: `article/${name}`, slug,
      body_selector: { start_heading: "## 본문", end_heading: blog ? "## 근거표 (게시 전에 뺍니다)" : "## 근거 대조 (게시 때 뺌)", separator: "---" },
      frontmatter: { kind: "post", slug, title: `시험 사본 ${slug}`, summary: "게시 흐름 검증을 위한 시험 사본입니다.", date: "2030-11-04T20:00+09:00", targets: [SITE_ALPHA, SITE_BETA], languages: { [SITE_ALPHA]: ["ko", "en"], [SITE_BETA]: ["ko", "en"] }, hero, site_beta_category: "beta-a" },
      asset_roots: blog ? [blogFolder] : ["assets"], asset_path_map: mapping,
      media_map: { ko: { ready: true, hero, body_images: images.map(image => mapping[image] ?? image) }, en: { ready: false } },
    }
    fs.writeFileSync(path.join(state, "descriptors", `${slug}.json`), JSON.stringify(descriptor))
    return { name, slug, source: "adk", path: descriptor.path, file, original, descriptor }
  })
  const keys = crypto.generateKeyPairSync("ed25519")
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
  const keyFile = path.join(directory, "signing.pem")
  fs.writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
  const gateSecret = crypto.randomBytes(32).toString("hex"), gateFile = path.join(directory, "gate.key")
  fs.writeFileSync(gateFile, gateSecret, { mode: 0o600 })
  const env = {
    PUBLISH_STATE_DIR: state, XDG_RUNTIME_DIR: path.join(directory, "runtime"), PUBLISH_GATEWAY_SCOPE: "test-gate",
    PUBLISH_GATEWAY_OVERWRITE_CONFIRMED: "1", PUBLISH_APPROVER_IDS: fixtureActor, PUBLISH_SIGNING_KEY_FILE: keyFile,
    PUBLISH_SIGNING_KEY_ID: "dashboard-test-key", PUBLISH_PUBLIC_KEYS: JSON.stringify({ "dashboard-test-key": publicKey }),
    PUBLISH_EXPORT_SERVICE_TOKEN: "test-export-service-token",
    NAIA_PUBLISH_TARGETS_JSON: PUBLISH_FIXTURE_TARGETS_JSON,
  }
  return { directory, root, state, documents, publicKey, gateSecret, gateFile, env }
}

export type PublishFixture = ReturnType<typeof createPublishFixture>
const listen = async (server: http.Server) => {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return (server.address() as { port: number }).port
}
const close = async (server?: http.Server) => {
  server?.closeIdleConnections()
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

export async function startPublishDashboard(fixture: PublishFixture, options: {
  nextHandler?: http.RequestListener
  beforeAssetWriteHook?: () => Promise<void> | void
  control?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean | Promise<boolean>
} = {}) {
  const { createRequestHandler, getProxySecretPath, clearProxySecretCache } = await import("../../dashboard/server.mjs")
  const { clearGateSecretCache } = await import("../../dashboard/identity-header-guard.mjs")
  const observed: Array<{ method: string; url: string; actor: string | undefined; account: string | undefined; key: string | undefined }> = []
  const faults = { point: "", remaining: 0 }
  const app = await createServer({ root: fixture.root, port: 0, host: "127.0.0.1", beforeAssetWriteHook: options.beforeAssetWriteHook,
    publishFault(point) { if (faults.point === point && faults.remaining > 0) { faults.remaining--; throw new Error("시험용 저장 장애") } },
  })
  const proxySecret = crypto.randomBytes(32).toString("hex")
  ;(app as any).proxySecret = proxySecret
  app.addHook("onRequest", async request => {
    observed.push({ method: request.method, url: request.url, actor: request.headers["x-naia-actor-id"] as string | undefined,
      account: request.headers["x-ax-account-key"] as string | undefined, key: request.headers["idempotency-key"] as string | undefined })
  })
  let dashboard: http.Server | undefined, gate: http.Server | undefined
  let account = "owner", loseApprovalResponse: "disconnect" | "body-drop" | undefined
  try {
    await app.listen({ port: 0, host: "127.0.0.1" })
    const apiPort = (app.server.address() as { port: number }).port
    const proxyFile = getProxySecretPath(apiPort)
    fs.mkdirSync(path.dirname(proxyFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(proxyFile, proxySecret, { mode: 0o600 })
    clearProxySecretCache(); clearGateSecretCache()
    const dashboardEnv: NodeJS.ProcessEnv = { ...process.env, NAIA_API_PORT: String(apiPort), NAIA_GATE_SECRET_FILE: fixture.gateFile }
    dashboard = http.createServer(createRequestHandler(options.nextHandler ?? ((_request: any, response: any) => { response.writeHead(404); response.end() }), {}, dashboardEnv))
    const dashboardPort = await listen(dashboard)
    gate = http.createServer(async (request, response) => {
      if (options.control && await options.control(request, response)) return
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !key.startsWith("x-naia-") && key !== "x-ax-account-key"))
      headers["x-ax-account-key"] = account
      headers["x-naia-gate-secret"] = fixture.gateSecret
      const upstream = http.request({ host: "127.0.0.1", port: dashboardPort, path: request.url, method: request.method, headers }, reply => {
        if (loseApprovalResponse && request.url?.endsWith("/approve") && (reply.statusCode === 200 || reply.statusCode === 201)) {
          const mode = loseApprovalResponse
          loseApprovalResponse = undefined
          reply.resume(); reply.once("end", () => {
            if (mode === "disconnect") { response.destroy(); return }
            // 성공 응답을 끝까지 받은 뒤 본문만 유실한다. 헤더 전 연결 종료는 Chrome이 POST를 자동 재전송할 수 있다.
            const headers: http.IncomingHttpHeaders = { ...reply.headers, "content-length": "0" }
            delete headers["transfer-encoding"]
            response.writeHead(reply.statusCode!, headers); response.end()
          }); return
        }
        response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response)
      })
      upstream.on("error", error => response.destroy(error)); request.pipe(upstream)
    })
    const gatePort = await listen(gate), origin = `http://127.0.0.1:${gatePort}`
    // URL와 Origin만 브라우저처럼 보충한다. 요청·응답은 실제 HTTP 관문과 실제 프록시를 통과한다.
    const fetchFn: typeof fetch = (input, init: RequestInit = {}) => fetch(new URL(String(input), origin), { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), origin } })
    return { app, origin, fetchFn, dashboardEnv, observed, faults,
      setAccount(value: string) { account = value }, dropNextApprovalResponse(mode: "disconnect" | "body-drop" = "disconnect") { loseApprovalResponse = mode },
      async close() { await close(gate); await close(dashboard); await app.close(); clearProxySecretCache(); clearGateSecretCache() },
    }
  } catch (error) {
    await close(gate); await close(dashboard); await app.close(); clearProxySecretCache(); clearGateSecretCache(); throw error
  }
}
