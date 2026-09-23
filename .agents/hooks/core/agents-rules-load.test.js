#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readAgentsRules, deepMerge } = require("./agents-rules-load.js");

const root = path.resolve(__dirname, "..", "..", "..");
const core = JSON.parse(fs.readFileSync(path.join(root, ".agents", "context", "agents-rules.json"), "utf8"));
const detailRef = core.detail && core.detail.file;
assert.equal(typeof detailRef, "string", "agents-rules.json must name its detail file");
const detail = JSON.parse(fs.readFileSync(path.join(root, detailRef), "utf8"));
const merged = readAgentsRules(root);

const at = (object, dotted) => dotted.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
// Key arrays, not dotted strings: some catalogue keys contain dots (about.nextain.io).
const atKeys = (object, keys) => keys.reduce((value, key) => (value == null ? undefined : value[key]), object);
const leafPaths = (object, prefix = []) => Object.entries(object).flatMap(([key, value]) => {
	const here = [...prefix, key];
	return value && typeof value === "object" && !Array.isArray(value) ? leafPaths(value, here) : [here];
});

// Every one-line summary in the core points at a section that exists in the detail file.
const sections = Object.keys(core.detail.sections || {});
assert.ok(sections.length > 0, "detail.sections must list the moved sections");
for (const key of sections) {
	assert.notEqual(at(detail, key), undefined, `detail.sections.${key} has no matching section in ${detailRef}`);
	assert.equal(typeof core.detail.sections[key], "string", `detail.sections.${key} must be a one-line rule`);
	assert.ok(!core.detail.sections[key].includes("\n"), `detail.sections.${key} must be one line`);
}

// Every moved section is reachable from a core summary: its own path or an ancestor is listed.
const { _about, ...moved } = detail;
const movedRoots = [];
const collectRoots = (object, prefix = []) => {
	for (const [key, value] of Object.entries(object)) {
		const here = [...prefix, key];
		if (atKeys(core, here) !== undefined && value && typeof value === "object" && !Array.isArray(value)) collectRoots(value, here);
		else movedRoots.push(here.join("."));
	}
};
collectRoots(moved);
for (const moved of movedRoots) {
	const covered = sections.some((key) => moved === key || moved.startsWith(`${key}.`));
	assert.ok(covered, `moved section ${moved} has no one-line summary in the core detail.sections`);
}

// The merge keeps every leaf of both files.
for (const leaf of leafPaths(moved)) assert.deepEqual(atKeys(merged, leaf), atKeys(moved, leaf), `merged rules changed ${leaf.join(" > ")}`);
for (const leaf of leafPaths(core)) assert.notEqual(atKeys(merged, leaf), undefined, `merged rules lost core ${leaf.join(" > ")}`);

// Code-read sections resolve through the merge.
assert.ok(merged.ai_workflow.routine_action_authorization.unbound_routine_commands, "codex routine hook section must resolve");
// remote-identity.js reads the catalogues from the core file directly, so they must stay there.
assert.ok(core.local_projects && core.submodules, "remote-identity catalogue sections must stay in agents-rules.json");

// A leaf present in both files is a collision, not a silent override.
assert.throws(() => deepMerge({ a: { b: 1 } }, { a: { b: 2 } }), /collides with core at a\.b/);

// A named detail file that is missing fails loudly so fail-closed callers stay closed.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agents-rules-load-"));
try {
	fs.mkdirSync(path.join(scratch, ".agents", "context"), { recursive: true });
	fs.writeFileSync(path.join(scratch, ".agents", "context", "agents-rules.json"), JSON.stringify({ detail: { file: ".agents/context/missing.json" } }));
	assert.throws(() => readAgentsRules(scratch), /ENOENT/);
	fs.writeFileSync(path.join(scratch, ".agents", "context", "agents-rules.json"), JSON.stringify({ plain: true }));
	assert.deepEqual(readAgentsRules(scratch), { plain: true }, "a rules file without detail reads as is");
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`agents-rules split: ${sections.length} summaries, ${movedRoots.length} moved sections, merge OK`);
