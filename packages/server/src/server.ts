import Fastify, { FastifyInstance } from "fastify"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import { workspaceRoutes } from "./routes/workspace.js"
import { skillRoutes } from "./routes/skills.js"
import { watchRoutes } from "./routes/watch.js"
import { portalRoutes } from "./routes/portal.js"
import {
  validateHost,
  validatePath,
  writeProxySecret,
  evaluateTrust,
  formatTrustLog,
  TrustDecision,
} from "./security.js"
import type { FolderCheckContext } from "./view-folders.js"

export interface ServerConfig {
  root: string
  port: number
  host: string
  folderCheckContext?: FolderCheckContext
  beforeRenameHook?: () => Promise<void> | void
}

export function getExpectedPort(app: FastifyInstance, configPort: number): number {
  const addr = app.server.address()
  if (addr && typeof addr === "object" && "port" in addr && addr.port > 0) {
    return addr.port
  }
  return configPort
}

export async function createServer(config: ServerConfig) {
  const app = Fastify({ logger: true })

  // CORS 끔
  await app.register(cors, { origin: false })
  await app.register(websocket)

  app.decorate("adkRoot", config.root)
  app.decorate("proxySecret", null as string | null)
  app.decorate("folderCheckContext", config.folderCheckContext ?? null)
  app.decorateRequest("trust", null as TrustDecision | null)

  // 요청 보호 검사 (Host 검사, 경로 탈출 검사, 믿음 판정)
  app.addHook("onRequest", async (request, reply) => {
    // 1. Host 검사: 127.0.0.1, localhost, [::1]과 자기 포트가 아니면 421
    const expectedPort = getExpectedPort(app, config.port)
    if (!validateHost(request.headers.host, expectedPort)) {
      reply.code(421).send({ error: "Misdirected Request" })
      return
    }

    // 2. 경로 탈출 검사: request.raw.url 경로 부분에 '.', '..' 조각, %2e, %2f, %5c, 역슬래시가 있으면 400
    if (!validatePath(request.raw.url)) {
      reply.code(400).send({ error: "Invalid path" })
      return
    }

    // 3. 믿음 판정
    const proxySecret = (app as any).proxySecret as string | null
    const trust = evaluateTrust(request.headers, proxySecret)
    ;(request as any).trust = trust

    // 4. 한 줄 판정 로그
    const rawLocal = Array.isArray(request.headers["x-naia-local"])
      ? request.headers["x-naia-local"][0]
      : request.headers["x-naia-local"]
    const rawOriginOk = Array.isArray(request.headers["x-naia-origin-ok"])
      ? request.headers["x-naia-origin-ok"][0]
      : request.headers["x-naia-origin-ok"]
    const localStr = rawLocal ?? "none"
    const originOkStr = rawOriginOk ?? ""
    const logLine = `${formatTrustLog(trust)}·local ${localStr}·origin-ok ${originOkStr}`
    console.log(logLine)
    request.log.info(logLine)
  })

  // listen 성공 시 프록시 비밀 값 생성 및 저장
  app.addHook("onListen", async () => {
    const actualPort = getExpectedPort(app, config.port)
    if (actualPort > 0 && !(app as any).proxySecret) {
      const { secret } = writeProxySecret(actualPort)
      ;(app as any).proxySecret = secret
    }
  })

  app.register(workspaceRoutes, { prefix: "/api/workspace" })
  app.register(skillRoutes, { prefix: "/api/skills" })
  // /api/files 라우트 등록 제거됨
  app.register(watchRoutes, { prefix: "/api/ws" })
  app.register(portalRoutes, {
    prefix: "/api/portal",
    beforeRename: config.beforeRenameHook,
  })

  app.get("/api/health", async () => ({
    status: "ok",
    root: config.root,
    timestamp: new Date().toISOString(),
  }))

  return app
}

export async function startServer(config: ServerConfig) {
  const app = await createServer(config)
  await app.listen({ port: config.port, host: config.host })
  return app
}
