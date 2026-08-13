#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { commit } = require("./bash.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "commit-review-policy-"));

function git(...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function check() {
	return commit("git commit -m test", { cwd: root });
}

function digest() {
	const diff = execFileSync("git", ["diff", "--cached", "--binary", "--no-ext-diff", "--", ".", ":(exclude).agents/progress/**"], { cwd: root });
	return require("crypto").createHash("sha256").update(diff).digest("hex");
}

function cleanProgress(overrides = {}) {
	const hash = digest();
	return {
		repo: "nextain/example", issue: "X", task_id: "issue-1", current_phase: "sync_verify",
		review_log: { task_id: "issue-1", phase: "review", result: "2_consecutive_clean", staged_diff_sha256: hash, rounds: cleanRounds() },
		post_test_review_log: { task_id: "issue-1", phase: "integration", result: "2_consecutive_clean", staged_diff_sha256: hash, rounds: cleanRounds() },
		...overrides,
	};
}

function cleanRounds() {
	return [
		{ reviewer: "reviewer-a", verdict: "clean", reviewed_at: "2026-07-21T00:00:00Z" },
		{ reviewer: "reviewer-b", verdict: "clean", reviewed_at: "2026-07-21T00:01:00Z" },
	];
}

function writeProgress(value) {
	fs.mkdirSync(path.join(root, ".agents", "progress"), { recursive: true });
	fs.writeFileSync(path.join(root, ".agents", "progress", "work.json"), JSON.stringify(value));
}

try {
	git("init", "-q");
	git("remote", "add", "origin", "https://github.com/nextain/example.git");
	fs.writeFileSync(path.join(root, "code.js"), "changed\n");
	git("add", "code.js");
	assert(check(), "staged changes without progress must block");
	writeProgress({ issue: "X", issue_url: "https://github.com/nextain/example/issues/1", current_phase: "sync_verify" });
	assert(check(), "missing review evidence must block");
	writeProgress({ ...cleanProgress(), review_log: { task_id: "issue-1", phase: "review", result: "2_consecutive_clean", staged_diff_sha256: digest() } });
	assert(check(), "review claims without two structured rounds must block");
	writeProgress(cleanProgress());
	git("add", "-f", ".agents/progress/work.json");
	assert.strictEqual(check(), null, "both clean review proofs must pass");
	assert.strictEqual(digest(), cleanProgress().review_log.staged_diff_sha256, "staged progress evidence must not create a self-referential digest");
	assert.strictEqual(
		commit(`git --no-pager -c advice.detachedHead=false -C "${path.basename(root)}" commit -m test`, { cwd: path.dirname(root) }),
		null,
		"git global options and -C must resolve and enforce the target repository",
	);
	assert(commit("cd elsewhere && git commit -m test", { cwd: root }), "compound commands must fail closed");
	assert(commit("git status\ngit commit -m test", { cwd: root }), "newline commands must fail closed");
	assert(commit("$(git commit -m test)", { cwd: root }), "command substitution commits must fail closed");
	assert(commit('echo "$(git commit -m test)"', { cwd: root }), "quoted command substitutions must fail closed");
	assert(commit('sh -c "git commit -m test"', { cwd: root }), "shell wrapper commits must fail closed");
	assert(commit("env MODE=test git commit -m test", { cwd: root }), "wrapper commits must fail closed");
	assert(commit("git commit -am test", { cwd: root }), "implicit staging commits must fail closed");
	assert(commit("git commit --interactive -m test", { cwd: root }), "interactive staging commits must fail closed");
	assert(commit("git commit --patch -m test", { cwd: root }), "patch staging commits must fail closed");
	assert(commit("git commit --pa -m test", { cwd: root }), "abbreviated patch options must fail closed");
	assert(commit("git commit --ame -m test", { cwd: root }), "abbreviated amend commits must fail closed");
	assert.strictEqual(commit("git commit -mfeat", { cwd: root }), null, "attached commit messages must remain valid");
	assert(commit("git commit code.js -m test", { cwd: root }), "pathspec commits must fail closed");
	assert(commit(`git --git-dir=${root}/.git commit -m test`, { cwd: root }), "alternate git-dir commits must fail closed");
	assert.strictEqual(commit("git commit --dry-run", { cwd: root }), null, "dry-run must remain read-only");
	assert(commit("git commit --dry-run --interactive", { cwd: root }), "dry-run must not exempt index-changing options");
	assert.strictEqual(commit("echo 'git commit -m example'", { cwd: root }), null, "quoted examples must remain read-only");
	assert.strictEqual(commit("echo 'git commit -m example' | cat", { cwd: root }), null, "quoted example pipelines must remain read-only");
	writeProgress(cleanProgress({ review_log: { phase: "development", result: "2_consecutive_clean", staged_diff_sha256: digest() } }));
	assert(check(), "wrong development phase must block");
	writeProgress(cleanProgress({ post_test_review_log: { phase: "test", result: "2_consecutive_clean", staged_diff_sha256: digest() } }));
	assert(check(), "wrong integration phase must block");
	writeProgress(cleanProgress());
	fs.appendFileSync(path.join(root, "code.js"), "new staged content\n");
	git("add", "code.js");
	assert(check(), "changing staged content after review must invalidate evidence");
	writeProgress({ issue: "Y", issue_url: "https://github.com/other/repo/issues/9", current_phase: "sync_verify" });
	assert(check(), "different-repository progress must not bypass the gate");
	console.log("commit review policy tests: PASS");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
