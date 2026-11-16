"use strict";
// node .agents/hooks/core/time-window.test.js
const assert = require("assert");
const tw = require("./time-window.js");

const at = (iso) => Date.parse(iso);

// ── mutation window ─────────────────────────────────────────────────────────
const win = { timezone: "Asia/Seoul", days: [1, 2, 3, 4, 5], start: "10:00", end: "18:00" };

// no window configured → nothing restricts mutation
assert.deepStrictEqual(tw.mutationWindowStatus(undefined, 0), { configured: false, allowed: true, reasonCode: null, window: null });
assert.strictEqual(tw.canonicalMutationWindow(undefined), null);

// Thu 2026-09-10 KST: start inside, end outside (UTC 01:00 = 10:00 KST)
for (const [iso, allowed] of [
	["2026-09-10T00:59:59Z", false],
	["2026-09-10T01:00:00Z", true],
	["2026-09-10T08:59:59Z", true],
	["2026-09-10T09:00:00Z", false],
	["2026-09-12T03:00:00Z", false], // Saturday
]) {
	const s = tw.mutationWindowStatus(win, at(iso));
	assert.strictEqual(s.allowed, allowed, iso);
	assert.strictEqual(s.reasonCode, allowed ? null : "mutation_window_closed", iso);
	assert.strictEqual(s.configured, true);
}

// local weekday follows the window timezone, not UTC: Fri 23:30 UTC = Sat 08:30 KST
assert.strictEqual(tw.mutationWindowStatus({ ...win, days: [6], start: "08:00", end: "09:00" }, at("2026-09-11T23:30:00Z")).allowed, true);
// DST: America/New_York 09:00 local is 13:00 UTC in summer, 14:00 UTC in winter
const ny = { timezone: "America/New_York", days: [1, 2, 3, 4, 5, 6, 7], start: "09:00", end: "10:00" };
assert.strictEqual(tw.mutationWindowStatus(ny, at("2026-07-15T13:00:00Z")).allowed, true);
assert.strictEqual(tw.mutationWindowStatus(ny, at("2026-01-15T13:00:00Z")).allowed, false);
assert.strictEqual(tw.mutationWindowStatus(ny, at("2026-01-15T14:00:00Z")).allowed, true);
// Date instance accepted; canonical form sorts days
assert.strictEqual(tw.mutationWindowStatus(win, new Date("2026-09-10T01:00:00Z")).allowed, true);
assert.deepStrictEqual(tw.canonicalMutationWindow({ ...win, days: [5, 1, 3] }).days, [1, 3, 5]);

// invalid configuration is rejected, never guessed
for (const bad of [
	null, [], "x",
	{ ...win, extra: 1 },
	{ ...win, timezone: "Nowhere/Bad" },
	{ ...win, timezone: "+09:00" },
	{ ...win, timezone: "" },
	{ ...win, days: [] },
	{ ...win, days: [0] },
	{ ...win, days: [8] },
	{ ...win, days: [1, 1] },
	{ ...win, days: ["mon"] },
	{ ...win, start: "9:00" },
	{ ...win, end: "24:00" },
	{ ...win, start: "18:00", end: "10:00" },
	{ ...win, start: "10:00", end: "10:00" },
]) {
	assert.throws(() => tw.mutationWindowStatus(bad, 0), `mutation window must be rejected: ${JSON.stringify(bad)}`);
}
for (const now of [NaN, Infinity, "2026-09-10", null, false]) {
	assert.throws(() => tw.mutationWindowStatus(win, now), `bad clock: ${String(now)}`);
}

// ── contact window ──────────────────────────────────────────────────────────
const contact = { timezone: "Asia/Seoul", days: ["mon", "tue", "wed", "thu", "fri"], start_hour: 10, end_hour: 18 };
for (const [iso, allowed] of [
	["2026-09-10T00:59:59Z", false],
	["2026-09-10T01:00:00Z", true],
	["2026-09-10T08:59:59Z", true],
	["2026-09-10T09:00:00Z", false],
	["2026-09-12T03:00:00Z", false],
]) {
	assert.strictEqual(tw.contactWindowStatus(contact, at(iso)).allowed, allowed, iso);
}
assert.deepStrictEqual(tw.contactWindowStatus(contact, at("2026-09-10T01:00:00Z")), { allowed: true, timezone: "Asia/Seoul", day: 4, hour: 10 });
// a 24-hour schedule is independent of the human contact schedule
const now = at("2026-09-10T18:00:00Z");
assert.strictEqual(tw.contactWindowStatus(contact, now).allowed, false);
assert.strictEqual(tw.contactWindowStatus({ ...contact, days: [1, 2, 3, 4, 5, 6, 7], start_hour: 0, end_hour: 24 }, now).allowed, true);
// UTC spelling, numeric and digit-string days
assert.strictEqual(tw.contactWindowStatus({ timezone: "UTC", days: ["4", 5], start_hour: 0, end_hour: 1 }, at("2026-09-10T00:30:00Z")).allowed, true);
assert.deepStrictEqual(tw.normalizeContactSchedule({ ...contact, days: ["Fri", 1] }).days, [5, 1]);

for (const bad of [
	null, [],
	{ ...contact, timezone: "bad" },
	{ ...contact, timezone: "KST" },
	{ ...contact, timezone: "Nowhere/Bad" },
	{ ...contact, days: [] },
	{ ...contact, days: ["funday"] },
	{ ...contact, days: [1, "mon"] },
	{ ...contact, start_hour: -1 },
	{ ...contact, end_hour: 25 },
	{ ...contact, start_hour: 9.5 },
	{ ...contact, end_hour: 10 },
	{ ...contact, extra: true },
	{ timezone: "UTC", days: [1], start_hour: 0 },
]) {
	assert.throws(() => tw.contactWindowStatus(bad, 0), `contact schedule must be rejected: ${JSON.stringify(bad)}`);
}
for (const bad of [NaN, Infinity, "2026-09-10", null]) {
	assert.throws(() => tw.contactWindowStatus(contact, bad), `bad clock: ${String(bad)}`);
}

console.log("time-window: ok");
