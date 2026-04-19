const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3141";

async function getSkills() {
  const res = await fetch(`${API}/api/skills`, { cache: "no-store" })
  if (!res.ok) return []
  return res.json()
}

export default async function SkillsPage() {
  const skills = await getSkills()

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Skills</h1>
      <p className="text-neutral-400 text-sm">{Array.isArray(skills) ? skills.length : 0} skills registered</p>

      <div className="space-y-3">
        {Array.isArray(skills) && skills.map((skill: {
          name: string
          description: string
          trigger?: string
          management?: string
          frontmatter: Record<string, unknown>
        }) => (
          <div key={skill.name} id={skill.name}
            className="p-4 rounded-lg border border-neutral-800 hover:border-neutral-600 transition-colors">
            <div className="flex items-center justify-between">
              <span className="font-medium text-lg">{skill.name}</span>
              {skill.management && (
                <span className={`text-xs px-2 py-0.5 rounded ${
                  skill.management === "Auto" ? "bg-purple-900/30 text-purple-400" : "bg-neutral-800 text-neutral-400"
                }`}>{skill.management}</span>
              )}
            </div>
            <div className="text-sm text-neutral-400 mt-1">{skill.description}</div>
            {skill.trigger && (
              <div className="text-xs text-neutral-500 mt-2 font-mono bg-neutral-900 px-3 py-1.5 rounded">
                {skill.trigger}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
