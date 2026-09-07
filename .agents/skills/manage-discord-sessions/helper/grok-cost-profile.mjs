// Discord costProfile names stay control/balanced/economy for every backend so
// an operator can switch `backend.selected` without rewriting the config shape.
// The efforts are not the Codex table: Codex balanced pins low reasoning, while
// Grok balanced pins medium, which is that CLI's ordinary working effort.
//
// A config may override the effort explicitly with
// `backend.profiles.grok.reasoningEffort`; this map only supplies the default.
export const GROK_DISCORD_COST_BY_PROFILE = Object.freeze({
	control: "high",
	balanced: "medium",
	economy: "low",
});

export function grokDiscordCost(costProfile = "balanced") {
	const selected = GROK_DISCORD_COST_BY_PROFILE[costProfile];
	if (!selected) throw new Error("unsupported Grok cost profile");
	return selected;
}
