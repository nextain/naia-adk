import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	AGENT_CONTEXT_LIMITS,
	buildAgentContextSnapshot,
	resolveAgentContextWorkspace,
	verifyAgentContextBeforeAttempt,
} from "../helper/agent-context.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "naia-agent-context-"));
	roots.push(root);
	mkdirSync(join(root, ".agents/context"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Agent rules\nKeep scope bounded.\n", "utf8");
	writeFileSync(join(root, ".agents/context/policy.yaml"), "policy: deterministic\n", "utf8");
	writeFileSync(join(root, ".agents/context/terms.yaml"), "term: context\n", "utf8");
	return root;
}

test("agent context snapshot is deterministic, sorted, bounded, and free of runtime identifiers", () => {
	const root = fixture();
	const first = buildAgentContextSnapshot({
		workspace: root,
		entrypoint: "AGENTS.md",
		contextFiles: [".agents/context/terms.yaml", ".agents/context/policy.yaml"],
		participantId: "999999999999999999",
	});
	const second = buildAgentContextSnapshot({
		workspace: root,
		entrypoint: "AGENTS.md",
		contextFiles: [".agents/context/policy.yaml", ".agents/context/terms.yaml"],
	});
	assert.equal(first.contextHash, second.contextHash);
	assert.equal(first.prefix, second.prefix);
	assert.deepEqual(first.manifest.files.map((item) => item.path), ["AGENTS.md", ".agents/context/policy.yaml", ".agents/context/terms.yaml"]);
	assert.equal(first.totalBytes, first.manifest.files.reduce((sum, item) => sum + item.bytes, 0));
	assert.doesNotMatch(first.prefix, /999999999999999999/);
	assert.equal(first.prefix.includes(root), false);
	assert.match(first.prefix, new RegExp(`Context-SHA256: ${first.contextHash}`));
	assert.deepEqual(verifyAgentContextBeforeAttempt(first), { contextHash: first.contextHash, verified: true });
});

test("agent context hash and prefix are derived from the same exact bytes", () => {
	const root = fixture();
	const path = join(root, ".agents/context/policy.yaml");
	writeFileSync(path, "policy: deterministic\r\n", "utf8");
	const before = buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	assert.match(before.prefix, /policy: deterministic\r\n/);
	writeFileSync(path, "policy: deterministic\n", "utf8");
	const after = buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	assert.notEqual(before.contextHash, after.contextHash);
	assert.notEqual(before.manifest.files[1].sha256, after.manifest.files[1].sha256);
	assert.throws(() => verifyAgentContextBeforeAttempt(before), (error) => error.code === "context_changed_restart_required");
});

test("attempt verification fails closed when a startup context file disappears", () => {
	const root = fixture();
	const snapshot = buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	rmSync(join(root, ".agents/context/policy.yaml"));
	assert.throws(() => verifyAgentContextBeforeAttempt(snapshot), (error) => error.code === "context_changed_restart_required");
});

test("attempt verification revalidates the allowlist and rejects a symlink replacement", () => {
	const root = fixture();
	const outside = mkdtempSync(join(tmpdir(), "naia-agent-context-replacement-"));
	roots.push(outside);
	const contextPath = join(root, ".agents/context/policy.yaml");
	const snapshot = buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	writeFileSync(join(outside, "policy.yaml"), "policy: deterministic\n", "utf8");
	rmSync(contextPath);
	symlinkSync(join(outside, "policy.yaml"), contextPath);
	assert.throws(() => verifyAgentContextBeforeAttempt(snapshot), (error) => error.code === "context_changed_restart_required");
});

test("attempt verification rejects an intermediate-directory symlink swap", () => {
	const root = fixture();
	const outside = mkdtempSync(join(tmpdir(), "naia-agent-context-parent-swap-"));
	roots.push(outside);
	mkdirSync(join(outside, "context"));
	writeFileSync(join(outside, "context/policy.yaml"), "policy: deterministic\n", "utf8");
	const snapshot = buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents/context/policy.yaml"] });
	renameSync(join(root, ".agents/context"), join(root, ".agents/context-original"));
	symlinkSync(join(outside, "context"), join(root, ".agents/context"));
	assert.throws(() => verifyAgentContextBeforeAttempt(snapshot), (error) => error.code === "context_changed_restart_required");
});

test("workspace resolution rejects escapes, symlinks, duplicates, and non-POSIX config paths", () => {
	const root = fixture();
	const outside = mkdtempSync(join(tmpdir(), "naia-agent-context-outside-"));
	roots.push(outside);
	writeFileSync(join(outside, "outside.md"), "outside\n", "utf8");
	symlinkSync(join(outside, "outside.md"), join(root, "linked.md"));
	const linkedWorkspace = join(outside, "linked-workspace");
	symlinkSync(root, linkedWorkspace);
	assert.throws(() => resolveAgentContextWorkspace({ workspace: linkedWorkspace, entrypoint: "AGENTS.md", contextFiles: [] }), /workspace.*symbolic links/);
	assert.throws(() => resolveAgentContextWorkspace({ workspace: root, entrypoint: "../outside.md", contextFiles: [] }), /traversal|relative path/);
	assert.throws(() => resolveAgentContextWorkspace({ workspace: root, entrypoint: "linked.md", contextFiles: [] }), /symbolic links/);
	assert.throws(() => resolveAgentContextWorkspace({ workspace: root, entrypoint: "AGENTS.md", contextFiles: ["AGENTS.md"] }), /unique/);
	assert.throws(() => resolveAgentContextWorkspace({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [".agents\\context\\policy.yaml"] }), /POSIX relative path/);
});

test("agent context enforces count, per-file, total, and UTF-8 bounds", () => {
	const root = fixture();
	const tooMany = [];
	for (let index = 0; index < AGENT_CONTEXT_LIMITS.maxContextFiles; index += 1) {
		const relativePath = `.agents/context/count-${String(index).padStart(2, "0")}.txt`;
		writeFileSync(join(root, relativePath), "x", "utf8");
		tooMany.push(relativePath);
	}
	assert.throws(() => buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: tooMany }), /count exceeds/);

	const oversized = ".agents/context/oversized.txt";
	writeFileSync(join(root, oversized), Buffer.alloc(AGENT_CONTEXT_LIMITS.maxFileBytes + 1, 0x61));
	assert.throws(() => buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [oversized] }), /file exceeds/);

	const totalFiles = [];
	for (let index = 0; index < 5; index += 1) {
		const relativePath = `.agents/context/total-${index}.txt`;
		writeFileSync(join(root, relativePath), Buffer.alloc(220 * 1024, 0x62));
		totalFiles.push(relativePath);
	}
	assert.throws(() => buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: totalFiles }), /total size/);

	const invalidUtf8 = ".agents/context/invalid.txt";
	writeFileSync(join(root, invalidUtf8), Buffer.from([0xc3, 0x28]));
	assert.throws(() => buildAgentContextSnapshot({ workspace: root, entrypoint: "AGENTS.md", contextFiles: [invalidUtf8] }), /valid UTF-8/);
});
