#!/usr/bin/env node
/**
 * Issue a review receipt from the verbatim reviewer transcripts of one round.
 *
 * Usage:
 *   node scripts/issue-review-receipt.cjs <review-id> <reviewed-at> <tool>:<model>=<log> ...
 *
 * Every claim in the receipt is derived from the transcripts by the shared parser in
 * request-contract-review-transcript.cjs; this script invents nothing. Each transcript is
 * copied next to the receipt, so the validator can re-derive the same claims from the
 * preserved bytes rather than trusting what the receipt says about itself.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scope = require("./request-contract-review-scope.cjs");
const transcript = require("./request-contract-review-transcript.cjs");

const { stages } = transcript;
const [reviewId, reviewedAt, ...reviewerArgs] = process.argv.slice(2);

if (!reviewId || !reviewedAt || reviewerArgs.length === 0) {
	process.stderr.write("usage: issue-review-receipt.cjs <review-id> <reviewed-at> <tool>:<model>=<log> ...\n");
	process.exit(2);
}
if (!/^[A-Za-z0-9._-]+$/.test(reviewId)) {
	process.stderr.write(`review id must be filename-safe: ${reviewId}\n`);
	process.exit(2);
}

fs.mkdirSync(path.join(scope.receiptsDir, "logs"), { recursive: true });
const requiredFiles = scope.reviewedFiles();

const reviewers = [];
for (const arg of reviewerArgs) {
	const parsed = arg.match(/^([^:]+):([^=]+)=(.+)$/);
	if (!parsed) {
		process.stderr.write(`malformed reviewer argument: ${arg}\n`);
		process.exit(2);
	}
	const [, tool, model, logPath] = parsed;
	const raw = fs.readFileSync(logPath);
	const derived = transcript.readTranscript(raw);
	const readSet = new Set(derived.files_read);
	const missingFiles = requiredFiles.filter((relativePath) => !readSet.has(relativePath));
	if (missingFiles.length > 0) {
		process.stderr.write(`${model}: Files Read attestation omits ${missingFiles.length} reviewed file(s): ${missingFiles.join(", ")}\n`);
		process.exit(1);
	}

	/** Both halves of the reviewer identity land in a filename, so both must be sanitised — a tool named `../../etc` would escape the store. */
	const safe = (value) => value.replace(/[^A-Za-z0-9._-]/g, "-");
	const preservedName = `${reviewId}__${safe(tool)}__${safe(model)}.log`;
	const preservedPath = path.join(scope.receiptsDir, "logs", preservedName);
	/** Evidence is append-only: silently overwriting a transcript would erase the review it recorded. */
	if (fs.existsSync(preservedPath) && !fs.readFileSync(preservedPath).equals(raw)) {
		process.stderr.write(`refusing to overwrite an existing transcript with different bytes: ${preservedName}\n`);
		process.exit(1);
	}
	fs.writeFileSync(preservedPath, raw);

	reviewers.push({
		tool,
		model,
		log: path.posix.join(".agents", "requirements", "reviews", "logs", preservedName),
		log_sha256: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
		scope_digest: derived.scope_digest,
		files_read: derived.files_read,
		covers: derived.covers,
		stages: derived.stages,
		findings: derived.findings,
	});
}

const currentDigest = scope.computeScopeDigest();
const currentManifest = scope.reviewManifest();

/**
 * The reviewers must have judged the tree being issued. Their transcripts carry the digest
 * they were given; if the working tree has moved since — because the writer edited reviewed
 * code after the round — the verdicts belong to a tree that no longer exists and this receipt
 * would silently bind them to a tree nobody reviewed.
 */
for (const reviewer of reviewers) {
	if (!reviewer.scope_digest) {
		process.stderr.write(`${reviewer.model}: transcript carries no Scope Digest section; cannot bind its verdict to a tree\n`);
		process.exit(1);
	}
	if (reviewer.scope_digest !== currentDigest) {
		process.stderr.write(`${reviewer.model}: reviewed ${reviewer.scope_digest} but the tree is now ${currentDigest} — the reviewed content changed after the round; re-review\n`);
		process.exit(1);
	}
}

/** One transcript cannot stand in for several reviewers. */
const seenTranscripts = new Map();
for (const reviewer of reviewers) {
	const previous = seenTranscripts.get(reviewer.log_sha256);
	if (previous) {
		process.stderr.write(`${reviewer.tool}:${reviewer.model} and ${previous} were given the same transcript; one review cannot count as two reviewers\n`);
		process.exit(1);
	}
	seenTranscripts.set(reviewer.log_sha256, `${reviewer.tool}:${reviewer.model}`);
}

const stageResults = {};
for (const stage of stages) {
	const verdicts = reviewers.map((reviewer) => reviewer.stages[stage]);
	const clean = verdicts.filter((verdict) => verdict === "clean").length;
	const dirty = verdicts.filter((verdict) => verdict === "dirty").length;
	const silent = verdicts.filter((verdict) => verdict === null).length;
	const findings = reviewers.reduce((total, reviewer) => total + (reviewer.findings[stage] || 0), 0);
	stageResults[stage] = {
		verdict: dirty > 0 || clean === 0 ? "dirty" : "clean",
		findings,
		clean_reviewers: clean,
		dirty_reviewers: dirty,
		silent_reviewers: silent,
	};
}

/**
 * Everything at least one Clean reviewer vouched for. Whether that is enough voices for a
 * given requirement is the validator's call, made per requirement against the stage quorum.
 */
const cleanReviewers = reviewers.filter((reviewer) => stages.some((stage) => reviewer.stages[stage] === "clean"));
const covers = new Set(cleanReviewers.flatMap((reviewer) => reviewer.covers));

const receipt = {
	review_id: reviewId,
	product: "naia-adk-request-contract",
	reviewed_at: reviewedAt,
	scope_digest: currentDigest,
	scope_manifest: currentManifest,
	covers: [...covers].sort(),
	stages: stageResults,
	reviewers,
};

fs.writeFileSync(path.join(scope.receiptsDir, `${reviewId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);

for (const stage of stages) {
	const result = stageResults[stage];
	process.stdout.write(`${stage}: ${result.verdict.toUpperCase()} (clean=${result.clean_reviewers} dirty=${result.dirty_reviewers} silent=${result.silent_reviewers} findings=${result.findings})\n`);
}
process.stdout.write(`covers: ${receipt.covers.join(", ") || "(none)"}\n`);
process.stdout.write(`receipt written: .agents/requirements/reviews/${reviewId}.json\n`);
