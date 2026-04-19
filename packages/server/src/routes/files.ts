import type { FastifyInstance, FastifyPluginCallback } from "fastify"
import fs from "node:fs"
import path from "node:path"

export const fileRoutes: FastifyPluginCallback = (app, _opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot

  app.get("/*", async (req) => {
    const filePath = (req.params as { "*": string })["*"]
    const absPath = path.join(root, filePath)

    if (!absPath.startsWith(root)) {
      return { error: "Path traversal denied" }
    }

    if (!fs.existsSync(absPath)) {
      return { error: "File not found" }
    }

    const stat = fs.statSync(absPath)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(absPath, { withFileTypes: true })
      return entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
        size: e.isFile() ? fs.statSync(path.join(absPath, e.name)).size : undefined,
      }))
    }

    const ext = path.extname(absPath).toLowerCase()
    const binary = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".hwp", ".hwpx", ".zip"]
    if (binary.includes(ext)) {
      const buf = fs.readFileSync(absPath)
      return {
        type: "binary",
        ext,
        size: buf.length,
        base64: buf.toString("base64"),
      }
    }

    return {
      type: "text",
      ext,
      content: fs.readFileSync(absPath, "utf-8"),
    }
  })

  done()
}
