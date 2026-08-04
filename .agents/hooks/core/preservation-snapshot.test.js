#!/usr/bin/env node
"use strict";

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const snapshot = require("./preservation-snapshot.js");

function sha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function git(cwd, args) {
	return cp.execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
}

function write(root, relative, value, mode = 0o644) {
	const target = path.join(root, ...relative.split("/"));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, value, { mode });
	fs.chmodSync(target, mode);
}

function expectCode(fn, code) {
	assert.throws(fn, (error) => error && error.code === code, `expected ${code}`);
}

function makeRepository() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "preservation-snapshot-test-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	git(repo, ["init", "--quiet"]);
	git(repo, ["config", "user.email", "snapshot-test@example.invalid"]);
	git(repo, ["config", "user.name", "Snapshot Test"]);
	write(repo, ".gitignore", "surface/ignored.txt\n");
	write(repo, "surface/entry.sh", "#!/bin/sh\nprintf baseline\n", 0o755);
	write(repo, "surface/data.bin", Buffer.from([0, 1, 2, 255]));
	write(repo, "surface/nested/value.txt", "baseline\n");
	write(repo, "outside/not-in-snapshot.txt", "outside\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "--quiet", "-m", "baseline"]);
	const baseline = git(repo, ["rev-parse", "HEAD"]).trim();
	return { root, repo, baseline };
}

function testImmutableBaselineAndCurrentWorkspace() {
	const fixture = makeRepository();
	try {
		write(fixture.repo, "surface/nested/value.txt", "current\n");
		write(fixture.repo, "surface/untracked.txt", "untracked\n");
		write(fixture.repo, "surface/ignored.txt", "ignored\n");

		const baselineDestination = path.join(fixture.root, "baseline");
		const baseline = snapshot.materialize({
			cwd: fixture.repo,
			destination: baselineDestination,
			roots: ["surface"],
			phase: "baseline",
			ref: fixture.baseline,
			sha256,
		});
		assert.strictEqual(baseline.ref, fixture.baseline);
		assert.strictEqual(baseline.git_digest, sha256(fs.readFileSync("/usr/bin/git")));
		assert.strictEqual(baseline.destination, baselineDestination);
		assert.deepStrictEqual(Object.keys(baseline.files), [
			"surface/data.bin",
			"surface/entry.sh",
			"surface/nested/value.txt",
		]);
		assert.strictEqual(fs.readFileSync(path.join(baselineDestination, "surface/nested/value.txt"), "utf8"), "baseline\n");
		assert.strictEqual(fs.statSync(path.join(baselineDestination, "surface/entry.sh")).mode & 0o777, 0o755);
		assert.strictEqual(fs.statSync(baselineDestination).mode & 0o777, 0o700);
		assert.strictEqual(baseline.files["surface/data.bin"].digest, sha256(Buffer.from([0, 1, 2, 255])));
		const repeatedBaseline = snapshot.materialize({
			cwd: path.join(fixture.repo, "surface"),
			destination: path.join(fixture.root, "baseline-repeated"),
			roots: ["surface"],
			phase: "baseline",
			ref: fixture.baseline,
			sha256,
		});
		assert.strictEqual(repeatedBaseline.digest, baseline.digest);

		const currentDestination = path.join(fixture.root, "current");
		const current = snapshot.materialize({
			cwd: path.join(fixture.repo, "surface/nested"),
			destination: currentDestination,
			roots: ["surface", "surface"],
			phase: "current",
			sha256,
		});
		assert.strictEqual(current.ref, fixture.baseline);
		assert.deepStrictEqual(current.roots, ["surface"]);
		assert.deepStrictEqual(Object.keys(current.files), [
			"surface/data.bin",
			"surface/entry.sh",
			"surface/nested/value.txt",
			"surface/untracked.txt",
		]);
		assert.strictEqual(fs.readFileSync(path.join(currentDestination, "surface/nested/value.txt"), "utf8"), "current\n");
		assert.ok(!fs.existsSync(path.join(currentDestination, "surface/ignored.txt")));
		assert.ok(!fs.existsSync(path.join(currentDestination, "outside/not-in-snapshot.txt")));
		assert.notStrictEqual(current.digest, baseline.digest);
		assert.strictEqual(snapshot.verifyCurrentStable(fixture.repo, ["surface"], current, sha256), true);
		write(fixture.repo, "surface/untracked.txt", "changed\n");
		assert.strictEqual(snapshot.verifyCurrentStable(fixture.repo, ["surface"], current, sha256), false);
		assert.strictEqual(snapshot.verifyCurrentStable(fixture.repo, ["surface"], { ...current, repository: { ...current.repository, inode: current.repository.inode + 1 } }, sha256), false);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

function testUnsafeInputsFailClosed() {
	const fixture = makeRepository();
	try {
		const invalidRoots = [[], [""], ["../surface"], ["surface/.."], ["surface/./nested"], ["surface//nested"], [path.resolve(fixture.repo, "surface")], ["C:\\surface"], ["\\\\server\\surface"], ["surface\0escape"]];
		for (const [index, roots] of invalidRoots.entries()) {
			expectCode(() => snapshot.materialize({
				cwd: fixture.repo,
				destination: path.join(fixture.root, `invalid-root-${index}`),
				roots,
				phase: "current",
				sha256,
			}), "preservation_snapshot_roots_invalid");
		}
		expectCode(() => snapshot.materialize({ cwd: fixture.repo, destination: path.join(fixture.root, "bad-phase"), roots: ["surface"], phase: "future", sha256 }), "preservation_snapshot_phase_invalid");
		expectCode(() => snapshot.materialize({ cwd: fixture.repo, destination: path.join(fixture.root, "bad-ref"), roots: ["surface"], phase: "baseline", ref: "HEAD", sha256 }), "preservation_snapshot_ref_invalid");
		expectCode(() => snapshot.materialize({ cwd: fixture.repo, destination: path.join(fixture.root, "unpinned-git"), roots: ["surface"], phase: "current", sha256, gitExecutable: "/usr/bin/git", allowedGitDigests: ["0".repeat(64)] }), "preservation_snapshot_git_not_allowed");
		const existing = path.join(fixture.root, "existing");
		fs.mkdirSync(existing);
		expectCode(() => snapshot.materialize({ cwd: fixture.repo, destination: existing, roots: ["surface"], phase: "current", sha256 }), "preservation_snapshot_destination_exists");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

function testSymbolicLinksCannotBecomeRegularSnapshotFiles() {
	if (process.platform === "win32") return;
	const fixture = makeRepository();
	try {
		fs.symlinkSync("missing-target", path.join(fixture.repo, "surface/broken-link"));
		assert.ok(snapshot.currentFiles(fixture.repo, ["surface"]).includes("surface/broken-link"));
		expectCode(() => snapshot.materialize({
			cwd: fixture.repo,
			destination: path.join(fixture.root, "current-with-link"),
			roots: ["surface"],
			phase: "current",
			sha256,
		}), "preservation_snapshot_file_invalid");

		git(fixture.repo, ["add", "surface/broken-link"]);
		git(fixture.repo, ["commit", "--quiet", "-m", "add symlink"]);
		const linkRef = git(fixture.repo, ["rev-parse", "HEAD"]).trim();
		expectCode(() => snapshot.materialize({
			cwd: fixture.repo,
			destination: path.join(fixture.root, "baseline-with-link"),
			roots: ["surface"],
			phase: "baseline",
			ref: linkRef,
			sha256,
		}), "preservation_snapshot_file_invalid");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
}

const tests = [
	["immutable baseline and current workspace", testImmutableBaselineAndCurrentWorkspace],
	["unsafe inputs fail closed", testUnsafeInputsFailClosed],
	["symbolic links fail closed", testSymbolicLinksCannotBecomeRegularSnapshotFiles],
];

for (const [name, test] of tests) {
	test();
	process.stdout.write(`preservation snapshot: PASS (${name})\n`);
}
