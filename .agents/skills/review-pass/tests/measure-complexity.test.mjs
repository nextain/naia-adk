import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { measureComplexity, validateComplexityWaiver } from "../scripts/measure-complexity.mjs";

const content = (lines) => `${"x\n".repeat(lines)}`;
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("complexity thresholds warn and block deterministically", () => {
	assert.equal(measureComplexity({ path: "src/small.mjs", content: content(499) }).status, "OK");
	assert.equal(measureComplexity({ path: "src/warn.mjs", content: content(500) }).status, "WARN");
	assert.equal(measureComplexity({ path: "src/large.mjs", content: content(800) }).status, "REFACTOR_REQUIRED");
	assert.deepEqual(measureComplexity({ path: "src/growth.mjs", content: content(600), addedLines: 250 }).triggers, ["large_file_warning", "large_file_growth"]);
	assert.equal(measureComplexity({ path: "src/critical.mjs", content: content(1_200) }).triggers[0], "critical_file_size");
	assert.equal(measureComplexity({ path: "src/one-line.mjs", content: "x".repeat(2_000_000) }).status, "REFACTOR_REQUIRED");
});

test("complexity waiver is exact, reasoned, bounded, expiring, and hash-bound", () => {
	const value = content(900);
	const waiver = {
		path: "src/parser.mjs",
		sha256: sha256(value),
		maxLines: 950,
		maxBytes: Buffer.byteLength(value),
		reason: "Generated protocol table must remain byte-ordered for the upstream parser.",
		owner: "platform-team",
		authorityRef: `source:USR-123#${"sha256:"}${"a".repeat(64)}`,
		expiresOn: "2026-10-31",
	};
	assert.equal(measureComplexity({ path: waiver.path, content: value, waiver, today: "2026-08-04" }).status, "WAIVED_COMPLEXITY");
	assert.equal(validateComplexityWaiver({ ...waiver, reason: "too big" }, { path: waiver.path, sha256: waiver.sha256, lines: 900, bytes: Buffer.byteLength(value), today: "2026-08-04" }).reason, "waiver_reason_invalid");
	assert.equal(measureComplexity({ path: waiver.path, content: `${value}changed\n`, waiver, today: "2026-08-04" }).waiverProblem, "waiver_hash_mismatch");
	const context = { path: waiver.path, sha256: waiver.sha256, lines: 900, bytes: Buffer.byteLength(value), today: "2026-08-04" };
	assert.equal(validateComplexityWaiver({ ...waiver, expiresOn: "2026-08-03" }, context).reason, "waiver_expired");
	assert.equal(validateComplexityWaiver({ ...waiver, expiresOn: "2026-02-30" }, { ...context, today: "2026-02-01" }).reason, "waiver_expired");
	assert.equal(validateComplexityWaiver({ ...waiver, expiresOn: "2027-12-31" }, context).reason, "waiver_expiry_too_distant");
	assert.equal(validateComplexityWaiver({ ...waiver, owner: "self" }, context).reason, "waiver_owner_invalid");
	assert.equal(validateComplexityWaiver({ ...waiver, authorityRef: "abc" }, context).reason, "waiver_authority_invalid");
	assert.equal(validateComplexityWaiver({ ...waiver, maxLines: 899 }, context).reason, "waiver_line_limit_exceeded");
	assert.equal(validateComplexityWaiver({ ...waiver, maxBytes: Buffer.byteLength(value) - 1 }, context).reason, "waiver_byte_limit_exceeded");
});

test("CLI binds enforcement to the complete repository change set", () => {
	const root = mkdtempSync(join(tmpdir(), "review-complexity-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/module.mjs"), content(10));
		writeFileSync(join(root, "package.json"), '{"private":true}\n');
		execFileSync("git", ["-C", root, "add", "src/module.mjs", "package.json"]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(root, "src/module.mjs"), content(800));
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const blocked = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(blocked.status, 2);
		const beforeConfigChange = JSON.parse(blocked.stdout);
		assert.equal(beforeConfigChange.result, "REFACTOR_REQUIRED");
		writeFileSync(join(root, "package.json"), '{"private":true,"test":"bounded"}\n');
		const afterConfigChange = JSON.parse(spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" }).stdout);
		assert.equal(afterConfigChange.scope.changedSetSha256, beforeConfigChange.scope.changedSetSha256);
		assert.notEqual(afterConfigChange.scope.repositoryChangedSetSha256, beforeConfigChange.scope.repositoryChangedSetSha256);
		const preflight = resolve(import.meta.dirname, "../scripts/review-preflight.mjs");
		const review = spawnSync(process.execPath, [preflight, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(review.status, 2);
		assert.equal(JSON.parse(review.stdout).verdict, "NOT_CLEAN");
		const subtree = spawnSync(process.execPath, [script, "--root", join(root, "src"), "--base", "HEAD"], { encoding: "utf8" });
		assert.equal(subtree.status, 1);
		assert.match(subtree.stderr, /repository top-level/);
		const narrowed = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--file", "src/module.mjs"], { encoding: "utf8" });
		assert.equal(narrowed.status, 1);
		assert.match(narrowed.stderr, /unknown complexity option/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("staged payload cannot hide behind restored worktree bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "review-index-worktree-split-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		const safe = content(10);
		writeFileSync(join(root, "src/module.mjs"), safe);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(root, "src/module.mjs"), content(900));
		execFileSync("git", ["-C", root, "add", "src/module.mjs"]);
		writeFileSync(join(root, "src/module.mjs"), safe);
		assert.equal(execFileSync("git", ["-C", root, "diff", "HEAD", "--", "src/module.mjs"], { encoding: "utf8" }), "");
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const hidden = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(hidden.status, 1);
		assert.match(hidden.stderr, /staged file differs from the worktree/);
		writeFileSync(join(root, "src/module.mjs"), content(900));
		const visible = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(visible.status, 2, visible.stderr);
		assert.equal(JSON.parse(visible.stdout).files.find((file) => file.path === "src/module.mjs")?.status, "REFACTOR_REQUIRED");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("tracked waiver target deletion remains blocking", () => {
	const root = mkdtempSync(join(tmpdir(), "review-waiver-delete-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, ".agents/context"), { recursive: true });
		mkdirSync(join(root, ".agents/requirements/sources"), { recursive: true });
		const source = `${JSON.stringify({ id: "USR-123", source_kind: "human", origin: "native_user_message", actor: "user", events: [{ exact_text: "allow a reviewed short exception" }] }, null, 2)}\n`;
		writeFileSync(join(root, ".agents/requirements/sources/USR-123-complexity.json"), source);
		const large = content(900);
		writeFileSync(join(root, "src/legacy.mjs"), large);
		const expiry = new Date();
		expiry.setUTCDate(expiry.getUTCDate() + 30);
		const waiver = { schemaVersion: 1, waivers: [{ path: "src/legacy.mjs", sha256: sha256(large), maxLines: 900, maxBytes: Buffer.byteLength(large), reason: "Divisible legacy debt has a short reviewed decomposition deferral.", owner: "platform-maintainers", authorityRef: `source:USR-123#${sha256(source)}`, expiresOn: expiry.toISOString().slice(0, 10) }] };
		writeFileSync(join(root, ".agents/context/complexity-waivers.json"), `${JSON.stringify(waiver, null, 2)}\n`);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		rmSync(join(root, "src/legacy.mjs"));
		const preflight = resolve(import.meta.dirname, "../scripts/review-preflight.mjs");
		const result = spawnSync(process.execPath, [preflight, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 2);
		const report = JSON.parse(result.stdout);
		assert.deepEqual(report.complexity.unusedWaivers, ["src/legacy.mjs"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("deleted governed paths remain visible and change the exact changed-set digest", () => {
	const root = mkdtempSync(join(tmpdir(), "review-source-delete-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/first.mjs"), "export const first = 1;\n");
		writeFileSync(join(root, "src/second.mjs"), "export const second = 2;\n");
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		rmSync(join(root, "src/first.mjs"));
		const first = JSON.parse(spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" }).stdout);
		writeFileSync(join(root, "src/first.mjs"), "export const first = 1;\n");
		rmSync(join(root, "src/second.mjs"));
		const second = JSON.parse(spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" }).stdout);
		assert.deepEqual(first.deletedSourceFiles, ["src/first.mjs"]);
		assert.deepEqual(second.deletedSourceFiles, ["src/second.mjs"]);
		assert.notEqual(first.scope.changedSetSha256, second.scope.changedSetSha256);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("tracked source type-change to symlink is rejected", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "review-type-change-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/module.mjs"), content(10));
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(root, "target.txt"), content(2_000));
		rmSync(join(root, "src/module.mjs"));
		symlinkSync("../target.txt", join(root, "src/module.mjs"));
		const preflight = resolve(import.meta.dirname, "../scripts/review-preflight.mjs");
		const result = spawnSync(process.execPath, [preflight, "--root", root, "--base", "HEAD"], { encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must not be a symbolic link/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("normative skill references cannot bypass executable instruction measurement", () => {
	const root = mkdtempSync(join(tmpdir(), "review-skill-reference-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		const references = join(root, ".agents/skills/example/references");
		mkdirSync(references, { recursive: true });
		writeFileSync(join(root, ".agents/skills/example/SKILL.md"), "# Example\n\nRead references/policy.md in full.\n");
		writeFileSync(join(references, "policy.md"), content(10));
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(references, "policy.md"), content(800));
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const result = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 2);
		const report = JSON.parse(result.stdout);
		assert.equal(report.files.find((file) => file.path === ".agents/skills/example/references/policy.md")?.status, "REFACTOR_REQUIRED");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("human-facing skill mirrors are governed source", () => {
	const root = mkdtempSync(join(tmpdir(), "review-user-skill-mirror-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		const references = join(root, ".users/skills/example/references");
		mkdirSync(references, { recursive: true });
		writeFileSync(join(references, "policy.md"), content(10));
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(references, "policy.md"), content(800));
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const result = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 2);
		const report = JSON.parse(result.stdout);
		assert.equal(report.files.find((file) => file.path === ".users/skills/example/references/policy.md")?.status, "REFACTOR_REQUIRED");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("NUL-delimited change discovery preserves newlines in governed filenames", () => {
	const root = mkdtempSync(join(tmpdir(), "review-newline-path-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		const unusual = "src/line\nbreak.mjs";
		writeFileSync(join(root, unusual), content(10));
		execFileSync("git", ["-C", root, "add", "--", unusual]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		writeFileSync(join(root, unusual), content(800));
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const result = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 2, result.stderr);
		assert.equal(JSON.parse(result.stdout).files.find((file) => file.path === unusual)?.status, "REFACTOR_REQUIRED");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unmerged governed sources remain in the measured change set", () => {
	const root = mkdtempSync(join(tmpdir(), "review-unmerged-source-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/conflict.mjs"), "export const value = 'base';\n");
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		const primary = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
		execFileSync("git", ["-C", root, "checkout", "-qb", "other"]);
		writeFileSync(join(root, "src/conflict.mjs"), "export const value = 'other';\n");
		execFileSync("git", ["-C", root, "commit", "-qam", "other"]);
		execFileSync("git", ["-C", root, "checkout", "-q", primary]);
		writeFileSync(join(root, "src/conflict.mjs"), "export const value = 'main';\n");
		execFileSync("git", ["-C", root, "commit", "-qam", "main"]);
		assert.notEqual(spawnSync("git", ["-C", root, "merge", "other"], { encoding: "utf8" }).status, 0);
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const result = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD~1", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /unresolved merge paths/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("dirty submodule worktree bytes receive distinct recursive repository digests", () => {
	const root = mkdtempSync(join(tmpdir(), "review-dirty-submodule-parent-"));
	const child = mkdtempSync(join(tmpdir(), "review-dirty-submodule-child-"));
	try {
		for (const directory of [root, child]) {
			execFileSync("git", ["-C", directory, "init", "-q"]);
			execFileSync("git", ["-C", directory, "config", "user.email", "test@example.invalid"]);
			execFileSync("git", ["-C", directory, "config", "user.name", "Complexity Test"]);
		}
		writeFileSync(join(child, "module.mjs"), "export const value = 1;\n");
		execFileSync("git", ["-C", child, "add", "."]);
		execFileSync("git", ["-C", child, "commit", "-qm", "child base"]);
		execFileSync("git", ["-C", root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child"]);
		execFileSync("git", ["-C", root, "commit", "-qam", "parent base"]);
		writeFileSync(join(root, "vendor/child/module.mjs"), "export const value = 2;\n");
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const firstResult = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(firstResult.status, 0, firstResult.stderr);
		writeFileSync(join(root, "vendor/child/module.mjs"), "export const value = 3;\n");
		const secondResult = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(secondResult.status, 0, secondResult.stderr);
		assert.notEqual(JSON.parse(firstResult.stdout).scope.repositoryChangedSetSha256, JSON.parse(secondResult.stdout).scope.repositoryChangedSetSha256);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(child, { recursive: true, force: true });
	}
});

test("waiver document rejects unknown top-level fields", () => {
	const root = mkdtempSync(join(tmpdir(), "review-waiver-schema-"));
	try {
		execFileSync("git", ["-C", root, "init", "-q"]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Complexity Test"]);
		mkdirSync(join(root, ".agents/context"), { recursive: true });
		writeFileSync(join(root, ".agents/context/complexity-waivers.json"), `${JSON.stringify({ schemaVersion: 1, waivers: [], bypass: true }, null, 2)}\n`);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
		const script = resolve(import.meta.dirname, "../scripts/measure-complexity.mjs");
		const result = spawnSync(process.execPath, [script, "--root", root, "--base", "HEAD", "--json"], { encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /waiver document is invalid/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("review pass makes deterministic complexity a pre-review Clean blocker", () => {
	const root = resolve(import.meta.dirname, "..", "..", "..", "..");
	const referenceFiles = [
		"preflight.md",
		"stage-profiles.md",
		"invocation-and-output.md",
		"consensus-and-convergence.md",
		"configuration-and-requirements.md",
		"reporting-and-delivery.md",
	];
	const skill = [
		readFileSync(resolve(root, ".agents/skills/review-pass/SKILL.md"), "utf8"),
		...referenceFiles.map((file) => readFileSync(resolve(root, ".agents/skills/review-pass/references", file), "utf8")),
	].join("\n");
	const mirror = [
		readFileSync(resolve(root, ".users/skills/review-pass/SKILL.md"), "utf8"),
		...referenceFiles.map((file) => readFileSync(resolve(root, ".users/skills/review-pass/references", file), "utf8")),
	].join("\n");
	assert.match(skill, /review-preflight\.mjs --root \{repo\} --base \{baseline_ref\} --json/);
	assert.match(skill, /Execute the mandatory repository-wide preflight command shown above/);
	assert.match(skill, /waiver_claim_mismatch/);
	assert.match(skill, /source:USR-NNN#sha256:<digest>/);
	assert.match(skill, /complexitySha256/);
	assert.match(skill, /unwaived deterministic refactor requirement remains/);
	assert.match(mirror, /waiver_claim_mismatch/);
});
