/**
 * Catalog test — verifies every descriptor in @naia-adk/skills-builtin is
 * well-formed (name, description, version, tier, inputSchema present), no
 * duplicate names, total count matches the Phase 4.0 Day 3-7 plan.
 *
 * Tracking issue: nextain/naia-os#273
 */

import { describe, expect, it } from "vitest";
import type { SkillDescriptor } from "@naia-adk/skill-spec";
import {
	ALL_DESCRIPTORS,
	agentsDescriptor,
	approvalsDescriptor,
	botmadangDescriptor,
	channelsDescriptor,
	configDescriptor,
	cronDescriptor,
	deviceDescriptor,
	diagnosticsDescriptor,
	memoDescriptor,
	naiaDiscordDescriptor,
	notifyDiscordDescriptor,
	notifyGoogleChatDescriptor,
	notifySlackDescriptor,
	panelDescriptor,
	sessionsDescriptor,
	skillManagerDescriptor,
	systemStatusDescriptor,
	timeDescriptor,
	ttsDescriptor,
	voicewakeDescriptor,
	weatherDescriptor,
} from "../index.js";

const VALID_TIERS = new Set(["T0", "T1", "T2", "T3"]);

describe("@naia-adk/skills-builtin catalog", () => {
	it("exports 21 descriptors total (Phase 4.0 Day 3-7 complete)", () => {
		expect(ALL_DESCRIPTORS).toHaveLength(21);
	});

	it("ALL_DESCRIPTORS contains each named export", () => {
		const expected = [
			agentsDescriptor,
			approvalsDescriptor,
			botmadangDescriptor,
			channelsDescriptor,
			configDescriptor,
			cronDescriptor,
			deviceDescriptor,
			diagnosticsDescriptor,
			memoDescriptor,
			naiaDiscordDescriptor,
			notifyDiscordDescriptor,
			notifyGoogleChatDescriptor,
			notifySlackDescriptor,
			panelDescriptor,
			sessionsDescriptor,
			skillManagerDescriptor,
			systemStatusDescriptor,
			timeDescriptor,
			ttsDescriptor,
			voicewakeDescriptor,
			weatherDescriptor,
		];
		for (const d of expected) {
			expect(ALL_DESCRIPTORS).toContain(d);
		}
	});

	it("every descriptor has required fields", () => {
		for (const d of ALL_DESCRIPTORS) {
			expect(d.name, `${d.name ?? "?"}: name`).toBeTypeOf("string");
			expect(d.name.length, `${d.name}: name not empty`).toBeGreaterThan(0);
			expect(d.description, `${d.name}: description`).toBeTypeOf("string");
			expect(d.description.length, `${d.name}: description not empty`).toBeGreaterThan(0);
			expect(d.version, `${d.name}: version`).toBeTypeOf("string");
			expect(d.tier, `${d.name}: tier in ${[...VALID_TIERS].join("|")}`).toMatch(/^T[0-3]$/);
			expect(d.inputSchema, `${d.name}: inputSchema`).toBeTypeOf("object");
			expect(d.inputSchema.type, `${d.name}: inputSchema.type`).toBe("object");
		}
	});

	it("no duplicate descriptor names", () => {
		const names = ALL_DESCRIPTORS.map((d) => d.name);
		const uniq = new Set(names);
		expect(uniq.size, `duplicates: ${[...names].sort()}`).toBe(names.length);
	});

	it("tier distribution matches plan (7 T0, 11 T1, 3 T2)", () => {
		const byTier = new Map<string, SkillDescriptor[]>();
		for (const d of ALL_DESCRIPTORS) {
			const list = byTier.get(d.tier) ?? [];
			list.push(d);
			byTier.set(d.tier, list);
		}
		expect(byTier.get("T0")?.length, "T0 (free)").toBe(7);
		expect(byTier.get("T1")?.length, "T1 (notify)").toBe(11);
		expect(byTier.get("T2")?.length, "T2 (approval)").toBe(3);
		expect(byTier.get("T3")?.length, "T3 (blocked)").toBeUndefined();
	});

	it("notify descriptors require a 'message' string", () => {
		for (const d of [notifyDiscordDescriptor, notifyGoogleChatDescriptor, notifySlackDescriptor]) {
			expect(d.inputSchema.required, `${d.name}: required has message`).toContain("message");
			const props = d.inputSchema.properties as Record<string, { type: string }>;
			expect(props.message.type, `${d.name}: message is string`).toBe("string");
		}
	});

	it("tier-2 descriptors all have approval-worthy actions in description", () => {
		for (const d of [agentsDescriptor, approvalsDescriptor, botmadangDescriptor]) {
			// soft check: tier-2 should mention manage/create/delete/post or similar mutation verbs
			expect(d.description, `${d.name}: tier-2 mutation hint`).toMatch(
				/manage|create|delete|update|post|register|set/i,
			);
		}
	});
});
