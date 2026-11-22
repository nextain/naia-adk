import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const dashboard = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = path.resolve(dashboard, "../..")
const output = path.join(dashboard, ".next/standalone")
const require = createRequire(import.meta.url)
const { nodeFileTrace } = require("next/dist/compiled/@vercel/nft")
const entries = ["ax-messenger-gateway.mjs", "messenger-gate.mjs", "host-guard.mjs", "gate-secret.mjs", "identity-header-guard.mjs", "short-links.mjs", "public-access.mjs"].map(name => path.join(dashboard, name))
entries.push(path.join(root, "packages/ax-messenger/dist/index.js"))
const { fileList, warnings } = await nodeFileTrace(entries, { base: root, processCwd: dashboard })
if (warnings.size) throw new AggregateError([...warnings], "Failed to trace standalone runtime dependencies")

function ensureDirectory(directory) {
  const relative = path.relative(output, directory)
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Standalone path escapes output")
  let current = output
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current)
    const resolved = fs.realpathSync(current)
    if (resolved !== output && !resolved.startsWith(output + path.sep)) throw new Error(`Standalone path escapes output: ${relative}`)
  }
}

function copy(relative) {
  const source = path.join(root, relative)
  const target = path.join(output, relative)
  const parent = path.dirname(target)
  ensureDirectory(parent)
  const stat = fs.lstatSync(source)
  const existing = fs.lstatSync(target, { throwIfNoEntry: false })
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(source)
    if (path.isAbsolute(link)) throw new Error(`Absolute runtime link is not portable: ${relative}`)
    if (existing) {
      if (existing.isSymbolicLink() && fs.readlinkSync(target) === link) return
      fs.rmSync(target, { recursive: true, force: true })
    }
    fs.symlinkSync(link, target)
  } else if (stat.isFile()) {
    if (existing && !existing.isFile()) fs.rmSync(target, { recursive: true, force: true })
    fs.copyFileSync(source, target)
  }
}
for (const file of fileList) copy(file)
// The custom Next server uses additional modules beyond Next's generated launcher.
const nextPackage = fs.realpathSync(path.dirname(require.resolve("next/package.json")))
const nextRelative = path.relative(root, nextPackage)
if (nextRelative.startsWith("..") || path.isAbsolute(nextRelative)) throw new Error("Next runtime must be inside the workspace")
const nextTarget = path.join(output, nextRelative)
ensureDirectory(nextTarget)
if (!fs.realpathSync(nextTarget).startsWith(output + path.sep)) throw new Error("Next output escapes standalone")
fs.cpSync(nextPackage, nextTarget, { recursive: true, force: false })
for (const file of ["server.mjs", "app/docs/tabs.ts"]) copy(path.relative(root, path.join(dashboard, file)))
const standaloneDashboard = path.join(output, path.relative(root, dashboard))
fs.cpSync(path.join(dashboard, ".next/static"), path.join(standaloneDashboard, ".next/static"), { recursive: true })
const publicDir = path.join(dashboard, "public")
if (fs.existsSync(publicDir)) fs.cpSync(publicDir, path.join(standaloneDashboard, "public"), { recursive: true })
// Next's generated server bypasses the custom authentication and messenger routes.
fs.copyFileSync(path.join(dashboard, "scripts/standalone-launcher.cjs"), path.join(standaloneDashboard, "server.js"))
