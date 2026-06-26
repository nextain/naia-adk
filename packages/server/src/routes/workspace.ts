import type { FastifyInstance, FastifyPluginCallback } from "fastify"
import {
  loadProjectIndex,
  loadAgentsRules,
  getWorkspaceMeta,
  classifySubmodules,
  buildFileTree,
  resolveIndexPresence,
} from "@naia-adk/core"

export const workspaceRoutes: FastifyPluginCallback = (app, _opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot

  app.get("/meta", async () => {
    const meta = getWorkspaceMeta(root)
    const rules = loadAgentsRules(root)
    return { meta, rules: rules ? Object.keys(rules as Record<string, unknown>) : [] }
  })

  app.get("/index", async () => {
    const index = loadProjectIndex(root)
    if (!index) return { error: "No project-index.yaml found" }
    // Stamp on-disk presence so the dashboard distinguishes declared vs present
    // (nextain/naia-adk#11). Additive — existing yaml keys are preserved.
    return resolveIndexPresence(root, index)
  })

  app.get("/tree", async (req) => {
    const query = req.query as { path?: string; depth?: string }
    const dirPath = query.path || ""
    const depth = parseInt(query.depth || "2", 10)
    const index = loadProjectIndex(root)
    const categories = index ? classifySubmodules(index) : new Map()

    const tree = buildFileTree(root, dirPath, depth)
    return { tree, categories: Object.fromEntries(categories) }
  })

  app.get("/classify", async () => {
    const index = loadProjectIndex(root)
    if (!index) return { error: "No project-index.yaml found" }
    const categories = classifySubmodules(index)
    return Object.fromEntries(categories)
  })

  done()
}
