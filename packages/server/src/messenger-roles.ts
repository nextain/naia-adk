// AI roles the messenger knows: who gets a DM channel, who an @mention wakes, and who the dashboard offers.
// A fork names its roles in NAIA_MESSENGER_ROLES as "id" or "id:label", comma separated, e.g. "coder:코더,reviewer".
// scripts/messenger/wake-move.mjs reads the same variable with the same rules.
export interface MessengerRole {
  id: string
  label: string
}

export const DEFAULT_MESSENGER_ROLES: readonly MessengerRole[] = Object.freeze([{ id: "naia", label: "나이아" }])
// Same shape as the route-<role> part of a wake file name.
const ROLE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/

const warnedRoleValues = new Set<string>()

// A set value with no valid entry falls back to the default with one warning, so DMs and @ wakes do not vanish.
export function messengerRoles(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): MessengerRole[] {
  const raw = (env.NAIA_MESSENGER_ROLES ?? "").trim()
  if (!raw) return DEFAULT_MESSENGER_ROLES.map((role) => ({ ...role }))
  const out: MessengerRole[] = []
  for (const part of raw.split(",")) {
    const [rawId, ...rest] = part.split(":")
    const id = rawId.trim()
    if (!ROLE_ID_RE.test(id) || out.some((role) => role.id === id)) continue
    const label = rest.join(":").trim().slice(0, 40)
    out.push({ id, label: label || id })
  }
  if (out.length) return out
  if (!warnedRoleValues.has(raw)) {
    warnedRoleValues.add(raw)
    warn(`NAIA_MESSENGER_ROLES has no valid role id (lowercase letter first, then a-z 0-9 _ -); using the default ${DEFAULT_MESSENGER_ROLES.map((role) => role.id).join(",")}`)
  }
  return DEFAULT_MESSENGER_ROLES.map((role) => ({ ...role }))
}

export function messengerRoleIds(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): string[] {
  return messengerRoles(env, warn).map((role) => role.id)
}
