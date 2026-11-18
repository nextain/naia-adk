import { readFileSync } from "node:fs"

// Resolve against the installed ADK, independent of the server's workspace root.
export function readAdkVersion(): string {
  const version = readFileSync(new URL("../../../VERSION", import.meta.url), "utf8").trim()
  if (!version) throw new Error("ADK VERSION is empty")
  return version
}
