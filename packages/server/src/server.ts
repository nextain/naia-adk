import Fastify from "fastify"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import { workspaceRoutes } from "./routes/workspace.js"
import { skillRoutes } from "./routes/skills.js"
import { fileRoutes } from "./routes/files.js"
import { watchRoutes } from "./routes/watch.js"

export interface ServerConfig {
  root: string
  port: number
  host: string
}

export async function createServer(config: ServerConfig) {
  const app = Fastify({ logger: true })

  await app.register(cors, { origin: true })
  await app.register(websocket)

  app.decorate("adkRoot", config.root)

  app.register(workspaceRoutes, { prefix: "/api/workspace" })
  app.register(skillRoutes, { prefix: "/api/skills" })
  app.register(fileRoutes, { prefix: "/api/files" })
  app.register(watchRoutes, { prefix: "/api/ws" })

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
