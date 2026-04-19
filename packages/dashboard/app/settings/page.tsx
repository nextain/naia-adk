import { promises as fs } from "fs"
import path from "path"

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141";

async function getConfigFiles(root: string) {
  const files: { name: string; path: string }[] = []
  const configDir = path.join(root, ".agents", "context")
  try {
    const entries = await fs.readdir(configDir)
    for (const entry of entries) {
      files.push({ name: entry, path: `.agents/context/${entry}` })
    }
  } catch {}
  return files
}

async function getServerHealth() {
  try {
    const res = await fetch(`${API}/api/health`, { cache: "no-store" })
    if (res.ok) return await res.json()
  } catch {}
  return null
}

export default async function SettingsPage() {
  const [files, health] = await Promise.all([
    getConfigFiles(process.cwd()),
    getServerHealth(),
  ])

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">LLM</h2>
        <a href="/settings/llm"
          className="block p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
          <div className="font-medium">LLM Providers & Models</div>
          <div className="text-sm text-neutral-400 mt-0.5">Configure OpenAI, Anthropic, Google, Any-LLM gateway</div>
        </a>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Server</h2>
        <div className="p-4 rounded-lg border border-neutral-800 space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-neutral-400">Status</span>
            <span className={`text-xs px-2 py-0.5 rounded ${
              health ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
            }`}>{health ? "connected" : "disconnected"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">API Port</span>
            <span className="font-mono">3141</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Dashboard Port</span>
            <span className="font-mono">3142</span>
          </div>
          <div className="flex justify-between">
            <span className="text-neutral-400">Host</span>
            <span className="font-mono">localhost</span>
          </div>
          {health && (
            <div className="flex justify-between">
              <span className="text-neutral-400">Workspace</span>
              <span className="font-mono text-xs truncate max-w-xs">{health.root}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Workspace Clients</h2>
        <div className="space-y-2">
          {["opencode", "Claude Code", "Codex", "naia-os"].map((client) => (
            <div key={client}
              className="p-4 rounded-lg border border-neutral-800 flex items-center justify-between">
              <span className="font-medium">{client}</span>
              <span className={`text-xs px-2 py-0.5 rounded ${
                client === "opencode" && health ? "bg-green-900/30 text-green-400" : "bg-neutral-800 text-neutral-500"
              }`}>{client === "opencode" && health ? "connected" : "disconnected"}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Configuration Files</h2>
        <div className="space-y-2">
          {files.map((f) => (
            <div key={f.path}
              className="p-3 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
              <div className="font-medium font-mono text-sm">{f.name}</div>
              <div className="text-xs text-neutral-500">{f.path}</div>
            </div>
          ))}
          {[
            { name: "AGENTS.md", path: "AGENTS.md" },
            { name: ".gitignore", path: ".gitignore" },
            { name: ".gitmodules", path: ".gitmodules" },
            { name: "README.md", path: "README.md" },
          ].map((f) => (
            <div key={f.path}
              className="p-3 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
              <div className="font-medium font-mono text-sm">{f.name}</div>
              <div className="text-xs text-neutral-500">{f.path}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-neutral-300">Data Directories</h2>
        <div className="grid grid-cols-3 gap-3">
          {[
            { dir: "data-company", desc: "Company-wide docs", tier: "T2" },
            { dir: "data-teams", desc: "Team documents", tier: "T3" },
            { dir: "data-private", desc: "Personal data", tier: "T3+" },
            { dir: "projects", desc: "Project repos", tier: "T2" },
            { dir: "skills", desc: "AI skills", tier: "T1" },
            { dir: "scripts", desc: "Utility scripts", tier: "T1" },
          ].map((d) => (
            <div key={d.dir} className="p-3 rounded-lg border border-neutral-800">
              <div className="font-medium font-mono text-sm">{d.dir}/</div>
              <div className="text-xs text-neutral-400 mt-0.5">{d.desc}</div>
              <span className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-500 mt-1 inline-block">{d.tier}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
