import type { SkillDescriptor } from "@naia-adk/skill-spec";

/** Descriptor for the weather skill. Spec only — execution lives in naia-os/agent. */
export const weatherDescriptor: SkillDescriptor = {
	name: "weather",
	description:
		"Get current weather for a location. Returns temperature, condition, humidity, and wind info.",
	version: "1.0.0",
	tier: "T0",
	inputSchema: {
		type: "object",
		properties: {
			location: {
				type: "string",
				description: "City or location name (e.g. Seoul, Tokyo, New York)",
			},
		},
		required: ["location"],
	},
	tags: ["weather", "external-api"],
};
