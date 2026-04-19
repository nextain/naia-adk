import type { FastifyInstance, FastifyPluginCallback } from "fastify"
import { discoverSkills } from "@naia-adk/core"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"

export const skillRoutes: FastifyPluginCallback = (app, _opts, done) => {
  const root = (app as FastifyInstance & { adkRoot: string }).adkRoot

  app.get("/", async () => {
    return discoverSkills(root)
  })

  app.get("/:name", async (req) => {
    const { name } = req.params as { name: string }
    const skills = discoverSkills(root)
    const skill = skills.find((s) => s.name === name)
    if (!skill) return { error: `Skill '${name}' not found` }
    return skill
  })

  app.get("/:name/content", async (req) => {
    const { name } = req.params as { name: string }
    const skills = discoverSkills(root)
    const skill = skills.find((s) => s.name === name)
    if (!skill) return { error: `Skill '${name}' not found` }
    const fullPath = path.join(root, skill.path)
    const raw = fs.readFileSync(fullPath, "utf-8")
    return { raw, frontmatter: matter(raw).data }
  })

  done()
}
