"use strict";
/**
 * Pins the marker lookup in both directions. The bug this guards against is
 * silent: an exact-directory test still passes every "marker disables the
 * harness" test written from the repository root, while leaving every
 * sub-project session enforced.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const harnessSwitch = require("./harness-switch.js");

function tree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-switch-"));
	const deep = path.join(root, "projects", "sub", "src");
	fs.mkdirSync(deep, { recursive: true });
	return { root, deep };
}

test("no marker anywhere leaves enforcement on", () => {
	const { root, deep } = tree();
	assert.equal(harnessSwitch.findHarnessMarker({ cwd: deep }), null);
	assert.equal(harnessSwitch.harnessDisabled({ cwd: deep }), false);
	fs.rmSync(root, { recursive: true, force: true });
});

test("a marker at the repository root disables a sub-project working directory", () => {
	const { root, deep } = tree();
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	const marker = path.join(root, ".claude", "no-harness");
	fs.writeFileSync(marker, "");
	assert.equal(harnessSwitch.findHarnessMarker({ cwd: deep }), marker);
	assert.equal(harnessSwitch.harnessDisabled({ cwd: deep }), true);
	fs.rmSync(root, { recursive: true, force: true });
});

test("the nearest marker is reported, and configDirs narrows the search", () => {
	const { root, deep } = tree();
	for (const [dir, at] of [[".claude", root], [".codex", path.dirname(deep)]]) {
		fs.mkdirSync(path.join(at, dir), { recursive: true });
		fs.writeFileSync(path.join(at, dir, "no-harness"), "");
	}
	assert.equal(harnessSwitch.findHarnessMarker({ cwd: deep }), path.join(path.dirname(deep), ".codex", "no-harness"));
	assert.equal(harnessSwitch.findHarnessMarker({ cwd: deep, configDirs: [".claude"] }), path.join(root, ".claude", "no-harness"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("a directory named no-harness does not disable enforcement", () => {
	const { root, deep } = tree();
	fs.mkdirSync(path.join(root, ".claude", "no-harness"), { recursive: true });
	assert.equal(harnessSwitch.findHarnessMarker({ cwd: deep }), null);
	fs.rmSync(root, { recursive: true, force: true });
});

test("the environment switch still works without any marker", () => {
	const { root, deep } = tree();
	assert.equal(harnessSwitch.harnessDisabled({ cwd: deep, env: { CLAUDE_HARNESS: "off" } }), true);
	assert.equal(harnessSwitch.harnessDisabled({ cwd: deep, env: { CLAUDE_HARNESS: "on" } }), false);
	assert.equal(harnessSwitch.harnessDisabled({ cwd: deep, env: { CLAUDE_HARNESS: "off" }, envVars: ["AI_HARNESS"] }), false);
	fs.rmSync(root, { recursive: true, force: true });
});

test("roots are searched when no cwd is supplied", () => {
	const { root, deep } = tree();
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(root, ".pi", "no-harness"), "");
	assert.equal(harnessSwitch.harnessDisabled({ roots: [deep] }), true);
	assert.equal(harnessSwitch.harnessDisabled({ roots: [] }), false);
	fs.rmSync(root, { recursive: true, force: true });
});
