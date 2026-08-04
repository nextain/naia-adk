#!/usr/bin/env node
/**
 * Deterministically validate the tracked RCI requirement and review trace.
 *
 * The review check is not satisfied by a plausible-looking string in the requirement
 * file. Each stage must name receipts in `.agents/requirements/reviews/`, each receipt
 * must carry a Clean verdict from enough distinct reviewers, and each receipt must be
 * bound to the review-scope digest of the tree it actually judged. A verdict recorded
 * for one tree therefore cannot be spent on a different one.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const scope = require("./request-contract-review-scope.cjs");
const transcript = require("./request-contract-review-transcript.cjs");

const { root, requirementsDir, receiptsDir } = scope;
const sourcesDir = path.join(requirementsDir, "sources");
const stages = ["planning", "development", "test", "integration"];
/** Legacy verified RCI-001..011 receipt quorum. Four evidence roles are tracked separately by review-pass/governed review. */
const stageMinimumReviewers = { planning: 2, development: 3, test: 2, integration: 3 };
const requiredCleanRounds = 2;
const expectedIds = Array.from({ length: 16 }, (_, index) => `RCI-${String(index + 1).padStart(3, "0")}`);
const expectedDirectives = Array.from({ length: 8 }, (_, index) => `USR-${String(index + 1).padStart(3, "0")}`);
const pendingIds = new Set(["RCI-012", "RCI-013", "RCI-014", "RCI-015", "RCI-016"]);
const sourceKinds = new Set(["human", "derived", "candidate"]);
const sourceOrigins = new Set(["native_user_message", "derived_artifact", "external_document", "candidate"]);
/**
 * Pre-manifest receipts are usable only as historical, release-blocking evidence. Binding
 * their exact tracked bytes prevents a new or modified receipt from deleting modern
 * evidence fields and silently downgrading itself into the legacy path.
 */
const legacyReceiptDigests = new Map([
	["2026-07-14-round-1", "sha256:993850f8e8f8adbea6d382906b28f9ff76aa8e49966842113071e89dc701d0dd"],
	["2026-07-14-round-2", "sha256:972b4b85c97e103856772a2d40a03a45b9bd62d933ddfdff8c38725fe5eed543"],
]);
const requiredUsr008Obligations = new Set([
	"existing-site-preservation",
	"professor-source-scenario-integration",
	"three-round-measurement",
	"full-scope-adversarial-review",
	"generic-harness-prevention",
]);
/** One process validates one immutable review snapshot; avoid hundreds of repeated Git walks. */
const currentReviewedFiles = scope.reviewedFiles();

function fail(message) {
	throw new Error(`request-contract requirement trace: ${message}`);
}

/** Split a document on its top-level (column-zero) keys so key order never matters. */
const { topLevelBlocks, unquote, scalarOf, bodyOf, inlineListOf, sha256, canonicalSourceEvent, sourceIndexEntries, legacySourceGapIds, validateSourceLocator, validateSourceRecord, loadSourceLedger, validateRequirementContract, validatePendingReviews, parseReviews, parseTracePaths } = require("./validate-request-contract-source.cjs")({
	scope, root, sourcesDir, stages, fail, sourceKinds, sourceOrigins, requiredUsr008Obligations,
});

function loadReceipts(readReceipt) {
	const receipts = new Map();
	if (!fs.existsSync(receiptsDir)) fail("review receipt store is missing");
	for (const filename of fs.readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).sort()) {
		const id = filename.replace(/\.json$/, "");
		let receipt;
		try {
			const bytes = Buffer.from(readReceipt(filename));
			receipt = JSON.parse(bytes.toString("utf8"));
			Object.defineProperty(receipt, "__file_sha256", { value: sha256(bytes), enumerable: false });
		} catch {
			fail(`receipt ${id}: not valid JSON`);
		}
		if (receipt.review_id !== id) fail(`receipt ${id}: filename/review_id mismatch`);
		receipts.set(id, receipt);
	}
	return receipts;
}

/**
 * Re-derive everything the receipt claims about a reviewer straight from the preserved
 * bytes. Hashing the transcript alone proves only that *some* transcript exists: a real
 * FOUND_ISSUES transcript could sit next to a receipt asserting Clean, and both the hash
 * and the format check would pass. So the transcript is parsed again here, with the same
 * parser the issuer used, and the receipt must agree with what it says.
 */
function receiptManifestPaths(receipt, receiptId) {
	if (receipt.scope_manifest === undefined) return [];
	if (!Array.isArray(receipt.scope_manifest) || receipt.scope_manifest.length === 0) fail(`receipt ${receiptId}: scope_manifest must be a non-empty array when present`);
	const paths = [];
	for (const [index, entry] of receipt.scope_manifest.entries()) {
		const label = `receipt ${receiptId}: scope_manifest entry ${index + 1}`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${label} is not an object`);
		if (typeof entry.path !== "string" || entry.path.trim() === "" || path.isAbsolute(entry.path) || entry.path.includes("\\")) fail(`${label} has an invalid repository-relative path`);
		if (!["file", "symlink", "deletion"].includes(entry.type)) fail(`${label} has an invalid object type`);
		if (!Number.isInteger(entry.size) || entry.size < 0) fail(`${label} has an invalid size`);
		if (!/^sha256:[0-9a-f]{64}$/.test(entry.sha256 || "")) fail(`${label} has an invalid digest`);
		if (entry.type === "symlink") {
			if (typeof entry.target_path !== "string" || entry.target_path.trim() === "" || path.isAbsolute(entry.target_path) || entry.target_path.includes("\\")) fail(`${label} has an invalid internal target path`);
			if (!Number.isInteger(entry.target_size) || entry.target_size < 0) fail(`${label} has an invalid target size`);
			if (!/^sha256:[0-9a-f]{64}$/.test(entry.target_sha256 || "")) fail(`${label} has an invalid target digest`);
		} else if (entry.target_path !== undefined || entry.target_size !== undefined || entry.target_sha256 !== undefined) {
			fail(`${label} carries symlink target metadata for a non-symlink`);
		}
		paths.push(entry.path);
	}
	if (new Set(paths).size !== paths.length) fail(`receipt ${receiptId}: scope_manifest contains duplicate paths`);
	if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) fail(`receipt ${receiptId}: scope_manifest paths are not canonical sorted order`);
	return paths;
}

function deriveReviewerEvidence(reviewer, receiptId, receiptScopeDigest, receiptFiles, readLog) {
	const label = `receipt ${receiptId} reviewer ${reviewer.model}`;
	if (!/^sha256:[0-9a-f]{64}$/.test(reviewer.log_sha256 || "")) fail(`${label} has no verbatim log digest`);
	/** Containment is decided on the resolved path: a `logs/../../..` prefix passes a startsWith check. */
	const logsDir = path.join(receiptsDir, "logs");
	const resolved = typeof reviewer.log === "string" ? path.resolve(root, reviewer.log) : "";
	if (path.dirname(resolved) !== logsDir || path.basename(resolved) !== path.basename(reviewer.log || "")) {
		fail(`${label} does not preserve its transcript in the receipt store`);
	}

	let bytes;
	try {
		bytes = readLog(reviewer.log);
	} catch {
		fail(`${label} transcript is missing: ${reviewer.log}`);
	}
	const actual = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== reviewer.log_sha256) fail(`${label} transcript does not hash to its recorded digest`);

	const derived = transcript.readTranscript(bytes);
	if (reviewer.scope_digest !== derived.scope_digest) fail(`${label} scope_digest differs from its transcript`);
	if (reviewer.files_read !== undefined && JSON.stringify(derived.files_read) !== JSON.stringify(reviewer.files_read)) {
		fail(`${label} Files Read attestation differs from its transcript`);
	}
	if (JSON.stringify(derived.covers) !== JSON.stringify(reviewer.covers)) fail(`${label} coverage differs from its transcript`);
	if (JSON.stringify(derived.stages) !== JSON.stringify(reviewer.stages)) fail(`${label} stage verdicts differ from its transcript`);
	if (JSON.stringify(derived.findings) !== JSON.stringify(reviewer.findings)) fail(`${label} finding counts differ from its transcript`);
	const readSet = new Set(derived.files_read);
	const missingFiles = receiptFiles.filter((relativePath) => !readSet.has(relativePath));
	if (missingFiles.length > 0) {
		fail(`${label} omitted ${missingFiles.length} reviewed file(s) from its Files Read attestation`);
	}
	/** The reviewer's own transcript names the tree it judged; a verdict cannot be moved onto another one. */
	if (derived.scope_digest !== receiptScopeDigest) {
		fail(`${label} judged ${derived.scope_digest ?? "an unstated tree"}, not the receipt's ${receiptScopeDigest}`);
	}
	return derived;
}

function verifyReviewerAgainstTranscript(reviewer, receiptId, stage, requirementId, scopeDigest, receiptFiles, readLog) {
	const derived = deriveReviewerEvidence(reviewer, receiptId, scopeDigest, receiptFiles, readLog);
	if (derived.stages[stage] !== reviewer.stages?.[stage]) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} claims a ${stage} verdict of ${JSON.stringify(reviewer.stages?.[stage])} but its transcript says ${JSON.stringify(derived.stages[stage])}`);
	}
	if (derived.stages[stage] !== "clean") {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not give a clean ${stage} verdict`);
	}
	if (derived.findings[stage] !== 0) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript reports ${derived.findings[stage]} ${stage} finding(s)`);
	}
	if (!derived.covers.includes(requirementId)) {
		fail(`${requirementId}: receipt ${receiptId} reviewer ${reviewer.model} transcript does not report covering it`);
	}
}

function auditReceiptIntrinsic(receipt, id, readLog) {
	if (receipt.product !== "naia-adk-request-contract") fail(`receipt ${id}: wrong product`);
	if (typeof receipt.reviewed_at !== "string" || Number.isNaN(Date.parse(receipt.reviewed_at))) fail(`receipt ${id}: invalid reviewed_at`);
	if (!/^sha256:[0-9a-f]{64}$/.test(receipt.scope_digest || "")) fail(`receipt ${id}: invalid scope digest`);
	const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers : [];
	if (reviewers.length === 0) fail(`receipt ${id}: no reviewers`);
	const hasLegacyEvidenceGap = receipt.scope_manifest === undefined || reviewers.some((reviewer) => reviewer.files_read === undefined);
	const legacyDigest = legacyReceiptDigests.get(id);
	if (hasLegacyEvidenceGap && (!legacyDigest || legacyDigest !== receipt.__file_sha256)) fail(`receipt ${id}: incomplete modern evidence without an exact legacy byte binding`);
	const receiptFiles = receiptManifestPaths(receipt, id);
	if (receipt.scope_manifest !== undefined && scope.computeManifestDigest(receipt.scope_manifest) !== receipt.scope_digest) fail(`receipt ${id}: scope_manifest does not compute to its scope_digest`);

	const transcriptDigests = new Set();
	const identities = new Set();
	const facts = [];
	for (const reviewer of reviewers) {
		const identity = `${reviewer.tool}/${reviewer.model}`;
		if (identities.has(identity)) fail(`receipt ${id}: duplicate reviewer identity ${identity}`);
		identities.add(identity);
		if (transcriptDigests.has(reviewer.log_sha256)) fail(`receipt ${id}: one transcript is listed under two reviewers`);
		transcriptDigests.add(reviewer.log_sha256);
		facts.push(deriveReviewerEvidence(reviewer, id, receipt.scope_digest, receiptFiles, readLog));
	}

	const expectedStages = {};
	for (const stage of stages) {
		const verdicts = facts.map((fact) => fact.stages[stage]);
		const clean = verdicts.filter((verdict) => verdict === "clean").length;
		const dirty = verdicts.filter((verdict) => verdict === "dirty").length;
		const silent = verdicts.filter((verdict) => verdict === null).length;
		const findings = facts.reduce((total, fact) => total + (fact.findings[stage] || 0), 0);
		expectedStages[stage] = { verdict: dirty > 0 || clean === 0 ? "dirty" : "clean", findings, clean_reviewers: clean, dirty_reviewers: dirty, silent_reviewers: silent };
	}
	if (JSON.stringify(receipt.stages) !== JSON.stringify(expectedStages)) fail(`receipt ${id}: aggregate stage claims do not match reviewer transcripts`);
	const cleanFacts = facts.filter((fact) => stages.some((stage) => fact.stages[stage] === "clean"));
	const expectedCovers = [...new Set(cleanFacts.flatMap((fact) => fact.covers))].sort();
	if (JSON.stringify(receipt.covers) !== JSON.stringify(expectedCovers)) fail(`receipt ${id}: aggregate coverage does not match reviewer transcripts`);
}

function validateReceiptIntegrity(receipt, id, stage, requirementId, readLog) {
	const stageResult = receipt.stages?.[stage];
	if (!stageResult) fail(`${requirementId}: receipt ${id} carries no ${stage} verdict`);
	if (stageResult.verdict !== "clean") fail(`${requirementId}: receipt ${id} ${stage} verdict is not clean`);
	if (!Number.isInteger(stageResult.findings) || stageResult.findings !== 0) fail(`${requirementId}: receipt ${id} ${stage} is clean with a nonzero finding count`);
	if (!/^sha256:[0-9a-f]{64}$/.test(receipt.scope_digest || "")) fail(`${requirementId}: receipt ${id} has no valid scope digest`);
	const hasLegacyEvidenceGap = receipt.scope_manifest === undefined || (receipt.reviewers ?? []).some((reviewer) => reviewer.files_read === undefined);
	const legacyDigest = legacyReceiptDigests.get(id);
	if (hasLegacyEvidenceGap && (!legacyDigest || legacyDigest !== receipt.__file_sha256)) {
		fail(`${requirementId}: receipt ${id} omits modern manifest/Files Read evidence without an exact legacy byte binding`);
	}
	const receiptFiles = receiptManifestPaths(receipt, id);

	/**
	 * Quorum is counted per requirement, not per receipt: a reviewer only vouches for what
	 * it said it covered. One reviewer omitting RCI-007 should cost that requirement its
	 * vote, not void the receipt for the ten it did cover.
	 */
	const reviewers = Array.isArray(receipt.reviewers) ? receipt.reviewers : [];
	/** Distinct reviewers means distinct reviews: the same transcript listed twice is one voice, not two. */
	const transcripts = new Set();
	for (const reviewer of reviewers) {
		if (transcripts.has(reviewer.log_sha256)) fail(`${requirementId}: receipt ${id} lists one transcript under two reviewers`);
		transcripts.add(reviewer.log_sha256);
	}
	const vouching = reviewers.filter((reviewer) => reviewer?.stages?.[stage] === "clean" && Array.isArray(reviewer.covers) && reviewer.covers.includes(requirementId));
	const identities = new Set(vouching.map((reviewer) => `${reviewer.tool}/${reviewer.model}`));
	if (identities.size < stageMinimumReviewers[stage]) {
		fail(`${requirementId}: receipt ${id} ${stage} has ${identities.size} clean reviewer(s) vouching for it; ${stageMinimumReviewers[stage]} distinct reviewers are required`);
	}
	for (const reviewer of vouching) verifyReviewerAgainstTranscript(reviewer, id, stage, requirementId, receipt.scope_digest, receiptFiles, readLog);
}

function validateReceiptEligibility(receipt, id, stage, requirementId, scopeDigest, scopeManifest) {
	if (receipt.scope_digest !== scopeDigest) fail(`${requirementId}: receipt ${id} judged a different tree (scope digest drift — the reviewed content changed after the review)`);
	if (JSON.stringify(receipt.scope_manifest) !== JSON.stringify(scopeManifest)) {
		fail(`${requirementId}: receipt ${id} does not bind the exact path, object type, size, and digest manifest supplied for review`);
	}
	const vouching = (receipt.reviewers ?? []).filter((reviewer) => reviewer?.stages?.[stage] === "clean" && Array.isArray(reviewer.covers) && reviewer.covers.includes(requirementId));
	for (const reviewer of vouching) {
		if (!Array.isArray(reviewer.files_read)) fail(`${requirementId}: receipt ${id} reviewer ${reviewer.model} has no explicit Files Read attestation for the current review schema`);
	}
}

const readLogFromDisk = (relativePath) => fs.readFileSync(path.join(root, relativePath));

function traceTestRegistrationExists(source, symbol) {
	if (typeof source !== "string" || typeof symbol !== "string" || symbol === "") return false;
	const names = new Set();
	for (const match of source.matchAll(/\btest\s*\(\s*("(?:\\.|[^"\\])*")/g)) {
		try { names.add(JSON.parse(match[1])); } catch { return false; }
	}
	return names.has(symbol);
}

function validateData(files, indexText, receipts, scopeDigest, exists = (relativePath) => fs.existsSync(path.join(root, relativePath)), readLog = readLogFromDisk, sourceLedger = new Map(), scopeManifest = scope.reviewManifest()) {
	const ids = [...files.keys()].sort();
	const legacyGaps = new Set(legacySourceGapIds(indexText));
	const allowedDirectives = new Set([...expectedDirectives, ...sourceLedger.keys()]);
	if (ids.join(",") !== expectedIds.join(",")) fail(`expected ${expectedIds.join(",")}; got ${ids.join(",")}`);
	if (!sourceLedger.has("USR-008")) fail("USR-008 does not resolve to an immutable source ledger record");
	for (const [receiptId, receipt] of receipts) auditReceiptIntrinsic(receipt, receiptId, readLog);

	/**
	 * A Dirty verdict against the very tree being certified is disqualifying, whether or not any
	 * requirement bothered to name that receipt. Passing by citing only the Clean rounds and
	 * quietly leaving a Dirty one in the store beside them is exactly the shape of the failure
	 * this gate exists to prevent.
	 */
	for (const [receiptId, receipt] of receipts) {
		if (receipt.scope_digest !== scopeDigest) continue;
		for (const stage of stages) {
			if (receipt.stages?.[stage]?.verdict === "dirty") {
				fail(`receipt ${receiptId} records a dirty ${stage} verdict against this exact tree; fix what it found and re-review`);
			}
		}
	}

	const directiveUnion = new Set();
	const eligibilityChecks = [];
	for (const id of expectedIds) {
		const blocks = topLevelBlocks(files.get(id), id);
		if (scalarOf(blocks, "id", id) !== id) fail(`${id}: filename/id mismatch`);
		if (scalarOf(blocks, "product", id) !== "naia-adk-request-contract") fail(`${id}: wrong product`);
		const expectedStatus = pendingIds.has(id) ? "active" : "verified";
		if (scalarOf(blocks, "status", id) !== expectedStatus) fail(`${id}: status is not ${expectedStatus}`);
		const expectedSourceKind = pendingIds.has(id) ? "derived" : "human";
		if (scalarOf(blocks, "source", id) !== expectedSourceKind) fail(`${id}: source is not ${expectedSourceKind}`);
		const expectedProvenance = pendingIds.has(id) ? "ledger_resolved" : "legacy_unresolved";
		if (scalarOf(blocks, "source_provenance", id) !== expectedProvenance) fail(`${id}: source_provenance is not ${expectedProvenance}`);

		const directiveInline = scalarOf(blocks, "source_directives", id).match(/^\[(.*)\]$/s);
		if (!directiveInline) fail(`${id}: source_directives missing or malformed`);
		const directives = directiveInline[1].split(",").map((item) => unquote(item)).filter((item) => item !== "");
		if (directives.length === 0 || directives.some((item) => !allowedDirectives.has(item))) fail(`${id}: invalid source_directives`);
		for (const directive of directives) directiveUnion.add(directive);
		if (pendingIds.has(id)) validateRequirementContract(blocks, id, directives, sourceLedger);
		else for (const directive of directives) if (!legacyGaps.has(directive) && !sourceLedger.has(directive)) fail(`${id}: legacy directive ${directive} is neither ledger-resolved nor explicitly unresolved`);

		const acceptance = bodyOf(blocks, "acceptance_criteria", id);
		if ((acceptance.match(/^\s{2}-\s+.+$/gm) || []).length < 2) fail(`${id}: fewer than two acceptance criteria`);

		const trace = bodyOf(blocks, "trace", id);
		for (const section of ["code", "tests"]) {
			for (const entry of parseTracePaths(trace, section, id)) {
				if (!exists(entry.path)) fail(`${id}: trace path does not exist: ${entry.path}`);
				if (section === "tests" && entry.path.startsWith(".claude/hooks/test/") && entry.path.includes("request-contract")
					&& !traceTestRegistrationExists(fs.readFileSync(path.join(root, entry.path), "utf8"), entry.symbol)) {
					fail(`${id}: trace test symbol does not exist in ${entry.path}: ${entry.symbol}`);
				}
			}
		}

		if (pendingIds.has(id)) {
			validatePendingReviews(trace, id);
		} else {
		const reviews = parseReviews(trace, id);
		for (const stage of stages) {
			const receiptIds = reviews[stage];
			if (receiptIds.length < requiredCleanRounds) {
				fail(`${id}: ${stage} names ${receiptIds.length} Clean round(s); review-pass requires ${requiredCleanRounds} consecutive`);
			}
			/**
			 * Two receipts are two rounds only if two reviews actually happened. Nothing else
			 * separates them: both must carry the same scope digest by construction, so a single
			 * round could otherwise be issued twice under different ids and satisfy the streak —
			 * which is the exact violation this gate exists to catch. Round identity is therefore
			 * the set of transcripts it was derived from: no transcript may be spent twice.
			 */
			const spent = new Map();
			for (const receiptId of receiptIds) {
				const receipt = receipts.get(receiptId);
				if (!receipt) fail(`${id}: ${stage} names receipt ${receiptId}, which does not exist in the receipt store`);
				validateReceiptIntegrity(receipt, receiptId, stage, id, readLog);
				eligibilityChecks.push({ receipt, receiptId, stage, requirementId: id });
				for (const reviewer of receipt.reviewers ?? []) {
					const previous = spent.get(reviewer.log_sha256);
					if (previous !== undefined && previous !== receiptId) {
						fail(`${id}: ${stage} counts ${previous} and ${receiptId} as separate Clean rounds, but they rest on the same reviewer transcript (${reviewer.model}) — one round cannot be spent twice`);
					}
					spent.set(reviewer.log_sha256, receiptId);
				}
			}
		}
		}

		const title = scalarOf(blocks, "title", id);
		const escapedId = id.replace("-", "\\-");
		const indexMatches = [...indexText.matchAll(new RegExp(`^\\s+- \\{ id: ${escapedId}, title: "([^"]+)", status: ([^ }]+) \\}\\s*$`, "gm"))];
		if (indexMatches.length !== 1) fail(`${id}: expected exactly one index entry`);
		if (indexMatches[0][1] !== title || indexMatches[0][2] !== expectedStatus) fail(`${id}: index title/status drift`);
	}

	if (expectedDirectives.some((directive) => !directiveUnion.has(directive))) fail("USR-001 through USR-008 are not all traced");
	if (!/product:\s*naia-adk-request-contract[\s\S]*?req_count:\s*16\b/.test(indexText)) fail("request-contract index count is not 16");

	/**
	 * Release eligibility is intentionally the final pass. A known stale receipt must never
	 * short-circuit structural, index, source, trace, transcript, or receipt-integrity checks
	 * for a later requirement and thereby hide repository damage behind an expected blocker.
	 */
	for (const check of eligibilityChecks) {
		validateReceiptEligibility(check.receipt, check.receiptId, check.stage, check.requirementId, scopeDigest, scopeManifest);
	}
}

function loadRequirementFiles() {
	const files = new Map();
	const tracked = new Set(scope.requirementFilenames());
	const working = fs.readdirSync(requirementsDir).filter((name) => /^RCI-\d{3}-.+\.yaml$/.test(name));
	for (const filename of [...new Set([...tracked, ...working])].sort()) {
		const relativePath = path.posix.join(".agents", "requirements", filename);
		const text = scope.workingBytes(relativePath).toString("utf8");
		const declared = scalarOf(topLevelBlocks(text, filename), "id", filename);
		const status = scalarOf(topLevelBlocks(text, filename), "status", filename);
		if (status === "verified" && !tracked.has(filename)) fail(`${filename}: verified requirement is not Git-tracked`);
		const fromName = filename.slice(0, "RCI-000".length);
		if (declared !== fromName) fail(`${filename}: declares id ${declared}`);
		if (files.has(declared)) fail(`${declared}: declared by more than one file`);
		files.set(declared, text);
	}
	return files;
}

const executeRequirementTraceSelfTests = require("./validate-request-contract-self-tests.cjs");

/** Self-tests first: they must hold whatever state the real store is in. */
if (!transcript.selfTest()) fail("the shared transcript parser failed its own self-test");
if (!scope.selfTest()) fail("the review-scope digest failed its own self-test");
executeRequirementTraceSelfTests({
	scope, transcript, currentReviewedFiles, expectedIds, expectedDirectives, pendingIds,
	requiredUsr008Obligations, fail, sha256, canonicalSourceEvent, loadSourceLedger, validateData, traceTestRegistrationExists,
});
if (process.env.RCI_SELF_TEST_ONLY === "1") {
	process.stdout.write("request-contract requirement trace self-tests: PASS\n");
	process.exit(0);
}

const files = loadRequirementFiles();
const indexText = fs.readFileSync(path.join(requirementsDir, "_index.yaml"), "utf8");
const sourceLedger = loadSourceLedger(indexText);
const unresolvedLegacySources = legacySourceGapIds(indexText);
const readReceipt = (filename) => fs.readFileSync(path.join(receiptsDir, filename), "utf8");
const receipts = loadReceipts(readReceipt);
const scopeDigest = scope.computeScopeDigest();
let releaseBlocker = null;
try {
	validateData(files, indexText, receipts, scopeDigest, undefined, undefined, sourceLedger, scope.reviewManifest());
} catch (error) {
	const match = String(error && error.message || "").match(/^request-contract requirement trace: (RCI-\d{3}): receipt ([A-Za-z0-9._-]+) judged a different tree \(scope digest drift/);
	if (!match) throw error;
	releaseBlocker = { code: "review_scope_stale", requirement_id: match[1], receipt_id: match[2] };
}
if (!releaseBlocker && unresolvedLegacySources.length > 0) releaseBlocker = { code: "legacy_source_provenance_unresolved", source_ids: unresolvedLegacySources };

if (process.env.RCI_RELEASE_STATUS_JSON === "1") {
	process.stdout.write(`${JSON.stringify({ status: releaseBlocker ? "blocked" : "eligible", blocker: releaseBlocker })}\n`);
	process.exit(releaseBlocker ? 3 : 0);
}
if (releaseBlocker?.code === "review_scope_stale") fail(`${releaseBlocker.requirement_id}: receipt ${releaseBlocker.receipt_id} judged a different tree (scope digest drift — the reviewed content changed after the review)`);
if (releaseBlocker?.code === "legacy_source_provenance_unresolved") fail(`legacy native source provenance remains unresolved: ${releaseBlocker.source_ids.join(", ")}; do not issue new verified receipts from AI-authored reconstructions`);

process.stdout.write("request-contract requirement trace: PASS\n");
