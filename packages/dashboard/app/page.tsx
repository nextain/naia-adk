const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141";

type IndexEntry = {
  path?: string;
  type?: string;
  visibility?: string;
  description?: string;
  rulesEntrypoint?: string;
  present?: boolean;
};

async function getMeta() {
  const res = await fetch(`${API}/api/workspace/meta`, { cache: "no-store" })
  if (!res.ok) return null
  return res.json()
}

async function getSkills() {
  const res = await fetch(`${API}/api/skills`, { cache: "no-store" })
  if (!res.ok) return []
  return res.json()
}

async function getIndex() {
  const res = await fetch(`${API}/api/workspace/index`, { cache: "no-store" })
  if (!res.ok) return null
  return res.json()
}

function countPresent(entries: Record<string, IndexEntry>, keys: string[]): number {
  return keys.filter((k) => entries[k]?.present).length
}

export default async function Home() {
  const [meta, skills, index] = await Promise.all([getMeta(), getSkills(), getIndex()])

  const submodules: Record<string, IndexEntry> = index?.submodules ?? {}
  const localProjects: Record<string, IndexEntry> = index?.local_projects ?? {}

  const submoduleKeys = Object.keys(submodules)
  const localProjectKeys = Object.keys(localProjects)
  const refKeys = submoduleKeys.filter((k) => k.startsWith("ref-"))
  const nonRefSubmoduleKeys = submoduleKeys.filter((k) => !k.startsWith("ref-"))

  const presentProjects = countPresent(localProjects, localProjectKeys)
  const presentRefs = countPresent(submodules, refKeys)
  const presentNonRefSubmodules = countPresent(submodules, nonRefSubmoduleKeys)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{meta?.meta?.name || "Naia ADK"}</h1>
        <p className="text-neutral-400 mt-1">{meta?.meta?.org}/{meta?.meta?.repo}</p>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card label="Projects" value={presentProjects} declared={localProjectKeys.length} />
        <Card label="Submodules" value={presentNonRefSubmodules} declared={nonRefSubmoduleKeys.length} />
        <Card label="References" value={presentRefs} declared={refKeys.length} />
        <Card label="Skills" value={Array.isArray(skills) ? skills.length : 0} />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="text-lg font-semibold mb-3">Skills</h2>
          <div className="space-y-2">
            {Array.isArray(skills) && skills.map((s: { name: string; description: string; trigger?: string }) => (
              <a key={s.name} href={`/skills#${s.name}`}
                className="block p-3 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
                <div className="font-medium">{s.name}</div>
                <div className="text-sm text-neutral-400 mt-0.5">{s.description}</div>
              </a>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-3">Projects</h2>
          <div className="space-y-2">
            {localProjectKeys.map((name: string) => {
              const entry = localProjects[name]
              const missing = entry?.present === false
              return (
                <a key={name} href={`/workspace#${name}`}
                  className={`block p-3 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors ${missing ? "opacity-50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{name}</span>
                    <div className="flex items-center gap-2">
                      {missing && (
                        <span className="text-xs px-2 py-0.5 rounded bg-amber-900/30 text-amber-400">missing</span>
                      )}
                      {entry?.visibility && (
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          entry.visibility === "public" ? "bg-green-900/30 text-green-400" : "bg-neutral-800 text-neutral-400"
                        }`}>{entry.visibility}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-neutral-400 mt-0.5">{entry?.description}</div>
                </a>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Card({ label, value, declared }: { label: string; value: number; declared?: number }) {
  const phantom = declared !== undefined && declared > value
  return (
    <div className="p-4 rounded-lg border border-neutral-800">
      <div className="text-3xl font-bold">{value}</div>
      <div className="text-sm text-neutral-400 mt-1">{label}</div>
      {phantom && (
        <div className="text-xs text-amber-500 mt-1">{declared} declared</div>
      )}
    </div>
  )
}
