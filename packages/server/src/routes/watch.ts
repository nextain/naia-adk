import type { FastifyInstance, FastifyPluginCallback } from "fastify"
import chokidar from "chokidar"

const watchers = new Map<string, chokidar.FSWatcher>()

export const watchRoutes: FastifyPluginCallback = (app, _opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot

  app.get("/*", { websocket: true }, (socket, req) => {
    const watchPath = (req.params as { "*": string })["*"]
    const absPath = watchPath ? path.join(root, watchPath) : root

    const watcher = chokidar.watch(absPath, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      depth: 3,
    })

    watcher.on("all", (event, filePath) => {
      socket.send(JSON.stringify({
        event,
        path: filePath.replace(root, "").replace(/\\/g, "/"),
        timestamp: new Date().toISOString(),
      }))
    })

    const key = `${Date.now()}-${Math.random()}`
    watchers.set(key, watcher)

    socket.on("close", () => {
      watcher.close()
      watchers.delete(key)
    })
  })

  done()
}
