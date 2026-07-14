#!/usr/bin/env node
/**
 * Shared review-scope digest for the RCI requirement trace.
 *
 * The digest covers exactly the content a reviewer is asked to judge, so that any later
 * edit to reviewed content changes the digest and forces a fresh Clean streak — the rule
 * review-pass already states for humans, enforced mechanically.
 *
 * The file set is derived from `git ls-files`, not a hand-kept list: a hand-kept list
 * silently omits a newly added file, which would let reviewed content grow without the
 * digest moving. Two things are deliberately excluded: the `reviews:` lines inside the
 * requirement files, and the receipt store itself. Recording a verdict must not
 * invalidate the verdict it records.
 */

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requirementsDir = path.join(root, ".agents", "requirements");
const receiptsDir = path.join(requirementsDir, "reviews");

/** Tracked files whose path names the feature. */
const SCOPE_PATTERN = /request-contract/;
/**
 * Reviewed files the pattern cannot find and the requirements do not name: the governing
 * skills, the index, and the review machinery itself. Everything a requirement points at
 * is picked up automatically from its own trace, so this list stays small and does not
 * have to be remembered when the implementation grows.
 */
const EXTRA_SCOPE_FILES = [
	".agents/context/harness.yaml",
	".agents/requirements/_index.yaml",
	".agents/skills/manage-skills/SKILL.md",
	".agents/skills/review-pass/SKILL.md",
	".users/context/harness.md",
	"scripts/issue-review-receipt.cjs",
];
/** Review *metadata*, not reviewed content. */
const EXCLUDED_PREFIXES = [".agents/requirements/reviews/"];

/** A requirement file's reviews line records the review; it is not part of what was reviewed. */
function stripReviewsLine(text) {
	return text.replace(/^\s*reviews:.*(?:\r?\n|$)/gm, "");
}

function requirementFilenames() {
	return fs
		.readdirSync(requirementsDir)
		.filter((name) => /^RCI-\d{3}-.+\.yaml$/.test(name))
		.sort();
}

function trackedFiles() {
	const stdout = cp.execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	return stdout.split("\0").filter((entry) => entry !== "");
}

/**
 * Whatever a requirement's trace names as its implementation or its test IS reviewed
 * content, by the requirement's own declaration. Deriving the scope from that is what
 * keeps a hand-kept list from quietly falling behind the code it is supposed to cover.
 */
function tracedFiles() {
	const traced = new Set();
	for (const filename of requirementFilenames()) {
		const text = fs.readFileSync(path.join(requirementsDir, filename), "utf8");
		/** The trace block runs to the next top-level key or to end of file — a requirement that ends on its trace must not lose it. */
		const trace = text.match(/^trace:\s*$([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1];
		if (trace === undefined) throw new Error(`review scope: ${filename} has no trace block`);
		const paths = [...trace.matchAll(/path:\s*(?:"([^"]+)"|'([^']+)')/g)].map((match) => match[1] ?? match[2]);
		if (paths.length === 0) throw new Error(`review scope: ${filename} traces no paths`);
		for (const relativePath of paths) traced.add(relativePath);
	}
	return traced;
}

/** Every tracked file a reviewer judges, excluding the requirement files (handled separately). */
function scopeFiles() {
	const tracked = new Set(trackedFiles());
	const selected = new Set();
	for (const relativePath of tracked) {
		if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
		if (/^\.agents\/requirements\/RCI-\d{3}-.+\.yaml$/.test(relativePath)) continue;
		if (!SCOPE_PATTERN.test(relativePath)) continue;
		selected.add(relativePath);
	}
	for (const relativePath of [...EXTRA_SCOPE_FILES, ...tracedFiles()]) {
		if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
		if (!tracked.has(relativePath)) throw new Error(`review scope: reviewed file is not tracked: ${relativePath}`);
		selected.add(relativePath);
	}
	/** A symlinked skill pointer resolves to a directory; digest the real file, not the pointer. */
	return [...selected].filter((relativePath) => fs.statSync(path.join(root, relativePath)).isFile()).sort();
}

function computeScopeDigest() {
	const entries = [];
	for (const relativePath of scopeFiles()) {
		const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relativePath))).digest("hex");
		entries.push(`${relativePath}\t${digest}`);
	}
	for (const filename of requirementFilenames()) {
		const relativePath = path.posix.join(".agents", "requirements", filename);
		const text = fs.readFileSync(path.join(requirementsDir, filename), "utf8");
		const digest = crypto.createHash("sha256").update(stripReviewsLine(text)).digest("hex");
		entries.push(`${relativePath}\t${digest}`);
	}
	entries.sort();
	return `sha256:${crypto.createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}

/**
 * The one guarantee this file exists to make: recording a verdict must not invalidate the
 * verdict it records. If a future edit to `stripReviewsLine` stopped covering the indented
 * `trace.reviews` line, every receipt would be voided the moment it was written — and the
 * failure would look like ordinary digest drift rather than a bug. Pin it.
 */
function selfTest(report = (message) => process.stderr.write(`${message}\n`)) {
	const failures = [];

	const withReviews = ['trace:', '  code:', '    - { path: "a.js", symbol: "x", coverage: full }', '  reviews: { planning: ["r1"] }', "decisions: []", ""].join("\n");
	const withOtherReviews = withReviews.replace('  reviews: { planning: ["r1"] }', '  reviews: { planning: ["r9", "r8"], test: ["r7"] }');
	if (stripReviewsLine(withReviews) !== stripReviewsLine(withOtherReviews)) failures.push("stripReviewsLine leaves the indented trace.reviews line in the digest input");
	if (/reviews:/.test(stripReviewsLine(withReviews))) failures.push("stripReviewsLine does not remove an indented reviews line");
	if (!/path: "a\.js"/.test(stripReviewsLine(withReviews))) failures.push("stripReviewsLine strips reviewed content it should keep");

	if (computeScopeDigest() !== computeScopeDigest()) failures.push("computeScopeDigest is not stable across calls");

	/** Every requirement's traced paths must reach the scope, including one whose trace block ends the file. */
	const traced = tracedFiles();
	const scoped = new Set(scopeFiles());
	for (const relativePath of traced) {
		if (!scoped.has(relativePath)) failures.push(`a traced path is outside the review scope: ${relativePath}`);
	}
	if (traced.size === 0) failures.push("no requirement traces any path");

	for (const failure of failures) report(`review-scope self-test failed: ${failure}`);
	return failures.length === 0;
}

module.exports = { root, requirementsDir, receiptsDir, stripReviewsLine, requirementFilenames, tracedFiles, scopeFiles, computeScopeDigest, selfTest };

if (require.main === module) {
	if (process.argv[2] === "--list") process.stdout.write(`${scopeFiles().join("\n")}\n`);
	else if (process.argv[2] === "--self-test") {
		if (!selfTest()) process.exit(1);
		process.stdout.write("request-contract review-scope: PASS\n");
	} else process.stdout.write(`${computeScopeDigest()}\n`);
}
