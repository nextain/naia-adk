#!/usr/bin/env node
/**
 * Shared review-scope digest for the RCI requirement trace.
 *
 * The digest is deliberately computed from the current working tree, including
 * non-ignored untracked files. A staged snapshot is not the tree a reviewer reads:
 * hashing the index would let an unstaged edit or a newly-created implementation
 * retain an obsolete Clean receipt.
 *
 * Review metadata is excluded. Requirement `reviews:` lines and the receipt store
 * may therefore be written after a verdict without invalidating that verdict.
 */

const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requirementsDir = path.join(root, ".agents", "requirements");
const receiptsDir = path.join(requirementsDir, "reviews");

const SCOPE_PATTERN = /request-contract/;
const SOURCE_PATTERN = /^\.agents\/requirements\/sources\//;
const EXTRA_SCOPE_FILES = [
".agents/context/harness.yaml",
	".agents/context/development-model-routing.yaml",
	".agents/requirements/_index.yaml",
	".agents/skills/manage-skills/SKILL.md",
	".agents/skills/review-pass/SKILL.md",
	".users/context/harness.md",
	"packages/benchmark-contract/baselines/development-composition-profiles.json",
	"packages/benchmark-contract/src/development-profiles.mjs",
	"packages/benchmark-contract/test/development-profiles.test.mjs",
	"scripts/issue-review-receipt.cjs",
];
const EXCLUDED_PREFIXES = [".agents/requirements/reviews/"];

function stripReviewsLine(text) {
	return text.replace(/^\s*reviews:.*(?:\r?\n|$)/gm, "");
}

function deletionBytes(relativePath) {
	return Buffer.from(`request-contract-deleted-v1\0${relativePath}`, "utf8");
}

function createReviewScope(projectRoot, options = {}) {
	const scopeRoot = path.resolve(projectRoot);
	const scopePattern = options.scopePattern || SCOPE_PATTERN;
	const extraScopeFiles = options.extraScopeFiles || EXTRA_SCOPE_FILES;

	function git(args, output = "utf8") {
		return cp.execFileSync("git", args, { cwd: scopeRoot, encoding: output, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	}

	function trackedFiles() {
		return git(["ls-files", "-z"]).split("\0").filter(Boolean);
	}

	/** Files visible to a reviewer: index members plus non-ignored untracked files. */
	function reviewFiles() {
		return git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
			.split("\0")
			.filter(Boolean)
			.map((entry) => entry.replace(/\\/g, "/"));
	}

	/** Every current change is reviewable, even when its filename does not advertise the feature. */
	function changedFiles() {
		const commands = [
			["diff", "--name-only", "-z"],
			["diff", "--cached", "--name-only", "-z"],
			["ls-files", "--others", "--exclude-standard", "-z"],
		];
		return [...new Set(commands.flatMap((args) => git(args).split("\0").filter(Boolean).map((entry) => entry.replace(/\\/g, "/"))))].sort();
	}

	function resolveInside(relativePath) {
		const resolved = path.resolve(scopeRoot, relativePath);
		if (resolved !== scopeRoot && !resolved.startsWith(`${scopeRoot}${path.sep}`)) {
			throw new Error(`review scope: path escapes repository: ${relativePath}`);
		}
		return resolved;
	}

	function symlinkTarget(relativePath, resolved) {
		let real;
		try {
			real = fs.realpathSync(resolved);
		} catch (error) {
			throw new Error(`review scope: cannot resolve symlink ${relativePath}: ${error.message}`);
		}
		if (real !== scopeRoot && !real.startsWith(`${scopeRoot}${path.sep}`)) {
			throw new Error(`review scope: symlink target escapes repository: ${relativePath}`);
		}
		const stat = fs.statSync(real);
		if (!stat.isFile()) throw new Error(`review scope: symlink target is not a file: ${relativePath}`);
		return { resolved: real, relativePath: path.relative(scopeRoot, real).replace(/\\/g, "/"), bytes: fs.readFileSync(real) };
	}

	/** Current bytes, never index bytes. A tracked deletion receives a stable tombstone. */
	function workingBytes(relativePath) {
		const resolved = resolveInside(relativePath);
		try {
			if (fs.lstatSync(resolved).isSymbolicLink()) return symlinkTarget(relativePath, resolved).bytes;
			return fs.readFileSync(resolved);
		} catch (error) {
			if (error && error.code === "ENOENT" && new Set(trackedFiles()).has(relativePath)) return deletionBytes(relativePath);
			throw new Error(`review scope: cannot read current working-tree bytes for ${relativePath}: ${error.message}`);
		}
	}

	/** Preserve filesystem object identity: a symlink is its link payload, not its target bytes. */
	function reviewMaterial(relativePath) {
		const resolved = resolveInside(relativePath);
		let stat;
		try {
			stat = fs.lstatSync(resolved);
		} catch (error) {
			if (error && error.code === "ENOENT" && new Set(trackedFiles()).has(relativePath)) {
				return { type: "deletion", bytes: deletionBytes(relativePath) };
			}
			throw new Error(`review scope: cannot inspect current working-tree object for ${relativePath}: ${error.message}`);
		}
		if (stat.isSymbolicLink()) {
			const target = symlinkTarget(relativePath, resolved);
			return { type: "symlink", bytes: Buffer.from(fs.readlinkSync(resolved), "utf8"), target };
		}
		if (stat.isFile()) return { type: "file", bytes: fs.readFileSync(resolved) };
		throw new Error(`review scope: unsupported working-tree object for ${relativePath}`);
	}

	function requirementFilenames() {
		return reviewFiles()
			.filter((name) => /^\.agents\/requirements\/RCI-\d{3}-.+\.yaml$/.test(name))
			.map((name) => path.posix.basename(name))
			.sort();
	}

	function tracedFiles() {
		const traced = new Set();
		for (const filename of requirementFilenames()) {
			const relativePath = path.posix.join(".agents", "requirements", filename);
			const text = workingBytes(relativePath).toString("utf8");
			const trace = text.match(/^trace:\s*$([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1];
			if (trace === undefined) throw new Error(`review scope: ${filename} has no trace block`);
			const paths = [...trace.matchAll(/path:\s*(?:"([^"]+)"|'([^']+)')/g)].map((match) => match[1] ?? match[2]);
			if (paths.length === 0) throw new Error(`review scope: ${filename} traces no paths`);
			for (const item of paths) traced.add(item.replace(/\\/g, "/"));
		}
		return traced;
	}

	function isDigestible(relativePath, tracked) {
		try {
			const stat = fs.lstatSync(resolveInside(relativePath));
			return stat.isFile() || stat.isSymbolicLink();
		} catch (error) {
			if (error && error.code === "ENOENT") return tracked.has(relativePath);
			throw error;
		}
	}

	function scopeFiles() {
		const tracked = new Set(trackedFiles().map((entry) => entry.replace(/\\/g, "/")));
		const visible = new Set(reviewFiles());
		const selected = new Set();
		for (const relativePath of changedFiles()) {
			if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
			if (/^\.agents\/requirements\/RCI-\d{3}-.+\.yaml$/.test(relativePath)) continue;
			selected.add(relativePath);
		}
		for (const relativePath of visible) {
			if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
			if (/^\.agents\/requirements\/RCI-\d{3}-.+\.yaml$/.test(relativePath)) continue;
			if (scopePattern.test(relativePath) || SOURCE_PATTERN.test(relativePath)) selected.add(relativePath);
		}
		for (const relativePath of [...extraScopeFiles, ...tracedFiles()]) {
			if (EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;
			if (!visible.has(relativePath)) throw new Error(`review scope: reviewed file is neither tracked nor visible untracked content: ${relativePath}`);
			selected.add(relativePath);
		}
		return [...selected].filter((relativePath) => isDigestible(relativePath, tracked)).sort();
	}

	function reviewedFiles() {
		return [...new Set([
			...scopeFiles(),
			...requirementFilenames().map((filename) => path.posix.join(".agents", "requirements", filename)),
		])].sort();
	}

	/** Exact bytes supplied for review; requirement bindings exclude only their mutable reviews line. */
	function reviewManifest() {
		return reviewedFiles().map((relativePath) => {
			const material = reviewMaterial(relativePath);
			let bytes = material.bytes;
			if (material.type === "file" && /^\.agents\/requirements\/RCI-\d{3}-.+\.yaml$/.test(relativePath)) {
				bytes = Buffer.from(stripReviewsLine(bytes.toString("utf8")), "utf8");
			}
			const entry = {
				path: relativePath,
				type: material.type,
				size: bytes.length,
				sha256: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
			};
			if (material.type === "symlink") {
				entry.target_path = material.target.relativePath;
				entry.target_size = material.target.bytes.length;
				entry.target_sha256 = `sha256:${crypto.createHash("sha256").update(material.target.bytes).digest("hex")}`;
			}
			return entry;
		});
	}

	function computeManifestDigest(manifest) {
		return `sha256:${crypto.createHash("sha256").update(manifest.map((entry) => JSON.stringify(entry)).join("\n")).digest("hex")}`;
	}

	function digestEntries() {
		return reviewManifest().map((entry) => JSON.stringify(entry));
	}

	function computeScopeDigest() {
		return computeManifestDigest(reviewManifest());
	}

	return { requirementFilenames, trackedFiles, reviewFiles, changedFiles, workingBytes, reviewMaterial, tracedFiles, scopeFiles, reviewedFiles, reviewManifest, computeManifestDigest, digestEntries, computeScopeDigest };
}

const defaultScope = createReviewScope(root);

function writeFixture(repo, relativePath, contents) {
	const target = path.join(repo, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents);
}

/** Fault tests prove the exact regressions that an index-only digest missed. */
function selfTest(report = (message) => process.stderr.write(`${message}\n`)) {
	const failures = [];
	const withReviews = ['trace:', '  code:', '    - { path: "request-contract.js", symbol: "x", coverage: full }', '  reviews: { planning: ["r1"] }', 'decisions: []', ""].join("\n");
	const withOtherReviews = withReviews.replace('  reviews: { planning: ["r1"] }', '  reviews: { planning: ["r9", "r8"], test: ["r7"] }');
	if (stripReviewsLine(withReviews) !== stripReviewsLine(withOtherReviews)) failures.push("stripReviewsLine leaves review metadata in digest input");

	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "request-contract-review-scope-"));
	try {
		gitFixture(["init", "-q"], temp);
		gitFixture(["config", "user.email", "scope@test.invalid"], temp);
		gitFixture(["config", "user.name", "Scope Test"], temp);
		writeFixture(temp, ".agents/requirements/RCI-001-fixture.yaml", withReviews);
		writeFixture(temp, "request-contract.js", "baseline\n");
		gitFixture(["add", "."], temp);
		gitFixture(["commit", "-qm", "fixture"], temp);
		const fixture = createReviewScope(temp, { extraScopeFiles: [] });
		const baseline = fixture.computeScopeDigest();
		const baselineManifest = fixture.reviewManifest();
		if (fixture.computeManifestDigest(baselineManifest) !== baseline) failures.push("pure manifest digest differs from the live scope digest");
		const tamperedManifest = JSON.parse(JSON.stringify(baselineManifest));
		tamperedManifest[0].size += 1;
		if (fixture.computeManifestDigest(tamperedManifest) === baseline) failures.push("manifest metadata tampering does not move the pure digest");

		writeFixture(temp, "request-contract.js", "unstaged change\n");
		const unstaged = fixture.computeScopeDigest();
		if (unstaged === baseline) failures.push("an unstaged tracked edit does not move the scope digest");
		gitFixture(["add", "request-contract.js"], temp);
		writeFixture(temp, "request-contract.js", "changed after staging\n");
		if (fixture.computeScopeDigest() === unstaged) failures.push("a post-stage working-tree edit does not move the scope digest");

		writeFixture(temp, "new-request-contract-module.js", "untracked\n");
		const withUntracked = fixture.computeScopeDigest();
		fs.writeFileSync(path.join(temp, "new-request-contract-module.js"), "untracked changed\n");
		if (fixture.computeScopeDigest() === withUntracked) failures.push("an untracked implementation edit does not move the scope digest");
		writeFixture(temp, "unrelated-name.txt", "also part of the current change set\n");
		const withUnrelatedChange = fixture.computeScopeDigest();
		fs.writeFileSync(path.join(temp, "unrelated-name.txt"), "changed unrelated file\n");
		if (fixture.computeScopeDigest() === withUnrelatedChange) failures.push("a changed file outside feature naming and traces does not move the scope digest");

		writeFixture(temp, ".agents/requirements/sources/USR-001.json", "{\"source\":1}\n");
		const withSource = fixture.computeScopeDigest();
		fs.writeFileSync(path.join(temp, ".agents/requirements/sources/USR-001.json"), "{\"source\":2}\n");
		if (fixture.computeScopeDigest() === withSource) failures.push("an untracked source-ledger edit does not move the scope digest");

		try {
			writeFixture(temp, "target-a", "same target bytes\n");
			writeFixture(temp, "target-b", "same target bytes\n");
			const link = path.join(temp, "request-contract-link");
			fs.symlinkSync("target-a", link, "file");
			const beforeLinkChange = fixture.computeScopeDigest();
			fs.unlinkSync(link);
			fs.symlinkSync("target-b", link, "file");
			const afterLinkChange = fixture.computeScopeDigest();
			if (afterLinkChange === beforeLinkChange) failures.push("changing a symlink payload to equal target bytes does not move the scope digest");
			writeFixture(temp, "target-b", "changed target bytes\n");
			if (fixture.computeScopeDigest() === afterLinkChange) failures.push("changing an in-repository symlink target's consumed bytes does not move the scope digest");

			const outside = path.join(os.tmpdir(), `request-contract-external-${crypto.randomBytes(8).toString("hex")}.txt`);
			try {
				fs.writeFileSync(outside, "external bytes\n");
				fs.unlinkSync(link);
				fs.symlinkSync(outside, link, "file");
				try {
					fixture.computeScopeDigest();
					failures.push("an external symlink target is accepted into the review scope");
				} catch (error) {
					if (!String(error.message).includes("symlink target escapes repository")) throw error;
				}
			} finally {
				try { fs.unlinkSync(link); } catch { /* fixture cleanup */ }
				try { fs.unlinkSync(outside); } catch { /* fixture cleanup */ }
			}
		} catch (error) {
			if (!error || !["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
		}

		const beforeReviewMetadata = fixture.computeScopeDigest();
		writeFixture(temp, ".agents/requirements/RCI-001-fixture.yaml", withOtherReviews);
		if (fixture.computeScopeDigest() !== beforeReviewMetadata) failures.push("editing only reviews metadata invalidates its own verdict");
		writeFixture(temp, ".agents/requirements/reviews/logs/new.log", "review metadata\n");
		if (fixture.computeScopeDigest() !== beforeReviewMetadata) failures.push("receipt-store metadata enters the reviewed digest");
	} catch (error) {
		failures.push(`working-tree fault fixture failed: ${error.message}`);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}

	if (defaultScope.computeScopeDigest() !== defaultScope.computeScopeDigest()) failures.push("computeScopeDigest is not stable across calls");
	const traced = defaultScope.tracedFiles();
	const scoped = new Set(defaultScope.scopeFiles());
	for (const relativePath of traced) if (!scoped.has(relativePath)) failures.push(`a traced path is outside the review scope: ${relativePath}`);
	// 요구사항이 하나도 없는 새 워크스페이스에서는 추적할 대상 자체가 없다.
	// 요구사항이 하나라도 있으면 여전히 최소 한 경로를 추적해야 한다.
	if (defaultScope.requirementFilenames().length > 0 && traced.size === 0) failures.push("no requirement traces any path");

	for (const failure of failures) report(`review-scope self-test failed: ${failure}`);
	return failures.length === 0;
}

function gitFixture(args, cwd) {
	return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

module.exports = {
	root,
	requirementsDir,
	receiptsDir,
	stripReviewsLine,
	createReviewScope,
	...defaultScope,
	/** Backward-compatible name; now returns current working-tree bytes. */
	stagedBytes: defaultScope.workingBytes,
	selfTest,
};

if (require.main === module) {
	if (process.argv[2] === "--list") process.stdout.write(`${defaultScope.scopeFiles().join("\n")}\n`);
	else if (process.argv[2] === "--self-test") {
		if (!selfTest()) process.exit(1);
		process.stdout.write("request-contract review-scope: PASS\n");
	} else process.stdout.write(`${defaultScope.computeScopeDigest()}\n`);
}
