const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141";

async function getTree() {
  const res = await fetch(`${API}/api/workspace/tree?depth=1`, { cache: "no-store" })
  if (!res.ok) return null
  return res.json()
}

async function getIndex() {
  const res = await fetch(`${API}/api/workspace/index`, { cache: "no-store" })
  if (!res.ok) return null
  return res.json()
}

export default async function WorkspacePage() {
  const [tree, index] = await Promise.all([getTree(), getIndex()])

  const categories: Record<string, { label: string; items: { name: string; path: string; visibility: string; description: string; entryPoint?: string }[] }> = {
    project: { label: "Projects", items: [] },
    docs: { label: "Data", items: [] },
    lib: { label: "Libraries", items: [] },
    reference: { label: "References", items: [] },
  }

  if (index?.submodules) {
    for (const [name, entry] of Object.entries(index.submodules as Record<string, Record<string, string>>)) {
      const cat = entry.type === "docs" ? "docs" : entry.type === "reference" ? "reference" : entry.type === "lib" ? "lib" : "project"
      if (categories[cat]) {
        categories[cat].items.push({
          name,
          path: entry.path || "",
          visibility: entry.visibility || "private",
          description: entry.description || "",
          entryPoint: entry.rulesEntrypoint,
        })
      }
    }
  }

  if (index?.local_projects) {
    for (const [name, entry] of Object.entries(index.local_projects as Record<string, Record<string, string>>)) {
      categories.project.items.push({
        name,
        path: entry.path || "",
        visibility: entry.visibility || "private",
        description: entry.description || "",
        entryPoint: entry.rulesEntrypoint,
      })
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Workspace</h1>

      {Object.entries(categories).map(([key, section]) => (
        section.items.length > 0 && (
          <div key={key}>
            <h2 className="text-lg font-semibold mb-3 text-neutral-300">{section.label}</h2>
            <div className="grid grid-cols-2 gap-3">
              {section.items.map((item) => (
                <div key={item.name} id={item.name}
                  className="p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{item.name}</span>
                    <div className="flex gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        item.visibility === "public" ? "bg-green-900/30 text-green-400" : "bg-neutral-800 text-neutral-400"
                      }`}>{item.visibility}</span>
                      {item.entryPoint && (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-900/30 text-blue-400">{item.entryPoint}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-neutral-400 mt-1">{item.description}</div>
                  <div className="text-xs text-neutral-500 mt-1 font-mono">{item.path}</div>
                </div>
              ))}
            </div>
          </div>
        )
      ))}

      {tree?.tree && (
        <div>
          <h2 className="text-lg font-semibold mb-3 text-neutral-300">File Tree</h2>
          <pre className="text-sm font-mono text-neutral-400 bg-neutral-900 p-4 rounded-lg overflow-auto max-h-96">
            {JSON.stringify(tree.tree, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
